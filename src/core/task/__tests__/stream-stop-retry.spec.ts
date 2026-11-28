import { WebviewFocusTracker } from "../../webview/WebviewFocusTracker"
// cd src && npx vitest run core/task/__tests__/stream-stop-retry.spec.ts
//
// Property test for docs/architecture/tla/StreamStopRetry.tla (issue 2769).
// It runs the model's three invariant sentences on the real task loop with a
// stubbed provider stream:
// - NoResendWithoutConsent: a stopped request is only resent after the user
//   approves, with auto-approval on and off.
// - NoLostUsage: the stopped response's usage reaches the request row.
// - NoSecondUserTurn: a confirmed retry reuses the saved user turn.
// The stream shapes follow the OpenRouter chunk order: optional deltas, then
// the stop, then the usage the handler attaches to the error.

import * as fsp from "fs/promises"
import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"
import type { Anthropic } from "@anthropic-ai/sdk"

import { providerIdentifiers, type GlobalState, type ModelInfo, type ProviderSettings } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { StreamStopError } from "../../../api/providers/utils/stream-stop-error"
import type { ApiStreamChunk, ApiStreamUsageChunk } from "../../../api/transform/stream"
import { asyncStreamFrom } from "../../../test-utils/stream"
import { getEnvironmentDetails } from "../../environment/getEnvironmentDetails"

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

// Task tests do not exercise indexing; keep workspace resolution and its cache out of this suite.
vi.mock("../../../services/code-index/code-index-manager-registry", () => ({
	CodeIndexManagerRegistry: {
		getOrCreate: vi.fn().mockReturnValue(undefined),
		getAllInstances: vi.fn().mockReturnValue([]),
		disposeAll: vi.fn(),
	},
}))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }
	const mockTextDocument = { uri: { fsPath: "/mock/workspace/path/file.ts" } }
	const mockTextEditor = { document: mockTextDocument }
	const mockTab = { input: { uri: { fsPath: "/mock/workspace/path/file.ts" } } }
	const mockTabGroup = { tabs: [mockTab] }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: "/mock/workspace/path" },
					name: "mock-workspace",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: {
				stat: vi.fn().mockResolvedValue({ type: 1 }),
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (_key: string, defaultValue: unknown) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(function () {
			return mockEventEmitter
		}),
		Disposable: {
			from: vi.fn(),
		},
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text: string) => {
		return Promise.resolve({ text: `processed: ${text}`, mode: undefined, contentBlocks: [] })
	}),
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

type ProviderState = Awaited<ReturnType<ClineProvider["getState"]>>

type TaskTestAccess = {
	addToApiConversationHistory: (message: Anthropic.MessageParam, reasoning?: string) => Promise<void>
	safeEnsureModelFetched: () => Promise<ModelInfo>
	backoffAndAnnounce: (retryAttempt: number, error: unknown) => Promise<void>
	presentAssistantMessageSafe: () => void
	getSystemPrompt: (requestState?: ProviderState, requestModelInfo?: ModelInfo) => Promise<string>
}

// Private members the replay drives directly; the double provides only these.
const getTaskTestAccess = (task: Task): TaskTestAccess => task as unknown as TaskTestAccess

const stubModelInfo: ModelInfo = {
	contextWindow: 200_000,
	maxTokens: 8_192,
	supportsPromptCache: true,
}

const STOP_MESSAGE = "The provider stopped this response (content filter). The response may be incomplete."

/** The usage the fixed handler attaches to the stop error (the OpenRouter shape). */
const stoppedUsage: ApiStreamUsageChunk = {
	type: "usage",
	inputTokens: 1234,
	outputTokens: 5,
	totalCost: 0.01,
}

/**
 * The stream shapes from the acceptance criteria, in the OpenRouter chunk
 * order. Every shape ends in a StreamStopError; the usage rides on the error
 * except for the shape with no usage chunk.
 */
const stopShapes: Array<{ name: string; chunks: ApiStreamChunk[]; withUsage: boolean }> = [
	{ name: "no text", chunks: [], withUsage: true },
	{
		name: "reasoning only",
		chunks: [{ type: "reasoning", text: "thinking" }],
		withUsage: true,
	},
	{
		name: "partial text",
		chunks: [{ type: "text", text: "partial answer" }],
		withUsage: true,
	},
	{ name: "no usage chunk", chunks: [{ type: "text", text: "partial answer" }], withUsage: false },
]

function stopStream(shape: { chunks: ApiStreamChunk[]; withUsage: boolean }): AsyncGenerator<ApiStreamChunk> {
	return (async function* () {
		yield* shape.chunks
		const error = new StreamStopError("content_filter", STOP_MESSAGE)
		if (shape.withUsage) {
			error.usage = stoppedUsage
		}
		throw error
	})()
}

function firstApiReqRow(task: Task): Record<string, unknown> {
	const row = task.clineMessages.find((message) => message.say === "api_req_started")
	expect(row).toBeDefined()
	return JSON.parse(row!.text || "{}") as Record<string, unknown>
}

describe("stream stop retry (issue 2769)", () => {
	let tempRoot: string
	let mockProvider: ClineProvider
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: vscode.OutputChannel
	let mockExtensionContext: vscode.ExtensionContext
	let baseProviderState: ProviderState

	const providerStateWith = (overrides: Partial<ProviderState> = {}): ProviderState => ({
		...baseProviderState,
		mcpEnabled: false,
		...overrides,
	})

	beforeEach(async () => {
		vi.mocked(getEnvironmentDetails).mockResolvedValue("")
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		tempRoot = path.join(os.tmpdir(), `stream-stop-retry-${Date.now()}-${Math.random().toString(16).slice(2)}`)
		await fsp.mkdir(tempRoot, { recursive: true })

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: { fsPath: tempRoot },
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockImplementation((_key) => Promise.resolve(undefined)),
				store: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				delete: vi.fn().mockImplementation((_key) => Promise.resolve()),
			},
			extensionUri: { fsPath: path.join(tempRoot, "extension") },
			extension: {
				packageJSON: {
					version: "1.0.0",
				},
			},
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			name: "test-output",
			appendLine: vi.fn(),
			append: vi.fn(),
			replace: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		// The provider double overrides every webview and history method the loop
		// touches; no real webview exists in vitest.
		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
			new WebviewFocusTracker(),
		) as unknown as ClineProvider
		const providerDouble = mockProvider as unknown as Record<string, unknown>
		providerDouble.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		providerDouble.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		providerDouble.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		providerDouble.postStateToWebviewThrottled = vi.fn().mockResolvedValue(undefined)
		providerDouble.flushPostStateToWebviewThrottled = vi.fn().mockResolvedValue(undefined)
		providerDouble.updateTaskHistory = vi.fn().mockResolvedValue(undefined)
		providerDouble.log = vi.fn()
		providerDouble.getTaskWithId = vi.fn()

		baseProviderState = await mockProvider.getState()

		mockApiConfig = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}
	})

	afterEach(async () => {
		await fsp.rm(tempRoot, { recursive: true, force: true })
	})

	async function createTask(autoApprovalEnabled: boolean): Promise<Task> {
		vi.spyOn(mockProvider, "getState").mockResolvedValue(
			providerStateWith({ autoApprovalEnabled, requestDelaySeconds: 0 }),
		)

		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "stream stop retry replay",
			startTask: false,
		})

		vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
		// Stream rendering is outside this suite. Complete it without replacing ask polling.
		vi.spyOn(getTaskTestAccess(task), "presentAssistantMessageSafe").mockImplementation(() => {
			task.userMessageContentReady = true
		})
		vi.spyOn(getTaskTestAccess(task), "safeEnsureModelFetched").mockResolvedValue(stubModelInfo)
		return task
	}

	/** Saves one initial user turn so a retry can be checked against it. */
	async function seedUserTurn(task: Task): Promise<void> {
		await getTaskTestAccess(task).addToApiConversationHistory({
			role: "user",
			content: [{ type: "text", text: "original user request" }],
		})
		task.messageCounts.user = 1
	}

	function userTurnCount(task: Task): number {
		return task.apiConversationHistory.filter((message) => message.role === "user").length
	}

	it.each(stopShapes)(
		"asks instead of auto-retrying a stop with $name, keeps the usage, and adds no user turn",
		async (shape) => {
			const task = await createTask(true)
			await seedUserTurn(task)

			const askSpy = vi
				.spyOn(task, "ask")
				.mockResolvedValue({ response: "yesButtonClicked" } as Awaited<ReturnType<Task["ask"]>>)
			const backoffSpy = vi.spyOn(getTaskTestAccess(task), "backoffAndAnnounce").mockResolvedValue(undefined)

			let retryHistoryLength: number | undefined
			let retryUserMessageCount: number | undefined
			const attemptSpy = vi
				.spyOn(task, "attemptApiRequest")
				.mockImplementationOnce(() => stopStream(shape))
				.mockImplementationOnce(() => {
					// NoResendWithoutConsent and NoSecondUserTurn: the retry reached the
					// request seam after one approve, and the saved user turn is intact.
					retryHistoryLength = userTurnCount(task)
					retryUserMessageCount = task.messageCounts.user
					return asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "retry answer" }])
				})
				// The normal continuation request ends the replay the way the
				// neighbouring suites do: a synchronous throw from the seam.
				.mockImplementation(() => {
					throw new Error("stop after retry response")
				})

			await task.recursivelyMakeClineRequests([])

			// NoResendWithoutConsent: the ask gate ran even with auto-approval on,
			// and the generic retry path never ran for the stop.
			expect(askSpy).toHaveBeenCalledWith("api_req_failed", STOP_MESSAGE)
			expect(backoffSpy).not.toHaveBeenCalled()
			expect(attemptSpy).toHaveBeenNthCalledWith(2, 1, expect.objectContaining({ skipProviderRateLimit: true }))

			// NoLostUsage: the stopped response's usage reached the request row.
			const row = firstApiReqRow(task)
			if (shape.withUsage) {
				expect(row).toMatchObject({
					tokensIn: 1234,
					tokensOut: 5,
					cost: 0.01,
					cancelReason: "streaming_failed",
				})
			} else {
				expect(row).toMatchObject({ tokensIn: 0, tokensOut: 0, cancelReason: "streaming_failed" })
			}
			expect(String(row.streamingFailedMessage)).toContain("content filter")

			// NoSecondUserTurn: the retry reuses the saved user turn.
			expect(retryHistoryLength).toBe(1)
			expect(retryUserMessageCount).toBe(1)
		},
	)

	it.each([true, false])(
		"does not resend when the user declines the stop ask (auto-approval %s)",
		async (autoApprovalEnabled) => {
			const task = await createTask(autoApprovalEnabled)
			await seedUserTurn(task)

			const askSpy = vi
				.spyOn(task, "ask")
				.mockResolvedValue({ response: "noButtonClicked" } as Awaited<ReturnType<Task["ask"]>>)
			const attemptSpy = vi.spyOn(task, "attemptApiRequest").mockImplementation(() => stopStream(stopShapes[0]))

			await task.recursivelyMakeClineRequests([])

			// NoResendWithoutConsent: one stop, one ask, and no resend.
			expect(attemptSpy).toHaveBeenCalledOnce()
			expect(askSpy).toHaveBeenCalledWith("api_req_failed", STOP_MESSAGE)

			// NoLostUsage: the declined stop still reports its usage.
			expect(firstApiReqRow(task)).toMatchObject({
				tokensIn: 1234,
				tokensOut: 5,
				cost: 0.01,
				cancelReason: "streaming_failed",
			})
		},
	)

	it("sends a filtered response with an unpaired tool call to the stop ask, not the tool recovery", async () => {
		// Not-yet-covered check from issue 2769: a filtered response that contains
		// a tool call. A filter stop never emits tool_call_end, so the call stays
		// partial and cannot run: the tool recovery branch needs a complete tool.
		// The stop ask gates the retry, and the retried request starts with clean
		// streaming state.
		const task = await createTask(true)
		await seedUserTurn(task)

		const askSpy = vi
			.spyOn(task, "ask")
			.mockResolvedValue({ response: "yesButtonClicked" } as Awaited<ReturnType<Task["ask"]>>)
		let retrySawTool: boolean | undefined
		const attemptSpy = vi
			.spyOn(task, "attemptApiRequest")
			.mockImplementationOnce(() =>
				stopStream({
					chunks: [
						{
							type: "tool_call_partial",
							index: 0,
							id: "call_filtered_01",
							name: "read_file",
							arguments: '{"path":"config.json"}',
						},
					],
					withUsage: true,
				}),
			)
			.mockImplementationOnce(() => {
				retrySawTool = task.assistantMessageContent.length > 0
				return asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "retry answer" }])
			})
			.mockImplementation(() => {
				throw new Error("stop after retry response")
			})

		await task.recursivelyMakeClineRequests([])

		expect(askSpy).toHaveBeenCalledWith("api_req_failed", STOP_MESSAGE)
		expect(askSpy).not.toHaveBeenCalledWith(
			"resume_task",
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		)
		expect(firstApiReqRow(task)).toMatchObject({ tokensIn: 1234, tokensOut: 5, cancelReason: "streaming_failed" })
		// The retried request starts with clean streaming state, not the truncated call.
		expect(retrySawTool).toBe(false)
		expect(attemptSpy).toHaveBeenNthCalledWith(2, 1, expect.anything())
	})

	it("retries a normal response without touching the stop path (control)", async () => {
		const task = await createTask(true)
		await seedUserTurn(task)

		const askSpy = vi.spyOn(task, "ask")
		const backoffSpy = vi.spyOn(getTaskTestAccess(task), "backoffAndAnnounce").mockResolvedValue(undefined)
		const attemptSpy = vi
			.spyOn(task, "attemptApiRequest")
			.mockImplementationOnce(() => asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "done" }]))
			.mockImplementation(() => {
				throw new Error("stop after retry response")
			})

		await task.recursivelyMakeClineRequests([])

		// The normal path never asks on api_req_failed and never retries mid-stream.
		// The second call is the standard no-tool-use continuation request.
		expect(attemptSpy).toHaveBeenNthCalledWith(1, 0, expect.objectContaining({ skipProviderRateLimit: true }))
		expect(attemptSpy).toHaveBeenCalledTimes(2)
		expect(attemptSpy).toHaveBeenNthCalledWith(2, 0, expect.anything())
		expect(askSpy).not.toHaveBeenCalledWith("api_req_failed", expect.anything())
		expect(backoffSpy).not.toHaveBeenCalled()
		const row = firstApiReqRow(task)
		expect(row.cancelReason).toBeUndefined()
	})

	it("keeps a normal empty response on its own retry path (control)", async () => {
		const task = await createTask(true)
		await seedUserTurn(task)

		const askSpy = vi
			.spyOn(task, "ask")
			.mockResolvedValue({ response: "yesButtonClicked" } as Awaited<ReturnType<Task["ask"]>>)
		const attemptSpy = vi
			.spyOn(task, "attemptApiRequest")
			.mockImplementationOnce(() => asyncStreamFrom<ApiStreamChunk>([]))
			.mockImplementationOnce(() => asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "recovered" }]))
			.mockImplementation(() => {
				throw new Error("stop after retry response")
			})

		await task.recursivelyMakeClineRequests([])

		// The empty-response path still retries with its own incremented count,
		// and the request row does not claim a content filter stop.
		expect(attemptSpy).toHaveBeenNthCalledWith(2, 1, expect.objectContaining({ skipProviderRateLimit: true }))
		const row = firstApiReqRow(task)
		expect(row.streamingFailedMessage).toBeUndefined()
		expect(row.cancelReason).toBeUndefined()
		expect(askSpy).not.toHaveBeenCalledWith("api_req_failed", STOP_MESSAGE)
	})

	it("gates a stop that lands before the first chunk and surfaces its usage", async () => {
		const task = await createTask(true)
		vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockImplementation(async () => "system prompt")
		vi.spyOn(task, "say").mockResolvedValue(undefined)

		const earlyError = new StreamStopError("content_filter", STOP_MESSAGE)
		earlyError.usage = stoppedUsage
		// The stream must fail on its first read: yielding a chunk would turn the
		// replay into a mid-stream stop, which the other tests already cover.
		const earlyStopStream: AsyncGenerator<ApiStreamChunk> = {
			[Symbol.asyncIterator]() {
				return this
			},
			next: async () => {
				throw earlyError
			},
			return: async () => ({ done: true as const, value: undefined }),
			throw: async (error?: unknown) => {
				throw error
			},
			[Symbol.asyncDispose]: async () => {},
		}

		const backoffSpy = vi.spyOn(getTaskTestAccess(task), "backoffAndAnnounce").mockResolvedValue(undefined)
		const askSpy = vi
			.spyOn(task, "ask")
			.mockResolvedValue({ response: "yesButtonClicked" } as Awaited<ReturnType<Task["ask"]>>)
		const attemptSpy = vi.spyOn(task, "attemptApiRequest")
		const createSpy = vi
			.spyOn(task.api, "createMessage")
			.mockImplementationOnce(() => earlyStopStream)
			.mockImplementation(() => asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "ok" }]))

		const iterator = task.attemptApiRequest(0)

		// The fixed first-chunk path surfaces the stopped response's usage before
		// the ask, so the task loop records it.
		const first = await iterator.next()
		expect(first.done).toBe(false)
		expect(first.value).toMatchObject({ type: "usage", inputTokens: 1234, outputTokens: 5 })

		const second = await iterator.next()
		expect(second.done).toBe(false)
		expect(second.value).toMatchObject({ type: "text", text: "ok" })

		// NoResendWithoutConsent: the ask gated the auto-approval resend, and the
		// retry started from a fresh attempt count with no second user turn.
		expect(askSpy).toHaveBeenCalledWith("api_req_failed", STOP_MESSAGE)
		expect(backoffSpy).not.toHaveBeenCalled()
		expect(createSpy).toHaveBeenCalledTimes(2)
		expect(attemptSpy.mock.calls.map(([retryAttempt]) => retryAttempt)).toEqual([0, 0])
	})
})
