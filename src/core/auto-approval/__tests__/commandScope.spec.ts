import * as fs from "fs"
import * as path from "path"

import { DEFAULT_WORKSPACE_COMMAND_LISTS_ENABLED, globalSettingsSchema } from "@roo-code/types"
import * as vscode from "vscode"

import { Package } from "../../../shared/package"
import { makeUri, makeWorkspaceConfiguration } from "../../../test-utils/vscode"
import {
	readCommandListScopes,
	resolveEffectiveCommandLists,
	resolveWorkspaceWriteTarget,
	splitCommandListScopes,
	workspaceCommandListsEnabled,
} from "../commandScope"

// Scriptable stand-in for `vscode.workspace.workspaceFolders`: the module
// mock's getter reads through this object, so a test can change the open
// folders without re-mocking the module.
const workspaceState = vi.hoisted(() => ({
	workspaceFolders: undefined as { uri: unknown }[] | undefined,
}))

vi.mock("vscode", () => ({
	ConfigurationTarget: {
		Global: 1,
		Workspace: 2,
		WorkspaceFolder: 3,
	},
	workspace: {
		get workspaceFolders() {
			return workspaceState.workspaceFolders
		},
		getConfiguration: vi.fn(),
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
