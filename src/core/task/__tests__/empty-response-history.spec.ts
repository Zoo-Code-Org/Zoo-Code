import { WebviewFocusTracker } from "../../webview/WebviewFocusTracker"
// cd src && npx vitest run core/task/__tests__/empty-response-history.spec.ts
//
// Regression for issue 2691: an empty response must keep the saved user turn.
// Retries must not pop, restore, or add another copy of the tool-result turn, and
// the reloaded history must convert to exactly one tool_result per tool_use id.
// The suite drives the real retry branch in recursivelyMakeClineRequests with
// real temporary-file saves and readback; the provider stream is stubbed at
// attemptApiRequest.

import * as fsp from "fs/promises"
import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"
import type { Anthropic } from "@anthropic-ai/sdk"
import type OpenAI from "openai"

import { providerIdentifiers, type GlobalState, type ModelInfo, type ProviderSettings } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { readApiMessages, type ApiMessage } from "../../task-persistence"
import { getEffectiveApiHistory } from "../../condense"
import { mergeConsecutiveApiMessages } from "../mergeConsecutiveApiMessages"
import { convertToOpenAiMessages } from "../../../api/transform/openai-format"
import { setAbortLatch } from "../../../test-utils/run-state"
import { asyncStreamFrom } from "../../../test-utils/stream"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import * as safeWriteJsonModule from "../../../utils/safeWriteJson"

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

type TaskRetryProbe = {
	addToApiConversationHistory: (message: Anthropic.MessageParam, reasoning?: string) => Promise<void>
	safeEnsureModelFetched: () => Promise<ModelInfo>
	backoffAndAnnounce: (retryAttempt: number, error: unknown) => Promise<void>
	presentAssistantMessageSafe: () => void
	globalStoragePath: string
}

// Private members the replay drives directly; the double provides only these.
const probe = (task: Task): TaskRetryProbe => task as unknown as TaskRetryProbe

type ProviderState = Awaited<ReturnType<ClineProvider["getState"]>>

const stubModelInfo: ModelInfo = {
	contextWindow: 200_000,
	maxTokens: 8_192,
	supportsPromptCache: true,
}

const TOOL_USE_ID = "toolu_retry_01"

/** The tool_use assistant turn and its saved user result turn in the disk history. */
function findResultMessage(messages: ApiMessage[], toolUseId: string): ApiMessage | undefined {
	return messages.find(
		(message) =>
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === "tool_result" && block.tool_use_id === toolUseId),
	)
}

function countSavedResults(messages: ApiMessage[], toolUseId: string): number {
	return messages.reduce((count, message) => {
		if (message.role !== "user" || !Array.isArray(message.content)) {
			return count
		}
		return (
			count +
			message.content.filter((block) => block.type === "tool_result" && block.tool_use_id === toolUseId).length
		)
	}, 0)
}

/** The sink chain a resumed task uses: effective history, user-turn merge, then the provider conversion. */
function outgoingToolResultCount(messages: ApiMessage[], toolUseId: string): number {
	const effective = getEffectiveApiHistory(messages)
	const merged = mergeConsecutiveApiMessages(effective, { roles: ["user"] })
	const payload: OpenAI.Chat.ChatCompletionMessageParam[] = convertToOpenAiMessages(merged)
	return payload.filter((message) => message.role === "tool" && message.tool_call_id === toolUseId).length
}

async function readDiskHistory(task: Task): Promise<ApiMessage[]> {
	return readApiMessages({ taskId: task.taskId, globalStoragePath: probe(task).globalStoragePath })
}

describe("empty-response history persistence (issue 2691)", () => {
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
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "empty-response-history-"))

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

		baseProviderState = providerStateWith(await mockProvider.getState())

		mockApiConfig = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}
	})

	afterEach(async () => {
		await fsp.rm(tempRoot, { recursive: true, force: true })
	})

	interface SeedOptions {
		autoApprovalEnabled: boolean
	}

	/** Seeds user -> assistant(tool_use) through the production history path with real saves. */
	async function createTaskWithSavedToolUse({ autoApprovalEnabled }: SeedOptions): Promise<Task> {
		vi.spyOn(mockProvider, "getState").mockResolvedValue(
			providerStateWith({ autoApprovalEnabled, requestDelaySeconds: 0 }),
		)

		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "empty-response history replay",
			startTask: false,
		})

		vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
		// Stream rendering is outside this suite. Complete it without replacing ask polling.
		vi.spyOn(probe(task), "presentAssistantMessageSafe").mockImplementation(() => {
			task.userMessageContentReady = true
		})
		vi.spyOn(probe(task), "safeEnsureModelFetched").mockResolvedValue(stubModelInfo)

		await probe(task).addToApiConversationHistory({
			role: "user",
			content: [{ type: "text", text: "read the config file" }],
		})
		await probe(task).addToApiConversationHistory({
			role: "assistant",
			content: [{ type: "tool_use", id: TOOL_USE_ID, name: "read_file", input: { path: "config.json" } }],
		})
		return task
	}

	/** The mid-task loop entry: the pending tool result turn for the saved tool call. */
	function toolResultUserContent(): Anthropic.Messages.ContentBlockParam[] {
		return [{ type: "tool_result", tool_use_id: TOOL_USE_ID, content: "file contents" }]
	}

	/**
	 * First-attempt stream that reads the saved result turn from memory while it is
	 * being consumed, which is before any empty-response retry can run. The identity
	 * reader is valid once the attempt has started.
	 */
	function firstAttemptCapturingSavedIdentity(
		task: Task,
		chunks: ApiStreamChunk[],
	): {
		body: AsyncGenerator<ApiStreamChunk>
		identity: () => { messageId?: string; ts?: number }
	} {
		let captured: { messageId?: string; ts?: number } | undefined
		const body = (async function* () {
			const saved = findResultMessage(task.apiConversationHistory, TOOL_USE_ID)
			captured = { messageId: saved?.messageId, ts: saved?.ts }
			yield* chunks
		})()
		return {
			body,
			identity: () => {
				expect(captured).toBeDefined()
				return captured as { messageId?: string; ts?: number }
			},
		}
	}

	/** Keep the real ask wait pending across a poll, then deliver the webview response. */
	async function runWithRetryResponse(task: Task, response: "yesButtonClicked" | "noButtonClicked") {
		let settled = false
		const run = task.recursivelyMakeClineRequests(toolResultUserContent()).finally(() => {
			settled = true
		})
		try {
			await vi.waitFor(() => expect(task.clineMessages.at(-1)?.ask).toBe("api_req_failed"))
			// ask() polls every 100 ms. It must stay pending without a response.
			await new Promise((resolve) => setTimeout(resolve, 150))
			expect(settled).toBe(false)
			expect(countSavedResults(task.apiConversationHistory, TOOL_USE_ID)).toBe(1)
			expect(task.messageCounts.user).toBe(1)
		} finally {
			task.handleWebviewAskResponse(response)
			await run
		}
		return run
	}

	it("persists one result turn across an automatic empty-response retry with real files", async () => {
		const task = await createTaskWithSavedToolUse({ autoApprovalEnabled: true })

		const firstAttempt = firstAttemptCapturingSavedIdentity(task, [])
		const attemptApiRequestSpy = vi
			.spyOn(task, "attemptApiRequest")
			.mockImplementationOnce(() => firstAttempt.body)
			.mockImplementationOnce(() => asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "retry succeeded" }]))
			.mockImplementation(() => {
				throw new Error("stop after retry response")
			})

		await task.recursivelyMakeClineRequests(toolResultUserContent())

		const beforeRetry = firstAttempt.identity()

		// One empty attempt, one retried attempt, then the no-tool-use continuation
		// request that the final stub stops with a swallowed error.
		expect(attemptApiRequestSpy).toHaveBeenCalledTimes(3)
		// The retry reaches the request seam with its own incremented retry count.
		expect(attemptApiRequestSpy).toHaveBeenNthCalledWith(
			2,
			1,
			expect.objectContaining({ skipProviderRateLimit: true }),
		)

		const disk = await readDiskHistory(task)
		expect(countSavedResults(disk, TOOL_USE_ID)).toBe(1)
		// The retry leaves the saved turn and its identity unchanged.
		const afterRetry = findResultMessage(disk, TOOL_USE_ID)
		expect(afterRetry?.messageId).toBe(beforeRetry.messageId)
		expect(afterRetry?.ts).toBe(beforeRetry.ts)
		expect(outgoingToolResultCount(disk, TOOL_USE_ID)).toBe(1)
		// The saved turn counts once, plus
		// the separate no-tool-use continuation turn.
		expect(task.messageCounts.user).toBe(2)
	})

	it.each([1, 2, 3])("keeps one result turn across %i empty responses", async (emptyCount) => {
		const task = await createTaskWithSavedToolUse({ autoApprovalEnabled: true })

		const firstAttempt = firstAttemptCapturingSavedIdentity(task, [])
		vi.spyOn(probe(task), "backoffAndAnnounce").mockImplementation(async () => {
			expect(countSavedResults(task.apiConversationHistory, TOOL_USE_ID)).toBe(1)
			expect(findResultMessage(task.apiConversationHistory, TOOL_USE_ID)).toMatchObject(firstAttempt.identity())
			expect(task.messageCounts.user).toBe(1)
		})
		const attemptApiRequestSpy = vi.spyOn(task, "attemptApiRequest").mockImplementationOnce(() => firstAttempt.body)
		for (let attempt = 1; attempt < emptyCount; attempt++) {
			attemptApiRequestSpy.mockImplementationOnce(() => asyncStreamFrom<ApiStreamChunk>([]))
		}
		attemptApiRequestSpy
			.mockImplementationOnce(() => asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "finally answered" }]))
			.mockImplementation(() => {
				throw new Error("stop after retry response")
			})

		await task.recursivelyMakeClineRequests(toolResultUserContent())

		const beforeRetry = firstAttempt.identity()

		// Empty attempts, one answered attempt, then the stopped continuation.
		expect(attemptApiRequestSpy).toHaveBeenCalledTimes(emptyCount + 2)

		const disk = await readDiskHistory(task)
		expect(countSavedResults(disk, TOOL_USE_ID)).toBe(1)
		const afterRetry = findResultMessage(disk, TOOL_USE_ID)
		expect(afterRetry?.messageId).toBe(beforeRetry.messageId)
		expect(afterRetry?.ts).toBe(beforeRetry.ts)
		expect(outgoingToolResultCount(disk, TOOL_USE_ID)).toBe(1)
	})

	it("keeps one result turn when the retry is declined and records the failure", async () => {
		const task = await createTaskWithSavedToolUse({ autoApprovalEnabled: false })

		const firstAttempt = firstAttemptCapturingSavedIdentity(task, [])
		const attemptSpy = vi.spyOn(task, "attemptApiRequest")
		attemptSpy.mockImplementationOnce(() => firstAttempt.body)
		attemptSpy.mockImplementation(() => asyncStreamFrom<ApiStreamChunk>([]))

		const result = await runWithRetryResponse(task, "noButtonClicked")

		const beforeDecline = firstAttempt.identity()
		expect(result).toBe(false)

		const disk = await readDiskHistory(task)
		expect(countSavedResults(disk, TOOL_USE_ID)).toBe(1)
		const retained = findResultMessage(disk, TOOL_USE_ID)
		expect(retained?.messageId).toBe(beforeDecline.messageId)
		expect(retained?.ts).toBe(beforeDecline.ts)
		expect(retained?.content).toEqual(expect.arrayContaining(toolResultUserContent()))
		// The synthetic failure turn follows the retained user turn.
		expect(disk.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Failure: I did not provide a response." }],
		})
		expect(outgoingToolResultCount(disk, TOOL_USE_ID)).toBe(1)
		expect(task.messageCounts).toEqual({ user: 1, assistant: 1 })
	})

	it("keeps one result turn when the user confirms an explicit retry", async () => {
		const task = await createTaskWithSavedToolUse({ autoApprovalEnabled: false })

		const firstAttempt = firstAttemptCapturingSavedIdentity(task, [])
		const attemptApiRequestSpy = vi
			.spyOn(task, "attemptApiRequest")
			.mockImplementationOnce(() => firstAttempt.body)
			.mockImplementationOnce(() =>
				asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "explicit retry worked" }]),
			)
			.mockImplementation(() => {
				throw new Error("stop after retry response")
			})

		await runWithRetryResponse(task, "yesButtonClicked")

		// One empty attempt, one retried attempt, then the stopped continuation.
		expect(attemptApiRequestSpy).toHaveBeenCalledTimes(3)

		const disk = await readDiskHistory(task)
		expect(countSavedResults(disk, TOOL_USE_ID)).toBe(1)
		expect(findResultMessage(disk, TOOL_USE_ID)).toMatchObject(firstAttempt.identity())
		expect(findResultMessage(disk, TOOL_USE_ID)?.content).toEqual(expect.arrayContaining(toolResultUserContent()))
		expect(outgoingToolResultCount(disk, TOOL_USE_ID)).toBe(1)
	})

	it("retries an empty-content resume without adding the saved result again", async () => {
		const task = await createTaskWithSavedToolUse({ autoApprovalEnabled: true })
		await probe(task).addToApiConversationHistory({ role: "user", content: toolResultUserContent() })
		task.messageCounts.user = 1
		const firstAttempt = firstAttemptCapturingSavedIdentity(task, [])
		vi.spyOn(task, "attemptApiRequest")
			.mockImplementationOnce(() => firstAttempt.body)
			.mockImplementationOnce(() => asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "resumed" }]))
			.mockImplementation(() => {
				throw new Error("stop after retry response")
			})

		await task.recursivelyMakeClineRequests([])

		const disk = await readDiskHistory(task)
		expect(countSavedResults(disk, TOOL_USE_ID)).toBe(1)
		expect(findResultMessage(disk, TOOL_USE_ID)).toMatchObject(firstAttempt.identity())
		expect(outgoingToolResultCount(disk, TOOL_USE_ID)).toBe(1)
		expect(task.messageCounts.user).toBe(2)
	})

	it("keeps the saved history valid when no empty response occurs (control)", async () => {
		const task = await createTaskWithSavedToolUse({ autoApprovalEnabled: true })

		const firstAttempt = firstAttemptCapturingSavedIdentity(task, [{ type: "text", text: "answered first try" }])
		const attemptApiRequestSpy = vi
			.spyOn(task, "attemptApiRequest")
			.mockImplementationOnce(() => firstAttempt.body)
			.mockImplementation(() => {
				throw new Error("stop after first response")
			})

		await task.recursivelyMakeClineRequests(toolResultUserContent())

		const beforeSave = firstAttempt.identity()

		// One answered attempt, then the no-tool-use continuation that the stub stops.
		expect(attemptApiRequestSpy).toHaveBeenCalledTimes(2)

		const disk = await readDiskHistory(task)
		expect(countSavedResults(disk, TOOL_USE_ID)).toBe(1)
		const saved = findResultMessage(disk, TOOL_USE_ID)
		expect(saved?.messageId).toBe(beforeSave.messageId)
		expect(saved?.ts).toBe(beforeSave.ts)
		expect(outgoingToolResultCount(disk, TOOL_USE_ID)).toBe(1)
	})

	/**
	 * Fails the Nth save of the API conversation history (1-based, counting from
	 * now). The API history writes go through safeWriteJson, so a rejection there
	 * reaches saveApiConversationHistory without touching unrelated files.
	 */
	function injectApiHistorySaveFailure(failingWrite: number): { restore: () => void; failures: () => number } {
		const originalSafeWriteJson = safeWriteJsonModule.safeWriteJson
		let apiHistoryWrites = 0
		let failures = 0
		const writeSpy = vi.spyOn(safeWriteJsonModule, "safeWriteJson")
		writeSpy.mockImplementation(async (filePath, data, options) => {
			if (String(filePath).includes("api_conversation_history.json")) {
				apiHistoryWrites += 1
				if (apiHistoryWrites === failingWrite) {
					failures++
					throw Object.assign(new Error("injected save failure"), { code: "EACCES" })
				}
			}
			return originalSafeWriteJson(filePath, data, options)
		})
		return {
			restore: () => writeSpy.mockRestore(),
			failures: () => failures,
		}
	}

	it.each([1, 2])("keeps a single saved result when save %i fails", async (failingWrite) => {
		const task = await createTaskWithSavedToolUse({ autoApprovalEnabled: true })

		// Fail the initial result save or the assistant response save after retry.
		const injection = injectApiHistorySaveFailure(failingWrite)

		const firstAttempt = firstAttemptCapturingSavedIdentity(task, [])
		vi.spyOn(task, "attemptApiRequest")
			.mockImplementationOnce(() => firstAttempt.body)
			.mockImplementationOnce(() => asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "retry succeeded" }]))
			.mockImplementation(() => {
				throw new Error("stop after retry response")
			})

		await task.recursivelyMakeClineRequests(toolResultUserContent())

		const beforeRetry = firstAttempt.identity()
		expect(injection.failures()).toBe(1)
		injection.restore()

		const disk = await readDiskHistory(task)
		// A later save must keep one copy with the original identity.
		expect(countSavedResults(disk, TOOL_USE_ID)).toBe(1)
		const afterRetry = findResultMessage(disk, TOOL_USE_ID)
		expect(afterRetry?.messageId).toBe(beforeRetry.messageId)
		expect(afterRetry?.ts).toBe(beforeRetry.ts)
		expect(outgoingToolResultCount(disk, TOOL_USE_ID)).toBe(1)
	})

	it("keeps a single saved result when a declined retry also hits a failed save (fault injection)", async () => {
		const task = await createTaskWithSavedToolUse({ autoApprovalEnabled: false })

		// Fail the initial result save. The synthetic failure turn save flushes it.
		const injection = injectApiHistorySaveFailure(1)

		const firstAttempt = firstAttemptCapturingSavedIdentity(task, [])
		const attemptSpy = vi.spyOn(task, "attemptApiRequest")
		attemptSpy.mockImplementationOnce(() => firstAttempt.body)
		attemptSpy.mockImplementation(() => asyncStreamFrom<ApiStreamChunk>([]))

		const result = await runWithRetryResponse(task, "noButtonClicked")

		const beforeDecline = firstAttempt.identity()
		expect(result).toBe(false)
		expect(injection.failures()).toBe(1)
		injection.restore()

		const disk = await readDiskHistory(task)
		expect(countSavedResults(disk, TOOL_USE_ID)).toBe(1)
		const retained = findResultMessage(disk, TOOL_USE_ID)
		expect(retained?.messageId).toBe(beforeDecline.messageId)
		expect(retained?.ts).toBe(beforeDecline.ts)
		expect(retained?.content).toEqual(expect.arrayContaining(toolResultUserContent()))
		expect(disk.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Failure: I did not provide a response." }],
		})
		expect(outgoingToolResultCount(disk, TOOL_USE_ID)).toBe(1)
	})

	it.each(["before retry", "during backoff"])("keeps a summary saved %s", async (phase) => {
		const task = await createTaskWithSavedToolUse({ autoApprovalEnabled: true })
		const summary: ApiMessage = {
			role: "user",
			content: "Saved summary",
			messageId: "summary-1",
			ts: Date.now() + 100,
			isSummary: true,
			condenseId: "condense-1",
		}
		const condense = async () => {
			await task.overwriteApiConversationHistory([
				...task.apiConversationHistory.map((message) => ({ ...message, condenseParent: "condense-1" })),
				summary,
			])
		}
		if (phase === "during backoff") {
			vi.spyOn(probe(task), "backoffAndAnnounce").mockImplementation(condense)
		}
		let original: ApiMessage | undefined
		vi.spyOn(task, "attemptApiRequest")
			.mockImplementationOnce(() =>
				(async function* () {
					original = findResultMessage(task.apiConversationHistory, TOOL_USE_ID)
					if (phase === "before retry") await condense()
					yield* asyncStreamFrom<ApiStreamChunk>([])
				})(),
			)
			.mockImplementationOnce(() => asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "done" }]))
			.mockImplementation(() => {
				throw new Error("stop after retry")
			})

		await task.recursivelyMakeClineRequests(toolResultUserContent())

		const disk = await readDiskHistory(task)
		expect(disk.find((message) => message.messageId === summary.messageId)).toEqual(summary)
		expect(task.apiConversationHistory.find((message) => message.messageId === summary.messageId)).toEqual(summary)
		expect(getEffectiveApiHistory(disk)).toContainEqual(summary)
		expect(getEffectiveApiHistory(disk).some((message) => message.condenseParent === "condense-1")).toBe(false)
		expect(original?.messageId).toBeDefined()
		const retained = disk.filter((message) => message.messageId === original?.messageId)
		expect(retained).toHaveLength(1)
		expect(retained[0].ts).toBe(original?.ts)
		const effective = getEffectiveApiHistory(disk)
		const summaryIndex = effective.findIndex((message) => message.messageId === summary.messageId)
		// Condensation covers the retained result in either phase. No copy follows the summary.
		expect(countSavedResults(disk, TOOL_USE_ID)).toBe(1)
		expect(outgoingToolResultCount(disk, TOOL_USE_ID)).toBe(0)
		expect(disk.indexOf(retained[0])).toBeLessThan(
			disk.findIndex((message) => message.messageId === summary.messageId),
		)
		expect(retained[0].content).toEqual(expect.arrayContaining(toolResultUserContent()))
		expect(effective).not.toContainEqual(retained[0])
		expect(effective[summaryIndex + 1]?.role).toBe("assistant")
		// The summary and the no-tool-use continuation are the only effective user turns.
		expect(effective.filter((message) => message.role === "user")).toHaveLength(2)
		expect(task.messageCounts.user).toBe(2)
	})

	it("keeps the saved history valid when the task is cancelled during the retry backoff", async () => {
		const task = await createTaskWithSavedToolUse({ autoApprovalEnabled: true })

		// Cancel during the automatic retry backoff with the result still in history.
		vi.spyOn(probe(task), "backoffAndAnnounce").mockImplementation(async () => {
			setAbortLatch(task, true)
		})
		vi.spyOn(task, "attemptApiRequest").mockImplementation(() => asyncStreamFrom<ApiStreamChunk>([]))

		const result = await task.recursivelyMakeClineRequests(toolResultUserContent())

		expect(result).toBe(false)

		const disk = await readDiskHistory(task)
		// Cancellation keeps the original saved result in memory and on disk.
		expect(countSavedResults(disk, TOOL_USE_ID)).toBe(1)
		expect(outgoingToolResultCount(disk, TOOL_USE_ID)).toBe(1)
		expect(countSavedResults(task.apiConversationHistory, TOOL_USE_ID)).toBe(1)
		expect(task.messageCounts.user).toBe(1)
	})
})
