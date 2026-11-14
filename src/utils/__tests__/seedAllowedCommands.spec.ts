// npx vitest run utils/__tests__/seedAllowedCommands.spec.ts

import * as vscode from "vscode"

import { readCommandListScopes } from "../../core/auto-approval/commandScope"
import { Package } from "../../shared/package"
import { makeUri, makeWorkspaceConfiguration } from "../../test-utils/vscode"
import { seedCommandList } from "../seedAllowedCommands"

// Scriptable stand-in for `vscode.workspace.workspaceFolders`: the module
// mock's getter reads through this object, so a test can change the open
// folders without re-mocking the module.
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
	// Real VS Code reports `workspaceFolderValue` only for a configuration
	// looked up against a resource; an unscoped lookup reports no folder
	// layer no matter what any folder's settings contain. Scripting that
	// split per call is what lets these tests tell a scoped lookup apart
	// from an unscoped one.
	vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
		(_section?: string, scope?: vscode.ConfigurationScope | null) => {
			const config = makeWorkspaceConfiguration()
			// The shared double is scripted per call so the per-test fixture
			// values need no type assertion at the construction site. The gate
			// section reads independently of the list values: its shipped
			// default is off, so a test only gets an enforced workspace layer
			// by asking for one.
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
				// No resource to resolve against => no folder layer, matching
				// the real contract for unscoped (and explicit-null) lookups.
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

	// Structurally complete Memento double (keys/get/update), so the call
	// sites need no type assertion.
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
		// A real VS Code get() folds the workspace override into the effective
		// value, so this is the leak scenario: reading get() would seed
		// ["docker"] (from .vscode/settings.json) into global state. The
		// defaultValue mirrors real VS Code, where the declared default is
		// always present: the workspace override replaced it deliberately, so
		// re-granting it from global state is also forbidden.
		mockConfiguration({
			inspect: {
				key: "allowedCommands",
				defaultValue: ["git log", "git diff", "git show"],
				globalValue: undefined,
				workspaceValue: ["docker"],
			},
			effective: ["docker"],
			// Suppression only applies while the gate lets the workspace layer
			// take effect in enforcement.
			gate: true,
		})
		const globalState = mockMemento()

		await seedCommandList(globalState, "allowedCommands")

		expect(globalState.update).not.toHaveBeenCalled()
		expect(globalState.get("allowedCommands")).toBeUndefined()
	})

	it("leaves global state unset when only a workspace-folder-scoped value exists", async () => {
		// A folder override is visible only to a lookup resolved against that
		// folder's resource, so this fixture opens a folder and scripts the
		// folder layer (which the resource-aware double reports only for the
		// scoped call). An unscoped seed would read "no value anywhere" here
		// and re-grant the default the folder removed — this test fails on
		// that regression.
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

		// The folder layer only reaches the seed through a resource-scoped
		// lookup, so the seed must request one (same pin as the save path).
		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name, folderA)
		expect(globalState.update).not.toHaveBeenCalled()
		expect(globalState.get("allowedCommands")).toBeUndefined()
	})

	it("resolves the folder layer against the first workspace folder only", async () => {
		// Reading any other folder's configuration would silently decide the
		// seed from the wrong folder's settings file.
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
		// Presence is checked with `undefined`, not truthiness: a workspace that
		// set the list to [] opted out of the default as deliberately as one
		// that set ["docker"].
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
		// Copy, like the global-value path: global state must not share a
		// reference with the configuration object.
		expect(globalState.update.mock.calls[0][1]).not.toBe(defaultValue)

		// A later activation with the gate on but still no workspace-scoped
		// value: only an actual override suppresses the default, so the gate
		// alone must not withhold it.
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
		// An explicitly empty global list is a deliberate opt-out: the seed
		// persists [] so global state counts as seeded, rather than treating
		// the empty allowlist as unset and re-granting the declared defaults.
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
		// The guard treats presence, not emptiness: saving [] is a deliberate
		// choice to auto-approve nothing, and re-seeding the package default
		// would silently re-grant the approvals the user just revoked.
		mockConfiguration({ inspect: { key: "allowedCommands", defaultValue: ["git log", "git diff", "git show"] } })
		const globalState = mockMemento([])

		await seedCommandList(globalState, "allowedCommands")

		expect(globalState.update).not.toHaveBeenCalled()
		expect(globalState.get("allowedCommands")).toEqual([])
	})

	it("composes a later workspace override as a union with the seeded defaults", async () => {
		// Full schedule: a fresh activation seeds the declared default, then a
		// workspace override appears in a later activation. The seed
		// early-returns because global state already holds a list, so the
		// override is never persisted — and the enforcement read composes the
		// two layers as a set union. Neither list replaces the other; the
		// longest-prefix matcher decides which entry governs a given command.
		const defaultValue = ["git log", "git diff", "git show"]
		mockConfiguration({
			inspect: { key: "allowedCommands", defaultValue },
			effective: defaultValue,
		})
		const globalState = mockMemento()

		await seedCommandList(globalState, "allowedCommands")
		expect(globalState.update).toHaveBeenCalledExactlyOnceWith("allowedCommands", defaultValue)

		// A later activation in a workspace whose settings file sets the list:
		// the guard early-returns before any inspection, so no second write.
		mockConfiguration({
			inspect: { key: "allowedCommands", defaultValue, workspaceValue: ["docker ps"] },
			effective: ["docker ps"],
		})

		await seedCommandList(globalState, "allowedCommands")
		expect(globalState.update).toHaveBeenCalledTimes(1)
		expect(globalState.get("allowedCommands")).toEqual(defaultValue)

		// The enforcement view (ClineProvider.getState) keeps both layers and
		// merges them: the override adds entries, it does not replace the
		// seeded defaults, and vice versa.
		const scopes = readCommandListScopes("allowedCommands", globalState.get("allowedCommands"))
		expect(scopes.global).toEqual(defaultValue)
		expect(scopes.workspace).toEqual(["docker ps"])
		expect(scopes.merged).toEqual([...defaultValue, "docker ps"])
	})

	it("inspects the global value under the extension's own section key", async () => {
		// The seed must read the extension's own section; asking VS Code about
		// a different (or empty) section key would silently never find the
		// user's global list. With no folder open there is no resource to
		// scope against, so the explicit unscoped call is (section, undefined).
		mockConfiguration({ inspect: { key: "allowedCommands", globalValue: ["git"] } })
		// Structurally complete Memento double (keys/get/update), so the call
		// site needs no type assertion.
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
		// Symmetric with the allow side: a user-level `deniedCommands` edit in
		// settings.json has a one-time migration role, and the enforcement
		// global layer reads extension state only, so an unseeded deny list
		// silently drops the user's denials.
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
		// Per-key guards: an install whose allowlist was seeded by an earlier
		// version must still get the deny migration on the next activation.
		mockConfiguration({ inspect: { key: "deniedCommands", globalValue: ["docker"] }, effective: ["docker"] })
		const globalState = mockMemento(["npm"])

		await seedCommandList(globalState, "deniedCommands")

		expect(globalState.update).toHaveBeenCalledExactlyOnceWith("deniedCommands", ["docker"])
		expect(globalState.get("allowedCommands")).toEqual(["npm"])
	})

	it("seeds the declared default when a workspace value exists but the gate is off", async () => {
		// With the gate off the workspace layer contributes nothing to
		// enforcement, so withholding the default would leave commands
		// unapproved that the override never actually governed.
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
		// Pins the explicit-override semantics: an enforced workspace list
		// replaces the default across scopes, so the seed must not re-grant
		// the approvals the override removed.
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
