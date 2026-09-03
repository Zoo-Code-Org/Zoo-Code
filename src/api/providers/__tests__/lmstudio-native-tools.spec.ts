// npx vitest run api/providers/__tests__/lmstudio-native-tools.spec.ts

// Mock OpenAI client - must come before other imports
const mockCreate = vi.fn()
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
vi.mock("openai", () => {
	return {
		__esModule: true,
		default: vi.fn().mockImplementation(function () {
			return {
				chat: {
					completions: {
						create: mockCreate,
					},
				},
			}
		}),
	}
})

import { LmStudioHandler } from "../lm-studio"
import { NativeToolCallParser } from "../../../core/assistant-message/NativeToolCallParser"
import type { ApiHandlerOptions } from "../../../shared/api"

describe("LmStudioHandler Native Tools", () => {
	let handler: LmStudioHandler
	let mockOptions: ApiHandlerOptions

	const testTools = [
		{
			type: "function" as const,
			function: {
				name: "test_tool",
				description: "A test tool",
				parameters: {
					type: "object",
					properties: {
						arg1: { type: "string", description: "First argument" },
					},
					required: ["arg1"],
				},
			},
		},
	]

	beforeEach(() => {
		clearAllMocks()

		mockOptions = {
			apiModelId: "local-model",
			lmStudioModelId: "local-model",
			lmStudioBaseUrl: "http://localhost:1234",
		}
		handler = new LmStudioHandler(mockOptions)

		// Clear NativeToolCallParser state before each test
		NativeToolCallParser.clearRawChunkState()
	})

	describe("Native Tool Calling Support", () => {
		it("should include tools in request when model supports native tools and tools are provided", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { content: "Test response" } }] }]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
				tools: testTools,
			})
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					tools: expect.arrayContaining([
						expect.objectContaining({
							type: "function",
							function: expect.objectContaining({
								name: "test_tool",
							}),
						}),
					]),
				}),
			)
			// parallel_tool_calls should be true by default when not explicitly set
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).toHaveProperty("parallel_tool_calls", true)
		})

		it("should include tool_choice when provided", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { content: "Test response" } }] }]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
				tools: testTools,
				tool_choice: "auto",
			})
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					tool_choice: "auto",
				}),
			)
		})

		it("should always include tools and tool_choice in request (tools are always present after PR #10841)", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { content: "Test response" } }] }]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
			})
			await stream.next()

			const callArgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0]
			// Tools are now always present (minimum 6 from ALWAYS_AVAILABLE_TOOLS)
			expect(callArgs).toHaveProperty("tools")
			expect(callArgs).toHaveProperty("tool_choice")
			// parallel_tool_calls should be true by default when not explicitly set
			expect(callArgs).toHaveProperty("parallel_tool_calls", true)
		})

		it("should yield tool_call_partial chunks during streaming", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_lmstudio_123",
											function: {
												name: "test_tool",
												arguments: '{"arg1":',
											},
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											function: {
												arguments: '"value"}',
											},
										},
									],
								},
							},
						],
					},
				]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
				tools: testTools,
			})

			const chunks = await collectStream(stream)

			expect(chunks).toContainEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_lmstudio_123",
				name: "test_tool",
				arguments: '{"arg1":',
			})

			expect(chunks).toContainEqual({
				type: "tool_call_partial",
				index: 0,
				id: undefined,
				name: undefined,
				arguments: '"value"}',
			})
		})

		it("should set parallel_tool_calls based on metadata", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { content: "Test response" } }] }]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
				tools: testTools,
				parallelToolCalls: true,
			})
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					parallel_tool_calls: true,
				}),
			)
		})

		it("should yield tool_call_end events when finish_reason is tool_calls", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_lmstudio_test",
											function: {
												name: "test_tool",
												arguments: '{"arg1":"value"}',
											},
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {},
								finish_reason: "tool_calls",
							},
						],
					},
				]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
				tools: testTools,
			})

			const chunks = []
			for await (const chunk of stream) {
				// Simulate what Task.ts does: when we receive tool_call_partial,
				// process it through NativeToolCallParser to populate rawChunkTracker
				if (chunk.type === "tool_call_partial") {
					NativeToolCallParser.processRawChunk({
						index: chunk.index,
						id: chunk.id,
						name: chunk.name,
						arguments: chunk.arguments,
					})
				}
				chunks.push(chunk)
			}

			// Should have tool_call_partial and tool_call_end
			const partialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")

			expect(partialChunks).toHaveLength(1)
			expect(endChunks).toHaveLength(1)
			expect(endChunks[0].id).toBe("call_lmstudio_test")
		})

		it("emits completion only for identified calls and clears completed IDs", async () => {
			const toolCall = (id?: string) => ({
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id, function: { name: "test_tool", arguments: '{"arg1":"value"}' } },
							],
						},
					},
				],
			})
			mockCreate
				.mockImplementationOnce(() =>
					asyncStreamFrom([toolCall(), { choices: [{ delta: {}, finish_reason: "tool_calls" }] }]),
				)
				.mockImplementationOnce(() =>
					asyncStreamFrom([
						toolCall("call_lmstudio_stop"),
						{ choices: [{ delta: {}, finish_reason: "stop" }] },
					]),
				)
				.mockImplementationOnce(() =>
					asyncStreamFrom([
						toolCall("call_lmstudio_once"),
						{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
						{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
					]),
				)

			const createMessage = () => handler.createMessage("test prompt", [], { taskId: "task", tools: testTools })
			const idlessChunks = await collectStream(createMessage())
			const stoppedChunks = await collectStream(createMessage())
			const completedChunks = await collectStream(createMessage())

			expect(idlessChunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([])
			expect(stoppedChunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([])
			expect(completedChunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([
				{ type: "tool_call_end", id: "call_lmstudio_once" },
			])
		})

		it("isolates overlapping tool-call finalization between provider streams", async () => {
			let releaseFirstStream: (() => void) | undefined
			let markFirstStreamPaused: (() => void) | undefined
			const firstStreamRelease = new Promise<void>((resolve) => {
				releaseFirstStream = resolve
			})
			const firstStreamPaused = new Promise<void>((resolve) => {
				markFirstStreamPaused = resolve
			})
			const firstStream = async function* () {
				yield {
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_lmstudio_a",
										function: { name: "test_tool", arguments: '{"arg1":"a' },
									},
								],
							},
						},
					],
				}
				markFirstStreamPaused?.()
				await firstStreamRelease
				yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
			}
			const secondStream = asyncStreamFrom([
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_lmstudio_b",
										function: { name: "test_tool", arguments: '{"arg1":"b' },
									},
								],
							},
						},
					],
				},
				{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
			])
			mockCreate.mockImplementationOnce(() => firstStream()).mockImplementationOnce(() => secondStream)

			const collectAndTrack = async (stream: ReturnType<LmStudioHandler["createMessage"]>) => {
				const chunks = []
				const parserEvents = []
				const parserScope = NativeToolCallParser.createScope()
				for await (const chunk of stream) {
					if (chunk.type === "tool_call_partial") {
						parserEvents.push(
							...NativeToolCallParser.processRawChunk(
								{
									index: chunk.index,
									id: chunk.id,
									name: chunk.name,
									arguments: chunk.arguments,
								},
								parserScope,
							),
						)
					}
					chunks.push(chunk)
				}
				NativeToolCallParser.clearRawChunkState(parserScope)
				return { chunks, parserEvents }
			}

			const firstChunksPromise = collectAndTrack(
				handler.createMessage("first", [], { taskId: "task-a", tools: testTools }),
			)
			await firstStreamPaused
			const secondChunks = await collectAndTrack(
				handler.createMessage("second", [], { taskId: "task-b", tools: testTools }),
			)
			releaseFirstStream?.()
			const firstChunks = await firstChunksPromise

			expect(secondChunks.chunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([
				{ type: "tool_call_end", id: "call_lmstudio_b" },
			])
			expect(firstChunks.chunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([
				{ type: "tool_call_end", id: "call_lmstudio_a" },
			])
			expect(firstChunks.parserEvents).toEqual([
				{ type: "tool_call_start", id: "call_lmstudio_a", name: "test_tool" },
				{ type: "tool_call_delta", id: "call_lmstudio_a", delta: '{"arg1":"a' },
			])
			expect(secondChunks.parserEvents).toEqual([
				{ type: "tool_call_start", id: "call_lmstudio_b", name: "test_tool" },
				{ type: "tool_call_delta", id: "call_lmstudio_b", delta: '{"arg1":"b' },
			])
		})

		it("should work with parallel tool calls disabled (sends false)", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { content: "Response" } }] }]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
				tools: testTools,
				parallelToolCalls: false,
			})
			await stream.next()

			// When parallelToolCalls is false, the parameter should be sent as false
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).toHaveProperty("parallel_tool_calls", false)
		})

		it("should handle reasoning content alongside tool calls", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									content: "<think>Thinking about this...</think>",
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_after_think",
											function: {
												name: "test_tool",
												arguments: '{"arg1":"result"}',
											},
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {},
								finish_reason: "tool_calls",
							},
						],
					},
				]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
				tools: testTools,
			})

			const chunks = []
			for await (const chunk of stream) {
				if (chunk.type === "tool_call_partial") {
					NativeToolCallParser.processRawChunk({
						index: chunk.index,
						id: chunk.id,
						name: chunk.name,
						arguments: chunk.arguments,
					})
				}
				chunks.push(chunk)
			}

			// Should have reasoning, tool_call_partial, and tool_call_end
			const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")
			const partialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")

			expect(reasoningChunks).toHaveLength(1)
			expect(reasoningChunks[0].text).toBe("Thinking about this...")
			expect(partialChunks).toHaveLength(1)
			expect(endChunks).toHaveLength(1)
		})
	})
})
