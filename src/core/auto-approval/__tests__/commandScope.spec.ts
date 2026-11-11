import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { DEFAULT_WORKSPACE_COMMAND_LISTS_ENABLED, globalSettingsSchema } from "@roo-code/types"
import * as vscode from "vscode"

import { Package } from "../../../shared/package"
import { makeUri, makeWorkspaceConfiguration } from "../../../test-utils/vscode"
import {
	commandListFolderForResource,
	getEffectiveCommandDecision,
	readCommandListScopes,
	resolveEffectiveCommandLists,
	resolveWorkspaceWriteTarget,
	splitCommandListScopes,
	workspaceCommandListsEnabled,
} from "../commandScope"
import { getSingleCommandDecision } from "../commands"
import { checkAutoApproval } from "../index"
import { baseState, type State } from "./fixtures"

// Scriptable stand-in for `vscode.workspace.workspaceFolders`: the module
// mock's getter reads through this object, so a test can change the open
// folders without re-mocking the module. `foldersByPath` backs
// `getWorkspaceFolder`: keys are folder paths, values the folder objects, so
// a test controls which cwds resolve to a root. `throwsOnFoldersRead` makes
// the getter itself fail once, standing in for a workspace that cannot answer
// the lookup at all.
const workspaceState = vi.hoisted(() => ({
	workspaceFolders: undefined as { uri: unknown }[] | undefined,
	foldersByPath: new Map<string, unknown>(),
	throwsOnFoldersRead: false,
}))

// Scriptable stand-in for `fs.realpathSync`, which the root-side containment
// fallback consults. Every other fs binding stays real — the manifest reads
// and the real-filesystem tests run through `importOriginal` — and the double
// resolves paths to themselves by default: the mock roots are fake paths that
// exist on no filesystem, and an unresolvable root is compared by its
// registered path, so identity reproduces exactly what the real call does to
// them. Tests that need other behavior script it explicitly.
const fsState = vi.hoisted(() => ({
	// The unmocked implementation, captured by the module mock so a test can
	// delegate through the double to real filesystem behavior.
	realRealpathSync: null as null | ((target: string) => string),
}))

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>()
	fsState.realRealpathSync = (target: string) => String(actual.realpathSync(target))
	const realpathSync = vi.fn((target: string): string => String(target))
	// Interop shape: production code reaches `realpathSync` through the
	// default export and this spec through the named one; both must see the
	// same double.
	const actualDefault = (actual as { default?: typeof import("fs") }).default ?? actual
	return {
		...actual,
		default: { ...actualDefault, realpathSync },
		realpathSync,
	}
})

/** The unmocked `fs.realpathSync`, for tests that pin real-filesystem behavior. */
function realPath(target: string): string {
	if (!fsState.realRealpathSync) {
		throw new Error("the fs module mock did not capture the unmocked realpathSync")
	}
	return fsState.realRealpathSync(target)
}

vi.mock("vscode", () => ({
	ConfigurationTarget: {
		Global: 1,
		Workspace: 2,
		WorkspaceFolder: 3,
	},
	Uri: {
		// Structural local stand-in: the resolver only carries the path
		// through to `getWorkspaceFolder`.
		file: (fsPath: string) => ({ scheme: "file", authority: "", path: fsPath, fsPath, query: "", fragment: "" }),
	},
	workspace: {
		get workspaceFolders() {
			if (workspaceState.throwsOnFoldersRead) {
				// One-shot, like the throwing-lookup test it serves: a leaked
				// throw would fail every later read, including the
				// first-folder default reads the composition still performs.
				workspaceState.throwsOnFoldersRead = false
				throw new Error("workspace unavailable")
			}
			return workspaceState.workspaceFolders
		},
		getConfiguration: vi.fn(),
		// Mirrors VS Code's lexical containment: a prefix test against the
		// registered paths, with the platform separator as the guard between
		// root and remainder. The folder lookup does not consult this double —
		// it compares roots by their real paths — but the double stays
		// faithful so a test can register an outer root that lexically
		// contains a symlinked root's target, the containment that must not
		// decide the folder match.
		getWorkspaceFolder: vi.fn((resource?: { fsPath?: string }) => {
			const fsPath = resource?.fsPath ?? ""
			for (const [folderPath, uri] of workspaceState.foldersByPath) {
				if (fsPath === folderPath || fsPath.startsWith(folderPath + path.sep)) {
					return { uri }
				}
			}
			return undefined
		}),
	},
}))

interface ConfigDouble {
	inspect?: {
		key: string
		defaultValue?: string[]
		globalValue?: string[]
		workspaceValue?: string[]
		workspaceFolderValue?: string[]
	}
	effective?: string[]
}

function mockConfiguration({ inspect, effective = [] }: ConfigDouble = {}) {
	const config = makeWorkspaceConfiguration()
	// The shared double is scripted after creation so the per-test fixture
	// values need no type assertion at the construction site.
	vi.mocked(config.get).mockReturnValue(effective)
	vi.mocked(config.inspect).mockReturnValue(inspect)
	vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(config)
}

describe("readCommandListScopes", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("reads the workspace layer from the workspace-scoped configuration value", () => {
		mockConfiguration({ inspect: { key: "deniedCommands", workspaceValue: ["docker"] } })

		const scopes = readCommandListScopes("deniedCommands", [])

		expect(scopes.workspace).toEqual(["docker"])
		expect(scopes.merged).toEqual(["docker"])
	})

	it("prefers the workspace-folder value over the workspace value", () => {
		mockConfiguration({
			inspect: {
				key: "deniedCommands",
				workspaceValue: ["docker"],
				workspaceFolderValue: ["pnpm docker"],
			},
		})

		const scopes = readCommandListScopes("deniedCommands", [])

		expect(scopes.workspace).toEqual(["pnpm docker"])
		expect(scopes.merged).toEqual(["pnpm docker"])
	})

	it("ignores the effective get() value so global-scoped entries are not double-counted", () => {
		// A real VS Code get() folds globalValue into the effective result, so
		// reading the workspace layer from get() would leak "npm" (a
		// user-settings-only entry) into the workspace layer.
		mockConfiguration({
			inspect: { key: "allowedCommands", globalValue: ["npm"], workspaceValue: ["docker"] },
			effective: ["npm", "docker"],
		})

		const scopes = readCommandListScopes("allowedCommands", [])

		expect(scopes.workspace).toEqual(["docker"])
		expect(scopes.merged).toEqual(["docker"])
	})

	it("returns an empty workspace layer when only globalValue is set", () => {
		mockConfiguration({
			inspect: { key: "allowedCommands", globalValue: ["npm"] },
			effective: ["npm"],
		})

		const scopes = readCommandListScopes("allowedCommands", [])

		expect(scopes.workspace).toEqual([])
		expect(scopes.merged).toEqual([])
	})

	it("unions global and workspace layers with deduplication and stable order", () => {
		mockConfiguration({ inspect: { key: "deniedCommands", workspaceValue: ["docker", "rm"] } })

		const scopes = readCommandListScopes("deniedCommands", ["git", "docker"])

		expect(scopes.global).toEqual(["git", "docker"])
		expect(scopes.workspace).toEqual(["docker", "rm"])
		expect(scopes.merged).toEqual(["git", "docker", "rm"])
	})

	it("drops blank and non-string entries from both layers", () => {
		mockConfiguration({ inspect: { key: "deniedCommands", workspaceValue: ["docker", "  "] } })

		const scopes = readCommandListScopes("deniedCommands", ["git", "", "   "] as string[])

		expect(scopes.global).toEqual(["git"])
		expect(scopes.workspace).toEqual(["docker"])
		expect(scopes.merged).toEqual(["git", "docker"])
	})

	it("treats a missing inspect result as an empty workspace layer", () => {
		mockConfiguration({ inspect: undefined })

		const scopes = readCommandListScopes("deniedCommands", ["git"])

		expect(scopes.workspace).toEqual([])
		expect(scopes.merged).toEqual(["git"])
	})

	it("falls back to an empty workspace layer when the configuration lookup throws", () => {
		vi.mocked(vscode.workspace.getConfiguration).mockImplementation(() => {
			throw new Error("configuration unavailable")
		})

		const scopes = readCommandListScopes("deniedCommands", ["git"])

		expect(scopes.workspace).toEqual([])
		expect(scopes.merged).toEqual(["git"])
	})

	it("takes the workspace layer from a caller-supplied snapshot without reading the configuration", () => {
		// The save path threads one captured inspection through every
		// derivation, so the snapshot is authoritative: the configuration's own
		// value must never be consulted a second time.
		mockConfiguration({ inspect: { key: "deniedCommands", workspaceValue: ["stale"] } })

		const scopes = readCommandListScopes("deniedCommands", [], { workspaceValue: ["docker"] })

		expect(scopes.workspace).toEqual(["docker"])
		expect(scopes.merged).toEqual(["docker"])
		expect(vscode.workspace.getConfiguration).not.toHaveBeenCalled()
	})
})

describe("splitCommandListScopes", () => {
	it("keeps workspace entries in the workspace layer and routes new entries to global", () => {
		// The issue #1939 leak: the dialog sends the merged list back, and the
		// workspace-only entry "docker" must not end up in the global write.
		const result = splitCommandListScopes(["docker", "aws"], ["docker"], [])

		expect(result.workspaceWrite).toEqual(["docker"])
		expect(result.globalWrite).toEqual(["aws"])
	})

	it("keeps a global entry in the global layer", () => {
		const result = splitCommandListScopes(["git"], [], ["git"])

		expect(result.workspaceWrite).toEqual([])
		expect(result.globalWrite).toEqual(["git"])
	})

	it("keeps an entry present in both layers in both layers when retained", () => {
		// Semantics: do not silently delete the user's global entry just
		// because the current folder happens to define it too; the entry was
		// deliberately authored in both scopes and the user kept it.
		const result = splitCommandListScopes(["docker"], ["docker"], ["docker"])

		expect(result.workspaceWrite).toEqual(["docker"])
		expect(result.globalWrite).toEqual(["docker"])
	})

	it("removes a deleted entry from the workspace layer without touching global", () => {
		// The user kept "git" and deleted workspace-only "docker"; "git" must
		// survive at its own (global) layer.
		const result = splitCommandListScopes(["git"], ["docker"], ["git"])

		expect(result.workspaceWrite).toEqual([])
		expect(result.globalWrite).toEqual(["git"])
	})

	it("removes a deleted entry from every layer that contained it", () => {
		// "docker" lived in both layers and the user deleted it; kept "rm"
		// stays at the workspace layer only.
		const result = splitCommandListScopes(["rm"], ["docker", "rm"], ["docker"])

		expect(result.workspaceWrite).toEqual(["rm"])
		expect(result.globalWrite).toEqual([])
	})

	it("routes entries the dialog seeded to the layer they came from", () => {
		const result = splitCommandListScopes(
			["git", "docker", "pnpm docker", "aws"],
			["docker", "pnpm docker"],
			["git"],
		)

		expect(result.workspaceWrite).toEqual(["docker", "pnpm docker"])
		expect(result.globalWrite).toEqual(["git", "aws"])
	})

	it("orders the global write as existing global entries then new entries in dialog order", () => {
		const result = splitCommandListScopes(["aws", "git", "npm"], ["docker"], ["git"])

		expect(result.globalWrite).toEqual(["git", "aws", "npm"])
	})

	it("drops blank and non-string entries from the incoming list", () => {
		// Deliberate wrong runtime type: configuration lists arrive as unknown,
		// so the sanitizer must drop non-strings instead of throwing on them.
		const result = splitCommandListScopes(["git", "", "   ", 42 as unknown as string], [], ["git"])

		expect(result.globalWrite).toEqual(["git"])
		expect(result.workspaceWrite).toEqual([])
	})

	it("deduplicates layers so re-writing cannot introduce duplicates", () => {
		const result = splitCommandListScopes(["docker", "docker"], ["docker", "docker"], ["docker"])

		expect(result.workspaceWrite).toEqual(["docker"])
		expect(result.globalWrite).toEqual(["docker"])
	})
})

describe("resolveWorkspaceWriteTarget", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		workspaceState.workspaceFolders = undefined
	})

	it("returns the workspace-folder target when a folder value is set", () => {
		mockConfiguration({
			inspect: { key: "deniedCommands", workspaceValue: ["docker"], workspaceFolderValue: ["pnpm docker"] },
		})

		expect(resolveWorkspaceWriteTarget("deniedCommands")).toBe(vscode.ConfigurationTarget.WorkspaceFolder)
	})

	it("returns the workspace target when only a workspace value is set", () => {
		mockConfiguration({ inspect: { key: "deniedCommands", workspaceValue: ["docker"] } })

		expect(resolveWorkspaceWriteTarget("deniedCommands")).toBe(vscode.ConfigurationTarget.Workspace)
	})

	it("returns undefined when only a global value is set, so no workspace layer is created", () => {
		mockConfiguration({ inspect: { key: "deniedCommands", globalValue: ["npm"] } })

		expect(resolveWorkspaceWriteTarget("deniedCommands")).toBeUndefined()
	})

	it("returns undefined when there is no inspect result", () => {
		mockConfiguration({ inspect: undefined })

		expect(resolveWorkspaceWriteTarget("deniedCommands")).toBeUndefined()
	})

	it("returns undefined when the configuration lookup throws", () => {
		vi.mocked(vscode.workspace.getConfiguration).mockImplementation(() => {
			throw new Error("configuration unavailable")
		})

		expect(resolveWorkspaceWriteTarget("deniedCommands")).toBeUndefined()
	})

	it("resolves the target from a caller-supplied snapshot without reading the configuration", () => {
		// The snapshot alone decides the target, so a folder value the live
		// configuration does not report still selects the folder target —
		// keeping split, write, and rollback on one captured state.
		mockConfiguration({ inspect: { key: "deniedCommands", workspaceValue: ["docker"] } })

		expect(resolveWorkspaceWriteTarget("deniedCommands", { workspaceFolderValue: ["pnpm docker"] })).toBe(
			vscode.ConfigurationTarget.WorkspaceFolder,
		)
		expect(vscode.workspace.getConfiguration).not.toHaveBeenCalled()
	})

	it("resolves the target from the configuration scoped to the first workspace folder", () => {
		const folderA = makeUri("/mock/folder-a")
		const folderB = makeUri("/mock/folder-b")
		workspaceState.workspaceFolders = [{ uri: folderA }, { uri: folderB }]
		mockConfiguration({ inspect: { key: "deniedCommands", workspaceFolderValue: ["pnpm docker"] } })

		expect(resolveWorkspaceWriteTarget("deniedCommands")).toBe(vscode.ConfigurationTarget.WorkspaceFolder)
		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, folderA)
		// Only the first folder is ever in scope: reading any other folder's
		// configuration would silently target the wrong folder's settings file.
		expect(vscode.workspace.getConfiguration).not.toHaveBeenCalledWith(Package.name, folderB)
	})

	it.each([undefined, [] as { uri: unknown }[]])(
		"falls back to an unscoped configuration when no workspace folder is open (%s)",
		(workspaceFolders) => {
			workspaceState.workspaceFolders = workspaceFolders
			mockConfiguration({ inspect: { key: "deniedCommands", workspaceValue: ["docker"] } })

			// With no resource to resolve against, no folder value can be
			// reported, so the folder target stays unreachable.
			expect(resolveWorkspaceWriteTarget("deniedCommands")).toBe(vscode.ConfigurationTarget.Workspace)
			expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, undefined)
		},
	)
})

function mockGateConfiguration(gate: unknown) {
	const config = makeWorkspaceConfiguration()
	vi.mocked(config.get).mockReturnValue(gate)
	vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(config)
	return config
}

// Raw per-key layers in the shape readCommandListScopes returns them.
const listScopes = (globalList: string[], workspaceList: string[]) => ({
	global: globalList,
	workspace: workspaceList,
	merged: [...new Set([...globalList, ...workspaceList])],
})

it("workspaceCommandListsEnabled: enables the workspace layers only when the gate configuration reads true", () => {
	vi.clearAllMocks()
	const config = mockGateConfiguration(true)

	expect(workspaceCommandListsEnabled()).toBe(true)
	expect(config.get).toHaveBeenCalledWith("workspaceCommandListsEnabled")
})

it("workspaceCommandListsEnabled: is off when the gate is unset", () => {
	vi.clearAllMocks()
	// Unset is the state of every installation that has never opted in, so it
	// must read as disabled: treating unset as enabled would widen
	// auto-approval by default. The equality against the declared default also
	// keeps this expectation attached to the constant that documents the
	// shipped default, not to an independently hard-coded boolean.
	const config = mockGateConfiguration(undefined)

	expect(workspaceCommandListsEnabled()).toBe(false)
	expect(workspaceCommandListsEnabled()).toBe(DEFAULT_WORKSPACE_COMMAND_LISTS_ENABLED)
	expect(config.get).toHaveBeenCalledWith("workspaceCommandListsEnabled")
})

it("workspaceCommandListsEnabled: keeps the workspace layers disabled when the gate lookup throws", () => {
	vi.clearAllMocks()
	// Fail-closed: a broken configuration read must never widen what the
	// workspace layer can auto-approve.
	vi.mocked(vscode.workspace.getConfiguration).mockImplementation(() => {
		throw new Error("configuration unavailable")
	})

	expect(workspaceCommandListsEnabled()).toBe(DEFAULT_WORKSPACE_COMMAND_LISTS_ENABLED)
	expect(workspaceCommandListsEnabled()).toBe(false)
})

// The manifest declaration is what makes the gate workspace-unsettable;
// VS Code itself refusing a workspace-layer value is platform behavior.
it("manifest: declares the gate as a default-off, application-scoped boolean", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../package.json"), "utf8"))
	const gate = manifest.contributes.configuration.properties["zoo-code.workspaceCommandListsEnabled"]

	expect(gate.type).toBe("boolean")
	expect(gate.default).toBe(false)
	expect(gate.scope).toBe("application")
})

it("manifest: keeps the command-list keys workspace-settable so the gated layer can exist", () => {
	// The gate scopes the workspace layers' effect; scoping the list keys
	// themselves would remove the workspace layer entirely.
	const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../package.json"), "utf8"))
	const properties = manifest.contributes.configuration.properties

	expect(properties["zoo-code.allowedCommands"].scope).toBeUndefined()
	expect(properties["zoo-code.deniedCommands"].scope).toBeUndefined()
})

it("persisted-settings schema: defaults the gate to disabled", () => {
	expect(globalSettingsSchema.parse({}).workspaceCommandListsEnabled).toBeUndefined()
	expect(globalSettingsSchema.parse({ workspaceCommandListsEnabled: true }).workspaceCommandListsEnabled).toBe(true)
	expect(DEFAULT_WORKSPACE_COMMAND_LISTS_ENABLED).toBe(false)
})

it("resolveEffectiveCommandLists: hides every workspace entry, allow and deny alike, while the gate is disabled", () => {
	const effective = resolveEffectiveCommandLists(listScopes([], ["docker"]), listScopes([], ["rm"]), false)

	expect(effective.allowed).toEqual([])
	expect(effective.denied).toEqual([])
	expect(effective.hiddenWorkspaceAllow).toEqual(["docker"])
	expect(effective.hiddenWorkspaceDeny).toEqual(["rm"])
})

it("resolveEffectiveCommandLists: treats unshadowed workspace entries as the sole layer when the global layer is empty", () => {
	const effective = resolveEffectiveCommandLists(listScopes(["git"], ["docker", "aws"]), listScopes([], ["rm"]), true)

	expect(effective.allowed).toEqual(["git", "docker", "aws"])
	expect(effective.denied).toEqual(["rm"])
	expect(effective.hiddenWorkspaceAllow).toEqual([])
	expect(effective.hiddenWorkspaceDeny).toEqual([])
})

it("resolveEffectiveCommandLists: lets a global allow entry decide a command a longer workspace deny entry also matches", () => {
	// Cross-directional shadowing: the workspace deny entry cannot decide
	// anything the global allow layer already covers, so it never reaches
	// the matcher.
	const effective = resolveEffectiveCommandLists(listScopes(["git"], []), listScopes([], ["git push"]), true)

	expect(effective.allowed).toEqual(["git"])
	expect(effective.denied).toEqual([])
	expect(effective.hiddenWorkspaceDeny).toEqual(["git push"])
})

it("resolveEffectiveCommandLists: lets a global deny entry veto a longer workspace allow entry", () => {
	const effective = resolveEffectiveCommandLists(listScopes([], ["git push"]), listScopes(["git"], []), true)

	expect(effective.allowed).toEqual([])
	expect(effective.denied).toEqual(["git"])
	expect(effective.hiddenWorkspaceAllow).toEqual(["git push"])
})

it("resolveEffectiveCommandLists: silences every workspace deny entry behind a global wildcard allow entry", () => {
	const effective = resolveEffectiveCommandLists(listScopes(["*"], []), listScopes([], ["git push", "rm -rf"]), true)

	expect(effective.allowed).toEqual(["*"])
	expect(effective.denied).toEqual([])
	expect(effective.hiddenWorkspaceDeny).toEqual(["git push", "rm -rf"])
})

it("resolveEffectiveCommandLists: shadows workspace entries case-insensitively, the way the matcher matches", () => {
	const effective = resolveEffectiveCommandLists(
		listScopes(["Git"], ["git status"]),
		listScopes([], ["DOCKER"]),
		true,
	)

	expect(effective.allowed).toEqual(["Git"])
	expect(effective.denied).toEqual(["DOCKER"])
	expect(effective.hiddenWorkspaceAllow).toEqual(["git status"])
	expect(effective.hiddenWorkspaceDeny).toEqual([])
})

// A user-level (global) entry decides every command it matches: a workspace
// entry applies only where no global entry matches, so a project file can
// fill gaps in the user's policy but never outrank it. Within a single layer
// the conflict rule is specificity — the longest match wins — and when allow
// and deny entries match with equal specificity, the deny decides: an
// ambiguous case fails closed rather than silently widening auto-approval.
// Letting an allow win a within-layer tie would approve commands a deny entry
// in the same layer claims, so reversing it requires an explicit policy
// decision, not a refactor that happens to flip the comparison's direction.
it("getSingleCommandDecision: resolves an equally specific allow/deny match to the deny", () => {
	// "*" matches every command but counts as length 1, so it ties the
	// one-character allow entry on "git status".
	expect(getSingleCommandDecision("git status", ["g"], ["*"])).toBe("auto_deny")
	// The same entry present in both lists ties trivially, and still denies.
	expect(getSingleCommandDecision("git push", ["git push"], ["git push"])).toBe("auto_deny")
})

// Control for the tie: conflicts are decided by specificity, not by a
// blanket deny preference — the longer entry wins whichever side it sits on.
it("getSingleCommandDecision: lets the strictly more specific entry win on either side", () => {
	expect(getSingleCommandDecision("git push origin", ["git push"], ["git"])).toBe("auto_approve")
	expect(getSingleCommandDecision("git push origin", ["git"], ["git push"])).toBe("auto_deny")
})

it("resolveEffectiveCommandLists: keeps a workspace wildcard deny alive for the commands no global entry matches", () => {
	// Composition drops a workspace entry only when a global entry covers
	// every command it could match. "*" matches commands "g" cannot, so the
	// deny survives into the effective pair. Deciding then follows the layer
	// precedence: the global entry decides every command it matches, and the
	// workspace deny applies exactly where the global layer is silent.
	const effective = resolveEffectiveCommandLists(listScopes(["g"], []), listScopes([], ["*"]), true)

	expect(effective.allowed).toEqual(["g"])
	expect(effective.denied).toEqual(["*"])
	// Inside the global allow prefix the global layer decides: the user's own
	// allow outranks a project wildcard deny.
	expect(getEffectiveCommandDecision("git status", effective)).toBe("auto_approve")
	// Outside the global prefix the deny matches alone, so the workspace
	// layer decides.
	expect(getEffectiveCommandDecision("docker ps", effective)).toBe("auto_deny")
})

it("getEffectiveCommandDecision: lets a global deny decide a command a workspace wildcard allow also matches", () => {
	// The precedence is symmetric: a user-level deny outranks a project's
	// allow exactly as a user-level allow outranks a project's deny, while
	// the workspace allow still decides the commands the user's layer is
	// silent about.
	const effective = resolveEffectiveCommandLists(listScopes([], ["*"]), listScopes(["g"], []), true)

	expect(getEffectiveCommandDecision("git status", effective)).toBe("auto_deny")
	expect(getEffectiveCommandDecision("docker ps", effective)).toBe("auto_approve")
})

it("getEffectiveCommandDecision: lets the workspace layer decide when no global entry matches", () => {
	// The global layers say nothing about "rm": the kept workspace deny
	// decides alone, while the global allow still decides the commands it
	// matches. A global entry matching nothing leaves the workspace layer in
	// full charge of the commands it covers.
	const effective = resolveEffectiveCommandLists(listScopes(["git"], []), listScopes([], ["rm"]), true)

	expect(getEffectiveCommandDecision("git status", effective)).toBe("auto_approve")
	expect(getEffectiveCommandDecision("rm -rf tmp", effective)).toBe("auto_deny")
})

it("getEffectiveCommandDecision: keeps within-layer conflict resolution in each layer", () => {
	// Within the workspace layer an equal-length allow/deny conflict still
	// denies: layer precedence orders the layers, not the entries of a layer.
	const inWorkspace = resolveEffectiveCommandLists(listScopes([], ["g"]), listScopes([], ["*"]), true)
	expect(getEffectiveCommandDecision("git status", inWorkspace)).toBe("auto_deny")
	// The same holds within the global layer: the wildcard deny ties the
	// one-character allow there too.
	const inGlobal = resolveEffectiveCommandLists(listScopes(["g"], []), listScopes(["*"], []), true)
	expect(getEffectiveCommandDecision("git status", inGlobal)).toBe("auto_deny")
})

// Command-branch enforcement composes its allow/deny pair from the raw
// global layers at the folder the task's cwd resolves to, so a task in
// another root is judged by that root's lists rather than the window's
// first folder. The window-scoped pair on the state stays what the dialog
// displays.

function openMultiRootWindow() {
	const folderA = makeUri("/mock/folder-a")
	const folderB = makeUri("/mock/folder-b")
	workspaceState.workspaceFolders = [{ uri: folderA }, { uri: folderB }]
	workspaceState.foldersByPath.set(folderA.fsPath, folderA)
	workspaceState.foldersByPath.set(folderB.fsPath, folderB)
	return { folderA, folderB }
}

// Scripts each folder's configuration independently so the test can tell
// which folder's settings the enforcement path actually read.
function mockFolderConfigurations(scripts: Record<string, { gate?: boolean; deny?: string[]; allow?: string[] }>) {
	vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
		(_section?: string, scope?: vscode.ConfigurationScope | null) => {
			const entry = scripts[scope && "fsPath" in scope ? scope.fsPath : ""]
			const config = makeWorkspaceConfiguration({ workspaceCommandListsEnabled: entry?.gate ?? false })
			vi.mocked(config.inspect).mockImplementation((key: string) => {
				const layer =
					key === "deniedCommands" ? entry?.deny : key === "allowedCommands" ? entry?.allow : undefined
				return layer ? { key, workspaceFolderValue: layer } : undefined
			})
			return config
		},
	)
}

// Raw global layers empty: every enforcement decision then comes from the
// folder layer, so a decision can only be right for one folder. The baked
// pair on the state is set to values no folder composes, so a check that
// consumed it instead of re-composing decides differently.
const taskFolderState = (bakedAllowed: string[]): State => ({
	...baseState,
	alwaysAllowExecute: true,
	allowedCommands: bakedAllowed,
	deniedCommands: [],
	globalAllowedCommands: [],
	globalDeniedCommands: [],
})

it("checkAutoApproval command: enforces the deny entries of the folder the task's cwd resolves to", async () => {
	vi.clearAllMocks()
	const { folderA, folderB } = openMultiRootWindow()
	// Folder A denies "echo", folder B denies "rm"; the task runs in B.
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: true, deny: ["echo"] },
		[folderB.fsPath]: { gate: true, deny: ["rm"] },
	})

	// The baked pair would approve exactly what folder B's layer denies.
	const result = await checkAutoApproval({
		state: taskFolderState(["rm"]),
		cwd: folderB.fsPath,
		ask: "command",
		text: "rm file",
	})

	expect(result).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "rm file", pattern: "rm" } })
	expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, folderB)
})

it("checkAutoApproval command: does not apply another root's deny entries to a task outside it", async () => {
	vi.clearAllMocks()
	const { folderA, folderB } = openMultiRootWindow()
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: true, deny: ["echo"] },
		[folderB.fsPath]: { gate: true, deny: ["rm"] },
	})

	// "echo" is denied only in the first folder; judging this B-rooted task
	// there would auto-deny it. Nothing allows it either, so the correct
	// multi-root decision is the plain user prompt.
	const result = await checkAutoApproval({
		state: taskFolderState(["echo"]),
		cwd: folderB.fsPath,
		ask: "command",
		text: "echo hi",
	})

	expect(result).toEqual({ decision: "ask" })
})

it("checkAutoApproval command: does not apply the first folder's allow list to a cwd naming no workspace root", async () => {
	vi.clearAllMocks()
	const { folderA, folderB } = openMultiRootWindow()
	// Folder A's layer allows "echo"; the cwd names a removed or relocated
	// folder, so no folder's layer may decide the command. Consuming folder A's
	// allow entry here would approve a command executing outside every
	// workspace folder: a cwd naming no workspace root must not be approvable
	// by any folder's allow list — the composition is judged by the (empty)
	// global layers only.
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: true, deny: [], allow: ["echo"] },
		[folderB.fsPath]: { gate: true, deny: ["rm"] },
	})

	const result = await checkAutoApproval({
		state: taskFolderState([]),
		cwd: "/mock/removed-folder",
		ask: "command",
		text: "echo hi",
	})

	expect(result).toEqual({ decision: "ask" })
})

it("checkAutoApproval command: composes a command without a cwd from the global entries and the first folder's list when both raw layers are present", async () => {
	vi.clearAllMocks()
	// With both raw layers set, the command branch re-composes instead of
	// consuming the baked pair. An absent cwd keeps the first-folder
	// configuration, so two independent witnesses apply: the raw global allow
	// entry decides "echo hi" (a check that consumed the baked pair instead
	// would find no match and fall to the plain prompt), and folder A's deny
	// entry — about a command the global layers say nothing of — decides
	// "date -u" (a composition that ignored the folder's configuration would
	// have only the raw global layers to enforce and would fall to the plain
	// prompt). The scope assertions pin which folder's configuration the
	// composition read.
	const { folderA, folderB } = openMultiRootWindow()
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: true, deny: ["date"] },
		[folderB.fsPath]: { gate: true, deny: ["rm"] },
	})

	const state = {
		...taskFolderState(["baked"]),
		globalAllowedCommands: ["echo"],
		globalDeniedCommands: ["rm"],
	}

	const globalWitness = await checkAutoApproval({ state, ask: "command", text: "echo hi" })
	expect(globalWitness).toEqual({ decision: "approve" })

	// "date" is shadowed by neither global layer, so only folder A's list can
	// deny it: the outcome names the folder whose configuration decided.
	const folderWitness = await checkAutoApproval({ state, ask: "command", text: "date -u" })
	expect(folderWitness).toEqual({
		decision: "deny",
		autoDeny: { kind: "denylist", command: "date -u", pattern: "date" },
	})
	expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, folderA)
	// Reading folder B instead would have judged the command against a folder
	// the window never defaults to.
	expect(vscode.workspace.getConfiguration).not.toHaveBeenCalledWith(Package.name, folderB)
})

it("checkAutoApproval command: still lets a global deny entry veto a command whose cwd names no workspace root", async () => {
	vi.clearAllMocks()
	const { folderA, folderB } = openMultiRootWindow()
	// The global-only composition keeps the global layers authoritative: the
	// unmatched cwd drops only the workspace layer, never the global deny.
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: true, deny: ["rm"] },
		[folderB.fsPath]: { gate: true, deny: ["rm"] },
	})

	const result = await checkAutoApproval({
		state: { ...taskFolderState([]), globalDeniedCommands: ["echo"] },
		cwd: "/mock/removed-folder",
		ask: "command",
		text: "echo hi",
	})

	expect(result).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "echo hi", pattern: "echo" } })
})

it("checkAutoApproval command: keeps the first-folder composition for a blank cwd", async () => {
	vi.clearAllMocks()
	const { folderA, folderB } = openMultiRootWindow()
	// A blank cwd is the cwd-absent case, not the unmatched case: it stays on
	// the first-folder configuration it used before per-folder scoping existed.
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: true, deny: ["echo"] },
		[folderB.fsPath]: { gate: true, deny: ["rm"] },
	})

	const result = await checkAutoApproval({
		state: taskFolderState([]),
		cwd: "",
		ask: "command",
		text: "echo hi",
	})

	expect(result).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "echo hi", pattern: "echo" } })
})

it("checkAutoApproval command: treats a throwing workspace-folder lookup as a cwd naming no folder", async () => {
	vi.clearAllMocks()
	const { folderA, folderB } = openMultiRootWindow()
	// The lookup guard exists so a broken lookup cannot fail the decision; the
	// degradation it produces must be the global-only composition, not a
	// first-folder guess — the same fail-closed direction as an unmatched cwd.
	// The stand-in throws exactly once, so a leak cannot change later tests'
	// folder resolution.
	workspaceState.throwsOnFoldersRead = true
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: true, deny: [], allow: ["echo"] },
		[folderB.fsPath]: { gate: true, deny: ["rm"] },
	})

	const result = await checkAutoApproval({
		state: taskFolderState([]),
		cwd: folderA.fsPath,
		ask: "command",
		text: "echo hi",
	})

	expect(result).toEqual({ decision: "ask" })
})

it("checkAutoApproval command: in a single-folder window reads exactly the same configuration as before", async () => {
	vi.clearAllMocks()
	const { folderA } = openMultiRootWindow()
	workspaceState.workspaceFolders = [{ uri: folderA }]
	workspaceState.foldersByPath.delete(makeUri("/mock/folder-b").fsPath)
	// The one open folder is both the task folder and the first folder, so
	// the resolved scope and the no-arg default are the same resource.
	mockFolderConfigurations({ [folderA.fsPath]: { gate: true, deny: ["echo"] } })

	const result = await checkAutoApproval({
		state: taskFolderState(["echo"]),
		cwd: folderA.fsPath,
		ask: "command",
		text: "echo hi",
	})

	expect(result).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "echo hi", pattern: "echo" } })
	expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, folderA)
})

it("checkAutoApproval command: enforces the deny entries of a filesystem-root workspace folder", async () => {
	vi.clearAllMocks()
	// A window opened directly on the filesystem root ("/" or the Windows
	// drive root) is a workspace folder whose children must still resolve to
	// it: failing containment there would drop the root's deny entries
	// silently — the exact fail-open the folder lookup must not have.
	const rootPath = path.parse(process.cwd()).root
	const rootUri = makeUri(rootPath)
	workspaceState.workspaceFolders = [{ uri: rootUri }]
	workspaceState.foldersByPath.set(rootPath, rootUri)
	mockFolderConfigurations({ [rootPath]: { gate: true, deny: ["echo"] } })

	const result = await checkAutoApproval({
		// Empty raw global layers: only the root folder's layer can decide.
		state: taskFolderState([]),
		cwd: path.join(rootPath, "srv"),
		ask: "command",
		text: "echo hi",
	})

	expect(result).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "echo hi", pattern: "echo" } })
	expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, rootUri)
})

// Enforcement decides commands through the layer split the composition
// carries: wherever a global (user-level) entry matches, the global layer
// decides, and the workspace layer decides only the commands no global entry
// matches. A single-character global entry ties a workspace wildcard entry in
// the merged pair's longest-prefix comparison, so a merged-pair matcher alone
// could not reproduce that precedence; these cases pin it through the public
// enforcement boundary.
const layeredState = (globalAllow: string[], globalDeny: string[] = []): State => ({
	...taskFolderState(["baked"]),
	globalAllowedCommands: globalAllow,
	globalDeniedCommands: globalDeny,
})

it("checkAutoApproval command: lets a global allow entry decide a command a workspace wildcard deny also matches", async () => {
	vi.clearAllMocks()
	const { folderA, folderB } = openMultiRootWindow()
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: true, deny: ["*"] },
		[folderB.fsPath]: { gate: true, deny: ["*"] },
	})

	const result = await checkAutoApproval({
		state: layeredState(["g"]),
		cwd: folderB.fsPath,
		ask: "command",
		text: "git status",
	})

	// The project's wildcard deny matches "git status" too, but the user's own
	// allow entry matches it, so the global layer decides: approve.
	expect(result).toEqual({ decision: "approve" })
})

it("checkAutoApproval command: lets the workspace wildcard deny decide the commands no global entry matches", async () => {
	vi.clearAllMocks()
	const { folderA, folderB } = openMultiRootWindow()
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: true, deny: ["*"] },
		[folderB.fsPath]: { gate: true, deny: ["*"] },
	})

	const result = await checkAutoApproval({
		state: layeredState(["g"]),
		cwd: folderB.fsPath,
		ask: "command",
		text: "docker ps",
	})

	// "docker ps" matches no global entry, so the kept workspace deny decides
	// it — the global allow of "g" fills no gap here, and the project fills its
	// own.
	expect(result).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "docker ps", pattern: "*" } })
})

it("checkAutoApproval command: lets a global deny entry veto a command a workspace wildcard allow also matches", async () => {
	vi.clearAllMocks()
	const { folderA, folderB } = openMultiRootWindow()
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: true, allow: ["*"] },
		[folderB.fsPath]: { gate: true, allow: ["*"] },
	})

	const state = layeredState([], ["g"])

	const denied = await checkAutoApproval({ state, cwd: folderB.fsPath, ask: "command", text: "git status" })
	expect(denied).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "git status", pattern: "g" } })

	// The precedence is symmetric: outside the global deny's prefix the
	// project's wildcard allow still decides.
	const allowed = await checkAutoApproval({ state, cwd: folderB.fsPath, ask: "command", text: "docker ps" })
	expect(allowed).toEqual({ decision: "approve" })
})

it("checkAutoApproval command: keeps the global-only degradation for a cwd naming no root under the layered composition", async () => {
	vi.clearAllMocks()
	const { folderA, folderB } = openMultiRootWindow()
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: true, deny: ["*"] },
		[folderB.fsPath]: { gate: true, deny: ["*"] },
	})

	const state = layeredState(["g"])

	const globalWitness = await checkAutoApproval({
		state,
		cwd: "/mock/removed-folder",
		ask: "command",
		text: "git status",
	})
	expect(globalWitness).toEqual({ decision: "approve" })

	// Dropping the workspace layer for an unmatched cwd must not promote the
	// command to an approval: with no global match either, the plain prompt
	// stands, exactly as under the pre-composed pair.
	const unmatched = await checkAutoApproval({
		state,
		cwd: "/mock/removed-folder",
		ask: "command",
		text: "docker ps",
	})
	expect(unmatched).toEqual({ decision: "ask" })
})

it("checkAutoApproval command: decides a command in a filesystem-root workspace folder by both layers", async () => {
	vi.clearAllMocks()
	// The root folder's deny must still reach enforcement for a child cwd
	// (containment keeps the layer), and the global layer must still outrank
	// it where it matches — folder containment and layer precedence together.
	const rootPath = path.parse(process.cwd()).root
	const rootUri = makeUri(rootPath)
	workspaceState.workspaceFolders = [{ uri: rootUri }]
	workspaceState.foldersByPath.set(rootPath, rootUri)
	mockFolderConfigurations({ [rootPath]: { gate: true, deny: ["*"] } })

	const state = layeredState(["g"])
	const cwd = path.join(rootPath, "srv")

	const globalWitness = await checkAutoApproval({ state, cwd, ask: "command", text: "git status" })
	expect(globalWitness).toEqual({ decision: "approve" })

	const folderWitness = await checkAutoApproval({ state, cwd, ask: "command", text: "docker ps" })
	expect(folderWitness).toEqual({
		decision: "deny",
		autoDeny: { kind: "denylist", command: "docker ps", pattern: "*" },
	})
	expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, rootUri)
})

it("checkAutoApproval command: decides each sub-command of a chain by its own matching layer", async () => {
	vi.clearAllMocks()
	const { folderA, folderB } = openMultiRootWindow()
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: true, deny: ["*"] },
		[folderB.fsPath]: { gate: true, deny: ["*"] },
	})

	const result = await checkAutoApproval({
		state: layeredState(["g"]),
		cwd: folderB.fsPath,
		ask: "command",
		text: "git status && docker ps",
	})

	// Chain aggregation holds across layers — any denial denies the whole
	// command — while each sub-command is decided by its own layer: "git
	// status" is approved by the global allow while "docker ps" is denied by
	// the workspace wildcard, and the denial names the denied sub-command, not
	// the approved one.
	expect(result).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "docker ps", pattern: "*" } })
})

// The layered aggregator also owns the chain parsing, redirect sanitization,
// substitution veto, and deny reporting of the flat matcher — the enforcement
// path selects it whenever both raw global lists are present, regardless of
// the gate. These cases run through the public boundary with the raw lists
// populated: a fixture without them exercises the pre-composed fallback
// instead, and a regression in the layered copy would pass unnoticed.
it("checkAutoApproval command: approves a blank command under the layered composition", async () => {
	vi.clearAllMocks()
	// A whitespace-only command parses to zero sub-commands and the layered
	// aggregator returns approval for that before any chain logic; pinning it
	// on the raw-lists path keeps the blanket branch from reclassifying an
	// empty command as unapproved.
	const state = layeredState([], [])

	expect(await checkAutoApproval({ state, ask: "command", text: "   " })).toEqual({ decision: "approve" })
	expect(
		await checkAutoApproval({
			state: { ...state, alwaysDenyUnapprovedCommands: true },
			ask: "command",
			text: "   ",
		}),
	).toEqual({ decision: "approve" })
})

it("checkAutoApproval command: denies a malformed command under blanket and prompts without it", async () => {
	vi.clearAllMocks()
	// "sh" is allowlisted, so only the layered path's own syntax-error
	// detection — not prefix matching — can keep an unterminated quote from
	// being auto-approved.
	const state = layeredState(["sh"])

	expect(await checkAutoApproval({ state, ask: "command", text: "sh -c 'echo a" })).toEqual({ decision: "ask" })

	const result = await checkAutoApproval({
		state: { ...state, alwaysDenyUnapprovedCommands: true },
		ask: "command",
		text: "sh -c 'echo a",
	})
	expect(result).toEqual({
		decision: "deny",
		autoDeny: expect.objectContaining({
			kind: "malformed_command",
			command: "sh -c 'echo a",
			parseError: expect.stringContaining("unterminated"),
		}),
	})
})

it("checkAutoApproval command: matches a 2>&1 redirect sub-command on its sanitized form", async () => {
	vi.clearAllMocks()
	// The redirect token survives command splitting, so the aggregator strips
	// it before deciding. The deny witness pins both halves: the verdict as
	// if the redirect were absent, and the reported offending sub-command as
	// the sanitized text rather than the raw token.
	const allowed = await checkAutoApproval({
		state: layeredState(["git"]),
		ask: "command",
		text: "git status 2>&1",
	})
	expect(allowed).toEqual({ decision: "approve" })

	const denied = await checkAutoApproval({
		state: layeredState([], ["git"]),
		ask: "command",
		text: "git status 2>&1",
	})
	expect(denied).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "git status", pattern: "git" } })
})

it("checkAutoApproval command: never auto-approves an allowed command containing a command substitution", async () => {
	vi.clearAllMocks()
	// Here-string command substitution: every sub-command is allowlisted, so
	// only the chain-wide substitution veto can keep this off the
	// auto-approve side.
	const state = layeredState(["cat"])

	expect(await checkAutoApproval({ state, ask: "command", text: "cat <<<$(whoami)" })).toEqual({ decision: "ask" })

	const result = await checkAutoApproval({
		state: { ...state, alwaysDenyUnapprovedCommands: true },
		ask: "command",
		text: "cat <<<$(whoami)",
	})
	expect(result).toEqual({
		decision: "deny",
		autoDeny: { kind: "dangerous_substitution", command: "cat <<<$(whoami)" },
	})
})

it("checkAutoApproval command: reports the denied pattern in the case the user stored", async () => {
	vi.clearAllMocks()
	// Matching is case-insensitive, but the reported pattern must be the
	// stored entry rather than the lower-cased match, so the denial names
	// what the user's list actually contains.
	const result = await checkAutoApproval({
		state: layeredState([], ["RM"]),
		ask: "command",
		text: "rm file",
	})

	expect(result).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "rm file", pattern: "RM" } })
})

it("checkAutoApproval command: reports the denied sub-command of a chain in its sanitized form", async () => {
	vi.clearAllMocks()
	// The denied index selects the reported sub-command from the sanitized
	// list: here that is both the second sub-command rather than the approved
	// first one, and the redirect-stripped text rather than the raw token.
	const result = await checkAutoApproval({
		state: layeredState(["git"], ["RM"]),
		ask: "command",
		text: "git status && Rm file 2>&1",
	})

	expect(result).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "Rm file", pattern: "RM" } })
})

// Creating a directory symlink on Windows needs developer mode or elevation; a
// junction needs neither and is resolved by realpath like a POSIX link, so the
// fixture tries a symlink first and falls back to a junction. Where neither can
// be created the real-filesystem test is skipped; the scripted tests below pin
// the same resolution logic on every platform.
function createDirectoryLink(target: string, linkPath: string): void {
	try {
		fs.symlinkSync(target, linkPath, "dir")
	} catch {
		fs.symlinkSync(target, linkPath, "junction")
	}
}

function canCreateDirectoryLink(): boolean {
	const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "command-scope-link-probe-"))
	try {
		const target = path.join(probeDir, "target")
		fs.mkdirSync(target)
		createDirectoryLink(target, path.join(probeDir, "link"))
		return true
	} catch {
		return false
	} finally {
		fs.rmSync(probeDir, { recursive: true, force: true })
	}
}
const directoryLinksAvailable = canCreateDirectoryLink()

// The root-side fallback runs after the registered paths matched nothing, so
// these tests control resolution through the double (the mock header explains
// the identity default) and keep the registry lists they expect to be read
// independent of resolution. Resetting here also keeps the double's scripted
// behavior from leaking into the manifest reads above and the file's other
// lookup tests.
afterEach(() => {
	workspaceState.workspaceFolders = undefined
	workspaceState.foldersByPath.clear()
	vi.mocked(fs.realpathSync).mockImplementation((target) => String(target))
})

it.skipIf(!directoryLinksAvailable)(
	"checkAutoApproval command: applies a symlinked workspace root's folder layer to a cwd in the root's real path",
	async () => {
		vi.clearAllMocks()
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "command-scope-link-root-"))
		try {
			const realRoot = path.join(baseDir, "real-root")
			const taskDir = path.join(realRoot, "sub")
			fs.mkdirSync(realRoot)
			fs.mkdirSync(taskDir)
			const link = path.join(baseDir, "link-to-root")
			createDirectoryLink(realRoot, link)
			const linkUri = makeUri(link)
			// The registry holds the link: the folder was opened through it, so
			// the registered paths match nothing for a cwd the filesystem has
			// already resolved, and only the root's real path connects the two.
			workspaceState.workspaceFolders = [{ uri: linkUri }]
			workspaceState.foldersByPath.set(link, linkUri)
			// One delegate covers every call the lookup makes against this link.
			vi.mocked(fs.realpathSync).mockImplementation((target) => realPath(String(target)))
			// The configuration is scripted for the registry entry, not the
			// real path: folder-scoped settings resolve against what VS Code
			// opened.
			mockFolderConfigurations({ [link]: { gate: true, allow: ["echo"] } })

			const result = await checkAutoApproval({
				// Empty raw global layers: only the link folder's layer can
				// decide.
				state: taskFolderState([]),
				cwd: realPath(taskDir),
				ask: "command",
				text: "echo hi",
			})

			expect(result).toEqual({ decision: "approve" })
			expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, linkUri)
		} finally {
			fs.rmSync(baseDir, { recursive: true, force: true })
		}
	},
)

it("commandListFolderForResource: falls back to the registered path for a root whose real path cannot be resolved", () => {
	vi.clearAllMocks()
	const rootPath = path.join(path.sep + "mock", "broken-root")
	const rootUri = makeUri(rootPath)
	// A relocated or deleted root has no real path; comparing it by the path the
	// registry holds keeps that folder's layer applied instead of silently
	// dropping it.
	workspaceState.workspaceFolders = [{ uri: rootUri }]
	vi.mocked(fs.realpathSync).mockImplementation((target) => {
		if (String(target) === rootPath) {
			throw new Error("ENOENT: no such file or directory")
		}
		return String(target)
	})

	expect(commandListFolderForResource(path.join(rootPath, "sub"))).toBe(rootUri)
})

it("commandListFolderForResource: a path inside no root stays unmatched after the real-path retry", () => {
	vi.clearAllMocks()
	const rootPath = path.join(path.sep + "mock", "root")
	workspaceState.workspaceFolders = [{ uri: makeUri(rootPath) }]

	// The sibling "root-two" shares "root" as a string prefix; only the
	// separator guard between root and remainder keeps it outside the root.
	expect(commandListFolderForResource(path.join(path.sep + "mock", "root-two", "x"))).toBeUndefined()
	expect(commandListFolderForResource(path.join(path.sep + "mock", "elsewhere"))).toBeUndefined()
})

it("commandListFolderForResource: matches a cwd equal to the root's real path", () => {
	vi.clearAllMocks()
	workspaceState.foldersByPath.clear()
	const rootPath = path.join(path.sep + "mock", "root")
	const registeredPath = path.join(path.sep + "mock", "root-link")
	const rootUri = makeUri(registeredPath)
	workspaceState.workspaceFolders = [{ uri: rootUri }]
	vi.mocked(fs.realpathSync).mockImplementation((target) =>
		String(target) === registeredPath ? rootPath : String(target),
	)

	expect(commandListFolderForResource(rootPath)).toBe(rootUri)
})

it("commandListFolderForResource: matches a cwd inside a filesystem-root workspace folder", () => {
	vi.clearAllMocks()
	// A filesystem root — "/" on POSIX, "C:\" on Windows — is a legal
	// workspace folder and already ends in a separator. Appending another
	// separator would leave no child path able to match the root, dropping
	// that folder's command-list layer out of enforcement silently.
	const rootPath = path.parse(process.cwd()).root
	const rootUri = makeUri(rootPath)
	workspaceState.workspaceFolders = [{ uri: rootUri }]

	expect(commandListFolderForResource(path.join(rootPath, "srv", "app"))).toBe(rootUri)
	// The root itself remains a match through the equality branch.
	expect(commandListFolderForResource(rootPath)).toBe(rootUri)
})

it("commandListFolderForResource: matches a child of a folder registered with a trailing separator", () => {
	vi.clearAllMocks()
	// The real-path fallback passes a registered trailing separator through
	// unresolved roots, so containment must treat an already-separated root
	// as its own child prefix instead of doubling the separator.
	const rootPath = path.join(path.sep + "mock", "root") + path.sep
	const rootUri = makeUri(rootPath)
	workspaceState.workspaceFolders = [{ uri: rootUri }]

	expect(commandListFolderForResource(path.join(rootPath, "sub"))).toBe(rootUri)
})

it("commandListFolderForResource: returns undefined when no workspace folder is open", () => {
	vi.clearAllMocks()
	workspaceState.foldersByPath.clear()
	workspaceState.workspaceFolders = undefined

	expect(commandListFolderForResource(path.join(path.sep + "mock", "root"))).toBeUndefined()
})

it("commandListFolderForResource: compares the cwd to the root's real path case-sensitively", () => {
	vi.clearAllMocks()
	workspaceState.workspaceFolders = [{ uri: makeUri(path.join(path.sep + "mock", "Root")) }]
	// Both sides arrive canonical, so their case agrees wherever the
	// comparison applies; folding case here could match a root the filesystem
	// treats as distinct.
	expect(commandListFolderForResource(path.join(path.sep + "mock", "root", "sub"))).toBeUndefined()
})

it("commandListFolderForResource: returns the registry Uri of the deepest matching root", () => {
	vi.clearAllMocks()
	const outerRoot = path.sep + "mock"
	const innerRegistered = path.join(outerRoot, "inner-real")
	const innerReal = path.join(outerRoot, "inner")
	const outerUri = makeUri(outerRoot)
	const innerUri = makeUri(innerRegistered)
	// Order matters: the outer root is seen first, so a lookup that returned
	// the first match instead of the deepest one decides differently here.
	workspaceState.workspaceFolders = [{ uri: outerUri }, { uri: innerUri }]
	vi.mocked(fs.realpathSync).mockImplementation((target) =>
		String(target) === innerRegistered ? innerReal : String(target),
	)

	const result = commandListFolderForResource(path.join(innerReal, "sub"))

	// Object identity against the registry entry pins both halves: the deepest
	// root won, and the value returned is the registered Uri (folder-scoped
	// configuration resolves against the registry, not the real path).
	expect(result).toBe(innerUri)
	expect(result?.fsPath).toBe(innerRegistered)
})

it("commandListFolderForResource: returns the deepest matching root when it is registered before the shallower root", () => {
	vi.clearAllMocks()
	// The reverse registration order of the test above. The deepest-wins rule
	// is a comparison, not a scan order, so it must hold whichever root the
	// registry happens to list first; a lookup that simply kept the last
	// candidate would return the outer root for this order while still
	// passing a shallower-first fixture.
	const outerRoot = path.sep + "mock"
	const innerReal = path.join(outerRoot, "inner")
	const outerUri = makeUri(outerRoot)
	const innerUri = makeUri(innerReal)
	workspaceState.workspaceFolders = [{ uri: innerUri }, { uri: outerUri }]

	expect(commandListFolderForResource(path.join(innerReal, "sub"))).toBe(innerUri)
})

it("checkAutoApproval command: judges a cwd inside a deeper root by that root's layer when the deeper root is registered first", async () => {
	vi.clearAllMocks()
	// The enforcement consequence of the order-independent deepest-wins rule,
	// with the registration order the other symlinked-root test does not use:
	// the deeper root comes first, so a lookup that returned the last match
	// would enforce the outer folder's list here — the outer entry allows what
	// the deeper entry denies, so the decision names the winning folder.
	const outerRoot = path.sep + "mock"
	const outerUri = makeUri(outerRoot)
	const innerReal = path.join(outerRoot, "inner")
	const innerUri = makeUri(innerReal)
	workspaceState.workspaceFolders = [{ uri: innerUri }, { uri: outerUri }]
	workspaceState.foldersByPath.set(outerRoot, outerUri)
	mockFolderConfigurations({
		[outerRoot]: { gate: true, allow: ["echo"] },
		[innerReal]: { gate: true, deny: ["echo"] },
	})

	const result = await checkAutoApproval({
		// Empty raw global layers: only the winning folder's layer can decide.
		state: taskFolderState([]),
		cwd: path.join(innerReal, "sub"),
		ask: "command",
		text: "echo hi",
	})

	expect(result).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "echo hi", pattern: "echo" } })
	expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, innerUri)
})

it("checkAutoApproval command: judges a cwd inside a symlinked root by that root's layer when an outer root also contains it lexically", async () => {
	vi.clearAllMocks()
	const outerRoot = path.sep + "mock"
	const outerUri = makeUri(outerRoot)
	const linkPath = path.join(outerRoot, "link")
	const innerReal = path.join(outerRoot, "inner")
	const linkUri = makeUri(linkPath)
	// The outer root is registered first, and the registry holds the inner
	// folder as the link: the command's canonical cwd sits inside the link's
	// target. The outer root is also a lexical prefix of the cwd, so
	// VS Code-style lexical containment resolves it there — a lookup that
	// trusted that first lexical hit would enforce the outer folder's list
	// and never consult the folder the command physically runs in.
	workspaceState.workspaceFolders = [{ uri: outerUri }, { uri: linkUri }]
	workspaceState.foldersByPath.set(outerRoot, outerUri)
	vi.mocked(fs.realpathSync).mockImplementation((target) =>
		String(target) === linkPath ? innerReal : String(target),
	)
	// The two folders' lists are deliberately opposite on "echo": the outer
	// root allows what the inner root denies, so the decision names the
	// folder whose configuration enforcement read.
	mockFolderConfigurations({
		[outerRoot]: { gate: true, allow: ["echo"] },
		[linkPath]: { gate: true, deny: ["echo"] },
	})

	const result = await checkAutoApproval({
		// Empty raw global layers: only the winning folder's layer can decide.
		state: taskFolderState([]),
		cwd: path.join(innerReal, "sub"),
		ask: "command",
		text: "echo hi",
	})

	// The deepest canonical match wins over the shallower lexical containment,
	// so the symlinked root's deny entry decides the command running inside it.
	expect(result).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "echo hi", pattern: "echo" } })
	expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, linkUri)
})

it("realpathSync preserves the on-disk case of an existing directory", () => {
	vi.clearAllMocks()
	const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "command-scope-case-"))
	try {
		const dirName = "MixedCase-Dir"
		const dir = path.join(baseDir, dirName)
		fs.mkdirSync(dir)
		// The comparison trusts realpath output case, so it is pinned against
		// the real filesystem rather than assumed: the final component keeps
		// the case it was created with, and a differently-cased spelling of the
		// same directory does not sit inside it.
		const realBase = realPath(baseDir)
		expect(realPath(dir)).toBe(path.join(realBase, dirName))
		expect(path.join(realBase, dirName.toLowerCase()).startsWith(`${realPath(dir)}${path.sep}`)).toBe(false)
	} finally {
		fs.rmSync(baseDir, { recursive: true, force: true })
	}
})
