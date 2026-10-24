import * as vscode from "vscode"

import { Package } from "../../../shared/package"
import { makeUri, makeWorkspaceConfiguration } from "../../../test-utils/vscode"
import { readCommandListScopes, resolveWorkspaceWriteTarget, splitCommandListScopes } from "../commandScope"

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
