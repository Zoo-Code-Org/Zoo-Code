import { NativeToolCallParser, type ToolCallStreamEvent } from "../NativeToolCallParser"

describe("NativeToolCallParser", () => {
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
		it("preserves read_file arguments that arrive before the call id and name", () => {
			const scope = NativeToolCallParser.createScope()
			const argumentsJson = JSON.stringify({ path: "src/leading.ts", mode: "slice", offset: 1, limit: 2000 })
			const split = 24

			expect(
				NativeToolCallParser.processRawChunk({ index: 0, arguments: argumentsJson.slice(0, split) }, scope),
			).toEqual([])

			const identifiedEvents = NativeToolCallParser.processRawChunk(
				{ index: 0, id: "call_late_identity", name: "read_file" },
				scope,
			)
			expect(identifiedEvents).toEqual([
				{ type: "tool_call_start", id: "call_late_identity", name: "read_file" },
				{
					type: "tool_call_delta",
					id: "call_late_identity",
					name: "read_file",
					delta: argumentsJson.slice(0, split),
				},
			])

			NativeToolCallParser.startStreamingToolCall("call_late_identity", "read_file", scope)
			for (const event of identifiedEvents) {
				if (event.type === "tool_call_delta") {
					if (event.name !== undefined) {
						// Post-merge streaming state is keyed by compound (id, name) keys;
						// raw-chunk deltas carry the tracked name, so rebuild the key Task.ts uses.
						NativeToolCallParser.processStreamingChunk(
							NativeToolCallParser.makeStreamingKey(event.id, event.name),
							event.delta,
							scope,
						)
					}
				}
			}

			const trailingEvents = NativeToolCallParser.processRawChunk(
				{ index: 0, arguments: argumentsJson.slice(split) },
				scope,
			)
			expect(trailingEvents).toEqual([
				{
					type: "tool_call_delta",
					id: "call_late_identity",
					name: "read_file",
					delta: argumentsJson.slice(split),
				},
			])
			for (const event of trailingEvents) {
				if (event.type === "tool_call_delta") {
					if (event.name !== undefined) {
						// Post-merge streaming state is keyed by compound (id, name) keys;
						// raw-chunk deltas carry the tracked name, so rebuild the key Task.ts uses.
						NativeToolCallParser.processStreamingChunk(
							NativeToolCallParser.makeStreamingKey(event.id, event.name),
							event.delta,
							scope,
						)
					}
				}
			}

			expect(NativeToolCallParser.finalizeRawChunks(scope)).toEqual([
				{ type: "tool_call_end", id: "call_late_identity", name: "read_file" },
			])
			const result = NativeToolCallParser.finalizeStreamingToolCall(
				NativeToolCallParser.makeStreamingKey("call_late_identity", "read_file"),
				scope,
			)
			expect(result?.type).toBe("tool_use")
			if (result?.type === "tool_use") {
				expect(result.nativeArgs).toEqual({ path: "src/leading.ts", mode: "slice", offset: 1, limit: 2000 })
			}
		})

		it("does not emit an end event for argument chunks that never receive an identity", () => {
			const scope = NativeToolCallParser.createScope()
			NativeToolCallParser.processRawChunk({ index: 0, arguments: '{"path":"orphan.ts"}' }, scope)

			expect(NativeToolCallParser.finalizeRawChunks(scope)).toEqual([])
		})

		it("retains peer calls until each call in a scope is finalized", () => {
			const scope = NativeToolCallParser.createScope()
			const firstKey = NativeToolCallParser.makeStreamingKey("call_first", "read_file")
			const secondKey = NativeToolCallParser.makeStreamingKey("call_second", "read_file")
			NativeToolCallParser.startStreamingToolCall("call_first", "read_file", scope)
			NativeToolCallParser.startStreamingToolCall("call_second", "read_file", scope)
			NativeToolCallParser.processStreamingChunk(firstKey, '{"path":"first.ts"}', scope)
			NativeToolCallParser.processStreamingChunk(secondKey, '{"path":"second.ts"}', scope)

			const firstResult = NativeToolCallParser.finalizeStreamingToolCall(firstKey, scope)
			expect(firstResult?.type).toBe("tool_use")
			if (firstResult?.type === "tool_use") expect(firstResult.nativeArgs).toMatchObject({ path: "first.ts" })
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(scope)).toBe(true)
			const secondResult = NativeToolCallParser.finalizeStreamingToolCall(secondKey, scope)
			expect(secondResult?.type).toBe("tool_use")
			if (secondResult?.type === "tool_use") expect(secondResult.nativeArgs).toMatchObject({ path: "second.ts" })
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(scope)).toBe(false)
		})

		it("clears active raw and streaming state without affecting unused scopes", () => {
			const activeScope = NativeToolCallParser.createScope()
			const unusedScope = NativeToolCallParser.createScope()
			NativeToolCallParser.processRawChunk({ index: 0, id: "call_active", name: "read_file" }, activeScope)
			NativeToolCallParser.startStreamingToolCall("call_active", "read_file", activeScope)

			NativeToolCallParser.clearRawChunkState(activeScope)
			NativeToolCallParser.clearAllStreamingToolCalls(activeScope)

			expect(NativeToolCallParser.finalizeRawChunks(activeScope)).toEqual([])
			expect(NativeToolCallParser.processStreamingChunk("call_active", "{}", activeScope)).toBeNull()
			expect(NativeToolCallParser.processStreamingChunk("missing", "{}", unusedScope)).toBeNull()
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(activeScope)).toBe(false)
		})

		it("keeps interleaved task streams isolated", () => {
			const firstScope = NativeToolCallParser.createScope()
			const secondScope = NativeToolCallParser.createScope()

			const firstStart = NativeToolCallParser.processRawChunk(
				{ index: 0, id: "call_first", name: "read_file" },
				firstScope,
			)
			NativeToolCallParser.startStreamingToolCall("call_first", "read_file", firstScope)

			NativeToolCallParser.clearRawChunkState(secondScope)
			NativeToolCallParser.clearAllStreamingToolCalls(secondScope)
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(firstScope)).toBe(true)

			const secondStart = NativeToolCallParser.processRawChunk(
				{ index: 0, id: "call_second", name: "read_file" },
				secondScope,
			)

			expect(firstStart).toEqual([{ type: "tool_call_start", id: "call_first", name: "read_file" }])
			expect(secondStart).toEqual([{ type: "tool_call_start", id: "call_second", name: "read_file" }])

			NativeToolCallParser.startStreamingToolCall("call_second", "read_file", secondScope)

			const firstDelta = NativeToolCallParser.processRawChunk(
				{ index: 0, arguments: JSON.stringify({ path: "first.ts" }) },
				firstScope,
			)
			const secondDelta = NativeToolCallParser.processRawChunk(
				{ index: 0, arguments: JSON.stringify({ path: "second.ts" }) },
				secondScope,
			)

			// Delta events carry the tracked name so consumers can build compound keys.
			expect(firstDelta).toEqual([
				{
					type: "tool_call_delta",
					id: "call_first",
					name: "read_file",
					delta: JSON.stringify({ path: "first.ts" }),
				},
			])
			expect(secondDelta).toEqual([
				{
					type: "tool_call_delta",
					id: "call_second",
					name: "read_file",
					delta: JSON.stringify({ path: "second.ts" }),
				},
			])
			if (firstDelta[0]?.type !== "tool_call_delta" || secondDelta[0]?.type !== "tool_call_delta") {
				throw new Error("Expected argument delta events")
			}

			const firstKey = NativeToolCallParser.makeStreamingKey("call_first", "read_file")
			const secondKey = NativeToolCallParser.makeStreamingKey("call_second", "read_file")
			NativeToolCallParser.processStreamingChunk(firstKey, firstDelta[0].delta, firstScope)
			NativeToolCallParser.processStreamingChunk(secondKey, secondDelta[0].delta, secondScope)

			const firstFinalizeEvents = NativeToolCallParser.finalizeRawChunks(firstScope)
			expect(firstFinalizeEvents).toEqual([{ type: "tool_call_end", id: "call_first", name: "read_file" }])
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(firstScope)).toBe(true)
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(secondScope)).toBe(true)

			const firstResult = NativeToolCallParser.finalizeStreamingToolCall(firstKey, firstScope)
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(firstScope)).toBe(false)
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(secondScope)).toBe(true)

			const secondFinalizeEvents = NativeToolCallParser.finalizeRawChunks(secondScope)
			expect(secondFinalizeEvents).toEqual([{ type: "tool_call_end", id: "call_second", name: "read_file" }])
			const secondResult = NativeToolCallParser.finalizeStreamingToolCall(secondKey, secondScope)
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(secondScope)).toBe(false)
			expect(firstResult?.type).toBe("tool_use")
			expect(secondResult?.type).toBe("tool_use")
			if (firstResult?.type !== "tool_use" || secondResult?.type !== "tool_use") {
				throw new Error("Expected native tool uses")
			}
			expect(firstResult.nativeArgs).toEqual({ path: "first.ts" })
			expect(secondResult.nativeArgs).toEqual({ path: "second.ts" })

			expect(NativeToolCallParser.finalizeRawChunks(firstScope)).toEqual([])
			expect(NativeToolCallParser.finalizeStreamingToolCall(firstKey, firstScope)).toBeNull()
			expect(
				NativeToolCallParser.processRawChunk({ index: 0, arguments: "buffered-after-cleanup" }, firstScope),
			).toEqual([])
			expect(
				NativeToolCallParser.processRawChunk({ index: 0, id: "call_reprobe", name: "read_file" }, firstScope),
			).toEqual([
				{ type: "tool_call_start", id: "call_reprobe", name: "read_file" },
				{ type: "tool_call_delta", id: "call_reprobe", name: "read_file", delta: "buffered-after-cleanup" },
			])
		})

		describe("read_file tool", () => {
			it("should emit a partial ToolUse with nativeArgs.path during streaming", () => {
				const id = "toolu_streaming_123"
				const scope = NativeToolCallParser.createScope()
				NativeToolCallParser.startStreamingToolCall(id, "read_file", scope)

				// Simulate streaming chunks
				const fullArgs = JSON.stringify({ path: "src/test.ts" })

				// Process the complete args as a single chunk for simplicity using compound key
				const key = NativeToolCallParser.makeStreamingKey(id, "read_file")
				const result = NativeToolCallParser.processStreamingChunk(key, fullArgs, scope)

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
				const scope = NativeToolCallParser.createScope()
				NativeToolCallParser.startStreamingToolCall(id, "read_file", scope)

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
					scope,
				)

				const result = NativeToolCallParser.finalizeStreamingToolCall(key, scope)

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
			const scope = NativeToolCallParser.createScope()
			const id = "toolu_collision_123"

			// Start two tool calls with the same id but different names
			NativeToolCallParser.startStreamingToolCall(id, "read_file", scope)
			NativeToolCallParser.startStreamingToolCall(id, "write_to_file", scope)

			// Accumulate arguments for each using compound keys
			const key1 = NativeToolCallParser.makeStreamingKey(id, "read_file")
			const key2 = NativeToolCallParser.makeStreamingKey(id, "write_to_file")

			NativeToolCallParser.processStreamingChunk(key1, JSON.stringify({ path: "file_a.ts" }), scope)
			NativeToolCallParser.processStreamingChunk(
				key2,
				JSON.stringify({ path: "file_b.ts", content: "hello" }),
				scope,
			)

			// Finalize both and verify they have distinct arguments
			const result1 = NativeToolCallParser.finalizeStreamingToolCall(key1, scope)
			const result2 = NativeToolCallParser.finalizeStreamingToolCall(key2, scope)

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
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(scope)).toBe(false)
		})
	})

	describe("finalizeRawChunks", () => {
		it("should include name field in events for compound-key deduplication", () => {
			const scope = NativeToolCallParser.createScope()

			// Simulate two different tools with the same toolCallId via raw chunk tracking.
			// processRawChunk returns [start, delta] when arguments are provided alongside name.
			const result1 = NativeToolCallParser.processRawChunk(
				{
					index: 1,
					id: "toolu_sameid",
					name: "read_file",
					arguments: '{"path":"a.ts"}',
				},
				scope,
			)
			// First call for index 1 returns start + delta events
			expect(result1.some((e) => e.type === "tool_call_start")).toBe(true)

			const result2 = NativeToolCallParser.processRawChunk(
				{
					index: 2,
					id: "toolu_sameid",
					name: "write_to_file",
					arguments: '{"path":"b.ts","content":"hello"}',
				},
				scope,
			)
			// Second call for index 2 also returns start + delta events
			expect(result2.some((e) => e.type === "tool_call_start")).toBe(true)

			// Finalize raw chunks — both should be included with their names
			const finalizeEvents = NativeToolCallParser.finalizeRawChunks(scope)

			expect(finalizeEvents).toHaveLength(2)
			expect(finalizeEvents.every((e) => e.type === "tool_call_end")).toBe(true)

			// Each event must carry its name for compound-key deduplication
			const names = finalizeEvents.map((e) => (e.type === "tool_call_end" ? e.name : undefined))
			expect(names).toContain("read_file")
			expect(names).toContain("write_to_file")
		})

		it("should emit separate end events when two tools share the same toolCallId", () => {
			const scope = NativeToolCallParser.createScope()

			// Both tools use the exact same call ID but different names
			NativeToolCallParser.processRawChunk(
				{
					index: 10,
					id: "toolu_dup",
					name: "codebase_search",
					arguments: '{"query":"foo"}',
				},
				scope,
			)
			NativeToolCallParser.processRawChunk(
				{
					index: 11,
					id: "toolu_dup",
					name: "search_files",
					arguments: '{"path":".","regex":"bar"}',
				},
				scope,
			)

			const events = NativeToolCallParser.finalizeRawChunks(scope)

			// Should produce two distinct end events
			expect(events).toHaveLength(2)

			// Verify compound keys would be unique
			const dedupKeys = new Set(events.map((e) => (e.type === "tool_call_end" ? `${e.id}::${e.name}` : e.id)))
			expect(dedupKeys.size).toBe(2)
		})

		it("should keep distinct nativeArgs when same-ID calls route deltas through their own compound keys", () => {
			const scope = NativeToolCallParser.createScope()

			// Two raw chunks share the same tool call ID but carry different names.
			const events1 = NativeToolCallParser.processRawChunk(
				{
					index: 30,
					id: "toolu_route",
					name: "read_file",
					arguments: '{"path":"a.ts"}',
				},
				scope,
			)
			const events2 = NativeToolCallParser.processRawChunk(
				{
					index: 31,
					id: "toolu_route",
					name: "write_to_file",
					arguments: '{"path":"b.ts","content":"hi"}',
				},
				scope,
			)

			const start1 = events1.find((e) => e.type === "tool_call_start")
			const delta1 = events1.find((e) => e.type === "tool_call_delta")
			const start2 = events2.find((e) => e.type === "tool_call_start")
			const delta2 = events2.find((e) => e.type === "tool_call_delta")

			if (
				!start1 ||
				start1.type !== "tool_call_start" ||
				!delta1 ||
				delta1.type !== "tool_call_delta" ||
				!start2 ||
				start2.type !== "tool_call_start" ||
				!delta2 ||
				delta2.type !== "tool_call_delta"
			) {
				throw new Error("Expected start and delta events for both calls")
			}

			// Delta events carry the tracked name so the consumer can build the
			// unambiguous compound key without an id-only lookup.
			expect(delta1.name).toBe("read_file")
			expect(delta2.name).toBe("write_to_file")

			// Route the deltas exactly like Task does: through the compound key.
			NativeToolCallParser.startStreamingToolCall(start1.id, start1.name, scope)
			NativeToolCallParser.startStreamingToolCall(start2.id, start2.name, scope)
			const key1 = NativeToolCallParser.makeStreamingKey(start1.id, start1.name)
			const key2 = NativeToolCallParser.makeStreamingKey(start2.id, start2.name)
			const partial1 = NativeToolCallParser.processStreamingChunk(key1, delta1.delta, scope)
			const partial2 = NativeToolCallParser.processStreamingChunk(key2, delta2.delta, scope)
			expect(partial1).not.toBeNull()
			expect(partial2).not.toBeNull()

			// Each call finalizes under its own compound key with its own arguments.
			const final1 = NativeToolCallParser.finalizeStreamingToolCall(key1, scope)
			const final2 = NativeToolCallParser.finalizeStreamingToolCall(key2, scope)
			if (!final1 || !final2 || final1.type !== "tool_use" || final2.type !== "tool_use") {
				throw new Error("Expected both calls to finalize as tool_use")
			}
			expect(final1.name).toBe("read_file")
			expect(final2.name).toBe("write_to_file")
			expect(final1.nativeArgs).toMatchObject({ path: "a.ts" })
			expect(final2.nativeArgs).toMatchObject({ path: "b.ts" })
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(scope)).toBe(false)
		})

		it("keeps delimiter-colliding (id, name) pairs separate", () => {
			// The encoder must be injective: a pair whose segments contain the raw
			// delimiter must not collide with a pair that splits on it.
			const key1 = NativeToolCallParser.makeStreamingKey("a::b", "c")
			const key2 = NativeToolCallParser.makeStreamingKey("a", "b::c")
			expect(key1).not.toBe(key2)

			// Backslash-colliding pairs must stay separate as well: escaping the delimiter
			// alone is not enough when a segment ends in a backslash.
			const key3 = NativeToolCallParser.makeStreamingKey("a\\", "b::c")
			const key4 = NativeToolCallParser.makeStreamingKey("a::b\\", "c")
			expect(key3).not.toBe(key4)

			const scope = NativeToolCallParser.createScope()
			NativeToolCallParser.startStreamingToolCall("a::b", "c", scope)
			NativeToolCallParser.startStreamingToolCall("a", "b::c", scope)

			// Each pair keeps its own accumulator and name; a shared key would collapse
			// the second start into the first entry.
			expect(NativeToolCallParser.getStreamingToolName(key1, scope)).toBe("c")
			expect(NativeToolCallParser.getStreamingToolName(key2, scope)).toBe("b::c")

			const partial1 = NativeToolCallParser.processStreamingChunk(key1, '{"x":1}', scope)
			const partial2 = NativeToolCallParser.processStreamingChunk(key2, '{"y":2}', scope)
			expect(partial1).not.toBeNull()
			expect(partial2).not.toBeNull()

			// The accumulators must stay separate: a shared key would merge the deltas.
			const entry1 = NativeToolCallParser.getStreamingToolCallById("a::b", scope)
			const entry2 = NativeToolCallParser.getStreamingToolCallById("a", scope)
			expect(entry1).not.toBeNull()
			expect(entry2).not.toBeNull()
			if (!entry1 || !entry2) {
				throw new Error("Expected both tracked entries")
			}
			expect(entry1.argumentsAccumulator).toBe('{"x":1}')
			expect(entry2.argumentsAccumulator).toBe('{"y":2}')
		})
	})

	describe("processRawChunk streaming reassembly", () => {
		// Mirror the sequencing Task.ts performs: feed each raw chunk through
		// processRawChunk, drive startStreamingToolCall on tool_call_start, feed
		// tool_call_delta into processStreamingChunk, and emit ends at stream close
		// via finalizeRawChunks() (the same call Task.ts makes after the stream ends).
		// Returns the ordered event types/ids plus the finalized tool uses by id.
		const drive = (rawChunks: Array<{ index: number; id?: string; name?: string; arguments?: string }>) => {
			const events: ToolCallStreamEvent[] = []
			const scope = NativeToolCallParser.createScope()

			const handleEvent = (event: ToolCallStreamEvent) => {
				events.push(event)
				if (event.type === "tool_call_start") {
					NativeToolCallParser.startStreamingToolCall(event.id, event.name, scope)
				} else if (event.type === "tool_call_delta") {
					if (event.name !== undefined) {
						// Post-merge streaming state is keyed by compound (id, name) keys;
						// raw-chunk deltas carry the tracked name, so rebuild the key Task.ts uses.
						NativeToolCallParser.processStreamingChunk(
							NativeToolCallParser.makeStreamingKey(event.id, event.name),
							event.delta,
							scope,
						)
					}
				}
			}

			for (const chunk of rawChunks) {
				for (const event of NativeToolCallParser.processRawChunk(chunk, scope)) {
					handleEvent(event)
				}
			}

			// Task.ts finalizes any tool calls still open at stream end via
			// finalizeRawChunks(), which emits the tool_call_end events.
			for (const event of NativeToolCallParser.finalizeRawChunks(scope)) {
				handleEvent(event)
			}

			const finalized = new Map<string, ReturnType<typeof NativeToolCallParser.finalizeStreamingToolCall>>()
			for (const start of events.filter((e) => e.type === "tool_call_start")) {
				finalized.set(
					start.id,
					NativeToolCallParser.finalizeStreamingToolCall(
						NativeToolCallParser.makeStreamingKey(start.id, start.name),
						scope,
					),
				)
			}

			return { events, finalized }
		}

		it("preserves leading argument bytes that arrive before the id", () => {
			// First chunk carries arguments but NO id; id+name arrive later, then more args.
			const fullArgs = JSON.stringify({ path: "src/leading.ts", mode: "slice" })
			const firstHalf = fullArgs.slice(0, 10)
			const secondHalf = fullArgs.slice(10)

			const { events, finalized } = drive([
				{ index: 0, arguments: firstHalf },
				{ index: 0, id: "call_late_id", name: "read_file" },
				{ index: 0, arguments: secondHalf },
			])

			// Exactly one start, in the right order, with the late id.
			const starts = events.filter((e) => e.type === "tool_call_start")
			expect(starts).toHaveLength(1)
			expect(starts[0].id).toBe("call_late_id")

			// The finalized arguments must contain the complete, uncorrupted payload.
			const result = finalized.get("call_late_id")
			expect(result).not.toBeNull()
			expect(result?.type).toBe("tool_use")
			if (result?.type === "tool_use") {
				const nativeArgs = result.nativeArgs as { path: string; mode?: string }
				expect(nativeArgs.path).toBe("src/leading.ts")
				expect(nativeArgs.mode).toBe("slice")
			}
		})

		it("handles id and name arriving in separate chunks (issue #218)", () => {
			const fullArgs = JSON.stringify({ path: "src/split.ts" })

			const { events, finalized } = drive([
				{ index: 0, id: "call_split" },
				{ index: 0, name: "read_file" },
				{ index: 0, arguments: fullArgs },
			])

			const starts = events.filter((e) => e.type === "tool_call_start")
			expect(starts).toHaveLength(1)
			expect(starts[0].id).toBe("call_split")

			const result = finalized.get("call_split")
			expect(result?.type).toBe("tool_use")
			if (result?.type === "tool_use") {
				const nativeArgs = result.nativeArgs as { path: string }
				expect(nativeArgs.path).toBe("src/split.ts")
			}
		})

		it("handles name arriving before id with buffered args in between (reverse ordering)", () => {
			const fullArgs = JSON.stringify({ path: "src/reverse.ts" })
			const firstHalf = fullArgs.slice(0, 9)
			const secondHalf = fullArgs.slice(9)

			const { events, finalized } = drive([
				{ index: 0, name: "read_file" },
				{ index: 0, arguments: firstHalf },
				{ index: 0, id: "call_reverse" },
				{ index: 0, arguments: secondHalf },
			])

			// Start must not fire until the id arrives, so exactly one start with the late id.
			const starts = events.filter((e) => e.type === "tool_call_start")
			expect(starts).toHaveLength(1)
			expect(starts[0].id).toBe("call_reverse")

			// The buffered delta must be flushed only after the start event.
			const startIndex = events.findIndex((e) => e.type === "tool_call_start")
			const firstDeltaIndex = events.findIndex((e) => e.type === "tool_call_delta")
			expect(startIndex).toBeLessThan(firstDeltaIndex)

			const result = finalized.get("call_reverse")
			expect(result).not.toBeNull()
			expect(result?.type).toBe("tool_use")
			if (result?.type === "tool_use") {
				expect((result.nativeArgs as { path: string }).path).toBe("src/reverse.ts")
			}
		})

		it("keeps two parallel tool calls on distinct indices isolated", () => {
			const argsA = JSON.stringify({ path: "src/a.ts" })
			const argsB = JSON.stringify({ path: "src/b.ts" })

			const { events, finalized } = drive([
				{ index: 0, arguments: argsA.slice(0, 8) },
				{ index: 1, arguments: argsB.slice(0, 8) },
				{ index: 0, id: "call_a", name: "read_file" },
				{ index: 1, id: "call_b", name: "read_file" },
				{ index: 0, arguments: argsA.slice(8) },
				{ index: 1, arguments: argsB.slice(8) },
			])

			const starts = events.filter((e) => e.type === "tool_call_start")
			expect(starts).toHaveLength(2)

			const resultA = finalized.get("call_a")
			const resultB = finalized.get("call_b")
			expect(resultA).not.toBeNull()
			expect(resultB).not.toBeNull()
			if (resultA?.type === "tool_use") {
				expect((resultA.nativeArgs as { path: string }).path).toBe("src/a.ts")
			}
			if (resultB?.type === "tool_use") {
				expect((resultB.nativeArgs as { path: string }).path).toBe("src/b.ts")
			}
		})

		it("emits the same event sequence for the single-chunk-with-id flow (regression guard)", () => {
			const fullArgs = JSON.stringify({ path: "src/single.ts" })

			const { events, finalized } = drive([
				{ index: 0, id: "call_single", name: "read_file", arguments: fullArgs },
			])

			expect(events.map((e) => e.type)).toEqual(["tool_call_start", "tool_call_delta", "tool_call_end"])
			expect(events.every((e) => e.id === "call_single")).toBe(true)

			const result = finalized.get("call_single")
			expect(result).not.toBeNull()
			expect(result?.type).toBe("tool_use")
			if (result?.type === "tool_use") {
				expect((result.nativeArgs as { path: string }).path).toBe("src/single.ts")
			}
		})

		it("does not emit a phantom tool_call_end for a tracker that never received an id", () => {
			const { events } = drive([{ index: 0, arguments: '{"path":"orphan.ts"}' }])

			expect(events.filter((e) => e.type === "tool_call_start")).toHaveLength(0)
			expect(events.filter((e) => e.type === "tool_call_end")).toHaveLength(0)
		})

		it("finalizeRawChunks() emits end events and guards against missing id", () => {
			const scope = NativeToolCallParser.createScope()
			// Simulate a started tool call: process chunks to populate state
			const chunks = [
				{ index: 0, id: "call_finalize", name: "read_file" },
				{ index: 0, arguments: '{"path":"file.ts"' },
				{ index: 0, arguments: ',"mode":"slice"}' },
			]

			const events: ToolCallStreamEvent[] = []
			for (const chunk of chunks) {
				for (const event of NativeToolCallParser.processRawChunk(chunk, scope)) {
					events.push(event)
					if (event.type === "tool_call_start") {
						NativeToolCallParser.startStreamingToolCall(event.id, event.name, scope)
					} else if (event.type === "tool_call_delta") {
						if (event.name !== undefined) {
							// Post-merge streaming state is keyed by compound (id, name) keys;
							// raw-chunk deltas carry the tracked name, so rebuild the key Task.ts uses.
							NativeToolCallParser.processStreamingChunk(
								NativeToolCallParser.makeStreamingKey(event.id, event.name),
								event.delta,
								scope,
							)
						}
					}
				}
			}

			// Now finalize the raw chunks to emit the end event
			const finalizeEvents = NativeToolCallParser.finalizeRawChunks(scope)
			for (const event of finalizeEvents) {
				events.push(event)
			}

			// Verify the end event was produced by finalizeRawChunks
			const ends = events.filter((e) => e.type === "tool_call_end")
			expect(ends).toHaveLength(1)
			expect(ends[0].id).toBe("call_finalize")

			// Finalize the tool call to ensure it contains the complete arguments
			const result = NativeToolCallParser.finalizeStreamingToolCall(
				NativeToolCallParser.makeStreamingKey("call_finalize", "read_file"),
				scope,
			)
			expect(result?.type).toBe("tool_use")
			if (result?.type === "tool_use") {
				expect((result.nativeArgs as { path: string }).path).toBe("file.ts")
			}
		})

		it("finalizeRawChunks() does not emit end for tracker without id", () => {
			const scope = NativeToolCallParser.createScope()
			// Start a tracker with arguments but no id, then finalize
			const chunks = [{ index: 0, arguments: '{"incomplete":true}' }]

			for (const chunk of chunks) {
				NativeToolCallParser.processRawChunk(chunk, scope)
			}

			// Finalize should not emit an end event if id was never set
			const finalizeEvents = NativeToolCallParser.finalizeRawChunks(scope)
			const ends = finalizeEvents.filter((e) => e.type === "tool_call_end")
			expect(ends).toHaveLength(0)

			NativeToolCallParser.clearRawChunkState(scope)
		})

		it("does not double-fire end events across repeated finalizeRawChunks calls", () => {
			const scope = NativeToolCallParser.createScope()
			// Drive a started tool call through the raw chunk path.
			const chunks = [
				{ index: 0, id: "call_dup", name: "read_file" },
				{ index: 0, arguments: '{"path":"file.ts"}' },
			]
			for (const chunk of chunks) {
				NativeToolCallParser.processRawChunk(chunk, scope)
			}

			const finishEvents = NativeToolCallParser.finalizeRawChunks(scope)
			const finalizeEvents = NativeToolCallParser.finalizeRawChunks(scope)

			const allEnds = [...finishEvents, ...finalizeEvents].filter((e) => e.type === "tool_call_end")
			expect(allEnds).toHaveLength(1)
			expect(allEnds[0].id).toBe("call_dup")

			NativeToolCallParser.clearRawChunkState(scope)
		})
	})

	// The compound-key contract in isolation: the gate verifies the escape itself (a behavioral
	// collision test cannot distinguish which escape substitution is wrong), plus the defensive
	// lookups that must stay total over missing scopes/keys.
	describe("compound key encoding and lookups", () => {
		it("escapes backslashes and colons in both key segments", () => {
			expect(NativeToolCallParser.makeStreamingKey("a\\b:c", "x::y")).toBe("a\\\\b\\:c::x\\:\\:y")
		})

		// These two pairs share one key under the naive `${id}::${name}` encoding — the escape must
		// keep them separate so their accumulators and dedup tracking never fuse.
		it("keeps (id, name) pairs that would collide under naive joining separate", () => {
			const keyA = NativeToolCallParser.makeStreamingKey("t1", "a::b")
			const keyB = NativeToolCallParser.makeStreamingKey("t1::a", "b")

			expect(keyA).not.toBe(keyB)
		})

		it("returns undefined from getStreamingToolName for an untracked key in a live scope", () => {
			// The scope's map exists (a call is tracked) but the queried key is absent: the inner
			// optional chain must short-circuit to undefined instead of throwing.
			const scope = NativeToolCallParser.createScope()
			NativeToolCallParser.startStreamingToolCall("toolu_live", "read_file", scope)

			expect(NativeToolCallParser.getStreamingToolName("toolu_other::read_file", scope)).toBeUndefined()
			expect(
				NativeToolCallParser.getStreamingToolName(
					NativeToolCallParser.makeStreamingKey("toolu_live", "read_file"),
					scope,
				),
			).toBe("read_file")
		})

		it("returns null from getStreamingToolCallById for a scope with no tracked calls", () => {
			// A fresh scope has no streaming map at all: the guard must return null rather than
			// throwing on the missing map.
			const scope = NativeToolCallParser.createScope()

			expect(NativeToolCallParser.getStreamingToolCallById("toolu_none", scope)).toBeNull()
		})
	})
})
