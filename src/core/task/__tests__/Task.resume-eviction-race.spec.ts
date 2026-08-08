// cd src && npx vitest run core/task/__tests__/Task.resume-eviction-race.spec.ts
//
// Regression anchor for the "Work #1 (no message)" title-clobber bug
// (Zoo Code v3.76.0, Discord report 2026-08-06).
//
// Root cause: resumeTaskFromHistory() starts with an async disk read. Until
// that read resolves, clineMessages is []. evictCurrentTask() calls
// abortTask(), which called saveClineMessages() -> taskMetadata(). With an
// empty array, taskMetadata() writes the "no_messages" placeholder as the
// title, permanently clobbering the real one in the history store.
//
// Fix: abortTask() skips saveClineMessages() for history tasks whose message
// load has not completed. The on-disk data is already correct at that point.
import * as os from "os"
import * as path from "path"

import type { ClineMessage, GlobalState, HistoryItem, ProviderSettings } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockSaveApiMessages, mockSaveTaskMessages, mockReadApiMessages, mockReadTaskMessages, mockPWaitFor } =
	vi.hoisted(() => ({
		mockSaveApiMessages: vi.fn().mockResolvedValue(undefined),
		mockSaveTaskMessages: vi.fn().mockResolvedValue(undefined),
		mockReadApiMessages: vi.fn().mockResolvedValue([]),
		// Controlled per-test via a deferred promise so we can hold the "disk
		// read" open while a rival navigation aborts the still-loading task.
		mockReadTaskMessages: vi.fn<() => Promise<ClineMessage[]>>(),
		mockPWaitFor: vi.fn().mockResolvedValue(undefined),
	}))

// ─── Module mocks ────────────────────────────────────────────────────────────
// vscode and fs/promises are globally aliased in vitest.config — no inline
// mock needed.

vi.mock("delay", () => ({ __esModule: true, default: vi.fn().mockResolvedValue(undefined) }))
vi.mock("execa", () => ({ execa: vi.fn() }))
vi.mock("p-wait-for", () => ({ default: mockPWaitFor }))

// taskMetadata is NOT mocked — the real implementation is under test.
vi.mock("../../task-persistence", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../task-persistence")>()
	return {
		...mod,
		saveApiMessages: mockSaveApiMessages,
		saveTaskMessages: mockSaveTaskMessages,
		readApiMessages: mockReadApiMessages,
		readTaskMessages: mockReadTaskMessages,
		TaskHistoryStore: vi.fn().mockImplementation(function () {
			return {
				initialize: vi.fn().mockResolvedValue(undefined),
				dispose: vi.fn(),
				get: vi.fn(),
				getAll: vi.fn().mockReturnValue([]),
				upsert: vi.fn().mockResolvedValue([]),
				delete: vi.fn().mockResolvedValue(undefined),
				deleteMany: vi.fn().mockResolvedValue(undefined),
				reconcile: vi.fn().mockResolvedValue(undefined),
				initialized: Promise.resolve(),
			}
		}),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi
		.fn()
		.mockImplementation((text) =>
			Promise.resolve({ text: `processed: ${text}`, mode: undefined, contentBlocks: [] }),
		),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))
vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))
vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))
vi.mock("../../ignore/RooIgnoreController")
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))
vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: vi.fn().mockReturnValue(false) }))

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createDeferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((res) => {
		resolve = res
	})
	return { promise, resolve }
}

/**
 * Minimal slice of ClineProvider that Task reads during construction and abort.
 * All types are derived from ClineProvider so TypeScript validates property
 * names and signatures without requiring the full class to be satisfied.
 */
type MockProvider = Pick<ClineProvider, "log" | "updateTaskHistory"> & {
	taskHistoryStore: Pick<ClineProvider["taskHistoryStore"], "get">
	context: {
		globalStorageUri: Pick<ClineProvider["context"]["globalStorageUri"], "fsPath">
		globalState: Pick<ClineProvider["context"]["globalState"], "get" | "update" | "keys">
		workspaceState: Pick<ClineProvider["context"]["workspaceState"], "get" | "update" | "keys">
		secrets: Pick<ClineProvider["context"]["secrets"], "get" | "store" | "delete">
		extensionUri: Pick<ClineProvider["context"]["extensionUri"], "fsPath">
		extension: Pick<ClineProvider["context"]["extension"], "packageJSON">
	}
}

function makeMockProvider(updateTaskHistory: ReturnType<typeof vi.fn>): MockProvider {
	return {
		log: vi.fn(),
		taskHistoryStore: { get: () => undefined },
		// vi.fn() is not directly assignable to the typed method signature.
		updateTaskHistory: updateTaskHistory as unknown as ClineProvider["updateTaskHistory"],
		context: {
			globalStorageUri: { fsPath: path.join(os.tmpdir(), "test-storage") },
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			workspaceState: {
				get: vi.fn().mockImplementation(() => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		},
	}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Task resume/eviction race (Work #1 (no message) regression)", () => {
	let mockApiConfig: ProviderSettings

	beforeEach(() => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}
	})

	it("does not clobber the real task title when evicted mid-resume", async () => {
		const REAL_TITLE = "Write a short paragraph about the benefits of regular code reviews"

		const historyItem: HistoryItem = {
			id: "parent-task-1",
			number: 1,
			task: REAL_TITLE,
			ts: Date.now() - 60_000,
			tokensIn: 500,
			tokensOut: 300,
			totalCost: 0.01,
			workspace: path.join(os.tmpdir(), "mock-workspace"),
		}

		// Hold the disk read open so the task is aborted while clineMessages is
		// still empty — the same window a user hits by navigating away quickly.
		const readDeferred = createDeferred<ClineMessage[]>()
		mockReadTaskMessages
			.mockReturnValueOnce(readDeferred.promise) // first read: held open to simulate the race window
			.mockResolvedValue([]) // second read (resumeTaskFromHistory:2023): post-abort, safe fallback

		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const mockProvider = makeMockProvider(updateTaskHistory)

		const task = new Task({
			provider: mockProvider as unknown as ClineProvider,
			apiConfiguration: mockApiConfig,
			historyItem,
			taskNumber: historyItem.number,
			startTask: false,
		})

		// Fire task.run() without awaiting — mirrors the fire-and-forget pattern
		// in ClineProvider#createTaskWithHistoryItem. For history tasks, run()
		// calls resumeTaskFromHistory(), which starts with an async disk read.
		const runPromise = task.run().catch(() => {
			// After abort, downstream steps (e.g. ask()) throw — expected.
		})

		// Abort while the disk read is still in flight, as evictCurrentTask()
		// does when the user navigates away before messages load.
		await task.abortTask(true)

		// The fix: saveClineMessages() must not be called for a history task
		// with clineMessages still empty. Verify the call was skipped entirely,
		// not just that the specific "no_messages" key was not written.
		expect(updateTaskHistory).not.toHaveBeenCalled()

		// Let the read resolve so the promise does not leak into the next test.
		readDeferred.resolve([
			{ ts: historyItem.ts, type: "say", say: "text", text: REAL_TITLE },
			{ ts: historyItem.ts + 1, type: "say", say: "completion_result", text: "Done." },
		])
		await runPromise
	})
})
