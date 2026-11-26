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
//
// Red-verify: tests 1 and 3 fail on pre-fix code because the restore block
// activates the stale pin unconditionally.

import { describe, it, expect, vi, beforeEach } from "vitest"
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
// with a recording double so the test can observe the history item the restored
// task is built from without booting the whole task runtime.
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

function makeRestoreHarness(options: { profiles: ProfileEntry[]; activeProfileName: string | undefined }) {
	const listConfig = vi.fn(async () => options.profiles)
	const getGlobalState = vi.fn((key: string) =>
		key === "currentApiConfigName" ? options.activeProfileName : undefined,
	)
	const activateProviderProfile = vi.fn(async () => {})
	const updateTaskHistory = vi.fn(async () => [])

	const provider = makeProviderStub({ contextProxy: { globalStorageUri: { fsPath: "/tmp" } } })

	Object.assign(provider, {
		getState: vi.fn(async () => ({
			apiConfiguration: { apiProvider: providerIdentifiers.openrouter },
			enableCheckpoints: false,
			checkpointTimeout: 10,
			experiments: {},
			diffFuzzyThreshold: 0.8,
		})),
		updateGlobalState: vi.fn(async () => {}),
		getGlobalState,
		activateProviderProfile,
		updateTaskHistory,
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

	return { runRestore, activateProviderProfile, updateTaskHistory, listConfig, getGlobalState }
}

function constructedHistoryItem(): HistoryItem | undefined {
	const firstCall = vi.mocked(Task).mock.calls[0]?.[0] as { historyItem?: HistoryItem } | undefined
	return firstCall?.historyItem
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
	})
})
