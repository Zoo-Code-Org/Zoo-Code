import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { Task } from "../Task"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { ClineProvider } from "../../webview/ClineProvider"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import type { ProviderSettings } from "@roo-code/types"
import type { ToolParamName } from "../../../shared/tools"
import { ApiStreamChunk, type ApiStreamToolCallPartialChunk } from "../../../api/transform/stream"
import { ContextProxy } from "../../config/ContextProxy"
import { TelemetryService } from "@roo-code/telemetry"

// Mock delay before any imports that might use it
vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

import delay from "delay"

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
			getConfiguration: vi.fn(() => ({ get: <T>(key: string, defaultValue: T) => defaultValue })),
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

describe("Task - Streaming Tool Call Handling", () => {
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

	afterEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls(scope)
		NativeToolCallParser.clearRawChunkState(scope)
	})

	describe("tool_call_partial chunk handling - NativeToolCallParser.processRawChunk", () => {
		it("should emit tool_call_start event when processing raw chunk with id and name", () => {
			const events = NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_123",
					name: "read_file",
					arguments: '{"path":"a.ts"}',
				},
				scope,
			)

			expect(events.length).toBeGreaterThan(0)
			const startEvent = events.find((e) => e.type === "tool_call_start")
			expect(startEvent).toBeDefined()
			if (startEvent && startEvent.type === "tool_call_start") {
				expect(startEvent.id).toBe("toolu_123")
				expect(startEvent.name).toBe("read_file")
			}
		})

		it("should emit tool_call_delta events for argument chunks", () => {
			const events = NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_123",
					name: "read_file",
					arguments: '{"path":"a.ts"}',
				},
				scope,
			)

			const deltaEvents = events.filter((e) => e.type === "tool_call_delta")
			expect(deltaEvents.length).toBeGreaterThan(0)
			if (deltaEvents[0] && deltaEvents[0].type === "tool_call_delta") {
				expect(deltaEvents[0].delta).toContain('"path"')
			}
		})

		it("should buffer deltas before start event and flush after", () => {
			NativeToolCallParser.clearRawChunkState(scope)

			// First chunk with id/name - should emit start + buffered delta
			const events1 = NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_buffer123",
					name: "read_file",
					arguments: '{"path":"test.ts"}',
				},
				scope,
			)

			expect(events1.some((e) => e.type === "tool_call_start")).toBe(true)
			expect(events1.some((e) => e.type === "tool_call_delta")).toBe(true)
		})

		it("should handle multiple chunks with same index (stream retry scenario)", () => {
			NativeToolCallParser.clearRawChunkState(scope)

			const events1 = NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_retry123",
					name: "read_file",
					arguments: '{"path":"a.ts"}',
				},
				scope,
			)

			const events2 = NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_retry123",
					name: "read_file",
					arguments: '{"path":"b.ts"}',
				},
				scope,
			)

			// Both should emit events (the dedup is handled by Task, not NativeToolCallParser)
			expect(events1.length).toBeGreaterThan(0)
			expect(events2.length).toBeGreaterThan(0)
		})
	})

	describe("NativeToolCallParser streaming state management", () => {
		it("should start tracking a streaming tool call and report hasActiveStreamingToolCalls", () => {
			NativeToolCallParser.clearAllStreamingToolCalls(scope)

			expect(NativeToolCallParser.hasActiveStreamingToolCalls(scope)).toBe(false)

			const id = "toolu_123"
			const name = "read_file"
			NativeToolCallParser.startStreamingToolCall(id, name, scope)

			expect(NativeToolCallParser.hasActiveStreamingToolCalls(scope)).toBe(true)
			expect(
				NativeToolCallParser.getStreamingToolName(NativeToolCallParser.makeStreamingKey(id, name), scope),
			).toBe("read_file")
		})

		it("should accumulate argument deltas via processStreamingChunk", () => {
			NativeToolCallParser.clearAllStreamingToolCalls(scope)

			const id = "toolu_delta_acc"
			const name = "execute_command"
			NativeToolCallParser.startStreamingToolCall(id, name, scope)
			const key = NativeToolCallParser.makeStreamingKey(id, name)

			const chunk1 = NativeToolCallParser.processStreamingChunk(key, '{"command":"echo', scope)
			expect(chunk1).toBeDefined()

			const chunk2 = NativeToolCallParser.processStreamingChunk(key, ' "hello"', scope)
			expect(chunk2).toBeDefined()

			// Verify accumulated arguments in streaming state
			const streamingState = NativeToolCallParser.getStreamingToolCallById(id, scope)
			expect(streamingState).toBeDefined()
			expect(streamingState!.argumentsAccumulator).toContain('"command":"echo')
		})

		it("should finalize tool call and return ToolUse via finalizeStreamingToolCall", () => {
			NativeToolCallParser.clearAllStreamingToolCalls(scope)

			const id = "toolu_final123"
			const name = "read_file"
			NativeToolCallParser.startStreamingToolCall(id, name, scope)
			const key = NativeToolCallParser.makeStreamingKey(id, name)
			NativeToolCallParser.processStreamingChunk(key, '{"path":"test.ts"}', scope)

			const result = NativeToolCallParser.finalizeStreamingToolCall(key, scope)

			expect(result).toBeDefined()
			expect(result?.type).toBe("tool_use")
			expect(result?.name).toBe("read_file")
			expect(result?.partial).toBe(false)
			// After finalization, should no longer be in streaming state
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(scope)).toBe(false)
		})

		it("should return null for finalizeStreamingToolCall when arguments are malformed", () => {
			NativeToolCallParser.clearAllStreamingToolCalls(scope)

			const id = "toolu_malformed"
			const name = "read_file"
			NativeToolCallParser.startStreamingToolCall(id, name, scope)
			const key = NativeToolCallParser.makeStreamingKey(id, name)
			NativeToolCallParser.processStreamingChunk(key, "{invalid json", scope)

			const result = NativeToolCallParser.finalizeStreamingToolCall(key, scope)

			// finalizeStreamingToolCall uses JSON.parse which will fail on malformed JSON
			expect(result).toBeNull()
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(scope)).toBe(false)
		})

		it("should return null when finalizing unknown tool call id", () => {
			NativeToolCallParser.clearAllStreamingToolCalls(scope)

			const result = NativeToolCallParser.finalizeStreamingToolCall("toolu_unknown::unknown", scope)
			expect(result).toBeNull()
		})

		it("should processStreamingChunk return null for unknown tool call id", () => {
			NativeToolCallParser.clearAllStreamingToolCalls(scope)

			const result = NativeToolCallParser.processStreamingChunk(
				"toolu_unknown::unknown",
				'{"some":"data"}',
				scope,
			)
			expect(result).toBeNull()
		})

		it("should handle multiple sequential streaming tool calls", () => {
			NativeToolCallParser.clearAllStreamingToolCalls(scope)

			// First tool call
			const id1 = "toolu_seq1"
			const name1 = "read_file"
			NativeToolCallParser.startStreamingToolCall(id1, name1, scope)
			const key1 = NativeToolCallParser.makeStreamingKey(id1, name1)
			NativeToolCallParser.processStreamingChunk(key1, '{"path":"a.ts"}', scope)
			const result1 = NativeToolCallParser.finalizeStreamingToolCall(key1, scope)
			expect(result1?.name).toBe("read_file")

			// Second tool call
			const id2 = "toolu_seq2"
			const name2 = "write_to_file"
			NativeToolCallParser.startStreamingToolCall(id2, name2, scope)
			const key2 = NativeToolCallParser.makeStreamingKey(id2, name2)
			NativeToolCallParser.processStreamingChunk(key2, '{"path":"b.ts","content":"hello"}', scope)
			const result2 = NativeToolCallParser.finalizeStreamingToolCall(key2, scope)
			expect(result2?.name).toBe("write_to_file")

			// Both should be finalized
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(scope)).toBe(false)
		})

		it("should handle same toolCallId with different names (MCP tools)", () => {
			NativeToolCallParser.clearAllStreamingToolCalls(scope)

			const id = "toolu_same"

			// First tool with same ID but different name
			const name1 = "mcp--server1--read_file"
			NativeToolCallParser.startStreamingToolCall(id, name1, scope)
			const key1 = NativeToolCallParser.makeStreamingKey(id, name1)
			NativeToolCallParser.processStreamingChunk(key1, '{"path":"a.ts"}', scope)
			const result1 = NativeToolCallParser.finalizeStreamingToolCall(key1, scope)
			expect(result1).toBeDefined()

			// Second tool with same ID but different name
			const name2 = "mcp--server2--write_to_file"
			NativeToolCallParser.startStreamingToolCall(id, name2, scope)
			const key2 = NativeToolCallParser.makeStreamingKey(id, name2)
			NativeToolCallParser.processStreamingChunk(key2, '{"path":"b.ts"}', scope)
			const result2 = NativeToolCallParser.finalizeStreamingToolCall(key2, scope)
			expect(result2).toBeDefined()

			// Both should be finalized (same ID, different names are tracked separately)
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(scope)).toBe(false)
		})
	})

	describe("processStreamingChunk partial ToolUse creation", () => {
		it("should create partial tool_use with correct structure on start", () => {
			NativeToolCallParser.clearAllStreamingToolCalls(scope)

			const id = "toolu_partial123"
			const name = "write_to_file"
			NativeToolCallParser.startStreamingToolCall(id, name, scope)
			const key = NativeToolCallParser.makeStreamingKey(id, name)

			const partial = NativeToolCallParser.processStreamingChunk(
				key,
				'{"path":"output.txt","content":"hello"}',
				scope,
			)

			expect(partial).toBeDefined()
			expect(partial?.type).toBe("tool_use")
			expect(partial?.name).toBe("write_to_file")
			expect(partial?.partial).toBe(true)
			expect(partial?.params).toBeDefined()
		})

		it("should update partial tool_use with accumulated arguments", () => {
			NativeToolCallParser.clearAllStreamingToolCalls(scope)

			const id = "toolu_update123"
			const name = "execute_command"
			NativeToolCallParser.startStreamingToolCall(id, name, scope)
			const key = NativeToolCallParser.makeStreamingKey(id, name)

			const chunk1 = NativeToolCallParser.processStreamingChunk(key, '{"command":"', scope)
			expect(chunk1?.params).toBeDefined()

			const chunk2 = NativeToolCallParser.processStreamingChunk(key, 'echo "hello"}', scope)
			expect(chunk2?.params).toBeDefined()
			// The accumulated arguments should be more complete in chunk2
			if (chunk2?.nativeArgs && typeof chunk2.nativeArgs === "object" && "command" in chunk2.nativeArgs) {
				expect(chunk2.nativeArgs.command).toContain("echo")
			}
		})

		it("should handle severely malformed JSON gracefully", () => {
			NativeToolCallParser.clearAllStreamingToolCalls(scope)

			const id = "toolu_fail123"
			const name = "read_file"
			NativeToolCallParser.startStreamingToolCall(id, name, scope)
			const key = NativeToolCallParser.makeStreamingKey(id, name)

			// Partial-json-parser can handle partial JSON like '{"path"' and return a partial result
			const partialResult = NativeToolCallParser.processStreamingChunk(key, '{"path"', scope)

			expect(partialResult).toBeDefined()
			expect(partialResult?.partial).toBe(true)
			// Even severely malformed JSON like '{invalid' gets parsed by partial-json-parser
			// It returns an empty object, which is still a valid (though incomplete) result
			const veryPartial = NativeToolCallParser.processStreamingChunk("toolu_fail123", "{invalid", scope)
			// partial-json-parser handles this gracefully - it may return an empty object or null
			// The key point is it doesn't throw an error and the streaming continues
			if (veryPartial != null) {
				expect(veryPartial.partial).toBe(true)
			} else {
				// null is also acceptable for severely malformed JSON
				expect(veryPartial).toBeNull()
			}
		})
	})

	describe("finalizeRawChunks integration", () => {
		it("should emit tool_call_end events when the stream is finalized with tool calls", () => {
			NativeToolCallParser.clearRawChunkState(scope)

			// First process some raw chunks to populate tracker
			NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_finish123",
					name: "read_file",
					arguments: '{"path":"test.ts"}',
				},
				scope,
			)

			// In the scoped design, end events are emitted by finalizeRawChunks at
			// stream end (the old processFinishReason entry point no longer exists).
			const events = NativeToolCallParser.finalizeRawChunks(scope)

			expect(events.length).toBeGreaterThan(0)
			expect(events[0].type).toBe("tool_call_end")
		})

		it("should finalize remaining raw chunks via finalizeRawChunks", () => {
			NativeToolCallParser.clearRawChunkState(scope)

			NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_finalize123",
					name: "read_file",
					arguments: '{"path":"test.ts"}',
				},
				scope,
			)

			const events = NativeToolCallParser.finalizeRawChunks(scope)

			expect(events.length).toBeGreaterThan(0)
			expect(events[0].type).toBe("tool_call_end")
		})

		it("should clear raw chunk state via clearRawChunkState", () => {
			NativeToolCallParser.clearRawChunkState(scope)

			NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_clear123",
					name: "read_file",
					arguments: '{"path":"test.ts"}',
				},
				scope,
			)

			NativeToolCallParser.clearRawChunkState(scope)

			const events = NativeToolCallParser.finalizeRawChunks(scope)
			expect(events.length).toBe(0)
		})
	})

	describe("tool_call_partial chunk handling - Task integration", () => {
		it("should emit tool_call_start event when processing raw chunk with id and name", async () => {
			NativeToolCallParser.clearRawChunkState(scope)

			const events = NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_123",
					name: "read_file",
					arguments: '{"path":"a.ts"}',
				},
				scope,
			)

			// Should emit both start and delta event
			expect(events.length).toBeGreaterThan(0)
			const startEvent = events.find((e) => e.type === "tool_call_start")
			expect(startEvent).toBeDefined()
			if (startEvent && startEvent.type === "tool_call_start") {
				expect(startEvent.id).toBe("toolu_123")
				expect(startEvent.name).toBe("read_file")
			}
			const deltaEvents = events.filter((e) => e.type === "tool_call_delta")
			expect(deltaEvents.length).toBeGreaterThan(0)
		})

		it("should handle duplicate tool_call_partial chunks with same index", async () => {
			NativeToolCallParser.clearRawChunkState(scope)

			const events1 = NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_dup123",
					name: "read_file",
					arguments: '{"path":"test.ts"}',
				},
				scope,
			)

			const events2 = NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_dup123",
					name: "read_file",
					arguments: '{"path":"test.ts"}',
				},
				scope,
			)

			// Both should emit delta events (dedup is handled by Task, not NativeToolCallParser)
			expect(events1.length).toBeGreaterThan(0)
			expect(events2.length).toBeGreaterThan(0)
		})

		it("should handle tool_call_delta event without id", async () => {
			NativeToolCallParser.clearRawChunkState(scope)

			const events = NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_delta123",
					name: undefined,
					arguments: undefined,
				},
				scope,
			)

			// Without name, no start event should be emitted
			expect(events.length).toBe(0)
		})

		it("should handle tool_call_end via finalizeRawChunks", async () => {
			NativeToolCallParser.clearRawChunkState(scope)

			// First process a raw chunk to track the tool call
			NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_end123",
					name: "read_file",
					arguments: '{"path":"test.ts"}',
				},
				scope,
			)

			// finalizeRawChunks should emit end events for all tracked tools that have started
			const events = NativeToolCallParser.finalizeRawChunks(scope)

			expect(events).toHaveLength(1)
			expect(events[0]).toEqual({ type: "tool_call_end", id: "toolu_end123", name: "read_file" })
		})

		it("should handle complete streaming lifecycle: processRawChunk -> finalizeRawChunks", async () => {
			NativeToolCallParser.clearRawChunkState(scope)

			// Start
			const startEvents = NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_lifecycle123",
					name: "read_file",
					arguments: '{"path":"test.ts"}',
				},
				scope,
			)

			expect(startEvents.some((e) => e.type === "tool_call_start")).toBe(true)

			// Delta (simulating another chunk with same index)
			const deltaEvents = NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_lifecycle123",
					name: "read_file",
					arguments: ',"more":"args"',
				},
				scope,
			)

			expect(deltaEvents.some((e) => e.type === "tool_call_delta")).toBe(true)

			// End via finalize
			const endEvents = NativeToolCallParser.finalizeRawChunks(scope)

			expect(endEvents).toHaveLength(1)
			expect(endEvents[0]).toEqual({ type: "tool_call_end", id: "toolu_lifecycle123", name: "read_file" })
		})

		it("should handle multiple sequential tool calls with different indices", async () => {
			NativeToolCallParser.clearRawChunkState(scope)

			// First tool call (index 0)
			const events1 = NativeToolCallParser.processRawChunk(
				{
					index: 0,
					id: "toolu_multi1",
					name: "read_file",
					arguments: '{"path":"file1.ts"}',
				},
				scope,
			)

			expect(events1.some((e) => e.type === "tool_call_start")).toBe(true)

			// Second tool call (index 1)
			const events2 = NativeToolCallParser.processRawChunk(
				{
					index: 1,
					id: "toolu_multi2",
					name: "write_to_file",
					arguments: '{"path":"file2.ts","content":"hello"}',
				},
				scope,
			)

			expect(events2.some((e) => e.type === "tool_call_start")).toBe(true)

			// Finalize both
			const endEvents = NativeToolCallParser.finalizeRawChunks(scope)

			expect(endEvents).toHaveLength(2)
			const endIds = endEvents.map((e) => e.id)
			expect(endIds).toContain("toolu_multi1")
			expect(endIds).toContain("toolu_multi2")
		})
	})

	describe("Task.ts compound key dedup and streaming paths", () => {
		// Test-local structural stand-in for the Task.assistantMessageContent entries
		// this block exercises: partial tool_use objects and parser results.
		type AssistantContentEntry = {
			type?: string
			id?: string
			name?: string
			params?: Partial<Record<ToolParamName, string>>
			partial?: boolean
		}

		it("should build and use compound streaming keys via makeStreamingKey", () => {
			const key = NativeToolCallParser.makeStreamingKey("toolu_compound123", "read_file")
			expect(key).toBe("toolu_compound123::read_file")

			NativeToolCallParser.startStreamingToolCall("toolu_compound123", "read_file", scope)
			expect(NativeToolCallParser.getStreamingToolName(key, scope)).toBe("read_file")
		})

		it("should ignore duplicate tool_call_start for same compound key", () => {
			const streamingToolCallIndices = new Map<string, number>()
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const events = [
				{ type: "tool_call_start", id: "toolu_dup_compound", name: "read_file" as const },
				{ type: "tool_call_start", id: "toolu_dup_compound", name: "read_file" as const },
			]
			const assistantMessageContent: AssistantContentEntry[] = []

			for (const event of events) {
				const dedupKey = `${event.id}::${event.name}`
				if (streamingToolCallIndices.has(dedupKey)) {
					console.warn(
						`[Task#test] Ignoring duplicate tool_call_start for ID: ${event.id} (tool: ${event.name})`,
					)
					continue
				}
				streamingToolCallIndices.set(dedupKey, assistantMessageContent.length)
				assistantMessageContent.push({ type: "tool_use", id: event.id, name: event.name, partial: true })
			}

			expect(assistantMessageContent).toHaveLength(1)
			expect(streamingToolCallIndices.has("toolu_dup_compound::read_file")).toBe(true)
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[Task#test]"))
			warnSpy.mockRestore()
		})

		it("should use compound key for delta events via getStreamingToolCallById", () => {
			const streamingToolCallIndices = new Map<string, number>()
			const assistantMessageContent: AssistantContentEntry[] = []

			NativeToolCallParser.startStreamingToolCall("toolu_delta_compound", "read_file", scope)
			const dedupKey = NativeToolCallParser.makeStreamingKey("toolu_delta_compound", "read_file")
			streamingToolCallIndices.set(dedupKey, 0)
			assistantMessageContent.push({
				type: "tool_use",
				id: "toolu_delta_compound",
				name: "read_file",
				params: {},
				partial: true,
			})

			const partialToolUse = NativeToolCallParser.processStreamingChunk(dedupKey, '{"path":"', scope)
			expect(partialToolUse).not.toBeNull()

			const existingEntry = NativeToolCallParser.getStreamingToolCallById("toolu_delta_compound", scope)
			expect(existingEntry).not.toBeNull()
			const resolvedKey = existingEntry
				? NativeToolCallParser.makeStreamingKey(existingEntry.id, existingEntry.name)
				: undefined
			const updatedToolUse = NativeToolCallParser.processStreamingChunk(resolvedKey!, '"test.ts"}', scope)
			expect(updatedToolUse).not.toBeNull()
			const name = NativeToolCallParser.getStreamingToolName(resolvedKey!, scope)
			const toolUseIndex = streamingToolCallIndices.get(`${existingEntry!.id}::${name}`)
			expect(toolUseIndex).toBe(0)
			if (!updatedToolUse) {
				throw new Error("Expected processStreamingChunk to return a tool use")
			}
			assistantMessageContent[toolUseIndex!] = updatedToolUse

			expect(assistantMessageContent).toHaveLength(1)
			expect(assistantMessageContent[0]?.type).toBe("tool_use")
			expect(assistantMessageContent[0]?.name).toBe("read_file")
		})

		it("should finalize and clean up tracking using compound key on tool_call_end", () => {
			const streamingToolCallIndices = new Map<string, number>()
			const assistantMessageContent: AssistantContentEntry[] = []
			const dedupKey = NativeToolCallParser.makeStreamingKey("toolu_cleanup123", "read_file")

			NativeToolCallParser.startStreamingToolCall("toolu_cleanup123", "read_file", scope)
			streamingToolCallIndices.set(dedupKey, 0)
			assistantMessageContent.push({ type: "tool_use", id: "toolu_cleanup123", name: "read_file", partial: true })
			NativeToolCallParser.processStreamingChunk(dedupKey, '{"path":"test.ts"}', scope)

			const finalToolUse = NativeToolCallParser.finalizeStreamingToolCall(dedupKey, scope)
			expect(finalToolUse).not.toBeNull()
			if (!finalToolUse) {
				throw new Error("Expected finalizeStreamingToolCall to return a tool use")
			}
			assistantMessageContent[0] = finalToolUse
			streamingToolCallIndices.delete(dedupKey)

			expect(assistantMessageContent).toHaveLength(1)
			expect(assistantMessageContent[0]?.type).toBe("tool_use")
			expect(assistantMessageContent[0]?.name).toBe("read_file")
			expect(assistantMessageContent[0]?.partial).toBe(false)
			expect(streamingToolCallIndices.has("toolu_cleanup123::read_file")).toBe(false)
		})

		it("should handle malformed JSON finalization with compound key cleanup", () => {
			const streamingToolCallIndices = new Map<string, number>()
			const assistantMessageContent: AssistantContentEntry[] = []
			const dedupKey = NativeToolCallParser.makeStreamingKey("toolu_malformed123", "read_file")

			NativeToolCallParser.startStreamingToolCall("toolu_malformed123", "read_file", scope)
			streamingToolCallIndices.set(dedupKey, 0)
			assistantMessageContent.push({
				type: "tool_use",
				id: "toolu_malformed123",
				name: "read_file",
				partial: true,
			})
			NativeToolCallParser.processStreamingChunk(dedupKey, "{invalid json", scope)

			const finalToolUse = NativeToolCallParser.finalizeStreamingToolCall(dedupKey, scope)
			expect(finalToolUse).toBeNull()
			assistantMessageContent[0].partial = false
			streamingToolCallIndices.delete(dedupKey)

			expect(assistantMessageContent).toHaveLength(1)
			expect(assistantMessageContent[0]?.type).toBe("tool_use")
			expect(assistantMessageContent[0]?.name).toBe("read_file")
			expect(assistantMessageContent[0]?.partial).toBe(false)
			expect(streamingToolCallIndices.has("toolu_malformed123::read_file")).toBe(false)
		})
	})
})
