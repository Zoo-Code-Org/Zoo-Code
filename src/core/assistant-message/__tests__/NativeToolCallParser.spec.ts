import { NativeToolCallParser, type ToolCallStreamEvent } from "../NativeToolCallParser"

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

				// Process the complete args as a single chunk for simplicity
				const result = NativeToolCallParser.processStreamingChunk(id, fullArgs)

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

				// Add the complete arguments
				NativeToolCallParser.processStreamingChunk(
					id,
					JSON.stringify({
						path: "finalized.ts",
						mode: "slice",
						offset: 1,
						limit: 10,
					}),
				)

				const result = NativeToolCallParser.finalizeStreamingToolCall(id)

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

	describe("processRawChunk streaming reassembly", () => {
		// Mirror the sequencing Task.ts performs: feed each raw chunk through
		// processRawChunk, drive startStreamingToolCall on tool_call_start, feed
		// tool_call_delta into processStreamingChunk, and emit ends at stream close
		// via finalizeRawChunks() (the same call Task.ts makes after the stream ends).
		// Returns the ordered event types/ids plus the finalized tool uses by id.
		const drive = (rawChunks: Array<{ index: number; id?: string; name?: string; arguments?: string }>) => {
			const events: ToolCallStreamEvent[] = []

			const handleEvent = (event: ToolCallStreamEvent) => {
				events.push(event)
				if (event.type === "tool_call_start") {
					NativeToolCallParser.startStreamingToolCall(event.id, event.name)
				} else if (event.type === "tool_call_delta") {
					NativeToolCallParser.processStreamingChunk(event.id, event.delta)
				}
			}

			for (const chunk of rawChunks) {
				for (const event of NativeToolCallParser.processRawChunk(chunk)) {
					handleEvent(event)
				}
			}

			// Task.ts finalizes any tool calls still open at stream end via
			// finalizeRawChunks(), which emits the tool_call_end events.
			for (const event of NativeToolCallParser.finalizeRawChunks()) {
				handleEvent(event)
			}

			const finalized = new Map<string, ReturnType<typeof NativeToolCallParser.finalizeStreamingToolCall>>()
			const startIds = events.filter((e) => e.type === "tool_call_start").map((e) => e.id)
			for (const id of startIds) {
				finalized.set(id, NativeToolCallParser.finalizeStreamingToolCall(id))
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
			// Simulate a started tool call: process chunks to populate state
			const chunks = [
				{ index: 0, id: "call_finalize", name: "read_file" },
				{ index: 0, arguments: '{"path":"file.ts"' },
				{ index: 0, arguments: ',"mode":"slice"}' },
			]

			const events: Array<{ type: string; id?: string }> = []
			for (const chunk of chunks) {
				for (const event of NativeToolCallParser.processRawChunk(chunk)) {
					events.push(event)
					if (event.type === "tool_call_start") {
						NativeToolCallParser.startStreamingToolCall(event.id, event.name)
					} else if (event.type === "tool_call_delta") {
						NativeToolCallParser.processStreamingChunk(event.id, event.delta)
					}
				}
			}

			// Now finalize the raw chunks to emit the end event
			const finalizeEvents = NativeToolCallParser.finalizeRawChunks()
			for (const event of finalizeEvents) {
				events.push(event)
			}

			// Verify the end event was produced by finalizeRawChunks
			const ends = events.filter((e) => e.type === "tool_call_end")
			expect(ends).toHaveLength(1)
			expect(ends[0].id).toBe("call_finalize")

			// Finalize the tool call to ensure it contains the complete arguments
			const result = NativeToolCallParser.finalizeStreamingToolCall("call_finalize")
			expect(result?.type).toBe("tool_use")
			if (result?.type === "tool_use") {
				expect((result.nativeArgs as { path: string }).path).toBe("file.ts")
			}
		})

		it("finalizeRawChunks() does not emit end for tracker without id", () => {
			// Start a tracker with arguments but no id, then finalize
			const chunks = [{ index: 0, arguments: '{"incomplete":true}' }]

			for (const chunk of chunks) {
				NativeToolCallParser.processRawChunk(chunk)
			}

			// Finalize should not emit an end event if id was never set
			const finalizeEvents = NativeToolCallParser.finalizeRawChunks()
			const ends = finalizeEvents.filter((e) => e.type === "tool_call_end")
			expect(ends).toHaveLength(0)

			NativeToolCallParser.clearRawChunkState()
		})

		it("does not double-fire end events across processFinishReason and finalizeRawChunks", () => {
			// Drive a started tool call through the raw chunk path.
			const chunks = [
				{ index: 0, id: "call_dup", name: "read_file" },
				{ index: 0, arguments: '{"path":"file.ts"}' },
			]
			for (const chunk of chunks) {
				NativeToolCallParser.processRawChunk(chunk)
			}

			// Task.ts emits ends via processFinishReason, then calls finalizeRawChunks
			// unconditionally. Both must not emit an end for the same tracker.
			const finishEvents = NativeToolCallParser.processFinishReason("tool_calls")
			const finalizeEvents = NativeToolCallParser.finalizeRawChunks()

			const allEnds = [...finishEvents, ...finalizeEvents].filter((e) => e.type === "tool_call_end")
			expect(allEnds).toHaveLength(1)
			expect(allEnds[0].id).toBe("call_dup")
			// finishReason emits the single end; finalize must be a no-op for the same tracker.
			expect(finishEvents.filter((e) => e.type === "tool_call_end")).toHaveLength(1)
			expect(finalizeEvents.filter((e) => e.type === "tool_call_end")).toHaveLength(0)

			NativeToolCallParser.clearRawChunkState()
		})
	})
})
