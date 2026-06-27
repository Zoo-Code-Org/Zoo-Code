import { NativeToolCallParser } from "../NativeToolCallParser"

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
				NativeToolCallParser.processRawChunk({ index: 0, arguments: "ignored-after-cleanup" }, firstScope),
			).toEqual([])
			expect(
				NativeToolCallParser.processRawChunk({ index: 0, id: "call_reprobe", name: "read_file" }, firstScope),
			).toEqual([{ type: "tool_call_start", id: "call_reprobe", name: "read_file" }])
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
})
