// npx vitest run src/core/task/__tests__/Task.runtime-thinking-effort.test.ts
//
// Task-local thinking effort state on Task:
// setRuntimeThinkingEffort / getRuntimeThinkingEffort, the in-memory
// effective-effort handler rebuild (the profile-derived apiConfiguration
// projection never carries the override).

import { ProviderSettings, type ModelInfo, type ReasoningEffortExtended } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { buildApiHandler } from "../../../api"
import { DeepSeekHandler } from "../../../api/providers/deepseek"
import { disposeApiHandler } from "../../../api/dispose-api-handler"
import { summarizeConversation } from "../../condense"
import { ApiStreamChunk } from "../../../api/transform/stream"

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
vi.mock("../../../api/dispose-api-handler", () => ({ disposeApiHandler: vi.fn() }))
vi.mock("../../../api", () => ({
	// Returns a fresh handler object per call so tests can assert on the exact
	// configuration each rebuild received (via vi.mocked(buildApiHandler).mock.calls).
	buildApiHandler: vi.fn((configuration: { apiModelId?: string }) => ({
		getModel: () => ({ info: {}, id: configuration.apiModelId ?? "test-model" }),
		countTokens: vi.fn().mockResolvedValue(0),
		createMessage: vi.fn(),
	})),
}))

// Request-path tests below: the summarization and tool-array collaborators are replaced so the
// four request sites are reachable without MCP or condensing machinery, while the real
// willManageContext/manageContext still decide the branch and hand the same metadata object to
// summarizeConversation - which is where the assertions read it.
vi.mock("../../condense", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../condense")>()
	return {
		...actual,
		summarizeConversation: vi.fn().mockResolvedValue({
			messages: [{ role: "user", content: [{ type: "text", text: "condensed" }], ts: 1 }],
			summary: "summary",
			cost: 0,
			newContextTokens: 1,
		}),
	}
})

vi.mock("../build-tools", () => ({
	buildNativeToolsArrayWithRestrictions: vi.fn().mockResolvedValue({ tools: [], allowedFunctionNames: undefined }),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue("environment details"),
}))

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTaskCreated: vi.fn(),
			captureTaskRestarted: vi.fn(),
			captureTaskCompleted: vi.fn(),
			captureLlmCompletion: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
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
	getSystemPrompt: (state: unknown, modelInfo: ModelInfo | undefined) => Promise<string>
	handleContextWindowExceededError: (requestModelInfo: ModelInfo) => Promise<void>
}

function getPrivateAccess(task: Task): RuntimeThinkingEffortAccess {
	return task as unknown as RuntimeThinkingEffortAccess
}

const SETTINGS_EFFORT: ReasoningEffortExtended = "low"

describe("Task runtime thinking effort override", () => {
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

	describe("dispose", () => {
		it("clears the override and leaves the profile-derived apiConfiguration unchanged", async () => {
			task.setRuntimeThinkingEffort("xhigh", "test-source")
			const access = getPrivateAccess(task)
			const handlerBefore = (task as unknown as { api: unknown }).api
			const buildsBefore = vi.mocked(buildApiHandler).mock.calls.length
			vi.mocked(disposeApiHandler).mockClear()

			await task.dispose()

			expect(access.runtimeThinkingEffort).toBeUndefined()
			expect(access.runtimeThinkingEffortSource).toBeUndefined()
			// The public read reports the same cleared state. Nothing is restored into
			// apiConfiguration here: it is the profile-derived projection and never carried
			// the override, so disposal can only leave the profile value it already had.
			expect(task.getRuntimeThinkingEffort()).toEqual({ effort: undefined, source: undefined })
			expect(task.apiConfiguration.reasoningEffort).toBe(SETTINGS_EFFORT)
			// A disposed task never serves another request: disposal must not rebuild
			// a replacement handler it would then have to collect and dispose.
			expect(vi.mocked(buildApiHandler).mock.calls.length).toBe(buildsBefore)
			// The handler the task owned is disposed exactly once, not retired a
			// second time by the clearing path.
			const disposedHandlers = vi.mocked(disposeApiHandler).mock.calls.map(([api]) => api)
			expect(disposedHandlers.filter((api) => api === handlerBefore)).toHaveLength(1)
		})
	})

	describe("setRuntimeThinkingEffort", () => {
		it("stores effort + source and rebuilds the handler with the override applied", () => {
			// The handler this task owned before the swap must be disposed by the swap:
			// handlers that hold host listeners (VS Code LM, GitHub Copilot) leak otherwise.
			const handlerBefore = task.api
			vi.mocked(disposeApiHandler).mockClear()
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
			// Exact configuration, not a shape subset: dropping any other profile field
			// from the rebuild would fail here.
			const lastCall = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastCall?.[0]).toEqual({ ...mockApiConfiguration, reasoningEffort: "xhigh" })
			// ...from a fresh copy, not the settings object itself.
			expect(lastCall?.[0]).not.toBe(mockApiConfiguration)
			const disposedHandlers = vi.mocked(disposeApiHandler).mock.calls.map(([api]) => api)
			expect(disposedHandlers.filter((api) => api === handlerBefore)).toHaveLength(1)
		})

		it("hands buildApiHandler a configuration a real provider handler honours", async () => {
			// The mocked builder proves the override reaches buildApiHandler; this feeds
			// the configuration it handed over to the REAL builder and checks that an
			// actual provider resolves it. deepseek's model-params step reads
			// `options.reasoningEffort` and outranks the model's own default ("high"),
			// while the profile asks for SETTINGS_EFFORT, so all three values differ.
			const { buildApiHandler: buildRealHandler } =
				await vi.importActual<typeof import("../../../api")>("../../../api")
			// The real builder routes this configuration to deepseek's handler, whose
			// model-params step is what reads the effort.
			const deepSeekEffortOf = (configuration: ProviderSettings): ReasoningEffortExtended | undefined => {
				const handler = buildRealHandler({
					...configuration,
					apiProvider: providerIdentifiers.deepseek,
					apiModelId: "deepseek-v4-flash",
				})
				if (!(handler instanceof DeepSeekHandler)) {
					throw new Error("the real builder must route this configuration to deepseek's handler")
				}
				return handler.getModel().reasoningEffort
			}

			expect(deepSeekEffortOf(mockApiConfiguration)).toBe(SETTINGS_EFFORT)

			task.setRuntimeThinkingEffort("max", "real-builder")
			const handedConfiguration = vi.mocked(buildApiHandler).mock.calls.at(-1)?.[0] as ProviderSettings
			expect(deepSeekEffortOf(handedConfiguration)).toBe("max")

			task.setRuntimeThinkingEffort(undefined)
			const clearedConfiguration = vi.mocked(buildApiHandler).mock.calls.at(-1)?.[0] as ProviderSettings
			expect(deepSeekEffortOf(clearedConfiguration)).toBe(SETTINGS_EFFORT)
		})

		it("replaces effort + source when re-set while active and restores on clear", () => {
			task.setRuntimeThinkingEffort("high", "first")
			task.setRuntimeThinkingEffort("medium", "second")

			expect(task.getRuntimeThinkingEffort()).toEqual({ effort: "medium", source: "second" })
			const lastSet = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastSet?.[0]).toEqual(expect.objectContaining({ reasoningEffort: "medium" }))

			// Clearing rebuilds from the profile projection itself — the same object, not
			// a copy carrying the intermediate effort.
			task.setRuntimeThinkingEffort(undefined)
			const lastClear = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastClear?.[0]).toBe(task.apiConfiguration)
			expect(task.apiConfiguration.reasoningEffort).toBe(SETTINGS_EFFORT)
		})

		it("restores the settings-derived effort when cleared with undefined", () => {
			task.setRuntimeThinkingEffort("max")
			const lastSet = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastSet?.[0]).toEqual(expect.objectContaining({ reasoningEffort: "max" }))

			// The handler that served the override must be disposed by the clearing swap.
			const handlerUnderOverride = task.api
			vi.mocked(disposeApiHandler).mockClear()
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
			// The handler is rebuilt from the projection object itself, and the handler
			// that served the override is gone.
			const lastCall = vi.mocked(buildApiHandler).mock.calls.at(-1)
			expect(lastCall?.[0]).toBe(task.apiConfiguration)
			const disposedHandlers = vi.mocked(disposeApiHandler).mock.calls.map(([api]) => api)
			expect(disposedHandlers.filter((api) => api === handlerUnderOverride)).toHaveLength(1)
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

	describe("disposal race (lifecycle guard)", () => {
		it("drops a runtime-effort update once disposal has started", async () => {
			task.setRuntimeThinkingEffort("xhigh", "test-source")
			const access = getPrivateAccess(task)
			const handlerAtDisposal = (task as unknown as { api: unknown }).api
			const buildsAtDisposal = vi.mocked(buildApiHandler).mock.calls.length
			vi.mocked(disposeApiHandler).mockClear()

			const disposing = task.dispose()
			// Both handler-rebuilding entry points, called while disposal is in flight.
			task.setRuntimeThinkingEffort("max", "during-disposal")
			task.updateApiConfiguration({ ...mockApiConfiguration, apiModelId: "claude-sonnet-4-6" })

			await disposing

			// No handler was constructed after the disposal snapshot and the task still points at
			// the handler that snapshot collected, so nothing built during disposal is left without
			// an owner, and the collected handler is disposed exactly once.
			expect(vi.mocked(buildApiHandler).mock.calls.length).toBe(buildsAtDisposal)
			expect((task as unknown as { api: unknown }).api).toBe(handlerAtDisposal)
			const disposedHandlers = vi.mocked(disposeApiHandler).mock.calls.map(([api]) => api)
			expect(disposedHandlers.filter((api) => api === handlerAtDisposal)).toHaveLength(1)
			// The dropped call left no state behind: neither the override nor the projection moved.
			expect(access.runtimeThinkingEffort).toBeUndefined()
			expect(task.apiConfiguration.apiModelId).toBe("claude-opus-4-7")
		})
	})

	describe("request paths (all four metadata sites)", () => {
		const MODEL_INFO: ModelInfo = { contextWindow: 50_000, maxTokens: 1024, supportsPromptCache: false }

		function oneChunkStream(text: string): AsyncGenerator<ApiStreamChunk> {
			return (async function* () {
				yield { type: "text", text }
			})()
		}

		// Called after every rebuild: setRuntimeThinkingEffort replaces this.api, so a spy installed on
		// the previous handler would never see the request.
		function attachRequestDoubles() {
			vi.spyOn(task.api, "getModel").mockReturnValue({ id: "dte-model", info: MODEL_INFO })
			Object.assign(task.api, {
				ensureModelFetched: vi.fn().mockResolvedValue(undefined),
				countTokens: vi.fn().mockResolvedValue(10),
			})
			mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
			return vi.spyOn(task.api, "createMessage").mockImplementation(() => oneChunkStream("response"))
		}

		const lastSummarizeMetadata = () => vi.mocked(summarizeConversation).mock.calls.at(-1)?.[0].metadata

		beforeEach(() => {
			// Real timers: these paths await abort-aware delays that fake timers would park.
			vi.useRealTimers()
			mockProvider.getState = vi.fn().mockResolvedValue({
				mode: "code",
				apiConfiguration: mockApiConfiguration,
				autoApprovalEnabled: true,
				autoCondenseContext: true,
				autoCondenseContextPercent: 80,
				requestDelaySeconds: 0,
				profileThresholds: {},
				customModes: [],
				experiments: {},
				disabledTools: [],
				customSupportPrompts: {},
			})
			// 90% of the 50k window against an 80% threshold: the automatic trigger fires.
			vi.spyOn(task, "getTokenUsage").mockReturnValue({
				totalCost: 0,
				totalTokensIn: 0,
				totalTokensOut: 0,
				contextTokens: 45_000,
			})
			vi.spyOn(getPrivateAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")
			task.apiConversationHistory = [{ role: "user", content: [{ type: "text", text: "task history" }], ts: 1 }]
		})

		it("carries the override into the manual condense request and drops it once cleared", async () => {
			task.setRuntimeThinkingEffort("xhigh", "test-source")
			attachRequestDoubles()
			await task.condenseContext()
			expect(lastSummarizeMetadata()?.reasoningEffort).toBe("xhigh")

			task.setRuntimeThinkingEffort(undefined)
			attachRequestDoubles()
			await task.condenseContext()
			expect(lastSummarizeMetadata()).not.toHaveProperty("reasoningEffort")
		})

		it("carries the override into the forced context-management request and drops it once cleared", async () => {
			const access = getPrivateAccess(task)
			task.setRuntimeThinkingEffort("xhigh", "test-source")
			attachRequestDoubles()
			await access.handleContextWindowExceededError(MODEL_INFO)
			expect(lastSummarizeMetadata()?.reasoningEffort).toBe("xhigh")

			task.setRuntimeThinkingEffort(undefined)
			attachRequestDoubles()
			await access.handleContextWindowExceededError(MODEL_INFO)
			expect(lastSummarizeMetadata()).not.toHaveProperty("reasoningEffort")
		})

		it("carries the override into automatic context management and the request stream, and drops both", async () => {
			task.setRuntimeThinkingEffort("xhigh", "test-source")
			const createMessage = attachRequestDoubles()

			const iterator = task.attemptApiRequest(0, { skipProviderRateLimit: true })
			await iterator.next()
			await iterator.return(undefined)

			expect(lastSummarizeMetadata()?.reasoningEffort).toBe("xhigh")
			expect(createMessage.mock.calls.at(-1)?.[2]).toHaveProperty("reasoningEffort", "xhigh")

			task.setRuntimeThinkingEffort(undefined)
			const cleared = attachRequestDoubles()
			const secondIterator = task.attemptApiRequest(0, { skipProviderRateLimit: true })
			await secondIterator.next()
			await secondIterator.return(undefined)

			expect(lastSummarizeMetadata()).not.toHaveProperty("reasoningEffort")
			expect(cleared.mock.calls.at(-1)?.[2]).not.toHaveProperty("reasoningEffort")
		})
	})
})
