import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { Task } from "../Task"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { ClineProvider } from "../../webview/ClineProvider"
import { WebviewFocusTracker } from "../../webview/WebviewFocusTracker"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import type { ProviderSettings } from "@roo-code/types"
import { ApiStreamChunk } from "../../../api/transform/stream"
import { ContextProxy } from "../../config/ContextProxy"
import { TelemetryService } from "@roo-code/telemetry"
import { asyncStreamFrom } from "../../../test-utils/stream"

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

// (review r11 4725371062) Passthrough wrapper around the real p-wait-for:
// every predicate is retained -- the real loop still polls it -- but each
// call records its false polls and flips a resolved flag when its predicate
// first returns true. The readiness gates read command 2's record to prove
// the approval wait itself is live and consumes its own approval, not
// merely that the armed slot is installed.
type WaitPredicateRecord = { falsePolls: number; resolved: boolean; intervalMs: number }
const waitRecordsStore = globalThis as unknown as { __batchWaitRecords?: WaitPredicateRecord[] }
const waitRecords = (): WaitPredicateRecord[] => (waitRecordsStore.__batchWaitRecords ??= [])
vi.mock("p-wait-for", async (importOriginal) => {
	const actual = await importOriginal<typeof import("p-wait-for")>()
	// The factory runs while Task.ts is still importing (vi.mock is
	// hoisted), so the shared store is read from globalThis here, not from
	// the module-level helper whose initialization has not run yet.
	const records = ((globalThis as unknown as { __batchWaitRecords?: WaitPredicateRecord[] }).__batchWaitRecords ??=
		[])
	return {
		__esModule: true,
		default: async (
			predicate: () => boolean | Promise<boolean>,
			options?: Parameters<typeof actual.default>[1],
		): Promise<void> => {
			const record: WaitPredicateRecord = {
				falsePolls: 0,
				resolved: false,
				intervalMs: (options as { interval?: number } | undefined)?.interval ?? 50,
			}
			records.push(record)
			const wrapped = async () => {
				const result = await predicate()
				if (result) {
					record.resolved = true
					return true
				}
				record.falsePolls += 1
				return false
			}
			await actual.default(wrapped, options)
		},
	}
})

vi.mock("uuid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("uuid")>()
	let n = 0
	return {
		...actual,
		v4: vi.fn(() => `batch-uuid-${++n}`),
		v7: vi.fn(() => `batch-uuid-${++n}`),
	}
})

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockImplementation((filePath) => {
			if (filePath.includes("ui_messages.json")) {
				return Promise.resolve(JSON.stringify([]))
			}
			if (filePath.includes("api_conversation_history.json")) {
				return Promise.resolve(JSON.stringify([]))
			}
			return Promise.resolve("[]")
		}),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		stat: vi.fn().mockRejectedValue({ code: "ENOENT" }),
		readdir: vi.fn().mockResolvedValue([]),
	}

	return {
		...actual,
		...mockFunctions,
		default: mockFunctions,
	}
})

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockImplementation((filePath) => {
		return filePath.includes("ui_messages.json") || filePath.includes("api_conversation_history.json")
	}),
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
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
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
			getConfiguration: vi.fn(() => ({ get: <T>(_key: string, defaultValue: T) => defaultValue })),
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
		RelativePattern: class RelativePattern {
			constructor(
				public path: string,
				public pattern: string,
			) {}
		},
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text) => {
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

vi.mock("../../condense", async (importOriginal) => {
	return {
		...((await importOriginal()) as Record<string, unknown>),
		summarizeConversation: vi.fn().mockResolvedValue({
			messages: [{ role: "user", content: [{ type: "text", text: "continued" }], ts: Date.now() }],
			summary: "summary",
			cost: 0,
			newContextTokens: 1,
		}),
	}
})

function commandChunks(): ApiStreamChunk[] {
	return [
		{
			type: "tool_call_partial",
			index: 0,
			id: "toolu_cmd1",
			name: "execute_command",
			arguments: '{"command":"echo \\"cmd1\\""}',
		},
		{
			type: "tool_call_partial",
			index: 1,
			id: "toolu_cmd2",
			name: "execute_command",
			arguments: '{"command":"echo \\"cmd2\\""}',
		},
		{
			type: "tool_call_partial",
			index: 2,
			id: "toolu_cmd3",
			name: "execute_command",
			arguments: '{"command":"echo \\"cmd3\\""}',
		},
	]
}

type BatchTaskAccess = {
	requestPolicySnapshot: Record<string, unknown> | undefined
	safeEnsureModelFetched: () => Promise<unknown>
	saveClineMessages: () => Promise<boolean>
	addToClineMessages: (msg: unknown, beforeEmit?: () => void) => Promise<unknown>
	attemptApiRequest: () => AsyncIterable<ApiStreamChunk>
	userMessageContent: Array<{ type: string; tool_use_id?: string }>
	// The ask arm writes the waiting ask's row ts after its publication
	// boundary; the readiness gates below read it as the live-wait signal.
	awaitingAskTargetRowTs?: number
}

describe("Task - multi-command approval in one request (issue 998)", () => {
	let mockProvider: ClineProvider
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: vscode.OutputChannel
	let scope: object
	let mockExtensionContext: vscode.ExtensionContext
	// Tasks created by the current test and their request-loop promises: the
	// tests end while a command ask still waits, so teardown must abort each
	// task and drain its loop before the parser state is cleared.
	const active: Array<{ task: Task; settled?: Promise<unknown> }> = []

	beforeEach(async () => {
		waitRecords().length = 0
		scope = NativeToolCallParser.createScope()
		NativeToolCallParser.clearAllStreamingToolCalls(scope)
		NativeToolCallParser.clearRawChunkState(scope)

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const storageUri = { fsPath: path.join(os.tmpdir(), "batch-approval-storage") }

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					if (key === "taskHistory") {
						return []
					}
					return undefined
				}),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
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
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			name: "test-output",
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
			replace: vi.fn(),
		}

		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
			new WebviewFocusTracker(),
		)

		mockApiConfig = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "batch-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.getTaskWithId = vi.fn().mockResolvedValue(null)

		const state = await mockProvider.getState()
		vi.spyOn(mockProvider, "getState").mockResolvedValue({
			...state,
			apiConfiguration: mockApiConfig,
			autoApprovalEnabled: false,
			requestDelaySeconds: 0,
			mode: "code",
			customModes: [],
			disabledTools: [],
			experiments: {},
			profileThresholds: {},
		})
	})

	afterEach(async () => {
		// Stop the ask pollers and request loops this test leaves behind: the
		// tests end mid-approval on purpose, so abort each task and drain its
		// loop before clearing the parser scope. A timeout here is a failure,
		// not a tolerated leak (review 6084536709 follow-up 4712539065): a
		// loop that never settles keeps its ask poller alive into the next
		// test, so the pending ask must settle before the parser state clears.
		for (const { task, settled } of active.splice(0)) {
			const aborted = await Promise.race([
				task.abortTask().catch(() => undefined),
				new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000)),
			])
			if (aborted === "timeout") {
				throw new Error(`teardown: abortTask did not settle within 2000ms for task ${task.taskId}`)
			}
			if (settled) {
				const outcome = await Promise.race([
					settled.then(() => "settled"),
					new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000)),
				])
				if (outcome === "timeout") {
					throw new Error(
						`teardown: request loop did not settle within 2000ms after abort for task ${task.taskId}`,
					)
				}
			}
		}
		NativeToolCallParser.clearAllStreamingToolCalls(scope)
		NativeToolCallParser.clearRawChunkState(scope)
	})

	function createTask(): Task {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "batch task",
			startTask: false,
		})
		const entry: { task: Task; settled?: Promise<unknown> } = { task }
		active.push(entry)
		const access = task as unknown as BatchTaskAccess
		vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
		// The real attemptApiRequest captures the frozen tool policy before
		// streaming; the mock below bypasses that, so stage it here.
		access.requestPolicySnapshot = { disabledTools: [], experiments: {}, customModes: [] }
		vi.spyOn(access, "safeEnsureModelFetched").mockResolvedValue({
			id: mockApiConfig.apiModelId!,
			maxTokens: 8192,
			contextWindow: 180000,
			supportsImages: false,
			inputPrice: 0.3,
			outputPrice: 1.5,
		})
		vi.spyOn(access, "saveClineMessages").mockResolvedValue(true)
		return task
	}

	function runThreeCommandRequest(task: Task): { settled: Promise<unknown>; apiCalls: () => number } {
		const access = task as unknown as BatchTaskAccess
		let calls = 0
		vi.spyOn(access, "attemptApiRequest").mockImplementation(() => {
			calls++
			if (calls === 1) {
				return asyncStreamFrom<ApiStreamChunk>(commandChunks())
			}
			throw new Error("BATCH-END-OF-REQUESTS")
		})
		const settled = task.recursivelyMakeClineRequests([{ type: "text", text: "test" }]).catch((e) => e)
		const entry = active.find((candidate) => candidate.task === task)
		if (entry) {
			entry.settled = settled
		}
		return {
			settled,
			apiCalls: () => calls,
		}
	}

	const settleWindow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2000))

	it("shows a separate prompt for each command and runs only the approved one", async () => {
		const task = createTask()
		const { settled } = runThreeCommandRequest(task)
		const access = task as unknown as BatchTaskAccess

		await vi.waitFor(
			() => {
				const ask = task.clineMessages.find((m) => m.type === "ask" && m.ask === "command" && !m.partial)
				if (!ask) {
					throw new Error("no complete command ask yet")
				}
			},
			{ timeout: 5000, interval: 50 },
		)
		task.approveAsk()
		// Readiness gate (review r9 4724196978, r10 4724737729): a result
		// absence plus a pending loop cannot distinguish a live approval wait
		// from a request that stalled before publishing command 2. The row
		// lands in memory before its publication awaits settle, so the gate
		// also requires the armed slot: it carries the row's own ts only
		// after the publication boundary and the arm ran.
		await vi.waitFor(
			() => {
				const second = task.clineMessages.find(
					(m) =>
						m.type === "ask" &&
						m.ask === "command" &&
						!m.partial &&
						!m.isAnswered &&
						(m.text ?? "").includes("cmd2"),
				)
				if (!second) {
					throw new Error("command 2 prompt not published yet")
				}
				if (access.awaitingAskTargetRowTs !== second.ts) {
					throw new Error("command 2 ask target not armed yet")
				}
			},
			{ timeout: 5000, interval: 50 },
		)
		await settleWindow()
		// Entry into the approval wait (review r10 4724737729, r11
		// 4725371062): the arm survived the settle window with no response
		// recorded, so the wait loop is live on command 2's token, not
		// stalled before publication. The armed slot alone cannot prove that
		// -- the arm runs inside the publication while Task.ask enters
		// pWaitFor only after the save and drain awaits -- so the gate reads
		// command 2's own wait record: the retained real predicate must have
		// polled false while the ask stayed pending.
		const cmd2Wait = await vi.waitFor(() => {
			// The ask wait at Task.ask polls on the 100ms interval it passes
			// to pWaitFor; the presenter's between-requests wait runs on the
			// 50ms default and command 1's wait already resolved (its approval
			// flipped it). Interval 100 plus false polls plus unresolved is
			// therefore exactly command 2's own approval wait: the retained
			// real predicate is live and waiting on command 2's token.
			const live = waitRecords().filter(
				(record) => record.falsePolls > 0 && !record.resolved && record.intervalMs === 100,
			)
			if (live.length !== 1) {
				throw new Error(`expected command 2's approval wait to be polling, found ${live.length}`)
			}
			return live[0]
		})
		const liveAsk = task.clineMessages.find(
			(m) =>
				m.type === "ask" &&
				m.ask === "command" &&
				!m.partial &&
				!m.isAnswered &&
				(m.text ?? "").includes("cmd2"),
		)
		if (!liveAsk || access.awaitingAskTargetRowTs !== liveAsk.ts) {
			throw new Error("command 2 approval wait not live")
		}

		const commandAsks = task.clineMessages.filter((m) => m.type === "ask" && m.ask === "command" && !m.partial)
		const toolResults = access.userMessageContent.filter((b) => b.type === "tool_result")
		const resultIds = toolResults.map((r) => r.tool_use_id)

		// The approved command produced its result; the second command shows its
		// own prompt and the loop is still waiting on it.
		expect(resultIds).toContain("toolu_cmd1")
		expect(resultIds).not.toContain("toolu_cmd2")
		expect(resultIds).not.toContain("toolu_cmd3")
		expect(commandAsks.length).toBeGreaterThanOrEqual(2)
		const loopOutcome = await Promise.race([settled.then(() => "ended"), settleWindow().then(() => "waiting")])
		expect(loopOutcome).toBe("waiting")

		// The retained real predicate resolves only through command 2's own
		// approval (review r11 4725371062): clicking Run flips the recorded
		// predicate, and the request loop then ends instead of waiting.
		task.approveAsk()
		await vi.waitFor(() => {
			if (!cmd2Wait.resolved) {
				throw new Error("command 2 approval-wait predicate has not observed its approval")
			}
		})
		// Approving command 2 advances the stream: the remaining command
		// prompts in turn, and approving the last one lets the request loop
		// reach the mocked end of requests (attemptApiRequest throws on call
		// 2) and settle. A prompt with no pending approval and no settlement
		// would mean the loop stalled outside the wait under test.
		while (true) {
			const settledNow = await Promise.race([
				settled.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
			])
			if (settledNow) {
				break
			}
			const pendingAsk = task.clineMessages.find(
				(m) => m.type === "ask" && m.ask === "command" && !m.partial && !m.isAnswered,
			)
			if (!pendingAsk) {
				throw new Error("request loop neither settled nor shows a pending command approval")
			}
			task.approveAsk()
		}
	}, 30000)

	it("does not run the next command when an orphan click lands in its entry window", async () => {
		const task = createTask()
		const access = task as unknown as BatchTaskAccess
		const realAdd = access.addToClineMessages.bind(task) as (
			msg: unknown,
			beforeEmit?: () => void,
		) => Promise<unknown>
		let commandAskCount = 0
		// (review 6079358113 follow-up 4714138962) The duplicate click must
		// deliver DURING the publication flush -- after the row is in memory
		// and on its way to the webview, before the arm runs -- not before
		// the add starts. The second unanswered ask's flush is parked so the
		// click lands inside that await; the entry reset cannot wipe this
		// orphan, so the wait predicate itself must drop it.
		let parkNextFlush = false
		let releaseParkedFlush: (() => void) | undefined
		vi.spyOn(mockProvider, "flushPostStateToWebviewThrottled").mockImplementation(async () => {
			if (!parkNextFlush) {
				return
			}
			parkNextFlush = false
			await new Promise<void>((resolve) => {
				releaseParkedFlush = () => {
					releaseParkedFlush = undefined
					resolve()
				}
			})
		})
		access.addToClineMessages = async (msg: unknown, beforeEmit?: () => void) => {
			const isCommandAsk =
				typeof msg === "object" &&
				msg !== null &&
				(msg as { type?: string; ask?: string }).type === "ask" &&
				(msg as { type?: string; ask?: string }).ask === "command"
			if (isCommandAsk) {
				commandAskCount++
			}
			if (isCommandAsk && commandAskCount === 2) {
				parkNextFlush = true
				const addPromise = realAdd(msg, beforeEmit)
				// The add parks inside the flush await: the row is in memory,
				// the arm has not run. Deliver the duplicate click of the first
				// approval now, then release the publication.
				await vi.waitFor(() => {
					if (releaseParkedFlush === undefined) {
						throw new Error("second ask flush not parked yet")
					}
				})
				task.handleWebviewAskResponse("yesButtonClicked")
				releaseParkedFlush?.()
				return addPromise
			}
			return realAdd(msg, beforeEmit)
		}
		const { settled } = runThreeCommandRequest(task)
		await vi.waitFor(
			() => {
				const ask = task.clineMessages.find((m) => m.type === "ask" && m.ask === "command" && !m.partial)
				if (!ask) {
					throw new Error("no complete command ask yet")
				}
			},
			{ timeout: 5000, interval: 50 },
		)
		task.approveAsk()
		// The same readiness gate (review r9 4724196978, r10 4724737729): the
		// orphan verdict needs command 2's prompt on the record, so a stalled
		// request cannot read as a live approval wait. The armed slot is the
		// publication evidence: it holds the row's ts only after the
		// publication boundary and the arm ran.
		await vi.waitFor(
			() => {
				const second = task.clineMessages.find(
					(m) =>
						m.type === "ask" &&
						m.ask === "command" &&
						!m.partial &&
						!m.isAnswered &&
						(m.text ?? "").includes("cmd2"),
				)
				if (!second) {
					throw new Error("command 2 prompt not published yet")
				}
				if (access.awaitingAskTargetRowTs !== second.ts) {
					throw new Error("command 2 ask target not armed yet")
				}
			},
			{ timeout: 5000, interval: 50 },
		)
		await settleWindow()
		// Entry into the approval wait (review r10 4724737729, r11
		// 4725371062): the arm survived the settle window with no response
		// recorded, so the wait loop is live on command 2's token, not
		// stalled before publication. The armed slot alone cannot prove that
		// -- the arm runs inside the publication while Task.ask enters
		// pWaitFor only after the save and drain awaits -- so the gate reads
		// command 2's own wait record: the retained real predicate must have
		// polled false while the ask stayed pending.
		const cmd2Wait = await vi.waitFor(() => {
			// The ask wait at Task.ask polls on the 100ms interval it passes
			// to pWaitFor; the presenter's between-requests wait runs on the
			// 50ms default and command 1's wait already resolved (its approval
			// flipped it). Interval 100 plus false polls plus unresolved is
			// therefore exactly command 2's own approval wait: the retained
			// real predicate is live and waiting on command 2's token.
			const live = waitRecords().filter(
				(record) => record.falsePolls > 0 && !record.resolved && record.intervalMs === 100,
			)
			if (live.length !== 1) {
				throw new Error(`expected command 2's approval wait to be polling, found ${live.length}`)
			}
			return live[0]
		})
		const liveAsk = task.clineMessages.find(
			(m) =>
				m.type === "ask" &&
				m.ask === "command" &&
				!m.partial &&
				!m.isAnswered &&
				(m.text ?? "").includes("cmd2"),
		)
		if (!liveAsk || access.awaitingAskTargetRowTs !== liveAsk.ts) {
			throw new Error("command 2 approval wait not live")
		}

		const toolResults = access.userMessageContent.filter((b) => b.type === "tool_result")
		const resultIds = toolResults.map((r) => r.tool_use_id)

		// The orphan click satisfied the first ask only. The second command must
		// still be waiting for its own approval, not executing on the orphan.
		expect(resultIds).toContain("toolu_cmd1")
		expect(resultIds).not.toContain("toolu_cmd2")
		expect(resultIds).not.toContain("toolu_cmd3")

		const loopOutcome = await Promise.race([settled.then(() => "ended"), settleWindow().then(() => "waiting")])
		expect(loopOutcome).toBe("waiting")

		// The orphan never answers command 2: its own approval does (review
		// r11 4725371062). The retained real predicate flips only through the
		// response routed to command 2's token, and the loop then ends.
		task.approveAsk()
		await vi.waitFor(() => {
			if (!cmd2Wait.resolved) {
				throw new Error("command 2 approval-wait predicate has not observed its approval")
			}
		})
		// Approving command 2 advances the stream: the remaining command
		// prompts in turn, and approving the last one lets the request loop
		// reach the mocked end of requests (attemptApiRequest throws on call
		// 2) and settle. A prompt with no pending approval and no settlement
		// would mean the loop stalled outside the wait under test.
		while (true) {
			const settledNow = await Promise.race([
				settled.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
			])
			if (settledNow) {
				break
			}
			const pendingAsk = task.clineMessages.find(
				(m) => m.type === "ask" && m.ask === "command" && !m.partial && !m.isAnswered,
			)
			if (!pendingAsk) {
				throw new Error("request loop neither settled nor shows a pending command approval")
			}
			task.approveAsk()
		}
	}, 30000)
})
