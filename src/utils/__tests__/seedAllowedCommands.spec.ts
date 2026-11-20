// npx vitest run utils/__tests__/seedAllowedCommands.spec.ts

import * as vscode from "vscode"

import { readCommandListScopes } from "../../core/auto-approval/commandScope"
import { Package } from "../../shared/package"
import { makeUri, makeWorkspaceConfiguration } from "../../test-utils/vscode"
import { seedCommandList } from "../seedAllowedCommands"

// Scriptable `workspaceFolders`: the mock's getter reads this, so tests can
// change open folders without re-mocking.
const workspaceState = vi.hoisted(() => ({
	workspaceFolders: undefined as { uri: unknown }[] | undefined,
}))

vi.mock("vscode", () => ({
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
	inspectThrows?: boolean
	gate?: boolean
}

function mockConfiguration({ inspect, effective = [], inspectThrows = false, gate = false }: ConfigDouble = {}) {
	// Real VS Code reports `workspaceFolderValue` only for a resource-scoped
	// lookup. Scripting that split lets tests tell scoped calls from unscoped.
	vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
		(_section?: string, scope?: vscode.ConfigurationScope | null) => {
			const config = makeWorkspaceConfiguration()
			// The gate reads independently of the lists: its default is off, so
			// a test gets an enforced workspace layer only by asking.
			vi.mocked(config.get).mockImplementation((section: string) =>
				section === "workspaceCommandListsEnabled" ? gate : effective,
			)
			vi.mocked(config.inspect).mockImplementation(() => {
				if (inspectThrows) {
					throw new Error("configuration access failed")
				}
				if (inspect === undefined) {
					return undefined
				}
				// No resource => no folder layer, as in real VS Code.
				return scope === undefined || scope === null ? { ...inspect, workspaceFolderValue: undefined } : inspect
			})
			return config
		},
	)
}

function mockMemento(existing: unknown = undefined, deniedExisting: unknown = undefined) {
	const store = new Map<string, unknown>()
	if (existing !== undefined) {
		store.set("allowedCommands", existing)
	}
	if (deniedExisting !== undefined) {
		store.set("deniedCommands", deniedExisting)
	}

	// Complete Memento double: no type assertion at call sites.
	return {
		keys: vi.fn((): readonly string[] => [...store.keys()]),
		get: vi.fn().mockImplementation((key: string) => store.get(key)),
		update: vi.fn().mockImplementation(async (key: string, value: unknown) => {
			store.set(key, value)
		}),
	}
}

describe("seedCommandList", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		workspaceState.workspaceFolders = undefined
	})

	it("leaves global state unset when only a workspace-scoped value exists", async () => {
		// The leak scenario: reading get() would seed the workspace override
		// into global state. The override also replaced the declared default,
		// so re-granting the default is forbidden too.
		mockConfiguration({
			inspect: {
				key: "allowedCommands",
				defaultValue: ["git log", "git diff", "git show"],
				globalValue: undefined,
				workspaceValue: ["docker"],
			},
			effective: ["docker"],
			// Suppression applies only while the gate enforces the workspace layer.
			gate: true,
		})
		const globalState = mockMemento()

		await seedCommandList(globalState, "allowedCommands")

		expect(globalState.update).not.toHaveBeenCalled()
		expect(globalState.get("allowedCommands")).toBeUndefined()
	})

	it("leaves global state unset when only a workspace-folder-scoped value exists", async () => {
		// A folder override is visible only to a resource-scoped lookup. An
		// unscoped seed would see nothing here and re-grant the suppressed
		// default — this test fails on that regression.
		const folderA = makeUri("/mock/folder-a")
		workspaceState.workspaceFolders = [{ uri: folderA }]
		mockConfiguration({
			inspect: {
				key: "allowedCommands",
				defaultValue: ["git log", "git diff", "git show"],
				globalValue: undefined,
				workspaceFolderValue: ["docker"],
			},
			gate: true,
		})
		const globalState = mockMemento()

		await seedCommandList(globalState, "allowedCommands")

		// The folder layer reaches the seed only through a resource-scoped lookup.
		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, folderA)
		expect(globalState.update).not.toHaveBeenCalled()
		expect(globalState.get("allowedCommands")).toBeUndefined()
	})

	it("resolves the folder layer against the first workspace folder only", async () => {
		// Reading another folder's configuration would seed from the wrong settings file.
		const folderA = makeUri("/mock/folder-a")
		const folderB = makeUri("/mock/folder-b")
		workspaceState.workspaceFolders = [{ uri: folderA }, { uri: folderB }]
		mockConfiguration({
			inspect: {
				key: "allowedCommands",
				defaultValue: ["git log", "git diff", "git show"],
				workspaceFolderValue: ["docker"],
			},
			gate: true,
		})
		const globalState = mockMemento()

		await seedCommandList(globalState, "allowedCommands")

		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, folderA)
		expect(vscode.workspace.getConfiguration).not.toHaveBeenCalledWith(Package.name, folderB)
		expect(globalState.update).not.toHaveBeenCalled()
	})

	it("treats an explicitly empty workspace value as an override that suppresses the default", async () => {
		// Presence is checked with `undefined`, not truthiness: an empty list
		// opts out of the default as deliberately as a populated one.
		mockConfiguration({
			inspect: {
				key: "allowedCommands",
				defaultValue: ["git log", "git diff", "git show"],
				globalValue: undefined,
				workspaceValue: [],
			},
			gate: true,
		})
		const globalState = mockMemento()

		await seedCommandList(globalState, "allowedCommands")

		expect(globalState.update).not.toHaveBeenCalled()
		expect(globalState.get("allowedCommands")).toBeUndefined()
	})

	it("seeds the declared default on a fresh install with no value set at any scope", async () => {
		const defaultValue = ["git log", "git diff", "git show"]
		mockConfiguration({
			inspect: { key: "allowedCommands", defaultValue },
			effective: defaultValue,
		})
		const globalState = mockMemento()

		await seedCommandList(globalState, "allowedCommands")

		expect(globalState.update).toHaveBeenCalledExactlyOnceWith("allowedCommands", defaultValue)
		// Copy, like the global-value path: no shared reference with the configuration.
		expect(globalState.update.mock.calls[0][1]).not.toBe(defaultValue)

		// Gate on with no override: only an actual override suppresses the default.
		mockConfiguration({
			inspect: { key: "allowedCommands", defaultValue },
			effective: defaultValue,
			gate: true,
		})
		const secondGlobalState = mockMemento()

		await seedCommandList(secondGlobalState, "allowedCommands")

		expect(secondGlobalState.update).toHaveBeenCalledExactlyOnceWith("allowedCommands", defaultValue)
	})

	it("seeds from the global-scope value when global state is empty", async () => {
		mockConfiguration({ inspect: { key: "allowedCommands", globalValue: ["git"] }, effective: ["git"] })
		const globalState = mockMemento()

		await seedCommandList(globalState, "allowedCommands")

		expect(globalState.update).toHaveBeenCalledExactlyOnceWith("allowedCommands", ["git"])
		expect(globalState.get("allowedCommands")).toEqual(["git"])
	})

	it("seeds an explicitly empty global value instead of the populated default", async () => {
		// An empty global list is a deliberate opt-out: persist [] so global
		// state counts as seeded and the defaults are not re-granted.
		mockConfiguration({
			inspect: {
				key: "allowedCommands",
				defaultValue: ["git log", "git diff", "git show"],
				globalValue: [],
			},
		})
		const globalState = mockMemento()

		await seedCommandList(globalState, "allowedCommands")

		expect(globalState.update).toHaveBeenCalledExactlyOnceWith("allowedCommands", [])
		expect(globalState.get("allowedCommands")).toEqual([])
	})

	it("does not overwrite global state that is already populated", async () => {
		mockConfiguration({ inspect: { key: "allowedCommands", globalValue: ["git"] }, effective: ["git"] })
		const globalState = mockMemento(["npm"])

		await seedCommandList(globalState, "allowedCommands")

		expect(globalState.update).not.toHaveBeenCalled()
		expect(globalState.get("allowedCommands")).toEqual(["npm"])
	})

	it("leaves an explicitly empty global-state list untouched", async () => {
		// The guard checks presence, not emptiness: re-seeding a saved [] would
		// re-grant approvals the user revoked.
		mockConfiguration({ inspect: { key: "allowedCommands", defaultValue: ["git log", "git diff", "git show"] } })
		const globalState = mockMemento([])

		await seedCommandList(globalState, "allowedCommands")

		expect(globalState.update).not.toHaveBeenCalled()
		expect(globalState.get("allowedCommands")).toEqual([])
	})

	it("composes a later workspace override as a union with the seeded defaults", async () => {
		// A fresh activation seeds the default; a later workspace override is
		// never persisted (the guard early-returns). Enforcement composes the
		// two layers as a set union; the matcher picks the governing entry.
		const defaultValue = ["git log", "git diff", "git show"]
		mockConfiguration({
			inspect: { key: "allowedCommands", defaultValue },
			effective: defaultValue,
		})
		const globalState = mockMemento()

		await seedCommandList(globalState, "allowedCommands")
		expect(globalState.update).toHaveBeenCalledExactlyOnceWith("allowedCommands", defaultValue)

		// Later activation with an override present: the guard early-returns first.
		mockConfiguration({
			inspect: { key: "allowedCommands", defaultValue, workspaceValue: ["docker ps"] },
			effective: ["docker ps"],
		})

		await seedCommandList(globalState, "allowedCommands")
		expect(globalState.update).toHaveBeenCalledTimes(1)
		expect(globalState.get("allowedCommands")).toEqual(defaultValue)

		// The enforcement view keeps both layers: the override adds entries,
		// it does not replace the seeded defaults.
		const scopes = readCommandListScopes("allowedCommands", globalState.get("allowedCommands"))
		expect(scopes.global).toEqual(defaultValue)
		expect(scopes.workspace).toEqual(["docker ps"])
		expect(scopes.merged).toEqual([...defaultValue, "docker ps"])
	})

	it("inspects the global value under the extension's own section key", async () => {
		// The seed must read the extension's own section; a wrong key would
		// silently find nothing. No folder open => unscoped (section, undefined).
		mockConfiguration({ inspect: { key: "allowedCommands", globalValue: ["git"] } })
		// Complete Memento double: no type assertion at the call site.
		const globalState: vscode.Memento = {
			keys: () => [],
			get: vi.fn(),
			update: vi.fn(),
		}

		await seedCommandList(globalState, "allowedCommands")

		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, undefined)
		const config = vi.mocked(vscode.workspace.getConfiguration).mock.results[0].value
		expect(config.inspect).toHaveBeenCalledWith("allowedCommands")
		expect(globalState.update).toHaveBeenCalledExactlyOnceWith("allowedCommands", ["git"])
	})

	it("leaves global state untouched when there is no inspect result at all", async () => {
		mockConfiguration({ inspect: undefined, effective: ["git"] })
		const globalState = mockMemento()

		await seedCommandList(globalState, "allowedCommands")

		expect(globalState.update).not.toHaveBeenCalled()
	})

	it("skips the seed without throwing when configuration access fails", async () => {
		mockConfiguration({ inspectThrows: true })
		const globalState = mockMemento()

		await expect(seedCommandList(globalState, "allowedCommands")).resolves.toBeUndefined()

		expect(globalState.update).not.toHaveBeenCalled()
	})

	it("does not share a reference with the inspected configuration value", async () => {
		const globalValue = ["git"]
		mockConfiguration({ inspect: { key: "allowedCommands", globalValue } })
		const globalState = mockMemento()

		await seedCommandList(globalState, "allowedCommands")

		expect(globalState.update).toHaveBeenCalledWith("allowedCommands", expect.arrayContaining(["git"]))
		expect(globalState.update.mock.calls[0][1]).not.toBe(globalValue)
	})

	it("seeds the deny list from its settings-file global value on a fresh profile", async () => {
		// Symmetric with the allow side: enforcement reads extension state only,
		// so an unseeded deny list silently drops the user's denials.
		mockConfiguration({ inspect: { key: "deniedCommands", globalValue: ["docker"] }, effective: ["docker"] })
		const globalState = mockMemento()

		await seedCommandList(globalState, "deniedCommands")

		expect(globalState.update).toHaveBeenCalledExactlyOnceWith("deniedCommands", ["docker"])
		expect(globalState.get("deniedCommands")).toEqual(["docker"])
	})

	it("does not overwrite an existing deniedCommands global state", async () => {
		mockConfiguration({ inspect: { key: "deniedCommands", globalValue: ["docker"] }, effective: ["docker"] })
		const globalState = mockMemento(undefined, ["rm"])

		await seedCommandList(globalState, "deniedCommands")

		expect(globalState.update).not.toHaveBeenCalled()
		expect(globalState.get("deniedCommands")).toEqual(["rm"])
	})

	it("seeds the deny list when only the allow list was already seeded", async () => {
		// Per-key guards: a seeded allowlist must not block the deny migration.
		mockConfiguration({ inspect: { key: "deniedCommands", globalValue: ["docker"] }, effective: ["docker"] })
		const globalState = mockMemento(["npm"])

		await seedCommandList(globalState, "deniedCommands")

		expect(globalState.update).toHaveBeenCalledExactlyOnceWith("deniedCommands", ["docker"])
		expect(globalState.get("allowedCommands")).toEqual(["npm"])
	})

	it("seeds the declared default when a workspace value exists but the gate is off", async () => {
		// Gate off: the override governs nothing, so it must not withhold the default.
		const defaultValue = ["git log", "git diff", "git show"]
		mockConfiguration({
			inspect: {
				key: "allowedCommands",
				defaultValue,
				workspaceValue: ["docker"],
			},
			effective: ["docker"],
		})
		const globalState = mockMemento()

		await seedCommandList(globalState, "allowedCommands")

		expect(globalState.update).toHaveBeenCalledExactlyOnceWith("allowedCommands", defaultValue)
	})

	it("suppresses the declared default for a workspace value while the gate is on", async () => {
		// An enforced workspace list replaces the default, so the seed must not
		// re-grant the approvals it removed.
		mockConfiguration({
			inspect: {
				key: "allowedCommands",
				defaultValue: ["git log", "git diff", "git show"],
				workspaceValue: ["docker"],
			},
			effective: ["docker"],
			gate: true,
		})
		const globalState = mockMemento()

		await seedCommandList(globalState, "allowedCommands")

		expect(globalState.update).not.toHaveBeenCalled()
	})
})
