import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { DEFAULT_WORKSPACE_COMMAND_LISTS_ENABLED, globalSettingsSchema } from "@roo-code/types"
import * as vscode from "vscode"

import { Package } from "../../../shared/package"
import { makeUri, makeWorkspaceConfiguration } from "../../../test-utils/vscode"
import {
	classifyCommandListBaseline,
	commandListFolderForResource,
	getEffectiveCommandDecision,
	readCommandListScopes,
	resolveEffectiveCommandLists,
	resolveWorkspaceWriteTarget,
	rollbackFailedCommandListWrite,
	splitCommandListScopes,
	workspaceCommandListsEnabled,
} from "../commandScope"
import { getSingleCommandDecision } from "../commands"
import { checkAutoApproval } from "../index"
import { baseState, type State } from "./fixtures"

// Double for `vscode.workspace.workspaceFolders`. The module mock reads
// this object, so a test changes the open folders without a new mock.
// `foldersByPath` backs `getWorkspaceFolder`, so a test controls which cwd
// resolves to which root. `throwsOnFoldersRead` makes the getter fail once,
// which stands for a workspace that cannot answer the lookup.
const workspaceState = vi.hoisted(() => ({
	workspaceFolders: undefined as { uri: unknown }[] | undefined,
	foldersByPath: new Map<string, unknown>(),
	throwsOnFoldersRead: false,
}))

// Double for `fs.realpathSync`. Only this binding is replaced. Every other fs
// call stays real, and the manifest and real-filesystem tests use
// `importOriginal`. The double resolves each path to itself: the mock roots
// exist on no filesystem, and an unresolvable root compares by its
// registered path. Tests that need other behavior script the double.
const fsState = vi.hoisted(() => ({
	// The real implementation, saved by the mock so a test can delegate to it.
	realRealpathSync: null as null | ((target: string) => string),
}))

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>()
	fsState.realRealpathSync = (target: string) => String(actual.realpathSync(target))
	const realpathSync = vi.fn((target: string): string => String(target))
	// Interop: production code imports the default export, this spec imports the
	// named one. Both must see the same double.
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
				// One throw only, like the test it serves. A second throw would fail every
				// later read, including the first-folder default the composition performs.
				workspaceState.throwsOnFoldersRead = false
				throw new Error("workspace unavailable")
			}
			return workspaceState.workspaceFolders
		},
		getConfiguration: vi.fn(),
		// Mirrors VS Code's lexical containment: a prefix test on the registered
		// paths, guarded by the platform separator. The folder lookup does not use
		// this double. It compares roots by real path. The double stays faithful, so
		// a test can register an outer root that lexically contains a symlinked
		// root's target. That outer root must not decide the folder match.
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
	// The mock scripts the shared double after creation, so the fixture needs no type assertion.
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
		// A real get() folds globalValue into the result. Reading the workspace
		// layer from get() would leak the user-only entry "npm" into that layer.
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
		// The save path passes one captured inspection to every derivation. The
		// snapshot is authoritative, so the configuration must not be read again.
		mockConfiguration({ inspect: { key: "deniedCommands", workspaceValue: ["stale"] } })

		const scopes = readCommandListScopes("deniedCommands", [], { workspaceValue: ["docker"] })

		expect(scopes.workspace).toEqual(["docker"])
		expect(scopes.merged).toEqual(["docker"])
		expect(vscode.workspace.getConfiguration).not.toHaveBeenCalled()
	})
})

describe("splitCommandListScopes", () => {
	it("keeps workspace entries in the workspace layer and routes new entries to global", () => {
		// The dialog sends the merged list back. A workspace-only entry such as
		// "docker" must not reach the global write.
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
		// Do not delete the user's global entry because the current folder also
		// defines it. The user authored the entry in both scopes and kept it.
		const result = splitCommandListScopes(["docker"], ["docker"], ["docker"])

		expect(result.workspaceWrite).toEqual(["docker"])
		expect(result.globalWrite).toEqual(["docker"])
	})

	it("removes a deleted entry from the workspace layer without touching global", () => {
		// The user kept "git" and deleted the workspace-only "docker". "git" survives at its own global layer.
		const result = splitCommandListScopes(["git"], ["docker"], ["git"])

		expect(result.workspaceWrite).toEqual([])
		expect(result.globalWrite).toEqual(["git"])
	})

	it("removes a deleted entry from every layer that contained it", () => {
		// "docker" lived in both layers and the user deleted it. The kept "rm" stays at the workspace layer only.
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
		// The snapshot alone picks the target. A folder value the live configuration
		// does not report still selects the folder target, so split, write, and
		// rollback share one captured state.
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

			// No resource means no folder value, so the folder target stays unreachable.
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
	// Unset is the state of every installation that never opted in, so unset
	// must read as disabled. Treating unset as enabled would widen auto-approval
	// by default. The comparison against the declared default also ties this
	// expectation to the constant that documents the shipped default.
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

// The manifest declaration makes the gate workspace-unsettable. VS Code refusing a
// workspace-layer value is platform behavior.
it("manifest: declares the gate as a default-off, application-scoped boolean", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../package.json"), "utf8"))
	const gate = manifest.contributes.configuration.properties["zoo-code.workspaceCommandListsEnabled"]

	expect(gate.type).toBe("boolean")
	expect(gate.default).toBe(false)
	expect(gate.scope).toBe("application")
})

it("manifest: keeps the command-list keys workspace-settable so the gated layer can exist", () => {
	// The gate scopes the effect of the workspace layers. Scoping the list keys would remove the workspace layer entirely.
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
	// Shadowing works in both directions. A workspace deny entry cannot decide anything the
	// global allow layer covers, so it never reaches the matcher.
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

// A global entry decides every command it matches. A workspace entry applies
// only where no global entry matches, so a project file fills gaps in the
// user's policy but never outranks it. Inside one layer the longest match
// wins. Equal lengths deny, so an ambiguous case fails closed. It does not
// silently widen auto-approval. An allow win would approve commands a deny
// entry in the same layer claims. Reversing that needs a policy decision.
it("getSingleCommandDecision: resolves an equally specific allow/deny match to the deny", () => {
	// "*" matches every command but counts as length 1, so it ties the
	// one-character allow entry on "git status".
	expect(getSingleCommandDecision("git status", ["g"], ["*"])).toBe("auto_deny")
	// The same entry present in both lists ties trivially, and still denies.
	expect(getSingleCommandDecision("git push", ["git push"], ["git push"])).toBe("auto_deny")
})

// Control for the tie: specificity decides the conflict, not a blanket deny preference.
// The longer entry wins on either side.
it("getSingleCommandDecision: lets the strictly more specific entry win on either side", () => {
	expect(getSingleCommandDecision("git push origin", ["git push"], ["git"])).toBe("auto_approve")
	expect(getSingleCommandDecision("git push origin", ["git"], ["git push"])).toBe("auto_deny")
})

it("resolveEffectiveCommandLists: keeps a workspace wildcard deny alive for the commands no global entry matches", () => {
	// Composition drops a workspace entry only when a global entry covers every
	// command it could match. "*" matches commands "g" cannot, so the deny
	// survives. The global entry then decides every command it matches, and the
	// workspace deny applies where the global layer is silent.
	const effective = resolveEffectiveCommandLists(listScopes(["g"], []), listScopes([], ["*"]), true)

	expect(effective.allowed).toEqual(["g"])
	expect(effective.denied).toEqual(["*"])
	// Inside the global allow prefix the global layer decides. The user's own allow outranks a project wildcard deny.
	expect(getEffectiveCommandDecision("git status", effective)).toBe("auto_approve")
	// Outside the global prefix the deny matches alone, so the workspace layer decides.
	expect(getEffectiveCommandDecision("docker ps", effective)).toBe("auto_deny")
})

it("getEffectiveCommandDecision: lets a global deny decide a command a workspace wildcard allow also matches", () => {
	// The precedence is symmetric: a user deny outranks a project allow, and a
	// user allow outranks a project deny. The workspace allow still decides the
	// commands the user's layer does not match.
	const effective = resolveEffectiveCommandLists(listScopes([], ["*"]), listScopes(["g"], []), true)

	expect(getEffectiveCommandDecision("git status", effective)).toBe("auto_deny")
	expect(getEffectiveCommandDecision("docker ps", effective)).toBe("auto_approve")
})

it("getEffectiveCommandDecision: lets the workspace layer decide when no global entry matches", () => {
	// The global layers say nothing about "rm", so the kept workspace deny
	// decides it. The global allow still decides the commands it matches. A
	// global entry that matches nothing leaves the workspace layer in charge.
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

// Command-branch enforcement composes its allow/deny pair from the raw global
// layers at the folder the task cwd resolves to. A task in another root is
// judged by that root's lists, not the window's first folder. The
// window-scoped pair on the state stays what the dialog displays.

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

// Raw global layers are empty, so every decision comes from the folder layer
// and can only be right for one folder. The baked pair on the state holds
// values no folder composes, so a check that consumes it decides differently.
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
	// Folder A denies "echo" and folder B denies "rm". The task runs in B.
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

	// "echo" is denied only in the first folder, so judging this B-rooted task
	// there would deny it. Nothing allows it, so the decision is the plain prompt.
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
	// Folder A's layer allows "echo". The cwd names a removed or relocated
	// folder, so no folder's layer may decide. Consuming folder A's allow entry
	// would approve a command that runs outside every workspace folder. Only the
	// empty global layers judge it.
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
	// With both raw layers set, the command branch re-composes and ignores the
	// baked pair. An absent cwd keeps the first-folder configuration, so two
	// witnesses apply. The raw global allow entry decides "echo hi". A check that
	// used the baked pair would find no match and fall to the prompt. Folder A's
	// deny entry decides "date -u". A composition that skipped the folder
	// configuration would fall to the prompt. The scope assertions pin which
	// folder's configuration the composition read.
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

	// Neither global layer shadows "date", so only folder A's list can deny it. The
	// outcome names the folder whose configuration decided.
	const folderWitness = await checkAutoApproval({ state, ask: "command", text: "date -u" })
	expect(folderWitness).toEqual({
		decision: "deny",
		autoDeny: { kind: "denylist", command: "date -u", pattern: "date" },
	})
	expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, folderA)
	// Reading folder B instead would judge the command against a folder the window never defaults to.
	expect(vscode.workspace.getConfiguration).not.toHaveBeenCalledWith(Package.name, folderB)
})

it("checkAutoApproval command: still lets a global deny entry veto a command whose cwd names no workspace root", async () => {
	vi.clearAllMocks()
	const { folderA, folderB } = openMultiRootWindow()
	// The global-only composition keeps the global layers authoritative. An unmatched cwd
	// drops only the workspace layer, never the global deny.
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
	// A blank cwd means no cwd, not an unmatched cwd. It keeps the first-folder configuration.
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
	// The lookup guard keeps a broken lookup from failing the decision. The
	// degradation must be the global-only composition, not a first-folder guess,
	// which matches the fail-closed direction of an unmatched cwd. The double
	// throws once, so a leak cannot change later tests.
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
	// The one open folder is both the task folder and the first folder, so the resolved
	// scope and the no-arg default name the same resource.
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
	// A window opened on the filesystem root ("/" or the Windows drive root) is
	// a workspace folder whose children must still resolve to it. Failed
	// containment there would drop the root's deny entries without a warning.
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

// Enforcement decides a command through the layer split the composition
// carries. Where a global entry matches, the global layer decides. The
// workspace layer decides only the commands no global entry matches. A
// single-character global entry ties a workspace wildcard entry in the merged
// pair, so a merged-pair matcher cannot reproduce that precedence. These
// cases pin it through the public enforcement boundary.
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

	// The project wildcard deny matches "git status" too, but the user's allow entry
	// matches it, so the global layer approves.
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

	// "docker ps" matches no global entry, so the kept workspace deny decides it. The
	// global allow of "g" fills no gap here.
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

	// The precedence is symmetric: outside the global deny's prefix the project wildcard allow still decides.
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

	// An unmatched cwd drops the workspace layer, which must not promote the
	// command to an approval. With no global match, the plain prompt stands.
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
	// The root folder's deny must reach enforcement for a child cwd, because
	// containment keeps the layer. The global layer still outranks it on a match.
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

	// Chain aggregation holds across layers: any denial denies the whole command.
	// Each sub-command is still decided by its own layer. The global allow
	// approves "git status" and the workspace wildcard denies "docker ps", and
	// the denial names the denied sub-command.
	expect(result).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "docker ps", pattern: "*" } })
})

it("checkAutoApproval command: denies a mixed allow/deny chain when one sub-command is unapproved under blanket", async () => {
	vi.clearAllMocks()
	const { folderA, folderB } = openMultiRootWindow()
	// The folder layers stay empty: no deny entry may decide the chain, so
	// only the all-sub-commands rule can keep it unapproved.
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: true },
		[folderB.fsPath]: { gate: true },
	})

	// One sub-command approved and one not, so only that rule denies the chain. An
	// any-match rule would approve it on "git status".
	const blanket = await checkAutoApproval({
		state: { ...layeredState(["git"]), alwaysDenyUnapprovedCommands: true },
		cwd: folderB.fsPath,
		ask: "command",
		text: "git status && docker ps",
	})
	expect(blanket).toEqual({ decision: "deny", autoDeny: { kind: "not_allowlisted", command: "docker ps" } })

	// Without blanket the same chain falls to the plain prompt.
	const prompt = await checkAutoApproval({
		state: layeredState(["git"]),
		cwd: folderB.fsPath,
		ask: "command",
		text: "git status && docker ps",
	})
	expect(prompt).toEqual({ decision: "ask" })
})

it("checkAutoApproval command: ignores a workspace allow entry while the gate is off", async () => {
	vi.clearAllMocks()
	const { folderA, folderB } = openMultiRootWindow()
	// The gate is off in both folders. The folder configuration is read, but its allow
	// entry must not reach the effective lists.
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: false },
		[folderB.fsPath]: { gate: false, allow: ["echo"] },
	})

	// The raw global layers keep the layered composition selected. They are empty, so the
	// gated-off workspace entry is the only entry that could allow "echo".
	const result = await checkAutoApproval({
		state: layeredState([], []),
		cwd: folderB.fsPath,
		ask: "command",
		text: "echo hi",
	})

	expect(result).toEqual({ decision: "ask" })
})

// The layered aggregator also owns the chain parsing, redirect sanitization,
// substitution veto, and deny reporting of the flat matcher. Enforcement
// selects it whenever both raw global lists are present, whatever the gate.
// A fixture without them exercises the fallback, and a regression in the
// layered copy would pass unnoticed.
it("checkAutoApproval command: approves a blank command under the layered composition", async () => {
	vi.clearAllMocks()
	// A whitespace-only command parses to zero sub-commands, and the layered
	// aggregator approves it before any chain logic. Pinning that on the
	// raw-lists path keeps the blanket branch from marking it unapproved.
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
	// "sh" is allowlisted, so only the syntax-error detection of the layered path can
	// stop an auto-approval of the unterminated quote.
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
	// The redirect token survives command splitting, so the aggregator strips it
	// before deciding. The deny case pins both halves: the verdict as if the
	// redirect were absent, and the sanitized text as the reported sub-command.
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
	// Every sub-command is allowlisted, so only the chain-wide substitution veto can keep
	// this command off the auto-approve side.
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
	// Matching ignores case. The reported pattern must be the stored entry, not
	// the lower-cased match, so the denial names what the user's list holds.
	const result = await checkAutoApproval({
		state: layeredState([], ["RM"]),
		ask: "command",
		text: "rm file",
	})

	expect(result).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "rm file", pattern: "RM" } })
})

it("checkAutoApproval command: reports the denied sub-command of a chain in its sanitized form", async () => {
	vi.clearAllMocks()
	// The denied index selects the reported sub-command from the sanitized list.
	// Here that is the second sub-command and the redirect-stripped text.
	const result = await checkAutoApproval({
		state: layeredState(["git"], ["RM"]),
		ask: "command",
		text: "git status && Rm file 2>&1",
	})

	expect(result).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "Rm file", pattern: "RM" } })
})

// A directory symlink on Windows needs developer mode or elevation. A junction
// needs neither, and realpath resolves it like a POSIX link, so the fixture
// tries a symlink first and then a junction. Where neither works, the
// real-filesystem test is skipped and the scripted tests still pin the logic.
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

// The root-side fallback runs after the registered paths match nothing. These
// tests steer resolution through the double and keep the registry lists
// independent of resolution. The reset here also stops the scripted behavior
// from leaking into the manifest reads and the other lookup tests.
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
			// The registry holds the link, because the folder was opened through it. The
			// registered paths match nothing, so only the root's real path connects them.
			workspaceState.workspaceFolders = [{ uri: linkUri }]
			workspaceState.foldersByPath.set(link, linkUri)
			// One delegate covers every call the lookup makes against this link.
			vi.mocked(fs.realpathSync).mockImplementation((target) => realPath(String(target)))
			// The configuration is scripted for the registry entry, not the real path.
			// Folder-scoped settings resolve against what VS Code opened.
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
	// A relocated or deleted root has no real path. Comparing it by the registered path
	// keeps that folder's layer applied instead of dropped.
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

	// The sibling "root-two" shares "root" as a string prefix. Only the separator guard keeps it outside the root.
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
	// A filesystem root ("/" on POSIX, "C:\" on Windows) is a legal workspace
	// folder and already ends in a separator. A second separator would stop every
	// child path from matching, which drops that folder's command-list layer.
	const rootPath = path.parse(process.cwd()).root
	const rootUri = makeUri(rootPath)
	workspaceState.workspaceFolders = [{ uri: rootUri }]

	expect(commandListFolderForResource(path.join(rootPath, "srv", "app"))).toBe(rootUri)
	// The root itself remains a match through the equality branch.
	expect(commandListFolderForResource(rootPath)).toBe(rootUri)
})

it("commandListFolderForResource: matches a child of a folder registered with a trailing separator", () => {
	vi.clearAllMocks()
	// The real-path fallback passes a registered trailing separator through an unresolved
	// root. Containment must then treat the separated root as its own child prefix.
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
	// Both sides arrive canonical, so their case agrees wherever the comparison applies.
	// Folding case here could match a root the filesystem keeps distinct.
	expect(commandListFolderForResource(path.join(path.sep + "mock", "root", "sub"))).toBeUndefined()
})

it("commandListFolderForResource: returns the registry Uri of the deepest matching root", () => {
	vi.clearAllMocks()
	const outerRoot = path.sep + "mock"
	const innerRegistered = path.join(outerRoot, "inner-real")
	const innerReal = path.join(outerRoot, "inner")
	const outerUri = makeUri(outerRoot)
	const innerUri = makeUri(innerRegistered)
	// Order matters: the outer root is seen first, so a lookup that returns the first match decides differently.
	workspaceState.workspaceFolders = [{ uri: outerUri }, { uri: innerUri }]
	vi.mocked(fs.realpathSync).mockImplementation((target) =>
		String(target) === innerRegistered ? innerReal : String(target),
	)

	const result = commandListFolderForResource(path.join(innerReal, "sub"))

	// Object identity against the registry entry pins both halves: the deepest
	// root won, and the result is the registered Uri. Folder-scoped configuration
	// resolves against the registry. The registered Uri is the one that must come
	// back, not the canonicalized path.
	expect(result).toBe(innerUri)
	expect(result?.fsPath).toBe(innerRegistered)
})

it("commandListFolderForResource: returns the deepest matching root when it is registered before the shallower root", () => {
	vi.clearAllMocks()
	// The reverse registration order of the test above. The deepest-wins rule is
	// a comparison, not a scan order, so it holds whichever root the registry
	// lists first. A lookup that kept the last candidate would return the outer
	// root here.
	const outerRoot = path.sep + "mock"
	const innerReal = path.join(outerRoot, "inner")
	const outerUri = makeUri(outerRoot)
	const innerUri = makeUri(innerReal)
	workspaceState.workspaceFolders = [{ uri: innerUri }, { uri: outerUri }]

	expect(commandListFolderForResource(path.join(innerReal, "sub"))).toBe(innerUri)
})

it("checkAutoApproval command: judges a cwd inside a deeper root by that root's layer when the deeper root is registered first", async () => {
	vi.clearAllMocks()
	// The enforcement consequence of the deepest-wins rule, with the other
	// registration order. The deeper root comes first, so a lookup that returns
	// the last match would enforce the outer folder's list. The outer entry
	// allows what the deeper entry denies, so the decision names the winner.
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
	// The outer root is registered first, and the registry holds the inner folder
	// as the link. The canonical cwd sits inside the link's target, and the outer
	// root is also a lexical prefix of the cwd. A lookup that trusted the first
	// lexical hit would enforce the outer folder's list and never read the folder
	// the command runs in.
	workspaceState.workspaceFolders = [{ uri: outerUri }, { uri: linkUri }]
	workspaceState.foldersByPath.set(outerRoot, outerUri)
	vi.mocked(fs.realpathSync).mockImplementation((target) =>
		String(target) === linkPath ? innerReal : String(target),
	)
	// The two folders hold opposite lists for "echo": the outer root allows what the inner
	// root denies, so the decision names the folder enforcement read.
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

	// The deepest canonical match wins over the shallower lexical containment, so the
	// symlinked root's deny decides the command that runs inside it.
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
		// The comparison trusts the case of the realpath output, so this pins it
		// against the real filesystem. The final component keeps the case it was
		// created with, and a differently-cased spelling does not sit inside it.
		const realBase = realPath(baseDir)
		expect(realPath(dir)).toBe(path.join(realBase, dirName))
		expect(path.join(realBase, dirName.toLowerCase()).startsWith(`${realPath(dir)}${path.sep}`)).toBe(false)
	} finally {
		fs.rmSync(baseDir, { recursive: true, force: true })
	}
})

describe("classifyCommandListBaseline", () => {
	// The four ways a submitted entry survives the baseline filter, plus the
	// drop case. Each row names the layer that keeps the entry, so a broken
	// predicate fails the row that owns it and no other.
	interface SurvivalRow {
		name: string
		baseline: string[]
		incoming: string[]
		workspace: string[]
		stateGlobal: string[]
		configGlobal: string[]
		globalLayerAtSaveStart: string[] | undefined
		survives: boolean
	}

	const rows: SurvivalRow[] = [
		{
			name: "an entry outside the baseline survives as a user addition",
			baseline: [],
			incoming: ["git"],
			workspace: [],
			stateGlobal: [],
			configGlobal: [],
			globalLayerAtSaveStart: undefined,
			survives: true,
		},
		{
			name: "a baseline entry the workspace layer holds survives",
			baseline: ["docker"],
			incoming: ["docker"],
			workspace: ["docker"],
			stateGlobal: [],
			configGlobal: [],
			globalLayerAtSaveStart: undefined,
			survives: true,
		},
		{
			name: "a baseline entry the configuration global layer holds survives",
			baseline: ["git"],
			incoming: ["git"],
			workspace: [],
			stateGlobal: [],
			configGlobal: ["git"],
			globalLayerAtSaveStart: ["git"],
			survives: true,
		},
		{
			name: "a baseline entry only the state copy holds survives when the configuration has no global layer",
			baseline: ["git"],
			incoming: ["git"],
			workspace: [],
			stateGlobal: ["git"],
			configGlobal: [],
			globalLayerAtSaveStart: undefined,
			survives: true,
		},
		{
			name: "a baseline entry only the state copy holds is dropped when a global layer exists",
			baseline: ["git"],
			incoming: ["git"],
			workspace: [],
			stateGlobal: ["git"],
			configGlobal: [],
			globalLayerAtSaveStart: [],
			survives: false,
		},
	]

	it.each(rows)("$name", (row) => {
		const result = classifyCommandListBaseline({
			baseline: row.baseline,
			incoming: row.incoming,
			currentScopes: { global: row.stateGlobal, workspace: row.workspace, merged: [] },
			configGlobalAtSaveStart: row.configGlobal,
			globalLayerAtSaveStart: row.globalLayerAtSaveStart,
			hiddenWorkspaceEntries: [],
			gateAtDisplay: undefined,
			gateNow: () => true,
		})

		expect(result.splitSourceEntries.includes(row.incoming[0])).toBe(row.survives)
	})

	// The external set spans three layers, and a submitted entry is never
	// external. These rows pin four filter terms: the submitted-entry term, the
	// baseline term, and the union terms for the state copy's global layer and
	// the configuration's global layer at save start. The union's workspace term
	// and the hidden-entry term are pinned only by the standalone tests below.
	interface ExternalRow {
		name: string
		baseline: string[]
		incoming: string[]
		workspace: string[]
		stateGlobal: string[]
		configGlobal: string[]
		expected: string[]
	}

	const externalRows: ExternalRow[] = [
		{
			name: "does not report a submitted entry that a workspace layer gained after display",
			baseline: ["git"],
			incoming: ["docker"],
			workspace: ["docker"],
			stateGlobal: [],
			configGlobal: [],
			expected: [],
		},
		{
			name: "reports an entry that only the state copy's global layer gained after display",
			baseline: ["git"],
			incoming: ["git"],
			workspace: [],
			stateGlobal: ["npm"],
			configGlobal: [],
			expected: ["npm"],
		},
		{
			name: "reports an entry that only the configuration's global layer held at save start",
			baseline: ["git"],
			incoming: ["git"],
			workspace: [],
			stateGlobal: [],
			configGlobal: ["npm"],
			expected: ["npm"],
		},
		{
			name: "does not report a displayed entry the submission deleted",
			baseline: ["git"],
			incoming: [],
			workspace: ["git"],
			stateGlobal: [],
			configGlobal: [],
			expected: [],
		},
	]

	it.each(externalRows)("$name", (row) => {
		const result = classifyCommandListBaseline({
			baseline: row.baseline,
			incoming: row.incoming,
			currentScopes: { global: row.stateGlobal, workspace: row.workspace, merged: [] },
			configGlobalAtSaveStart: row.configGlobal,
			globalLayerAtSaveStart: undefined,
			hiddenWorkspaceEntries: [],
			gateAtDisplay: undefined,
			gateNow: () => true,
		})

		expect(result.externallyAdded).toEqual(row.expected)
	})

	it("classifies a layer entry the submission omits as externally added", () => {
		// The settings file gained "aws" while the dialog was open. The dialog never
		// showed it, so the submission omits it, and the save must re-admit it.
		const result = classifyCommandListBaseline({
			baseline: ["git"],
			incoming: ["git"],
			currentScopes: { global: [], workspace: ["aws"], merged: [] },
			configGlobalAtSaveStart: [],
			globalLayerAtSaveStart: undefined,
			hiddenWorkspaceEntries: [],
			gateAtDisplay: undefined,
			gateNow: () => true,
		})

		expect(result.externallyAdded).toEqual(["aws"])
		expect(result.splitSourceEntries).toContain("aws")
	})

	it("keeps a hidden workspace entry out of the external set unless the global layer holds it", () => {
		// The workspace re-add preserves a hidden entry, so reporting it as externally
		// added would warn on every save. The global layer is displayed, so an entry
		// there is a real file addition and does warn.
		const hiddenOnly = classifyCommandListBaseline({
			baseline: [],
			incoming: [],
			currentScopes: { global: [], workspace: ["docker"], merged: [] },
			configGlobalAtSaveStart: [],
			globalLayerAtSaveStart: undefined,
			hiddenWorkspaceEntries: ["docker"],
			gateAtDisplay: undefined,
			gateNow: () => true,
		})
		const alsoGlobal = classifyCommandListBaseline({
			baseline: [],
			incoming: [],
			currentScopes: { global: [], workspace: ["docker"], merged: [] },
			configGlobalAtSaveStart: ["docker"],
			globalLayerAtSaveStart: ["docker"],
			hiddenWorkspaceEntries: ["docker"],
			gateAtDisplay: undefined,
			gateNow: () => true,
		})

		expect(hiddenOnly.externallyAdded).toEqual([])
		expect(alsoGlobal.externallyAdded).toEqual(["docker"])
	})

	it("treats a sender with no baseline as unclassified and reports nothing as externally added", () => {
		const result = classifyCommandListBaseline({
			baseline: undefined,
			incoming: ["git"],
			currentScopes: { global: ["aws"], workspace: ["docker"], merged: [] },
			configGlobalAtSaveStart: ["aws"],
			globalLayerAtSaveStart: ["aws"],
			hiddenWorkspaceEntries: [],
			gateAtDisplay: undefined,
			gateNow: () => true,
		})

		expect(result.externallyAdded).toEqual([])
		expect(result.splitSourceEntries).toEqual(["git"])
	})

	it("keeps the hidden set as the promotion set when the gate did not flip", () => {
		// "git" is in the hidden set and in the baseline, so an equality test that
		// reversed its sense would drop it and leave only "docker".
		const result = classifyCommandListBaseline({
			baseline: ["git"],
			incoming: ["git"],
			currentScopes: { global: [], workspace: ["git"], merged: [] },
			configGlobalAtSaveStart: [],
			globalLayerAtSaveStart: undefined,
			hiddenWorkspaceEntries: ["git", "docker"],
			gateAtDisplay: true,
			gateNow: () => true,
		})

		expect(result.promotionHiddenEntries).toEqual(["git", "docker"])
	})

	it("treats a baseline of the wrong runtime type as no baseline", () => {
		// A sender can put anything in the baseline slot. A non-array cannot answer
		// the display-time question, so the guard keeps the current hidden set
		// rather than filtering it against a value that cannot hold entries.
		const result = classifyCommandListBaseline({
			// Deliberately wrong type: the runtime guard, not the type system, decides.
			baseline: "git" as unknown as string[],
			incoming: ["git"],
			currentScopes: { global: [], workspace: ["git"], merged: [] },
			configGlobalAtSaveStart: [],
			globalLayerAtSaveStart: undefined,
			hiddenWorkspaceEntries: ["git", "docker"],
			gateAtDisplay: true,
			gateNow: () => false,
		})

		expect(result.externallyAdded).toEqual([])
		expect(result.splitSourceEntries).toEqual(["git"])
		expect(result.promotionHiddenEntries).toEqual(["git", "docker"])
	})

	it("drops a displayed entry from the promotion set when the gate flipped since display", () => {
		// The dialog showed "git" while the gate was on. The gate is off now, so "git"
		// sits in the hidden set, and keeping it must stay a workspace decision rather
		// than become a promotion into the global layer.
		const result = classifyCommandListBaseline({
			baseline: ["git"],
			incoming: ["git"],
			currentScopes: { global: [], workspace: ["git"], merged: [] },
			configGlobalAtSaveStart: [],
			globalLayerAtSaveStart: undefined,
			hiddenWorkspaceEntries: ["git", "docker"],
			gateAtDisplay: true,
			gateNow: () => false,
		})

		expect(result.promotionHiddenEntries).toEqual(["docker"])
	})

	it("does not read the gate when the sender reported no display-time value", () => {
		const gateNow = vi.fn(() => false)

		const result = classifyCommandListBaseline({
			baseline: ["git"],
			incoming: ["git"],
			currentScopes: { global: [], workspace: ["git"], merged: [] },
			configGlobalAtSaveStart: [],
			globalLayerAtSaveStart: undefined,
			hiddenWorkspaceEntries: ["docker"],
			gateAtDisplay: undefined,
			gateNow,
		})

		expect(result.promotionHiddenEntries).toEqual(["docker"])
		expect(gateNow).not.toHaveBeenCalled()
	})
})

describe("rollbackFailedCommandListWrite", () => {
	it("reports that nothing needs undoing when the global write never landed", async () => {
		const writeGlobalLayer = vi.fn(async () => undefined)

		const result = await rollbackFailedCommandListWrite({
			key: "allowedCommands",
			failure: "workspace write failed",
			globalWrite: ["git"],
			configGlobalAtSaveStart: [],
			globalLayerAtSaveStart: undefined,
			globalWriteApplied: false,
			readGlobalLayer: () => {
				throw new Error("must not be read")
			},
			writeGlobalLayer,
		})

		expect(result).toEqual({ status: "not-applied" })
		expect(writeGlobalLayer).not.toHaveBeenCalled()
	})

	it("removes this save's own additions and restores what it removed", async () => {
		// The save replaced ["git"] with ["git", "aws"]. The undo must drop "aws"
		// and keep "git", and it must not re-add anything the save never removed.
		const writeGlobalLayer = vi.fn(async () => undefined)

		const result = await rollbackFailedCommandListWrite({
			key: "allowedCommands",
			failure: "workspace write failed",
			globalWrite: ["git", "aws"],
			configGlobalAtSaveStart: ["git"],
			globalLayerAtSaveStart: ["git"],
			globalWriteApplied: true,
			readGlobalLayer: () => ["git", "aws"],
			writeGlobalLayer,
		})

		expect(result).toEqual({ status: "rolled-back" })
		expect(writeGlobalLayer).toHaveBeenCalledTimes(1)
		expect(writeGlobalLayer).toHaveBeenCalledWith(["git"])
	})

	it("restores an entry this save removed", async () => {
		// The save replaced ["git", "aws"] with ["git"], so the undo must put "aws"
		// back. A delta that only drops its own additions would leave the deletion.
		const writeGlobalLayer = vi.fn(async () => undefined)

		const result = await rollbackFailedCommandListWrite({
			key: "allowedCommands",
			failure: "workspace write failed",
			globalWrite: ["git"],
			configGlobalAtSaveStart: ["git", "aws"],
			globalLayerAtSaveStart: ["git", "aws"],
			globalWriteApplied: true,
			readGlobalLayer: () => ["git"],
			writeGlobalLayer,
		})

		expect(result).toEqual({ status: "rolled-back" })
		expect(writeGlobalLayer).toHaveBeenCalledWith(["git", "aws"])
	})

	it("keeps an entry a third party added mid-save", async () => {
		// The re-read holds "npm", which this save never wrote. A snapshot rewind
		// would delete it, so the delta must leave it in place.
		const writeGlobalLayer = vi.fn(async () => undefined)

		await rollbackFailedCommandListWrite({
			key: "allowedCommands",
			failure: "workspace write failed",
			globalWrite: ["git", "aws"],
			configGlobalAtSaveStart: ["git"],
			globalLayerAtSaveStart: ["git"],
			globalWriteApplied: true,
			readGlobalLayer: () => ["git", "aws", "npm"],
			writeGlobalLayer,
		})

		expect(writeGlobalLayer).toHaveBeenCalledWith(["git", "npm"])
	})

	it("clears the key when the re-read finds no layer and the undo is empty", async () => {
		// The layer held "git" at save start and the save wrote the same list, so
		// the delta is empty. A re-read that finds no layer means a third party
		// cleared it mid-save. Writing `[]` would materialize a layer no user made.
		const writeGlobalLayer = vi.fn(async () => undefined)

		const result = await rollbackFailedCommandListWrite({
			key: "allowedCommands",
			failure: "workspace write failed",
			globalWrite: ["git"],
			configGlobalAtSaveStart: ["git"],
			globalLayerAtSaveStart: ["git"],
			globalWriteApplied: true,
			readGlobalLayer: () => undefined,
			writeGlobalLayer,
		})

		expect(result).toEqual({ status: "rolled-back" })
		expect(writeGlobalLayer).toHaveBeenCalledWith(undefined)
	})

	it("does not duplicate an entry the undo both keeps and restores", async () => {
		// The save removed "aws" and the re-read still holds it, so the undo meets
		// "aws" twice: once in the kept fresh list and once in the removed set.
		const writeGlobalLayer = vi.fn(async () => undefined)

		const result = await rollbackFailedCommandListWrite({
			key: "allowedCommands",
			failure: "workspace write failed",
			globalWrite: ["git"],
			configGlobalAtSaveStart: ["git", "aws"],
			globalLayerAtSaveStart: ["git", "aws"],
			globalWriteApplied: true,
			readGlobalLayer: () => ["git", "aws"],
			writeGlobalLayer,
		})

		expect(result).toEqual({ status: "rolled-back" })
		expect(writeGlobalLayer).toHaveBeenCalledWith(["git", "aws"])
	})

	it("clears the key instead of materializing an empty layer", async () => {
		// The layer was absent at save start and the save wrote only its own entries.
		// The undo restores absence, so the activation seed still sees a user override.
		const writeGlobalLayer = vi.fn(async () => undefined)

		const result = await rollbackFailedCommandListWrite({
			key: "allowedCommands",
			failure: "workspace write failed",
			globalWrite: ["git"],
			configGlobalAtSaveStart: [],
			globalLayerAtSaveStart: undefined,
			globalWriteApplied: true,
			readGlobalLayer: () => ["git"],
			writeGlobalLayer,
		})

		expect(result).toEqual({ status: "rolled-back" })
		expect(writeGlobalLayer).toHaveBeenCalledWith(undefined)
	})

	it("keeps another writer's empty layer rather than clearing it", async () => {
		// The layer started absent, and another writer cleared it to `[]` mid-save.
		// That clear is a decision this save must not undo.
		const writeGlobalLayer = vi.fn(async () => undefined)

		await rollbackFailedCommandListWrite({
			key: "allowedCommands",
			failure: "workspace write failed",
			globalWrite: ["git"],
			configGlobalAtSaveStart: [],
			globalLayerAtSaveStart: undefined,
			globalWriteApplied: true,
			readGlobalLayer: () => [],
			writeGlobalLayer,
		})

		expect(writeGlobalLayer).toHaveBeenCalledWith([])
	})

	it("reports a failed re-read and writes nothing", async () => {
		const writeGlobalLayer = vi.fn(async () => undefined)

		const result = await rollbackFailedCommandListWrite({
			key: "allowedCommands",
			failure: "workspace write failed",
			globalWrite: ["git"],
			configGlobalAtSaveStart: [],
			globalLayerAtSaveStart: undefined,
			globalWriteApplied: true,
			readGlobalLayer: () => {
				throw new Error("configuration unavailable")
			},
			writeGlobalLayer,
		})

		expect(result.status).toBe("re-read-failed")
		expect(result).toMatchObject({ message: expect.stringContaining("could not be re-read to undo this save") })
		expect(writeGlobalLayer).not.toHaveBeenCalled()
	})

	it("reports a failed restore and does not claim the undo landed", async () => {
		const result = await rollbackFailedCommandListWrite({
			key: "allowedCommands",
			failure: "workspace write failed",
			globalWrite: ["git"],
			configGlobalAtSaveStart: [],
			globalLayerAtSaveStart: undefined,
			globalWriteApplied: true,
			readGlobalLayer: () => ["git"],
			writeGlobalLayer: async () => {
				throw new Error("restore rejected")
			},
		})

		expect(result.status).toBe("restore-failed")
		expect(result).toMatchObject({ message: expect.stringContaining("global-scoped restore also failed") })
		expect(result).not.toEqual({ status: "rolled-back" })
	})
})
