import { WebviewFocusTracker } from "../WebviewFocusTracker"
// pnpm --dir src exec vitest run --config vitest.core.config.ts core/webview/__tests__/ClineProvider.persistedViewState.spec.ts

import * as vscode from "vscode"
import { makeCompositeDisposable } from "../../../test-utils/vscode"

import { TelemetryService } from "@roo-code/telemetry"
import type { GlobalState, ModeConfig } from "@roo-code/types"

import { ContextProxy } from "../../config/ContextProxy"
import { ClineProvider } from "../ClineProvider"

// Mock setup
vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(""),
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../utils/storage", () => ({
	getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	getGlobalStoragePath: vi.fn().mockResolvedValue("/test/storage/path"),
}))

vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("delay", () => {
	const delayFn = (_ms: number) => Promise.resolve()
	delayFn.createDelay = delayFn
	delayFn.reject = delayFn
	delayFn.range = delayFn
	return { default: delayFn }
})

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Disposable: { from: (...subscriptions: vscode.Disposable[]) => makeCompositeDisposable(...subscriptions) },
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => {
			return {
				dispose: vi.fn(),
			}
		}),
	},
	env: {
		uriScheme: "vscode",
		language: "en",
		appName: "Visual Studio Code",
	},
	extensions: {
		all: [],
	},
	ExtensionMode: {
		Production: 1,
		Development: 2,
		Test: 3,
	},
	version: "1.85.0",
}))

vi.mock("../../../utils/tts", () => ({
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
}))

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(),
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => {
	return {
		default: vi.fn().mockImplementation(function () {
			return {
				initializeFilePaths: vi.fn(),
				dispose: vi.fn(),
			}
		}),
	}
})

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(() => ({
		taskId: "mock-task-id",
		instanceId: "mock-instance-id",
		abortTask: vi.fn().mockResolvedValue(undefined),
		emit: vi.fn(),
	})),
}))

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return {
				isAuthenticated: vi.fn().mockReturnValue(false),
				off: vi.fn(),
			}
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://app.roocode.com"),
}))

vi.mock("../../../integrations/theme/getTheme", () => ({
	getTheme: vi.fn().mockResolvedValue({ kind: "dark" }),
}))

vi.mock("../webviewMessageHandler", () => ({
	webviewMessageHandler: vi.fn().mockResolvedValue(undefined),
}))

type PersistedEntry = NonNullable<GlobalState["viewStates"]>[string]
type ViewStates = Record<string, PersistedEntry>

describe("ClineProvider - persisted view state write ordering", () => {
	let provider: ClineProvider
	let durable: Record<string, unknown>
	let failNextViewStatesWrite = false
	let mockContext: vscode.ExtensionContext
	// The durable profile value the storage double held at the instant the per-view write
	// rejected, so a test can tell a shared write that reached storage from one that only
	// moved the in-memory cache.
	let durableProfileAtViewWriteFailure: unknown
	let mockOutputChannel: vscode.OutputChannel

	// The tombstone set and the write queue are per-class, so every test starts from an
	// empty ledger: otherwise a ledger entry from the previous test reads as a failure
	// of this one.
	const tombstones = () => ClineProvider["clearedViewStateIds"]
	const evictions = () => provider["prunedViewIdsDuringActivation"]
	// One cast: the durable double stores every key as unknown, and the only reader
	// here is the viewStates map this suite seeds.
	const viewStates = () => durable["viewStates"] as ViewStates | undefined

	beforeEach(() => {
		vi.clearAllMocks()
		failNextViewStatesWrite = false
		durableProfileAtViewWriteFailure = undefined

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		durable = { mode: "code", currentApiConfigName: "test-config", viewStates: {} }

		const secrets: Record<string, string | undefined> = {}

		// Structural double providing only the storage members ClineProvider and ContextProxy
		// read. The viewStates update rejects once per armed test, which is how a durable
		// write failure is modelled: the in-memory cache is still updated first.
		const globalState: Record<string, unknown> = durable
		const update = vi.fn((key: string, value: unknown) => {
			if (key === "viewStates" && failNextViewStatesWrite) {
				failNextViewStatesWrite = false
				durableProfileAtViewWriteFailure = globalState["currentApiConfigName"]
				return Promise.reject(new Error("durable write failed"))
			}
			globalState[key] = value
			return Promise.resolve()
		})
		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" },
			globalState: {
				get: vi.fn((key: string) => globalState[key]),
				update,
				keys: vi.fn(() => Object.keys(globalState)),
			},
			secrets: {
				get: vi.fn((key: string) => secrets[key]),
				store: vi.fn((key: string, value: string | undefined) => {
					secrets[key] = value
					return Promise.resolve()
				}),
				delete: vi.fn((key: string) => {
					delete secrets[key]
					return Promise.resolve()
				}),
			},
			workspaceState: {
				get: vi.fn(() => undefined),
				update: vi.fn(() => Promise.resolve()),
				keys: vi.fn(() => []),
			},
			subscriptions: [],
			extension: { packageJSON: { version: "1.0.0" } },
			globalStorageUri: { fsPath: "/test/storage/path" },
		} as unknown as vscode.ExtensionContext

		// Structural double providing only the logging members ClineProvider calls.
		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		tombstones().clear()
		ClineProvider["persistedViewStateWriteQueue"] = Promise.resolve()

		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)
	})

	afterEach(async () => {
		await provider.dispose()
	})

	test("records no tombstone when the write that clears an entry rejects", async () => {
		const viewStateId = provider["viewId"]
		durable["viewStates"] = {
			[viewStateId]: { mode: "code", currentApiConfigName: "profile-a", updatedAt: 1 },
		}
		failNextViewStatesWrite = true

		await expect(
			provider["savePersistedViewState"]({ mode: undefined, currentApiConfigName: undefined }),
		).rejects.toThrow("durable write failed")

		// The map on disk still holds the entry, so the tombstone that would tell a later
		// activation to skip it was never earned.
		expect(tombstones().has(viewStateId)).toBe(false)
		expect(Object.hasOwn(viewStates() ?? {}, viewStateId)).toBe(true)
		expect(evictions()).toEqual([])
	})

	test("records the tombstone once the clearing write lands, and lifts it on the next landing write", async () => {
		const viewStateId = provider["viewId"]
		durable["viewStates"] = {
			[viewStateId]: { mode: "code", currentApiConfigName: "profile-a", updatedAt: 1 },
		}

		await provider["savePersistedViewState"]({ mode: undefined, currentApiConfigName: undefined })

		expect(tombstones().has(viewStateId)).toBe(true)
		expect(Object.hasOwn(viewStates() ?? {}, viewStateId)).toBe(false)

		await provider["savePersistedViewState"]({ mode: "code", currentApiConfigName: "profile-a" })

		expect(tombstones().has(viewStateId)).toBe(false)
		expect(viewStates()?.[viewStateId]?.mode).toBe("code")
	})

	test("records evictions only for the map that reached durable storage", async () => {
		// The cap keeps the 50 most recent closed-view entries, so 52 seeded entries evict
		// the two oldest while the live view's own entry is never aged out.
		const viewStateId = provider["viewId"]
		const seeded: ViewStates = {
			[viewStateId]: { mode: "code", currentApiConfigName: "profile-a", updatedAt: 100 },
		}
		for (let index = 0; index < 52; index++) {
			seeded[`closed-${index}`] = { mode: "code", currentApiConfigName: "profile-a", updatedAt: index }
		}
		durable["viewStates"] = seeded
		failNextViewStatesWrite = true

		await expect(provider["savePersistedViewState"]({ currentApiConfigName: "profile-b" })).rejects.toThrow(
			"durable write failed",
		)

		expect(evictions()).toEqual([])
		expect(tombstones().size).toBe(0)

		await provider["savePersistedViewState"]({ mode: "code", currentApiConfigName: "profile-b" })

		expect(evictions()).toEqual(["closed-0", "closed-1"])
		expect(Object.hasOwn(viewStates() ?? {}, "closed-0")).toBe(false)
	})

	test("leaves an entry this view never wrote under its temporary id", async () => {
		// Temporary ids restart from 0 on every host start, so this entry can belong to an
		// earlier session: re-keying it would adopt another session's pinned profile.
		const tempId = provider["viewId"]
		durable["viewStates"] = {
			[tempId]: { mode: "plan", currentApiConfigName: "profile-a", updatedAt: 5 },
		}

		await provider["rekeyPersistedViewStateEntry"]("stable-view")

		expect(Object.hasOwn(viewStates() ?? {}, tempId)).toBe(true)
		expect(Object.hasOwn(viewStates() ?? {}, "stable-view")).toBe(false)
		expect(tombstones().has(tempId)).toBe(false)
		expect(provider["wroteUnderTemporaryViewStateId"]).toBe(false)
	})

	test("re-keys an entry this view wrote under its temporary id", async () => {
		const tempId = provider["viewId"]

		await provider["savePersistedViewState"]({ mode: "code", currentApiConfigName: "profile-a" })

		expect(provider["wroteUnderTemporaryViewStateId"]).toBe(true)
		expect(Object.hasOwn(viewStates() ?? {}, tempId)).toBe(true)

		await provider["rekeyPersistedViewStateEntry"]("stable-view")

		expect(Object.hasOwn(viewStates() ?? {}, "stable-view")).toBe(true)
		expect(Object.hasOwn(viewStates() ?? {}, tempId)).toBe(false)
		expect(viewStates()?.["stable-view"]?.currentApiConfigName).toBe("profile-a")
		expect(tombstones().has(tempId)).toBe(true)
		expect(tombstones().has("stable-view")).toBe(false)
		expect(provider["wroteUnderTemporaryViewStateId"]).toBe(false)
	})

	test("records no tombstone when the re-key write rejects", async () => {
		const tempId = provider["viewId"]

		await provider["savePersistedViewState"]({ mode: "code", currentApiConfigName: "profile-a" })
		failNextViewStatesWrite = true

		await expect(provider["rekeyPersistedViewStateEntry"]("stable-view")).rejects.toThrow("durable write failed")

		// The entry is still under the temporary name, so the next registration must be able
		// to re-key it: recording the tombstone pair here would make the retry skip it.
		expect(tombstones().size).toBe(0)
		expect(Object.hasOwn(viewStates() ?? {}, tempId)).toBe(true)
		expect(Object.hasOwn(viewStates() ?? {}, "stable-view")).toBe(false)
		expect(provider["wroteUnderTemporaryViewStateId"]).toBe(true)
	})

	// Every reject path in setViewStateId stops before a write, so the assertions are about the id
	// this provider ends up holding and the map on disk, not about which log line it emitted.
	const rejectedViewIds: { label: string; value: string | undefined }[] = [
		{ label: "a non-string id", value: undefined },
		{ label: "an Object.prototype member name", value: "__proto__" },
		{
			label: "an id longer than the bound",
			value: "v".repeat(ClineProvider["MAX_VIEW_STATE_ID_LENGTH"] + 6),
		},
	]

	it.each(rejectedViewIds)(
		"refuses $label through the public setter and writes nothing durable",
		async ({ value }) => {
			const initialId = provider["viewStateId"]

			await provider.setViewStateId(value)

			expect(provider["viewStateId"]).toBe(initialId)
			expect(viewStates()).toEqual({})
			expect(tombstones().size).toBe(0)
		},
	)

	test("refuses a view id another live view already claimed", async () => {
		const initialId = provider["viewStateId"]
		const other = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)
		other["viewStateId"] = "shared-view-id"

		try {
			expect(ClineProvider.getAllInstances()).toContain(other)

			await provider.setViewStateId("shared-view-id")

			// Staying on the temporary id is the whole refusal: adopting the claimant's id would
			// load that view's pinned profile into this provider and let this webview overwrite
			// that view's persisted entry.
			expect(provider["viewStateId"]).toBe(initialId)
			expect(other["viewStateId"]).toBe("shared-view-id")
			expect(viewStates()).toEqual({})
		} finally {
			await other.dispose()
		}
	})

	test("adopts a valid id through the public setter and re-keys the entry this view wrote", async () => {
		const tempId = provider["viewId"]
		const stableId = "11111111-1111-4111-8111-111111111111"
		// Registering an id ends with a load, and that load reads the custom-modes registry.
		// Stubbing the registry read keeps this test about adoption and re-keying rather than
		// about what the mode file happens to contain.
		vi.spyOn(provider.customModesManager, "getCustomModes").mockResolvedValue([])

		await provider["savePersistedViewState"]({ mode: "code", currentApiConfigName: "profile-a" })

		await provider.setViewStateId(stableId)

		expect(provider["viewStateId"]).toBe(stableId)
		expect(viewStates()?.[stableId]?.currentApiConfigName).toBe("profile-a")
		expect(Object.hasOwn(viewStates() ?? {}, tempId)).toBe(false)
		expect(tombstones().has(tempId)).toBe(true)
		expect(tombstones().has(stableId)).toBe(false)
		expect(provider["wroteUnderTemporaryViewStateId"]).toBe(false)
	})

	test("keeps a mode slug only while the custom-modes registry knows it", async () => {
		const viewStateId = provider["viewId"]
		const getCustomModes = vi.spyOn(provider.customModesManager, "getCustomModes").mockResolvedValue([])
		const customMode: ModeConfig = {
			slug: "custom-review",
			name: "Custom Review",
			roleDefinition: "Review role",
			groups: ["read"],
		}

		// Captured rather than assumed: the proxy seeds its cache from the double's storage, and
		// this suite only needs the dropped slug to leave the shared value where it started.
		const before = provider.contextProxy.getValue("mode")

		await provider.setValues({ mode: "custom-review" })

		// The mode gate runs before anything is forwarded, so a slug the registry does not know
		// must reach neither the shared store nor this view's persisted entry.
		expect(provider.contextProxy.getValue("mode")).toBe(before)
		expect(viewStates()?.[viewStateId]?.mode).toBeUndefined()

		getCustomModes.mockResolvedValue([customMode])

		await provider.setValues({ mode: "custom-review" })

		expect(provider.contextProxy.getValue("mode")).toBe("custom-review")
		expect(viewStates()?.[viewStateId]?.mode).toBe("custom-review")
	})

	test("restores the shared value and rethrows when the per-view write fails", async () => {
		const viewStateId = provider["viewId"]

		await provider.setValues({ currentApiConfigName: "profile-a" })
		failNextViewStatesWrite = true

		await expect(provider.setValues({ currentApiConfigName: "profile-b" })).rejects.toThrow("durable write failed")

		// The shared store already carried the new name when the per-view record failed, so it is
		// rolled back to the value this call started from instead of being left ahead of the
		// durable per-view record.
		expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("profile-a")
		expect(viewStates()?.[viewStateId]?.currentApiConfigName).toBe("profile-a")
	})

	test("leaves the shared profile unset and creates no entry when the first per-view write fails", async () => {
		const viewStateId = provider["viewId"]

		// Cold state: this profile was never chosen, so there is no earlier value to roll back to.
		// Unset through the same store the provider reads, so the proxy cache and storage agree
		// that the key is unset before the call starts instead of merely disagreeing about it.
		await provider.contextProxy.setValue("currentApiConfigName", undefined)
		expect(provider.contextProxy.getValue("currentApiConfigName")).toBeUndefined()

		failNextViewStatesWrite = true

		await expect(provider.setValues({ currentApiConfigName: "profile-a" })).rejects.toThrow("durable write failed")

		// The shared write landed before the per-view write was attempted: the double held
		// "profile-a" in storage at the instant of the failure, so what follows is a rollback of
		// a value that really moved, not a no-op over a key that never left the cache.
		expect(durableProfileAtViewWriteFailure).toBe("profile-a")

		// A rollback here has no earlier name to restore: the only correct outcomes are that the
		// shared key stays unset in storage and not only in the cache this call reads back, that
		// no per-view entry was created for the write that failed, that the view-local buffer
		// never took the profile because it is advanced only after the durable write lands, and
		// that the ledger stayed empty because nothing was ever cleared from storage.
		expect(provider.contextProxy.getValue("currentApiConfigName")).toBeUndefined()
		expect(durable["currentApiConfigName"]).toBeUndefined()
		expect(Object.hasOwn(viewStates() ?? {}, viewStateId)).toBe(false)
		expect(Object.hasOwn(provider["viewLocalState"], "currentApiConfigName")).toBe(false)
		expect(tombstones().size).toBe(0)
	})
})
