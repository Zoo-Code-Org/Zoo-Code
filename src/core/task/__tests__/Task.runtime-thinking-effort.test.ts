// npx vitest run src/core/task/__tests__/Task.runtime-thinking-effort.test.ts
//
// DTE series 2/5 — task-local thinking effort state on Task:
// setRuntimeThinkingEffort / getRuntimeThinkingEffort, the in-memory
// effective-effort handler rebuild (the profile-derived apiConfiguration
// projection never carries the override).

import { ProviderSettings, type ReasoningEffortExtended } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { buildApiHandler } from "../../../api"

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
	getRuntimeThinkingEffortMetadata: () => { reasoningEffort?: ReasoningEffortExtended }
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

	afterEach(async () => {
		vi.useRealTimers()
		if (task) {
			await task.dispose().catch(() => {})
		}
	})

	describe("setRuntimeThinkingEffort", () => {
		it("stores effort + source and rebuilds the handler with the override applied", () => {
			task.setRuntimeThinkingEffort("xhigh", "test-source")

			expect(task.getRuntimeThinkingEffort()).toEqual({ effort: "xhigh", source: "test-source" })
			expect(getPrivateAccess(task).runtimeThinkingEffort).toBe("xhigh")
			expect(getPrivateAccess(task).runtimeThinkingEffortSource).toBe("test-source")

			// The settings object the provider handed in is never mutated.
			expect(mockApiConfiguration).toEqual(
				expect.objectContaining({
					reasoningEffort: SETTINGS_EFFORT,
				}),
			)
			// The handler is rebuilt with the override applied (last build call)...
			const lastCall = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastCall?.[0]).toEqual(expect.objectContaining({ reasoningEffort: "xhigh" }))
			// ...from a fresh copy, not the settings object itself.
			expect(lastCall?.[0]).not.toBe(mockApiConfiguration)
		})

		it("replaces effort + source when re-set while active and restores on clear", () => {
			task.setRuntimeThinkingEffort("high", "first")
			task.setRuntimeThinkingEffort("medium", "second")

			expect(task.getRuntimeThinkingEffort()).toEqual({ effort: "medium", source: "second" })
			const lastSet = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastSet?.[0]).toEqual(expect.objectContaining({ reasoningEffort: "medium" }))

			// Clearing rebuilds from the profile projection, not the intermediate effort.
			task.setRuntimeThinkingEffort(undefined)
			const lastClear = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastClear?.[0]).toEqual(expect.objectContaining({ reasoningEffort: SETTINGS_EFFORT }))
		})

		it("restores the settings-derived effort when cleared with undefined", () => {
			task.setRuntimeThinkingEffort("max")
			const lastSet = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastSet?.[0]).toEqual(expect.objectContaining({ reasoningEffort: "max" }))

			// A label passed on the clearing call must not survive into source.
			task.setRuntimeThinkingEffort(undefined, "stale-source")

			expect(task.getRuntimeThinkingEffort()).toEqual({ effort: undefined, source: undefined })
			// The profile effort survives the set/clear cycle with the rest of the
			// configuration intact.
			expect(task.apiConfiguration).toEqual(
				expect.objectContaining({
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "claude-opus-4-7",
					apiKey: "test-key",
					reasoningEffort: SETTINGS_EFFORT,
				}),
			)
			// The handler is rebuilt from the projection.
			const lastCall = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastCall?.[0]).toEqual(expect.objectContaining({ reasoningEffort: SETTINGS_EFFORT }))
		})

		it("never lets the override enter apiConfiguration (webview projection + profile save contract)", () => {
			// ClineProvider.getStateToPostToWebview posts the active task's
			// apiConfiguration object to the webview, and SettingsView returns it on
			// save (upsertApiConfiguration -> saveConfig). If the override entered the
			// projection, any settings save during an active override would persist the
			// task-local effort into the selected profile.
			task.setRuntimeThinkingEffort("xhigh", "test-ui")

			expect(task.apiConfiguration).toBe(mockApiConfiguration)
			expect(task.apiConfiguration.reasoningEffort).toBe(SETTINGS_EFFORT)

			// A profile switch while active keeps the projection profile-pure too.
			const newConfig = {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-opus-4-8",
				apiKey: "test-key",
				reasoningEffort: "medium",
			} as ProviderSettings
			task.updateApiConfiguration(newConfig)
			expect(task.apiConfiguration).toBe(newConfig)
			expect(task.apiConfiguration.reasoningEffort).toBe("medium")

			task.setRuntimeThinkingEffort(undefined)
			expect(task.apiConfiguration.reasoningEffort).toBe("medium")
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
		it("keeps the override applied over the new profile and restores the new profile on clear", () => {
			task.setRuntimeThinkingEffort("xhigh", "test-source")

			// A profile switch lands a different settings-derived effort while the override is active.
			const newConfig = {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-opus-4-8",
				apiKey: "test-key-2",
				reasoningEffort: "medium",
			} as ProviderSettings
			task.updateApiConfiguration(newConfig)

			// The override remains active...
			expect(task.getRuntimeThinkingEffort()).toEqual({ effort: "xhigh", source: "test-source" })
			// ...and the handler was rebuilt over the NEW profile with the override applied.
			const lastCall = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastCall?.[0]).toEqual(
				expect.objectContaining({ apiModelId: "claude-opus-4-8", reasoningEffort: "xhigh" }),
			)
			expect(lastCall?.[0]).not.toBe(newConfig)

			// Clearing restores the NEW profile's effort, not the stale original one.
			task.setRuntimeThinkingEffort(undefined)
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
			// Key absence, not toEqual({}): toEqual ignores keys whose value is undefined,
			// so only an absence assertion kills the always-consequent metadata mutant.
			expect(getPrivateAccess(task).getRuntimeThinkingEffortMetadata()).not.toHaveProperty("reasoningEffort")

			task.setRuntimeThinkingEffort("high")
			expect(getPrivateAccess(task).getRuntimeThinkingEffortMetadata()).toEqual({ reasoningEffort: "high" })

			task.setRuntimeThinkingEffort("low")
			expect(getPrivateAccess(task).getRuntimeThinkingEffortMetadata()).toEqual({ reasoningEffort: "low" })

			task.setRuntimeThinkingEffort(undefined)
			expect(getPrivateAccess(task).getRuntimeThinkingEffortMetadata()).not.toHaveProperty("reasoningEffort")
		})
	})

	describe("dispose", () => {
		it("clears the task-local override and restores the settings-derived API configuration at task end", async () => {
			task.setRuntimeThinkingEffort("xhigh", "source")
			await task.dispose()

			expect(task.getRuntimeThinkingEffort()).toEqual({ effort: undefined, source: undefined })
			const access = getPrivateAccess(task)
			expect(access.runtimeThinkingEffort).toBeUndefined()
			expect(access.runtimeThinkingEffortSource).toBeUndefined()
			expect(task.apiConfiguration.reasoningEffort).toBe(SETTINGS_EFFORT)
		})
	})
})
