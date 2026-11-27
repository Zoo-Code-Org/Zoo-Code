// npx vitest run __tests__/ClineProvider.restore-follows-active-profile.spec.ts
//
// Issue #970: the task header's context window stays on the old provider after a
// stop -> switch provider -> restore flow, and the usage bar can exceed 100%.
// Root cause on this path: ClineProvider.createTaskWithHistoryItemUnlocked
// re-activates the profile pinned in HistoryItem.apiConfigName even when the user
// has switched to a different profile while the task was stopped, so the restored
// task and the header keep the old provider's context window.
//
// Failure sentences these tests prevent:
// 1. Restoring a task re-activates a stale pinned profile that differs from the
//    user's active profile, so the resumed task keeps the old provider's limits.
// 2. The history item keeps pinning a profile that is not in effect for the
//    restored task, so every later restore flips the configuration back.
// 3. A restore whose pinned profile no longer exists loses the re-pin to the
//    profile that is actually in effect.
// 4. The restored task is built with settings that do not follow the profile in
//    effect after activation (a stale provider/model would keep the old context
//    window even with a correct pin).
// 5. A restore whose currentApiConfigName does not resolve in the profile list
//    loses the legacy reactivation of the still-existing pinned profile.
// 6. A failed pin write aborts the restore after the previous task was already
//    evicted, so the task cannot be resumed at all.
// 7. The re-pinned record mutates the store-owned cached item, so the store's
//    delta compare drops apiConfigName and the stale pin survives on disk.
// 8. A restore whose pinned profile exists but carries no configured provider
//    settings logs the deleted-profile warning, so the log misreports the state.
//
// Red-verify: tests 1 and 3 fail on pre-fix code because the restore block
// activates the stale pin unconditionally. Test 6 fails because the rejected
// updateTaskHistory await escapes before the Task is constructed. Test 7 fails
// because the mutated cache makes the store persist the old pin.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { providerIdentifiers } from "@roo-code/types"
import type { HistoryItem } from "@roo-code/types"

/* vscode mock for Task/Provider imports */
vi.mock("vscode", () => {
	const window = {
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	}
	const workspace = {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
			update: vi.fn(),
		})),
		workspaceFolders: [],
	}
	const env = { machineId: "test-machine", uriScheme: "vscode", appName: "VSCode", language: "en", sessionId: "sess" }
	const Uri = { file: (p: string) => ({ fsPath: p, toString: () => p }) }
	const commands = { executeCommand: vi.fn() }
	const ExtensionMode = { Development: 2 }
	const version = "1.0.0-test"
	return { window, workspace, env, Uri, commands, ExtensionMode, version }
})

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTaskCompleted: vi.fn(),
		},
	},
}))

vi.mock("../core/task-persistence/taskMessages", () => ({
	readTaskMessages: vi.fn().mockResolvedValue([]),
}))

vi.mock("../core/task-persistence", async (importOriginal) => {
	const real = await importOriginal<typeof import("../core/task-persistence")>()
	return {
		...real,
		readApiMessages: vi.fn().mockResolvedValue([]),
		saveApiMessages: vi.fn(async ({ messages }: { messages: unknown[] }) => messages),
		saveTaskMessages: vi.fn(async ({ messages }: { messages: unknown[] }) => messages),
	}
})

// The tail of createTaskWithHistoryItemUnlocked constructs a real Task. Replace it
// with a recording double so the test can observe the history item and the API
// configuration the restored task is built from without booting the whole task
// runtime.
vi.mock("../core/task/Task", async (importOriginal) => {
	const real = await importOriginal<typeof import("../core/task/Task")>()
	// A regular (non-arrow) function so `new Task(...)` constructs the double.
	const TaskDouble = vi.fn(function TaskDoubleMock(this: Record<string, unknown>, _options: unknown) {
		this.taskId = "restored-task"
		this.instanceId = "instance-1"
		this.parentTask = undefined
		this.abortTask = vi.fn(async () => {})
		this.emit = vi.fn()
		this.clineMessages = []
		this.apiConversationHistory = []
	})
	return { ...real, Task: TaskDouble }
})

import { ClineProvider } from "../core/webview/ClineProvider"
import { Task } from "../core/task/Task"
import { TaskHistoryStore } from "../core/task-persistence/TaskHistoryStore"
import { makeProviderStub } from "./helpers/provider-stub"

function makeHistoryItem(apiConfigName: string): HistoryItem {
	return {
		id: "task-1",
		number: 1,
		ts: 1700000000000,
		task: "summarize the repository",
		tokensIn: 100,
		tokensOut: 20,
		totalCost: 0.01,
		apiConfigName,
	} satisfies HistoryItem
}

type ProfileEntry = { name: string; apiProvider?: string }

interface RestoreHarnessOptions {
	profiles: ProfileEntry[]
	/** Value reported for the currentApiConfigName global (may be absent from `profiles`). */
	activeProfileName: string | undefined
	/** Real store to read history through and to persist with the real updateTaskHistory. */
	taskHistoryStore?: TaskHistoryStore
}

function makeRestoreHarness(options: RestoreHarnessOptions) {
	const listConfig = vi.fn(async () => options.profiles)
	const getGlobalState = vi.fn((key: string) =>
		key === "currentApiConfigName" ? options.activeProfileName : undefined,
	)
	// Activation switches the settings getState observes, mirroring the real
	// contract: after activateProviderProfile, getState reports the activated
	// profile's provider and model.
	let effectiveProfile = options.activeProfileName
	const activateProviderProfile = vi.fn(async ({ name }: { name: string }) => {
		effectiveProfile = name
	})
	const log = vi.fn()
	const updateTaskHistoryMock = vi.fn(async () => [])
	const getState = vi.fn(async () => {
		const settings = options.profiles.find((profile) => profile.name === effectiveProfile)
		return {
			apiConfiguration: {
				apiProvider: settings?.apiProvider ?? providerIdentifiers.openrouter,
				apiModelId: settings ? `model-of-${settings.name}` : "model-of-unresolved",
			},
			enableCheckpoints: false,
			checkpointTimeout: 10,
			experiments: {},
			diffFuzzyThreshold: 0.8,
		}
	})

	const provider = makeProviderStub({ contextProxy: { globalStorageUri: { fsPath: "/tmp" } } })

	Object.assign(provider, {
		getState,
		log,
		updateGlobalState: vi.fn(async () => {}),
		getGlobalState,
		activateProviderProfile,
		updateTaskHistory: options.taskHistoryStore ? ClineProvider.prototype.updateTaskHistory : updateTaskHistoryMock,
		taskHistoryStore: options.taskHistoryStore ?? { get: () => undefined, invalidate: async () => {} },
		providerSettingsManager: { listConfig },
		addClineToStack: vi.fn(async () => {}),
		getPendingEditOperation: vi.fn(() => undefined),
		taskCreationCallback: vi.fn(),
		getCurrentTask: vi.fn(() => undefined),
		evictCurrentTask: vi.fn(async () => {}),
	})

	const createTaskWithHistoryItemUnlocked = (
		ClineProvider.prototype as unknown as {
			createTaskWithHistoryItemUnlocked: (
				this: unknown,
				historyItem: HistoryItem,
				options?: { startTask?: boolean },
			) => Promise<unknown>
		}
	).createTaskWithHistoryItemUnlocked

	const runRestore = (historyItem: HistoryItem) =>
		createTaskWithHistoryItemUnlocked.call(provider, historyItem, { startTask: false })

	return {
		runRestore,
		activateProviderProfile,
		updateTaskHistory: updateTaskHistoryMock,
		listConfig,
		getGlobalState,
		log,
	}
}

function constructedTaskConfig():
	{ historyItem?: HistoryItem; apiConfiguration?: Record<string, unknown> } | undefined {
	const firstCall = vi.mocked(Task).mock.calls[0]?.[0] as
		{ historyItem?: HistoryItem; apiConfiguration?: Record<string, unknown> } | undefined
	return firstCall
}

function constructedHistoryItem(): HistoryItem | undefined {
	return constructedTaskConfig()?.historyItem
}

describe("ClineProvider restore follows the active profile", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("keeps the active profile when it differs from the stale pin and re-pins the task to it", async () => {
		const harness = makeRestoreHarness({
			profiles: [
				{ name: "provider-1", apiProvider: providerIdentifiers.anthropic },
				{ name: "provider-2", apiProvider: providerIdentifiers.openrouter },
			],
			activeProfileName: "provider-2",
		})

		await harness.runRestore(makeHistoryItem("provider-1"))

		expect(harness.activateProviderProfile).not.toHaveBeenCalled()
		expect(harness.updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({ id: "task-1", apiConfigName: "provider-2" }),
		)
		expect(constructedHistoryItem()?.apiConfigName).toBe("provider-2")
		// The re-pin decision must be visible in the log with both names: the
		// active profile that stays in effect and the stale pin it replaces.
		expect(harness.log).toHaveBeenCalledWith(
			"Restoring task task-1 with active profile 'provider-2' instead of stale pinned profile 'provider-1'.",
		)
		// The restored task must run on the active profile's settings, not the stale
		// pin's provider/model.
		expect(constructedTaskConfig()?.apiConfiguration).toStrictEqual({
			apiProvider: providerIdentifiers.openrouter,
			apiModelId: "model-of-provider-2",
		})
	})

	it("re-activates the pinned profile when it is still the active one", async () => {
		const harness = makeRestoreHarness({
			profiles: [{ name: "provider-1", apiProvider: providerIdentifiers.anthropic }],
			activeProfileName: "provider-1",
		})

		await harness.runRestore(makeHistoryItem("provider-1"))

		expect(harness.activateProviderProfile).toHaveBeenCalledWith(
			{ name: "provider-1" },
			expect.objectContaining({ persistTaskHistory: false }),
		)
		expect(harness.updateTaskHistory).not.toHaveBeenCalled()
		expect(constructedHistoryItem()?.apiConfigName).toBe("provider-1")
		// After the re-activation the restored task must run on the activated
		// profile's provider and model.
		expect(constructedTaskConfig()?.apiConfiguration).toStrictEqual({
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "model-of-provider-1",
		})
	})

	it("re-pins to the active profile when the pinned profile no longer exists", async () => {
		const harness = makeRestoreHarness({
			profiles: [{ name: "provider-2", apiProvider: providerIdentifiers.openrouter }],
			activeProfileName: "provider-2",
		})

		await harness.runRestore(makeHistoryItem("deleted-profile"))

		expect(harness.activateProviderProfile).not.toHaveBeenCalled()
		expect(harness.updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({ id: "task-1", apiConfigName: "provider-2" }),
		)
		expect(constructedHistoryItem()?.apiConfigName).toBe("provider-2")
		expect(constructedTaskConfig()?.apiConfiguration).toStrictEqual({
			apiProvider: providerIdentifiers.openrouter,
			apiModelId: "model-of-provider-2",
		})
	})

	it("re-activates the pin when no resolvable active profile exists", async () => {
		const harness = makeRestoreHarness({
			profiles: [{ name: "provider-1", apiProvider: providerIdentifiers.anthropic }],
			activeProfileName: undefined,
		})

		await harness.runRestore(makeHistoryItem("provider-1"))

		expect(harness.activateProviderProfile).toHaveBeenCalledWith(
			{ name: "provider-1" },
			expect.objectContaining({ persistTaskHistory: false }),
		)
		expect(harness.updateTaskHistory).not.toHaveBeenCalled()
		expect(constructedHistoryItem()?.apiConfigName).toBe("provider-1")
		// The activation must be what the observed settings follow: with no active
		// profile at restore time only the re-activated pin can supply provider/model.
		expect(constructedTaskConfig()?.apiConfiguration).toStrictEqual({
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "model-of-provider-1",
		})
	})

	it("re-activates the existing pinned profile when currentApiConfigName is absent from the profile list", async () => {
		// Regression-evidence case: the active name is a dangling pointer, the pin
		// still exists. Legacy fallback re-activates the pin and must not write.
		const harness = makeRestoreHarness({
			profiles: [{ name: "provider-1", apiProvider: providerIdentifiers.anthropic }],
			activeProfileName: "ghost-profile",
		})

		await harness.runRestore(makeHistoryItem("provider-1"))

		expect(harness.activateProviderProfile).toHaveBeenCalledWith(
			{ name: "provider-1" },
			expect.objectContaining({ persistTaskHistory: false }),
		)
		expect(harness.updateTaskHistory).not.toHaveBeenCalled()
		expect(constructedHistoryItem()?.apiConfigName).toBe("provider-1")
		expect(constructedTaskConfig()?.apiConfiguration).toStrictEqual({
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "model-of-provider-1",
		})
	})

	it("continues the restore when the pin write rejects", async () => {
		const harness = makeRestoreHarness({
			profiles: [
				{ name: "provider-1", apiProvider: providerIdentifiers.anthropic },
				{ name: "provider-2", apiProvider: providerIdentifiers.openrouter },
			],
			activeProfileName: "provider-2",
		})
		harness.updateTaskHistory.mockRejectedValueOnce(new Error("simulated pin-write failure"))

		// The previous task is already evicted at this point; the restore must not
		// fail, and the task must still be constructed with the refreshed pin and
		// the active configuration.
		await expect(harness.runRestore(makeHistoryItem("provider-1"))).resolves.toBeDefined()

		expect(vi.mocked(Task).mock.calls.length).toBe(1)
		expect(constructedHistoryItem()?.apiConfigName).toBe("provider-2")
		expect(constructedTaskConfig()?.apiConfiguration).toStrictEqual({
			apiProvider: providerIdentifiers.openrouter,
			apiModelId: "model-of-provider-2",
		})
		expect(harness.log).toHaveBeenCalledWith(
			expect.stringContaining("Failed to persist re-pinned profile 'provider-2'"),
		)
	})

	it("persists the refreshed pin through the real TaskHistoryStore", async () => {
		// Persistence-integrity case: the restore must re-pin the STORE-OWNED record
		// without mutating the cached item in place (an in-place mutation would make
		// the store's delta compare drop apiConfigName, leaving the stale pin on
		// disk). The disk file is the oracle.
		const storageRoot = await mkdtemp(join(tmpdir(), "zoo-970-store-"))
		try {
			const store = new TaskHistoryStore(storageRoot)
			await store.upsert(makeHistoryItem("provider-1"))
			// Route the store-cached object through the restore, exactly as the
			// history-navigation callers do.
			const cached = store.get("task-1")
			expect(cached?.apiConfigName).toBe("provider-1")

			const harness = makeRestoreHarness({
				profiles: [
					{ name: "provider-1", apiProvider: providerIdentifiers.anthropic },
					{ name: "provider-2", apiProvider: providerIdentifiers.openrouter },
				],
				activeProfileName: "provider-2",
				taskHistoryStore: store,
			})

			await harness.runRestore(cached as HistoryItem)

			const disk = JSON.parse(
				await readFile(join(storageRoot, "tasks", "task-1", "history_item.json"), "utf8"),
			) as HistoryItem
			expect(disk.apiConfigName).toBe("provider-2")
			// The cache is updated by the store's own write path, not by the restore.
			expect(store.get("task-1")?.apiConfigName).toBe("provider-2")
		} finally {
			await rm(storageRoot, { recursive: true, force: true })
		}
	})

	it("does not warn about a deleted profile when the pinned profile exists without a configured provider", async () => {
		// The pinned profile exists but carries no apiProvider settings: the
		// reactivation branch skips activation, and the restore must fall through
		// without the deleted-profile warning. That warning is reserved for a pin
		// whose profile is absent from the list.
		const harness = makeRestoreHarness({
			profiles: [{ name: "provider-1" }],
			activeProfileName: undefined,
		})

		await expect(harness.runRestore(makeHistoryItem("provider-1"))).resolves.toBeDefined()

		expect(harness.activateProviderProfile).not.toHaveBeenCalled()
		expect(harness.updateTaskHistory).not.toHaveBeenCalled()
		expect(harness.log).not.toHaveBeenCalledWith(expect.stringContaining("no longer exists"))
	})
})
