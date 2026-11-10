import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { DEFAULT_WORKSPACE_COMMAND_LISTS_ENABLED, globalSettingsSchema } from "@roo-code/types"
import * as vscode from "vscode"

import { Package } from "../../../shared/package"
import { makeUri, makeWorkspaceConfiguration } from "../../../test-utils/vscode"
import {
	commandListFolderForResource,
	readCommandListScopes,
	resolveEffectiveCommandLists,
	resolveWorkspaceWriteTarget,
	splitCommandListScopes,
	workspaceCommandListsEnabled,
} from "../commandScope"
import { checkAutoApproval } from "../index"
import { baseState, type State } from "./fixtures"

// Scriptable stand-in for `vscode.workspace.workspaceFolders`: the module
// mock's getter reads through this object, so a test can change the open
// folders without re-mocking the module. `foldersByPath` backs
// `getWorkspaceFolder`: keys are folder paths, values the folder objects, so
// a test controls which cwds resolve to a root.
const workspaceState = vi.hoisted(() => ({
	workspaceFolders: undefined as { uri: unknown }[] | undefined,
	foldersByPath: new Map<string, unknown>(),
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
			return workspaceState.workspaceFolders
		},
		getConfiguration: vi.fn(),
		getWorkspaceFolder: vi.fn((resource?: { fsPath?: string }) => {
			const fsPath = resource?.fsPath ?? ""
			for (const [folderPath, uri] of workspaceState.foldersByPath) {
				if (fsPath === folderPath || fsPath.startsWith(`${folderPath}/`)) {
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

it("checkAutoApproval command: composes a command without a cwd from the global layers when both raw layers are present", async () => {
	vi.clearAllMocks()
	// With both raw layers set, the command branch re-composes instead of
	// consuming the baked pair; an absent cwd keeps the first-folder
	// configuration, which here contributes nothing, so only the raw global
	// allow entry can decide. A check that consumed the baked pair instead
	// would find no match and fall to the plain prompt.
	const { folderA, folderB } = openMultiRootWindow()
	mockFolderConfigurations({
		[folderA.fsPath]: { gate: true },
		[folderB.fsPath]: { gate: true, deny: ["rm"] },
	})

	const result = await checkAutoApproval({
		state: { ...taskFolderState(["baked"]), globalAllowedCommands: ["echo"], globalDeniedCommands: ["rm"] },
		ask: "command",
		text: "echo hi",
	})

	expect(result).toEqual({ decision: "approve" })
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
	// Once-only: spies survive between tests in this file, and a leaked throwing
	// lookup would change every later test's folder resolution.
	vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementationOnce(() => {
		throw new Error("workspace unavailable")
	})
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
