// npx vitest run src/core/task/__tests__/Task.runtime-thinking-effort.test.ts
//
// DTE series 2/5 — task-local thinking effort state on Task:
// setRuntimeThinkingEffort / getRuntimeThinkingEffort, the in-memory
// apiConfiguration merge + restore, and the task-end reset in dispose().

import { ProviderSettings, type HistoryItem, type ReasoningEffortExtended } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { buildApiHandler } from "../../../api"
import { taskMetadata } from "../../task-persistence"

// Mock dependencies (same lightweight set as Task.throttle.test.ts)
vi.mock("../../webview/ClineProvider")
vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		releaseTerminalsForTask: vi.fn(),
	},
}))
vi.mock("../../ignore/RooIgnoreController")
vi.mock("../../protect/RooProtectedController")
vi.mock("../../context-tracking/FileContextTracker")
vi.mock("../../../integrations/editor/DiffViewProvider")
vi.mock("../../tools/ToolRepetitionDetector")
vi.mock("../../../api", () => ({
	// Returns a fresh handler object per call so tests can assert on the exact
	// configuration each rebuild received (via vi.mocked(buildApiHandler).mock.calls).
	buildApiHandler: vi.fn((configuration: { apiModelId?: string }) => ({
		getModel: () => ({ info: {}, id: configuration.apiModelId ?? "test-model" }),
	})),
}))

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTaskCreated: vi.fn(),
			captureTaskRestarted: vi.fn(),
		},
	},
}))

// Mock task persistence to avoid disk writes
vi.mock("../../task-persistence", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../task-persistence")>()),
	readApiMessages: vi.fn().mockResolvedValue([]),
	saveApiMessages: vi.fn().mockResolvedValue(undefined),
	readTaskMessages: vi.fn().mockResolvedValue([]),
	saveTaskMessages: vi.fn().mockResolvedValue(undefined),
	taskMetadata: vi.fn().mockResolvedValue({
		historyItem: {
			id: "test-task-id",
			number: 1,
			task: "Test task",
			ts: Date.now(),
			totalCost: 0.01,
			tokensIn: 100,
			tokensOut: 50,
		},
		tokenUsage: {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
			totalCacheWrites: 0,
			totalCacheReads: 0,
		},
	}),
}))

// Typed access to the intentionally-private DTE state, mirroring the
// getTaskTestAccess pattern in Task.spec.ts (single double assertion, documented).
type RuntimeThinkingEffortAccess = {
	runtimeThinkingEffort?: ReasoningEffortExtended
	runtimeThinkingEffortSource?: string
	preOverrideReasoningEffort?: ProviderSettings["reasoningEffort"]
	getRuntimeThinkingEffortMetadata: () => { reasoningEffort?: ReasoningEffortExtended }
	saveClineMessages: () => Promise<boolean>
}

function getPrivateAccess(task: Task): RuntimeThinkingEffortAccess {
	return task as unknown as RuntimeThinkingEffortAccess
}

const SETTINGS_EFFORT: ReasoningEffortExtended = "low"

describe("Task runtime thinking effort (DTE series 2/5)", () => {
	let mockProvider: Record<string, unknown>
	let mockApiConfiguration: ProviderSettings
	let task: Task

	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()

		mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/path" },
			},
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			log: vi.fn(),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
			flushPostStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		}

		mockApiConfiguration = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-opus-4-7",
			apiKey: "test-key",
			reasoningEffort: SETTINGS_EFFORT,
		} as ProviderSettings

		// mockProvider is a minimal structural double (ClineProvider is auto-mocked
		// by the vi.mock above); the task only touches the members supplied here.
		task = new Task({
			provider: mockProvider as unknown as ClineProvider,
			apiConfiguration: mockApiConfiguration,
			startTask: false,
		})
	})

	afterEach(() => {
		vi.useRealTimers()
		if (task && !task.abort) {
			task.dispose()
		}
	})

	describe("setRuntimeThinkingEffort", () => {
		it("stores effort + source, merges into the in-memory apiConfiguration, and rebuilds the handler", () => {
			task.setRuntimeThinkingEffort("xhigh", "test-source")

			expect(task.getRuntimeThinkingEffort()).toEqual({ effort: "xhigh", source: "test-source" })
			expect(getPrivateAccess(task).runtimeThinkingEffort).toBe("xhigh")
			expect(getPrivateAccess(task).runtimeThinkingEffortSource).toBe("test-source")

			// The in-memory copy carries the override...
			expect(task.apiConfiguration).toEqual(
				expect.objectContaining({
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "test-key",
					reasoningEffort: "xhigh",
				}),
			)
			// ...without mutating the settings object the provider handed in.
			expect(mockApiConfiguration).toEqual(
				expect.objectContaining({
					reasoningEffort: SETTINGS_EFFORT,
				}),
			)
			// The handler is rebuilt from the merged copy (last build call).
			const lastCall = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastCall?.[0]).toEqual(expect.objectContaining({ reasoningEffort: "xhigh" }))
			// The merged copy is a fresh object, not the settings object.
			expect(lastCall?.[0]).not.toBe(mockApiConfiguration)
		})

		it("does not re-capture the settings value when re-set while active", () => {
			task.setRuntimeThinkingEffort("high", "first")
			task.setRuntimeThinkingEffort("medium", "second")

			expect(task.getRuntimeThinkingEffort()).toEqual({ effort: "medium", source: "second" })
			// The settings-derived value captured at first activation is preserved.
			expect(getPrivateAccess(task).preOverrideReasoningEffort).toBe(SETTINGS_EFFORT)

			// Clearing restores the original settings value, not the intermediate one.
			task.setRuntimeThinkingEffort(undefined)
			expect(task.apiConfiguration.reasoningEffort).toBe(SETTINGS_EFFORT)
		})

		it("restores the settings-derived effort when cleared with undefined", () => {
			task.setRuntimeThinkingEffort("max")
			expect(task.apiConfiguration.reasoningEffort).toBe("max")

			task.setRuntimeThinkingEffort(undefined)

			expect(task.getRuntimeThinkingEffort()).toEqual({ effort: undefined, source: undefined })
			expect(task.apiConfiguration.reasoningEffort).toBe(SETTINGS_EFFORT)
			// The rest of the configuration is preserved through the restore.
			expect(task.apiConfiguration).toEqual(
				expect.objectContaining({
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "claude-opus-4-7",
					apiKey: "test-key",
				}),
			)
			// The handler is rebuilt from the restored copy.
			const lastCall = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastCall?.[0]).toEqual(expect.objectContaining({ reasoningEffort: SETTINGS_EFFORT }))
		})

		it("is a no-op when cleared while inactive (no handler rebuild)", () => {
			const callsBefore = vi.mocked(buildApiHandler).mock.calls.length

			task.setRuntimeThinkingEffort(undefined)

			expect(vi.mocked(buildApiHandler).mock.calls.length).toBe(callsBefore)
			expect(task.getRuntimeThinkingEffort()).toEqual({ effort: undefined, source: undefined })
			expect(task.apiConfiguration).toBe(mockApiConfiguration)
		})

		it("never writes to the provider or persisted settings", () => {
			task.setRuntimeThinkingEffort("xhigh")
			task.setRuntimeThinkingEffort(undefined)

			// Nothing is posted to the webview and the handed-in settings object is intact.
			expect(mockProvider.postStateToWebview).not.toHaveBeenCalled()
			expect(mockApiConfiguration).toEqual(
				expect.objectContaining({
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "claude-opus-4-7",
					apiKey: "test-key",
					reasoningEffort: SETTINGS_EFFORT,
				}),
			)
		})
	})

	describe("updateApiConfiguration while an override is active", () => {
		it("re-captures the incoming profile's effort as the restore value and keeps the override applied", () => {
			task.setRuntimeThinkingEffort("xhigh", "test-source")

			// A profile switch lands a different settings-derived effort while the override is active.
			const newConfig = {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-opus-4-8",
				apiKey: "test-key-2",
				reasoningEffort: "medium",
			} as ProviderSettings
			task.updateApiConfiguration(newConfig)

			// The override still wins in the in-memory copy...
			expect(task.apiConfiguration).toEqual(
				expect.objectContaining({
					apiModelId: "claude-opus-4-8",
					apiKey: "test-key-2",
					reasoningEffort: "xhigh",
				}),
			)
			// ...the override remains active...
			expect(task.getRuntimeThinkingEffort()).toEqual({ effort: "xhigh", source: "test-source" })
			// ...and the NEW profile's value is now the restore target.
			expect(getPrivateAccess(task).preOverrideReasoningEffort).toBe("medium")
			// The handler was rebuilt from the merged new copy.
			const lastCall = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastCall?.[0]).toEqual(
				expect.objectContaining({ apiModelId: "claude-opus-4-8", reasoningEffort: "xhigh" }),
			)
			expect(lastCall?.[0]).not.toBe(newConfig)

			// Clearing restores the NEW profile's effort, not the stale original one.
			task.setRuntimeThinkingEffort(undefined)
			expect(task.apiConfiguration.reasoningEffort).toBe("medium")
			expect(task.apiConfiguration).toEqual(
				expect.objectContaining({
					apiModelId: "claude-opus-4-8",
					apiKey: "test-key-2",
				}),
			)
			const lastCallAfterClear = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastCallAfterClear?.[0]).toEqual(expect.objectContaining({ reasoningEffort: "medium" }))
		})

		it("replaces the configuration as usual while inactive", () => {
			const newConfig = {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-opus-4-8",
				apiKey: "test-key-2",
				reasoningEffort: "medium",
			} as ProviderSettings

			task.updateApiConfiguration(newConfig)

			expect(task.apiConfiguration).toBe(newConfig)
			expect(task.apiConfiguration.reasoningEffort).toBe("medium")
			const lastCall = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastCall?.[0]).toBe(newConfig)
		})
	})

	describe("request metadata fragment", () => {
		it("is empty while inactive and carries the override while active", () => {
			expect(getPrivateAccess(task).getRuntimeThinkingEffortMetadata()).toEqual({})

			task.setRuntimeThinkingEffort("high")
			expect(getPrivateAccess(task).getRuntimeThinkingEffortMetadata()).toEqual({ reasoningEffort: "high" })

			task.setRuntimeThinkingEffort("low")
			expect(getPrivateAccess(task).getRuntimeThinkingEffortMetadata()).toEqual({ reasoningEffort: "low" })

			task.setRuntimeThinkingEffort(undefined)
			expect(getPrivateAccess(task).getRuntimeThinkingEffortMetadata()).toEqual({})
		})
	})

	describe("dispose", () => {
		it("clears the task-local override at task end", () => {
			task.setRuntimeThinkingEffort("xhigh", "source")
			task.dispose()

			expect(task.getRuntimeThinkingEffort()).toEqual({ effort: undefined, source: undefined })
			const access = getPrivateAccess(task)
			expect(access.runtimeThinkingEffort).toBeUndefined()
			expect(access.runtimeThinkingEffortSource).toBeUndefined()
			expect(access.preOverrideReasoningEffort).toBeUndefined()
		})
	})

	describe("history persistence round-trip", () => {
		const baseHistoryItem: HistoryItem = {
			id: "hist-task-id",
			number: 2,
			task: "Task from history",
			ts: Date.now(),
			totalCost: 0.01,
			tokensIn: 10,
			tokensOut: 5,
		}

		function makeHistoryTask(historyItem: Partial<HistoryItem>): Task {
			return new Task({
				provider: mockProvider as unknown as ClineProvider,
				apiConfiguration: mockApiConfiguration,
				startTask: false,
				historyItem: { ...baseHistoryItem, ...historyItem },
			})
		}

		it("restores the persisted task-local effort when constructed from a history item", () => {
			const histTask = makeHistoryTask({ thinkingEffort: "xhigh", thinkingEffortSource: "you" })

			expect(histTask.getRuntimeThinkingEffort()).toEqual({ effort: "xhigh", source: "you" })
			// The in-memory copy carries the restored effort, so the rebuilt handler uses it.
			expect(histTask.apiConfiguration).toEqual(expect.objectContaining({ reasoningEffort: "xhigh" }))
			const lastCall = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastCall?.[0]).toEqual(expect.objectContaining({ reasoningEffort: "xhigh" }))
			histTask.dispose()
		})

		it("leaves the override inactive for history items without a persisted effort", () => {
			const histTask = makeHistoryTask({})

			expect(histTask.getRuntimeThinkingEffort()).toEqual({ effort: undefined, source: undefined })
			expect(histTask.apiConfiguration.reasoningEffort).toBe(SETTINGS_EFFORT)
			histTask.dispose()
		})

		it("carries the active task-local effort onto the taskMetadata payload in saveClineMessages", async () => {
			task.setRuntimeThinkingEffort("max", "you")

			await getPrivateAccess(task).saveClineMessages()

			expect(vi.mocked(taskMetadata)).toHaveBeenCalledWith(
				expect.objectContaining({ thinkingEffort: "max", thinkingEffortSource: "you" }),
			)
		})

		it("omits the effort values from the taskMetadata payload while inactive", async () => {
			await getPrivateAccess(task).saveClineMessages()

			expect(vi.mocked(taskMetadata)).toHaveBeenCalledWith(
				expect.objectContaining({ thinkingEffort: undefined, thinkingEffortSource: undefined }),
			)
		})
	})

	describe("abortTask final save (DTE series 2/5)", () => {
		it("records the active task-local effort on the final history save despite dispose() clearing it", async () => {
			task.setRuntimeThinkingEffort("high", "you")

			await task.abortTask()

			// dispose() has already cleared the live state...
			expect(task.getRuntimeThinkingEffort()).toEqual({ effort: undefined, source: undefined })
			// ...but the final save still recorded the pre-dispose snapshot.
			expect(vi.mocked(taskMetadata)).toHaveBeenCalledWith(
				expect.objectContaining({ thinkingEffort: "high", thinkingEffortSource: "you" }),
			)
		})

		it("saves undefined effort fields on the final history save while inactive", async () => {
			await task.abortTask()

			expect(vi.mocked(taskMetadata)).toHaveBeenCalledWith(
				expect.objectContaining({ thinkingEffort: undefined, thinkingEffortSource: undefined }),
			)
		})
	})
})
