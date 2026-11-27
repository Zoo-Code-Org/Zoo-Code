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

// Mock delay before any imports that might use it
vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("uuid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("uuid")>()
	return {
		...actual,
		v7: vi.fn(() => "00000000-0000-7000-8000-000000000000"),
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

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
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
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		summarizeConversation: vi.fn().mockResolvedValue({
			messages: [{ role: "user", content: [{ type: "text", text: "continued" }], ts: Date.now() }],
			summary: "summary",
			cost: 0,
			newContextTokens: 1,
		}),
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

describe("Task - XML tool salvage (issue #547 defect 4)", () => {
	let mockProvider: ClineProvider
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: vscode.OutputChannel
	let scope: object
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(async () => {
		scope = NativeToolCallParser.createScope()
		NativeToolCallParser.clearAllStreamingToolCalls(scope)
		NativeToolCallParser.clearRawChunkState(scope)

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const storageUri = {
			fsPath: path.join(os.tmpdir(), "test-storage"),
		}

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
			extensionUri: {
				fsPath: "/mock/extension/path",
			},
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
			apiKey: "test-api-key",
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
			mode: "assistant",
			customModes: [],
			disabledTools: [],
			experiments: {},
			profileThresholds: {},
		})
	})

	afterEach(async () => {
		// The provider registers itself in the static ClineProvider.activeInstances
		// set on construction and only dispose() removes it; stale entries leak
		// into later tests' visible-instance lookups (review 4712438417). Dispose
		// first so the teardown never depends on parser fixture state.
		await mockProvider.dispose()
		NativeToolCallParser.clearAllStreamingToolCalls(scope)
		NativeToolCallParser.clearRawChunkState(scope)
	})

	describe("promotes and guards XML salvage", () => {
		// Structural access to the private Task state these tests assert against.
		type TaskStreamingTestAccess = {
			safeEnsureModelFetched: () => Promise<unknown>
			presentAssistantMessageSafe: () => void
			saveClineMessages: () => Promise<boolean>
			streamingToolCallIndices: Map<string, number>
			assistantMessageContent: unknown[]
		}

		function getTaskStreamingAccess(task: Task): TaskStreamingTestAccess {
			return task as unknown as TaskStreamingTestAccess
		}

		type TaskSalvageAccess = TaskStreamingTestAccess & {
			consecutiveNoToolUseCount: number
			userMessageContent: unknown[]
		}

		function getSalvageAccess(task: Task): TaskSalvageAccess {
			return task as unknown as TaskSalvageAccess
		}

		type FinalizedEntry = {
			type: string
			name: string
			id?: string
			partial: boolean
			content?: string
			nativeArgs?: Record<string, unknown>
		}

		// Replaces the plain counter field with a recording accessor so a test can
		// observe its peak across the request loop even after a later iteration
		// resets it.
		function recordNoToolUsePeak(task: Task): { peak: () => number } {
			let value = 0
			let peak = 0
			Object.defineProperty(getSalvageAccess(task), "consecutiveNoToolUseCount", {
				configurable: true,
				get: () => value,
				set: (next: number) => {
					value = next
					peak = Math.max(peak, next)
				},
			})
			return { peak: () => peak }
		}

		type ApiHistoryMessage = { role: string; content: unknown }
		type ApiHistoryAccess = {
			addToApiConversationHistory: (message: ApiHistoryMessage, reasoning?: string) => Promise<void>
		}

		// Captures the assistant entries as they reach the API history sink while
		// still running the real write. The history entry is built AFTER the
		// salvage decision, so a rejected response's entry shows the text the
		// salvage kept — a pre-salvage save snapshot cannot see a later clear
		// (review round 3, additional comment on 4712438423).
		function recordApiHistoryEntries(task: Task): { assistantEntries: ApiHistoryMessage[] } {
			const assistantEntries: ApiHistoryMessage[] = []
			const access = task as unknown as ApiHistoryAccess
			const original = access.addToApiConversationHistory.bind(task)
			vi.spyOn(access, "addToApiConversationHistory").mockImplementation(async (message, reasoning) => {
				if (message.role === "assistant") {
					assistantEntries.push({
						role: message.role,
						content: Array.isArray(message.content)
							? message.content.map((block) => ({ ...(block as Record<string, unknown>) }))
							: message.content,
					})
				}
				return original(message, reasoning)
			})
			return { assistantEntries }
		}

		async function createStreamingTask(options: { consecutiveMistakeLimit?: number } = {}) {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
				consecutiveMistakeLimit: options.consecutiveMistakeLimit,
			})
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			vi.spyOn(getTaskStreamingAccess(task), "safeEnsureModelFetched").mockResolvedValue({
				id: mockApiConfig.apiModelId!,
				maxTokens: 8192,
				contextWindow: 180000,
				supportsImages: false,
				inputPrice: 0.3,
				outputPrice: 1.5,
			})
			vi.spyOn(getTaskStreamingAccess(task), "presentAssistantMessageSafe").mockImplementation(() => {})
			vi.spyOn(getTaskStreamingAccess(task), "saveClineMessages").mockResolvedValue(true)
			return task
		}

		it("promotes an XML-only response into a native tool_use block", async () => {
			const task = await createStreamingTask()
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "<read_file><path>a.ts</path></read_file>" }]),
			)

			await task.recursivelyMakeClineRequests([{ type: "text", text: "test" }])

			const access = getSalvageAccess(task)
			const content = access.assistantMessageContent as FinalizedEntry[]
			const salvagedBlocks = content.filter((block) => block.type === "tool_use")
			expect(salvagedBlocks).toHaveLength(1)
			expect(salvagedBlocks[0].name).toBe("read_file")
			expect(salvagedBlocks[0].partial).toBe(false)
			expect(salvagedBlocks[0].nativeArgs).toMatchObject({ path: "a.ts" })
			// The turn must not count as a no-tool-use failure.
			expect(access.consecutiveNoToolUseCount).toBe(0)
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Salvaged 1 XML tool call"))
			warnSpy.mockRestore()
		})

		it("does not salvage XML text beside a native tool call in the same response (review 4716476974)", async () => {
			const task = await createStreamingTask()
			const { assistantEntries } = recordApiHistoryEntries(task)

			vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				asyncStreamFrom<ApiStreamChunk>([
					{
						type: "tool_call",
						id: "toolu_native_precedence",
						name: "write_to_file",
						arguments: '{"path":"b.ts","content":"hi"}',
					},
					{ type: "text", text: "<read_file><path>a.ts</path></read_file>" },
				]),
			)

			await task.recursivelyMakeClineRequests([{ type: "text", text: "test" }])

			// A native tool call wins: the salvage guard must not add a
			// second channel, so the full tool array contains only the
			// native call.
			const content = getSalvageAccess(task).assistantMessageContent as FinalizedEntry[]
			const toolUses = content.filter((block) => block.type === "tool_use")
			expect(toolUses).toHaveLength(1)
			expect(toolUses[0].name).toBe("write_to_file")
			expect(toolUses[0].id).toBe("toolu_native_precedence")
			// The XML text is not consumed by a salvage: the API history
			// retains it alongside the native tool_use.
			expect(assistantEntries.length).toBeGreaterThan(0)
			const entryBlocks = assistantEntries[0].content as Array<{ type: string; text?: string; name?: string }>
			expect(entryBlocks.find((block) => block.type === "text")?.text).toBe(
				"<read_file><path>a.ts</path></read_file>",
			)
			expect(entryBlocks.filter((block) => block.type === "tool_use").map((block) => block.name)).toStrictEqual([
				"write_to_file",
			])
		})

		it("converts a number-declared timeout before native parsing (review 4716476981)", async () => {
			const task = await createStreamingTask()
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				asyncStreamFrom<ApiStreamChunk>([
					{
						type: "text",
						text: "<execute_command><command>npm run dev</command><cwd>/test/workspace</cwd><timeout>5</timeout></execute_command>",
					},
				]),
			)

			await task.recursivelyMakeClineRequests([{ type: "text", text: "test" }])

			const content = getSalvageAccess(task).assistantMessageContent as FinalizedEntry[]
			const salvagedBlocks = content.filter((block) => block.type === "tool_use")
			expect(salvagedBlocks).toHaveLength(1)
			expect(salvagedBlocks[0].name).toBe("execute_command")
			// The schema declares timeout ["number","null"]; the XML text
			// must be promoted as the number 5. The pre-fix promotion kept
			// the string "5", which resolveAgentTimeoutMs converts to zero —
			// the command then never enters the background after 5 seconds
			// and the turn waits until the process exits or the user
			// intervenes.
			expect(salvagedBlocks[0].nativeArgs).toStrictEqual({
				command: "npm run dev",
				cwd: "/test/workspace",
				timeout: 5,
			})
			warnSpy.mockRestore()
		})

		it("leaves prose-wrapped XML alone (no false promotion)", async () => {
			const task = await createStreamingTask()
			const counter = recordNoToolUsePeak(task)
			const { assistantEntries } = recordApiHistoryEntries(task)

			vi.spyOn(task, "attemptApiRequest")
				.mockImplementationOnce(() =>
					asyncStreamFrom<ApiStreamChunk>([
						{
							type: "text",
							text: "I will check the file now: <read_file><path>a.ts</path></read_file>",
						},
					]),
				)
				.mockImplementationOnce(() =>
					asyncStreamFrom<ApiStreamChunk>([
						{
							type: "tool_call",
							id: "toolu_native",
							name: "write_to_file",
							arguments: '{"path":"b.ts","content":"hi"}',
						},
					]),
				)

			await task.recursivelyMakeClineRequests([{ type: "text", text: "test" }])

			const content = getSalvageAccess(task).assistantMessageContent as FinalizedEntry[]
			const toolUses = content.filter((block) => block.type === "tool_use")
			expect(toolUses).toHaveLength(1)
			expect(toolUses[0].name).toBe("write_to_file")
			expect(counter.peak()).toBe(1)
			// The rejected response stays plain text: the first assistant
			// API-history entry is built after the salvage decision, so it
			// shows the retained full text and no promoted tool_use (review
			// 4712438423, round-3 additional comment).
			expect(assistantEntries.length).toBeGreaterThan(0)
			const rejectedBlocks = assistantEntries[0].content as Array<{ type: string; text?: string }>
			expect(rejectedBlocks.some((block) => block.type === "tool_use")).toBe(false)
			expect(rejectedBlocks.find((block) => block.type === "text")?.text).toBe(
				"I will check the file now: <read_file><path>a.ts</path></read_file>",
			)
		})

		it("promotes several XML blocks in order", async () => {
			const task = await createStreamingTask()

			vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				asyncStreamFrom<ApiStreamChunk>([
					{
						type: "text",
						text: "<read_file><path>a.ts</path></read_file>\n<write_to_file><path>b.ts</path><content>hi</content></write_to_file>",
					},
				]),
			)

			await task.recursivelyMakeClineRequests([{ type: "text", text: "test" }])

			const content = getSalvageAccess(task).assistantMessageContent as FinalizedEntry[]
			const salvagedBlocks = content.filter((block) => block.type === "tool_use")
			expect(salvagedBlocks.map((block) => block.name)).toStrictEqual(["read_file", "write_to_file"])
		})

		it("keeps malformed tool XML as text instead of promoting a broken call", async () => {
			const task = await createStreamingTask()
			const counter = recordNoToolUsePeak(task)
			const { assistantEntries } = recordApiHistoryEntries(task)

			vi.spyOn(task, "attemptApiRequest")
				.mockImplementationOnce(() =>
					asyncStreamFrom<ApiStreamChunk>([
						{
							type: "text",
							text: "<read_file><read_file><path>a.ts</path></read_file></read_file>",
						},
					]),
				)
				.mockImplementationOnce(() =>
					asyncStreamFrom<ApiStreamChunk>([
						{
							type: "tool_call",
							id: "toolu_native2",
							name: "read_file",
							arguments: '{"path":"b.ts"}',
						},
					]),
				)

			await task.recursivelyMakeClineRequests([{ type: "text", text: "test" }])

			const content = getSalvageAccess(task).assistantMessageContent as FinalizedEntry[]
			const toolUses = content.filter((block) => block.type === "tool_use")
			expect(toolUses).toHaveLength(1)
			expect(toolUses[0].nativeArgs).toMatchObject({ path: "b.ts" })
			expect(counter.peak()).toBe(1)
			// The rejected nested-XML response stays plain text: the first
			// assistant API-history entry is built after the salvage
			// decision (review 4712438423, round-3 additional comment).
			expect(assistantEntries.length).toBeGreaterThan(0)
			const rejectedBlocks = assistantEntries[0].content as Array<{ type: string; text?: string }>
			expect(rejectedBlocks.some((block) => block.type === "tool_use")).toBe(false)
			expect(rejectedBlocks.find((block) => block.type === "text")?.text).toBe(
				"<read_file><read_file><path>a.ts</path></read_file></read_file>",
			)
		})

		it("promotes neither call when a valid call is followed by a parser-rejected one (review 4712438440)", async () => {
			const task = await createStreamingTask()
			const counter = recordNoToolUsePeak(task)
			const { assistantEntries } = recordApiHistoryEntries(task)

			vi.spyOn(task, "attemptApiRequest")
				.mockImplementationOnce(() =>
					asyncStreamFrom<ApiStreamChunk>([
						{
							type: "text",
							text: "<read_file><path>a.ts</path></read_file><read_file></read_file>",
						},
					]),
				)
				.mockImplementationOnce(() =>
					asyncStreamFrom<ApiStreamChunk>([
						{
							type: "tool_call",
							id: "toolu_native3",
							name: "write_to_file",
							arguments: '{"path":"b.ts","content":"hi"}',
						},
					]),
				)

			await task.recursivelyMakeClineRequests([{ type: "text", text: "test" }])

			// The parser rejects the pathless call, so the valid call staged
			// before it is discarded too: failure promotes nothing and the
			// complete response text is preserved. The first assistant
			// API-history entry is built after the salvage decision, so it
			// shows the retained full text and no promoted tool_use (review
			// 4712438423, round-3 additional comment).
			expect(assistantEntries.length).toBeGreaterThan(0)
			const rejectedBlocks = assistantEntries[0].content as Array<{ type: string; text?: string }>
			expect(rejectedBlocks.some((block) => block.type === "tool_use")).toBe(false)
			expect(rejectedBlocks.find((block) => block.type === "text")?.text).toBe(
				"<read_file><path>a.ts</path></read_file><read_file></read_file>",
			)
			expect(counter.peak()).toBe(1)
			// The retry's native call is the only tool_use in the content.
			const content = getSalvageAccess(task).assistantMessageContent as FinalizedEntry[]
			const toolUses = content.filter((block) => block.type === "tool_use")
			expect(toolUses).toHaveLength(1)
			expect(toolUses[0].name).toBe("write_to_file")
			expect(toolUses[0].nativeArgs).toMatchObject({ path: "b.ts" })
		})

		it("converts stringified structured parameters before native parsing (review 4712438429)", async () => {
			const task = await createStreamingTask()
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				asyncStreamFrom<ApiStreamChunk>([
					{
						type: "text",
						text: '<ask_followup_question><question>Continue?</question><follow_up>[{"text":"Yes"}]</follow_up></ask_followup_question>',
					},
				]),
			)

			await task.recursivelyMakeClineRequests([{ type: "text", text: "test" }])

			const content = getSalvageAccess(task).assistantMessageContent as FinalizedEntry[]
			const salvagedBlocks = content.filter((block) => block.type === "tool_use")
			expect(salvagedBlocks).toHaveLength(1)
			expect(salvagedBlocks[0].name).toBe("ask_followup_question")
			// The scanner captures every value as a string; the promotion
			// converts follow_up to its declared array type so the native
			// parser receives structured suggestions, while the ordinary
			// string parameter stays a string.
			expect(salvagedBlocks[0].nativeArgs).toMatchObject({
				question: "Continue?",
				follow_up: [{ text: "Yes" }],
			})
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Salvaged 1 XML tool call"))
			warnSpy.mockRestore()
		})

		it("keeps a JSON-looking value on a string-declared parameter a string (review 6081008463)", async () => {
			const task = await createStreamingTask()
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				asyncStreamFrom<ApiStreamChunk>([
					{
						type: "text",
						text: "<write_to_file><path>b.ts</path><content>[1, 2]</content></write_to_file>",
					},
				]),
			)

			await task.recursivelyMakeClineRequests([{ type: "text", text: "test" }])

			const content = getSalvageAccess(task).assistantMessageContent as FinalizedEntry[]
			const salvagedBlocks = content.filter((block) => block.type === "tool_use")
			expect(salvagedBlocks).toHaveLength(1)
			// content is declared string, so the JSON-looking value must stay
			// a string end to end (round-3 pre-merge check, case 1).
			expect(salvagedBlocks[0].nativeArgs).toMatchObject({ path: "b.ts", content: "[1, 2]" })
			warnSpy.mockRestore()
		})

		it("promotes neither call when a structured parameter is not valid JSON (review 4713747404)", async () => {
			const task = await createStreamingTask()
			const counter = recordNoToolUsePeak(task)
			const { assistantEntries } = recordApiHistoryEntries(task)
			const invalidCall =
				"<read_file><path>a.ts</path></read_file><ask_followup_question><question>Continue?</question><follow_up>not json</follow_up></ask_followup_question>"

			vi.spyOn(task, "attemptApiRequest")
				.mockImplementationOnce(() => asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: invalidCall }]))
				.mockImplementationOnce(() =>
					asyncStreamFrom<ApiStreamChunk>([
						{
							type: "tool_call",
							id: "toolu_native4",
							name: "write_to_file",
							arguments: '{"path":"b.ts","content":"hi"}',
						},
					]),
				)

			await task.recursivelyMakeClineRequests([{ type: "text", text: "test" }])

			// follow_up is declared array but is not JSON: the whole salvage
			// is rejected, so the staged read_file call never executes and
			// the full response text reaches the API history (round-3
			// pre-merge check, case 2).
			expect(assistantEntries.length).toBeGreaterThan(0)
			const rejectedBlocks = assistantEntries[0].content as Array<{ type: string; text?: string }>
			expect(rejectedBlocks.some((block) => block.type === "tool_use")).toBe(false)
			expect(rejectedBlocks.find((block) => block.type === "text")?.text).toBe(invalidCall)
			// The retry's native call is the only tool_use in the content.
			const content = getSalvageAccess(task).assistantMessageContent as FinalizedEntry[]
			const toolUses = content.filter((block) => block.type === "tool_use")
			expect(toolUses).toHaveLength(1)
			expect(toolUses[0].name).toBe("write_to_file")
			expect(counter.peak()).toBe(1)
		})

		it("promotes neither call when a declared array parameter parses as an object (review 4713747404)", async () => {
			const task = await createStreamingTask()
			const counter = recordNoToolUsePeak(task)
			const { assistantEntries } = recordApiHistoryEntries(task)
			const invalidCall =
				"<read_file><path>a.ts</path></read_file><ask_followup_question><question>Continue?</question><follow_up>{}</follow_up></ask_followup_question>"

			vi.spyOn(task, "attemptApiRequest")
				.mockImplementationOnce(() => asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: invalidCall }]))
				.mockImplementationOnce(() =>
					asyncStreamFrom<ApiStreamChunk>([
						{
							type: "tool_call",
							id: "toolu_native5",
							name: "write_to_file",
							arguments: '{"path":"b.ts","content":"hi"}',
						},
					]),
				)

			await task.recursivelyMakeClineRequests([{ type: "text", text: "test" }])

			// follow_up={} parses to an object although the schema declares
			// an array: the parser's presence-only check would promote the
			// call and clear the text, so the shape conflict must reject the
			// whole salvage (review 4713747404).
			expect(assistantEntries.length).toBeGreaterThan(0)
			const rejectedBlocks = assistantEntries[0].content as Array<{ type: string; text?: string }>
			expect(rejectedBlocks.some((block) => block.type === "tool_use")).toBe(false)
			expect(rejectedBlocks.find((block) => block.type === "text")?.text).toBe(invalidCall)
			const content = getSalvageAccess(task).assistantMessageContent as FinalizedEntry[]
			const toolUses = content.filter((block) => block.type === "tool_use")
			expect(toolUses).toHaveLength(1)
			expect(toolUses[0].name).toBe("write_to_file")
			expect(counter.peak()).toBe(1)
		})

		it("promotes nothing when an unknown tool name is mixed with a valid call (round-4 pre-merge check)", async () => {
			// The mistake limit is the loop's stop rail here: neither response
			// uses a tool, so the loop reaches the limit and asks; the ask stub
			// turns that into a deterministic stop instead of a real request.
			const task = await createStreamingTask({ consecutiveMistakeLimit: 1 })
			const { assistantEntries } = recordApiHistoryEntries(task)
			const mixedCall =
				"<not_a_real_tool><path>a.ts</path></not_a_real_tool><read_file><path>a.ts</path></read_file>"

			vi.spyOn(task, "ask").mockRejectedValue(new Error("loop-stop"))

			vi.spyOn(task, "attemptApiRequest")
				.mockImplementationOnce(() => asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: mixedCall }]))
				.mockImplementationOnce(() =>
					asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "No tool matches that request." }]),
				)

			await expect(task.recursivelyMakeClineRequests([{ type: "text", text: "test" }])).rejects.toThrow(
				"loop-stop",
			)

			// The unknown-name call fails the production parser, so the whole
			// salvage is rejected: no tool use is promoted, the response text
			// is kept verbatim, and the retry promotes no tool call either.
			expect(assistantEntries.length).toBeGreaterThanOrEqual(2)
			const firstBlocks = assistantEntries[0].content as Array<{ type: string; text?: string }>
			expect(firstBlocks.some((block) => block.type === "tool_use")).toBe(false)
			expect(firstBlocks.find((block) => block.type === "text")?.text).toBe(mixedCall)
			const retryBlocks = assistantEntries[1].content as Array<{ type: string; text?: string }>
			expect(retryBlocks.some((block) => block.type === "tool_use")).toBe(false)
			const content = getSalvageAccess(task).assistantMessageContent as FinalizedEntry[]
			expect(content.filter((block) => block.type === "tool_use")).toHaveLength(0)
		})
	})
})
