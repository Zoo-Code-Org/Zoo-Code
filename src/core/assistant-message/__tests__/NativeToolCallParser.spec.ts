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

		describe("fetch_web_content tool", () => {
			it("should parse fetch_web_content with url and prompt", () => {
				const toolCall = {
					id: "toolu_fetch_1",
					name: "fetch_web_content" as const,
					arguments: JSON.stringify({
						url: "https://example.com",
						prompt: "Find the main heading",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.nativeArgs).toBeDefined()
					const nativeArgs = result.nativeArgs as { url: string; prompt?: string }
					expect(nativeArgs.url).toBe("https://example.com")
					expect(nativeArgs.prompt).toBe("Find the main heading")
				}
			})

			it("should parse fetch_web_content with url only (no prompt)", () => {
				const toolCall = {
					id: "toolu_fetch_2",
					name: "fetch_web_content" as const,
					arguments: JSON.stringify({
						url: "https://api.example.com/status",
						prompt: null,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.nativeArgs).toBeDefined()
					const nativeArgs = result.nativeArgs as { url: string; prompt?: string | null }
					expect(nativeArgs.url).toBe("https://api.example.com/status")
					expect(nativeArgs.prompt).toBeNull()
				}
			})

			it("should return null when url is missing", () => {
				const toolCall = {
					id: "toolu_fetch_3",
					name: "fetch_web_content" as const,
					arguments: JSON.stringify({
						prompt: "some prompt",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				// Should return null because nativeArgs can't be constructed without url
				expect(result).toBeNull()
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
					delta: argumentsJson.slice(0, split),
				},
			])

			NativeToolCallParser.startStreamingToolCall("call_late_identity", "read_file", scope)
			for (const event of identifiedEvents) {
				if (event.type === "tool_call_delta") {
					NativeToolCallParser.processStreamingChunk(event.id, event.delta, scope)
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
					delta: argumentsJson.slice(split),
				},
			])
			for (const event of trailingEvents) {
				if (event.type === "tool_call_delta") {
					NativeToolCallParser.processStreamingChunk(event.id, event.delta, scope)
				}
			}

			expect(NativeToolCallParser.finalizeRawChunks(scope)).toEqual([
				{ type: "tool_call_end", id: "call_late_identity" },
			])
			const result = NativeToolCallParser.finalizeStreamingToolCall("call_late_identity", scope)
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
			NativeToolCallParser.startStreamingToolCall("call_first", "read_file", scope)
			NativeToolCallParser.startStreamingToolCall("call_second", "read_file", scope)
			NativeToolCallParser.processStreamingChunk("call_first", '{"path":"first.ts"}', scope)
			NativeToolCallParser.processStreamingChunk("call_second", '{"path":"second.ts"}', scope)

			const firstResult = NativeToolCallParser.finalizeStreamingToolCall("call_first", scope)
			expect(firstResult?.type).toBe("tool_use")
			if (firstResult?.type === "tool_use") expect(firstResult.nativeArgs).toMatchObject({ path: "first.ts" })
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(scope)).toBe(true)
			const secondResult = NativeToolCallParser.finalizeStreamingToolCall("call_second", scope)
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

			expect(firstDelta).toEqual([
				{ type: "tool_call_delta", id: "call_first", delta: JSON.stringify({ path: "first.ts" }) },
			])
			expect(secondDelta).toEqual([
				{ type: "tool_call_delta", id: "call_second", delta: JSON.stringify({ path: "second.ts" }) },
			])
			if (firstDelta[0]?.type !== "tool_call_delta" || secondDelta[0]?.type !== "tool_call_delta") {
				throw new Error("Expected argument delta events")
			}

			NativeToolCallParser.processStreamingChunk("call_first", firstDelta[0].delta, firstScope)
			NativeToolCallParser.processStreamingChunk("call_second", secondDelta[0].delta, secondScope)

			const firstFinalizeEvents = NativeToolCallParser.finalizeRawChunks(firstScope)
			expect(firstFinalizeEvents).toEqual([{ type: "tool_call_end", id: "call_first" }])
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(firstScope)).toBe(true)
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(secondScope)).toBe(true)

			const firstResult = NativeToolCallParser.finalizeStreamingToolCall("call_first", firstScope)
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(firstScope)).toBe(false)
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(secondScope)).toBe(true)

			const secondFinalizeEvents = NativeToolCallParser.finalizeRawChunks(secondScope)
			expect(secondFinalizeEvents).toEqual([{ type: "tool_call_end", id: "call_second" }])
			const secondResult = NativeToolCallParser.finalizeStreamingToolCall("call_second", secondScope)
			expect(NativeToolCallParser.hasActiveStreamingToolCalls(secondScope)).toBe(false)
			expect(firstResult?.type).toBe("tool_use")
			expect(secondResult?.type).toBe("tool_use")
			if (firstResult?.type !== "tool_use" || secondResult?.type !== "tool_use") {
				throw new Error("Expected native tool uses")
			}
			expect(firstResult.nativeArgs).toEqual({ path: "first.ts" })
			expect(secondResult.nativeArgs).toEqual({ path: "second.ts" })

			expect(NativeToolCallParser.finalizeRawChunks(firstScope)).toEqual([])
			expect(NativeToolCallParser.finalizeStreamingToolCall("call_first", firstScope)).toBeNull()
			expect(
				NativeToolCallParser.processRawChunk({ index: 0, arguments: "buffered-after-cleanup" }, firstScope),
			).toEqual([])
			expect(
				NativeToolCallParser.processRawChunk({ index: 0, id: "call_reprobe", name: "read_file" }, firstScope),
			).toEqual([
				{ type: "tool_call_start", id: "call_reprobe", name: "read_file" },
				{ type: "tool_call_delta", id: "call_reprobe", delta: "buffered-after-cleanup" },
			])
		})

		describe("read_file tool", () => {
			it("should emit a partial ToolUse with nativeArgs.path during streaming", () => {
				const id = "toolu_streaming_123"
				const scope = NativeToolCallParser.createScope()
				NativeToolCallParser.startStreamingToolCall(id, "read_file", scope)

				// Simulate streaming chunks
				const fullArgs = JSON.stringify({ path: "src/test.ts" })

				// Process the complete args as a single chunk for simplicity
				const result = NativeToolCallParser.processStreamingChunk(id, fullArgs, scope)

				expect(result).not.toBeNull()
				expect(result?.nativeArgs).toBeDefined()
				const nativeArgs = result?.nativeArgs as { path: string }
				expect(nativeArgs.path).toBe("src/test.ts")
			})
		})

		describe("fetch_web_content tool", () => {
			it("should emit a partial ToolUse with nativeArgs.url during streaming", () => {
				const id = "toolu_streaming_fetch_1"
				const scope = NativeToolCallParser.createScope()
				NativeToolCallParser.startStreamingToolCall(id, "fetch_web_content", scope)

				const fullArgs = JSON.stringify({ url: "https://example.com", prompt: "Find info" })
				const result = NativeToolCallParser.processStreamingChunk(id, fullArgs, scope)

				expect(result).not.toBeNull()
				expect(result?.nativeArgs).toBeDefined()
				const nativeArgs = result?.nativeArgs as { url: string; prompt?: string }
				expect(nativeArgs.url).toBe("https://example.com")
				expect(nativeArgs.prompt).toBe("Find info")
			})

			it("should accumulate nativeArgs across fragmented chunks split in awkward places", () => {
				const id = "toolu_streaming_fetch_fragmented_1"
				const scope = NativeToolCallParser.createScope()
				NativeToolCallParser.startStreamingToolCall(id, "fetch_web_content", scope)

				// Split the JSON arguments across several fragmented chunks,
				// including splits mid-key, mid-string-value, and between url and prompt.
				const chunks = [
					'{"ur', // mid-key: "url" is not complete yet
					'l":"https://exa', // completes the key, starts the value mid-string
					'mple.com"', // completes the url value
					',"prom', // mid-key for "prompt"
					'pt":"summ', // completes the key, starts the value mid-string
					'arize"}', // completes the prompt value and the object
				]

				let lastResult: ReturnType<typeof NativeToolCallParser.processStreamingChunk> = null
				for (const chunk of chunks) {
					// Feeding fragmented chunks must never throw.
					expect(() => {
						lastResult = NativeToolCallParser.processStreamingChunk(id, chunk, scope)
					}).not.toThrow()
				}

				// After all chunks arrive, the partial ToolUse should have the full url and prompt.
				expect(lastResult).not.toBeNull()
				expect(lastResult!.partial).toBe(true)
				expect(lastResult!.nativeArgs).toBeDefined()
				const nativeArgs = lastResult!.nativeArgs as { url: string; prompt?: string }
				expect(nativeArgs.url).toBe("https://example.com")
				expect(nativeArgs.prompt).toBe("summarize")
			})

			it("should expose the url before the prompt has fully arrived", () => {
				const id = "toolu_streaming_fetch_fragmented_2"
				const scope = NativeToolCallParser.createScope()
				NativeToolCallParser.startStreamingToolCall(id, "fetch_web_content", scope)

				// Before the url value is complete, nativeArgs may be absent (partialArgs.url undefined).
				const beforeUrl = NativeToolCallParser.processStreamingChunk(id, '{"url":"https://exa', scope)
				expect(beforeUrl).not.toBeNull()
				// partial-json exposes the in-progress url string immediately.
				const beforeUrlArgs = beforeUrl?.nativeArgs as { url?: string; prompt?: string } | undefined
				expect(beforeUrlArgs?.url).toBe("https://exa")
				// The prompt has not been seen at all yet.
				expect(beforeUrlArgs?.prompt).toBeUndefined()

				// The url completes and the prompt key begins, but its value hasn't arrived.
				const midPrompt = NativeToolCallParser.processStreamingChunk(id, 'mple.com","prompt":"su', scope)
				expect(midPrompt).not.toBeNull()
				const midPromptArgs = midPrompt?.nativeArgs as { url?: string; prompt?: string } | undefined
				expect(midPromptArgs?.url).toBe("https://example.com")
				expect(midPromptArgs?.prompt).toBe("su")

				// The remaining chunk completes the prompt value and the object.
				const complete = NativeToolCallParser.processStreamingChunk(id, 'mmarize"}', scope)
				expect(complete).not.toBeNull()
				const completeArgs = complete?.nativeArgs as { url: string; prompt?: string }
				expect(completeArgs.url).toBe("https://example.com")
				expect(completeArgs.prompt).toBe("summarize")
			})
		})
	})

	describe("finalizeStreamingToolCall", () => {
		describe("read_file tool", () => {
			it("should parse read_file args on finalize", () => {
				const id = "toolu_finalize_123"
				const scope = NativeToolCallParser.createScope()
				NativeToolCallParser.startStreamingToolCall(id, "read_file", scope)

				// Add the complete arguments
				NativeToolCallParser.processStreamingChunk(
					id,
					JSON.stringify({
						path: "finalized.ts",
						mode: "slice",
						offset: 1,
						limit: 10,
					}),
					scope,
				)

				const result = NativeToolCallParser.finalizeStreamingToolCall(id, scope)

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

		describe("fetch_web_content tool", () => {
			it("should parse fetch_web_content args on finalize", () => {
				const id = "toolu_finalize_fetch_1"
				const scope = NativeToolCallParser.createScope()
				NativeToolCallParser.startStreamingToolCall(id, "fetch_web_content", scope)

				NativeToolCallParser.processStreamingChunk(
					id,
					JSON.stringify({
						url: "https://docs.example.com/api",
						prompt: "Find authentication methods",
					}),
					scope,
				)

				const result = NativeToolCallParser.finalizeStreamingToolCall(id, scope)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as { url: string; prompt?: string }
					expect(nativeArgs.url).toBe("https://docs.example.com/api")
					expect(nativeArgs.prompt).toBe("Find authentication methods")
				}
			})

			it("should finalize fetch_web_content args delivered across fragmented chunks", () => {
				const id = "toolu_finalize_fetch_fragmented"
				const scope = NativeToolCallParser.createScope()
				NativeToolCallParser.startStreamingToolCall(id, "fetch_web_content", scope)

				// Deliver the JSON arguments across several fragmented chunks,
				// including splits mid-key, mid-string-value, and between url and prompt.
				const chunks = [
					'{"ur',
					'l":"https://docs.example.',
					'com/api"',
					',"prom',
					'pt":"Find authentication ',
					'methods"}',
				]

				let lastPartial: ReturnType<typeof NativeToolCallParser.processStreamingChunk> = null
				for (const chunk of chunks) {
					lastPartial = NativeToolCallParser.processStreamingChunk(id, chunk, scope)
					// Partial updates must remain flagged partial while streaming.
					if (lastPartial) {
						expect(lastPartial.partial).toBe(true)
					}
				}

				const result = NativeToolCallParser.finalizeStreamingToolCall(id, scope)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					// The finalized tool call must no longer be partial.
					expect(result.partial).toBe(false)
					const nativeArgs = result.nativeArgs as { url: string; prompt?: string }
					expect(nativeArgs.url).toBe("https://docs.example.com/api")
					expect(nativeArgs.prompt).toBe("Find authentication methods")
				}
			})

			it("should parse fetch_web_content with null prompt on finalize", () => {
				const id = "toolu_finalize_fetch_2"
				const scope = NativeToolCallParser.createScope()
				NativeToolCallParser.startStreamingToolCall(id, "fetch_web_content", scope)

				NativeToolCallParser.processStreamingChunk(
					id,
					JSON.stringify({
						url: "https://api.example.com/status",
						prompt: null,
					}),
					scope,
				)

				const result = NativeToolCallParser.finalizeStreamingToolCall(id, scope)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as { url: string; prompt?: string | null }
					expect(nativeArgs.url).toBe("https://api.example.com/status")
					expect(nativeArgs.prompt).toBeNull()
				}
			})
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
					NativeToolCallParser.processStreamingChunk(event.id, event.delta, scope)
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
			const startIds = events.filter((e) => e.type === "tool_call_start").map((e) => e.id)
			for (const id of startIds) {
				finalized.set(id, NativeToolCallParser.finalizeStreamingToolCall(id, scope))
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

			const events: Array<{ type: string; id?: string }> = []
			for (const chunk of chunks) {
				for (const event of NativeToolCallParser.processRawChunk(chunk, scope)) {
					events.push(event)
					if (event.type === "tool_call_start") {
						NativeToolCallParser.startStreamingToolCall(event.id, event.name, scope)
					} else if (event.type === "tool_call_delta") {
						NativeToolCallParser.processStreamingChunk(event.id, event.delta, scope)
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
			const result = NativeToolCallParser.finalizeStreamingToolCall("call_finalize", scope)
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
})
