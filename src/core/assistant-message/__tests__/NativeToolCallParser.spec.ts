import { NativeToolCallParser } from "../NativeToolCallParser"

describe("NativeToolCallParser", () => {
	beforeEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
	})

	describe("parseToolCall", () => {
		describe("read_file tool", () => {
			it("should parse minimal single-file read_file args", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/core/task/Task.ts",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.nativeArgs).toBeDefined()
					const nativeArgs = result.nativeArgs as { path: string }
					expect(nativeArgs.path).toBe("src/core/task/Task.ts")
				}
			})

			it("should parse slice-mode params", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/core/task/Task.ts",
						mode: "slice",
						offset: 10,
						limit: 20,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						path: string
						mode?: string
						offset?: number
						limit?: number
					}
					expect(nativeArgs.path).toBe("src/core/task/Task.ts")
					expect(nativeArgs.mode).toBe("slice")
					expect(nativeArgs.offset).toBe(10)
					expect(nativeArgs.limit).toBe(20)
				}
			})

			it("should parse indentation-mode params", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/utils.ts",
						mode: "indentation",
						indentation: {
							anchor_line: 123,
							max_levels: 2,
							include_siblings: true,
							include_header: false,
						},
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						path: string
						mode?: string
						indentation?: {
							anchor_line?: number
							max_levels?: number
							include_siblings?: boolean
							include_header?: boolean
						}
					}
					expect(nativeArgs.path).toBe("src/utils.ts")
					expect(nativeArgs.mode).toBe("indentation")
					expect(nativeArgs.indentation?.anchor_line).toBe(123)
					expect(nativeArgs.indentation?.include_siblings).toBe(true)
					expect(nativeArgs.indentation?.include_header).toBe(false)
				}
			})

			// Legacy format backward compatibility tests
			describe("legacy format backward compatibility", () => {
				it("should parse legacy files array format with single file", () => {
					const toolCall = {
						id: "toolu_legacy_1",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [{ path: "src/legacy/file.ts" }],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as { files: Array<{ path: string }>; _legacyFormat: true }
						expect(nativeArgs._legacyFormat).toBe(true)
						expect(nativeArgs.files).toHaveLength(1)
						expect(nativeArgs.files[0].path).toBe("src/legacy/file.ts")
					}
				})

				it("should parse legacy files array format with multiple files", () => {
					const toolCall = {
						id: "toolu_legacy_2",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [{ path: "src/file1.ts" }, { path: "src/file2.ts" }, { path: "src/file3.ts" }],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as { files: Array<{ path: string }>; _legacyFormat: true }
						expect(nativeArgs.files).toHaveLength(3)
						expect(nativeArgs.files[0].path).toBe("src/file1.ts")
						expect(nativeArgs.files[1].path).toBe("src/file2.ts")
						expect(nativeArgs.files[2].path).toBe("src/file3.ts")
					}
				})

				it("should parse legacy line_ranges as tuples", () => {
					const toolCall = {
						id: "toolu_legacy_3",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: [
										[1, 50],
										[100, 150],
									],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
							_legacyFormat: true
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 1, end: 50 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 100, end: 150 })
					}
				})

				it("should parse legacy line_ranges as objects", () => {
					const toolCall = {
						id: "toolu_legacy_4",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: [
										{ start: 10, end: 20 },
										{ start: 30, end: 40 },
									],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 10, end: 20 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 30, end: 40 })
					}
				})

				it("should parse legacy line_ranges as strings", () => {
					const toolCall = {
						id: "toolu_legacy_5",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: ["1-50", "100-150"],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 1, end: 50 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 100, end: 150 })
					}
				})

				it("should parse double-stringified files array (model quirk)", () => {
					// This tests the real-world case where some models double-stringify the files array
					// e.g., { files: "[{\"path\": \"...\"}]" } instead of { files: [{path: "..."}] }
					const toolCall = {
						id: "toolu_double_stringify",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: JSON.stringify([
								{ path: "src/services/example/service.ts" },
								{ path: "src/services/mcp/McpServerManager.ts" },
							]),
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string }>
							_legacyFormat: true
						}
						expect(nativeArgs._legacyFormat).toBe(true)
						expect(nativeArgs.files).toHaveLength(2)
						expect(nativeArgs.files[0].path).toBe("src/services/example/service.ts")
						expect(nativeArgs.files[1].path).toBe("src/services/mcp/McpServerManager.ts")
					}
				})

				it("should NOT set usedLegacyFormat for new format", () => {
					const toolCall = {
						id: "toolu_new",
						name: "read_file" as const,
						arguments: JSON.stringify({
							path: "src/new/format.ts",
							mode: "slice",
							offset: 1,
							limit: 100,
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBeUndefined()
					}
				})
			})
		})
	})

	describe("processStreamingChunk", () => {
		describe("read_file tool", () => {
			it("should emit a partial ToolUse with nativeArgs.path during streaming", () => {
				const id = "toolu_streaming_123"
				NativeToolCallParser.startStreamingToolCall(id, "read_file")

				// Simulate streaming chunks
				const fullArgs = JSON.stringify({ path: "src/test.ts" })

				// Process the complete args as a single chunk for simplicity using compound key
				const key = NativeToolCallParser.makeStreamingKey(id, "read_file")
				const result = NativeToolCallParser.processStreamingChunk(key, fullArgs)

				expect(result).not.toBeNull()
				expect(result?.nativeArgs).toBeDefined()
				const nativeArgs = result?.nativeArgs as { path: string }
				expect(nativeArgs.path).toBe("src/test.ts")
			})
		})
	})

	describe("finalizeStreamingToolCall", () => {
		describe("read_file tool", () => {
			it("should parse read_file args on finalize", () => {
				const id = "toolu_finalize_123"
				NativeToolCallParser.startStreamingToolCall(id, "read_file")

				// Add the complete arguments using compound key
				const key = NativeToolCallParser.makeStreamingKey(id, "read_file")
				NativeToolCallParser.processStreamingChunk(
					key,
					JSON.stringify({
						path: "finalized.ts",
						mode: "slice",
						offset: 1,
						limit: 10,
					}),
				)

				const result = NativeToolCallParser.finalizeStreamingToolCall(key)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as { path: string; offset?: number; limit?: number }
					expect(nativeArgs.path).toBe("finalized.ts")
					expect(nativeArgs.offset).toBe(1)
					expect(nativeArgs.limit).toBe(10)
				}
			})
		})
	})

	describe("streamingToolCalls collision", () => {
		it("should keep separate accumulated arguments for tools with same id but different names", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()
			NativeToolCallParser.clearRawChunkState()

			const id = "toolu_collision_123"

			// Start two tool calls with the same id but different names
			NativeToolCallParser.startStreamingToolCall(id, "read_file")
			NativeToolCallParser.startStreamingToolCall(id, "write_to_file")

			// Accumulate arguments for each using compound keys
			const key1 = NativeToolCallParser.makeStreamingKey(id, "read_file")
			const key2 = NativeToolCallParser.makeStreamingKey(id, "write_to_file")

			NativeToolCallParser.processStreamingChunk(key1, JSON.stringify({ path: "file_a.ts" }))
			NativeToolCallParser.processStreamingChunk(key2, JSON.stringify({ path: "file_b.ts", content: "hello" }))

			// Finalize both and verify they have distinct arguments
			const result1 = NativeToolCallParser.finalizeStreamingToolCall(key1)
			const result2 = NativeToolCallParser.finalizeStreamingToolCall(key2)

			expect(result1).not.toBeNull()
			expect(result2).not.toBeNull()
			expect(result1?.type).toBe("tool_use")
			expect(result2?.type).toBe("tool_use")

			if (result1?.type === "tool_use" && result2?.type === "tool_use") {
				const nativeArgs1 = result1.nativeArgs as { path: string }
				const nativeArgs2 = result2.nativeArgs as { path: string; content: string }
				expect(nativeArgs1.path).toBe("file_a.ts")
				expect(nativeArgs2.path).toBe("file_b.ts")
				expect(nativeArgs2.content).toBe("hello")
			}

			// Verify streaming state is cleaned up for both
			expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(false)
		})
	})

	describe("finalizeRawChunks", () => {
		it("should include name field in events for compound-key deduplication", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()
			NativeToolCallParser.clearRawChunkState()

			// Simulate two different tools with the same toolCallId via raw chunk tracking.
			// processRawChunk returns [start, delta] when arguments are provided alongside name.
			const result1 = NativeToolCallParser.processRawChunk({
				index: 1,
				id: "toolu_sameid",
				name: "read_file",
				arguments: '{"path":"a.ts"}',
			})
			// First call for index 1 returns start + delta events
			expect(result1.some((e) => e.type === "tool_call_start")).toBe(true)

			const result2 = NativeToolCallParser.processRawChunk({
				index: 2,
				id: "toolu_sameid",
				name: "write_to_file",
				arguments: '{"path":"b.ts","content":"hello"}',
			})
			// Second call for index 2 also returns start + delta events
			expect(result2.some((e) => e.type === "tool_call_start")).toBe(true)

			// Finalize raw chunks — both should be included with their names
			const finalizeEvents = NativeToolCallParser.finalizeRawChunks()

			expect(finalizeEvents).toHaveLength(2)
			expect(finalizeEvents.every((e) => e.type === "tool_call_end")).toBe(true)

			// Each event must carry its name for compound-key deduplication
			const names = finalizeEvents.map((e) => (e as any).name)
			expect(names).toContain("read_file")
			expect(names).toContain("write_to_file")
		})

		it("should emit separate end events when two tools share the same toolCallId", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()
			NativeToolCallParser.clearRawChunkState()

			// Both tools use the exact same call ID but different names
			NativeToolCallParser.processRawChunk({
				index: 10,
				id: "toolu_dup",
				name: "codebase_search",
				arguments: '{"query":"foo"}',
			})
			NativeToolCallParser.processRawChunk({
				index: 11,
				id: "toolu_dup",
				name: "search_files",
				arguments: '{"path":".","regex":"bar"}',
			})

			const events = NativeToolCallParser.finalizeRawChunks()

			// Should produce two distinct end events
			expect(events).toHaveLength(2)

			// Verify compound keys would be unique
			const dedupKeys = new Set(events.map((e) => `${e.id}::${(e as any).name}`))
			expect(dedupKeys.size).toBe(2)
		})
	})
})
