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

		describe("execute_command tool", () => {
			it("should parse execute_command with cwd as string", () => {
				const toolCall = {
					id: "toolu_exec_cwd_str",
					name: "execute_command" as const,
					arguments: JSON.stringify({
						command: "ls -la",
						cwd: "/home/user/projects",
						timeout: 30,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						command: string
						cwd?: string
						timeout?: number
					}
					expect(nativeArgs.command).toBe("ls -la")
					expect(nativeArgs.cwd).toBe("/home/user/projects")
					expect(nativeArgs.timeout).toBe(30)
				}
			})

			it("should parse execute_command with cwd omitted (uses default)", () => {
				const toolCall = {
					id: "toolu_exec_cwd_omitted",
					name: "execute_command" as const,
					arguments: JSON.stringify({
						command: "npm run build",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						command: string
						cwd?: string
						timeout?: number
					}
					expect(nativeArgs.command).toBe("npm run build")
					expect(nativeArgs.cwd).toBeUndefined()
					expect(nativeArgs.timeout).toBeUndefined()
				}
			})

			it("should normalize cwd null to undefined (valid)", () => {
				const toolCall = {
					id: "toolu_exec_cwd_null",
					name: "execute_command" as const,
					arguments: JSON.stringify({
						command: "echo hello",
						cwd: null,
						timeout: null,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						command: string
						cwd?: string
						timeout?: number
					}
					expect(nativeArgs.command).toBe("echo hello")
					expect(nativeArgs.cwd).toBeUndefined()
					expect(nativeArgs.timeout).toBeUndefined()
				}
			})

			it("should parse execute_command with cwd as empty string (valid)", () => {
				const toolCall = {
					id: "toolu_exec_cwd_empty",
					name: "execute_command" as const,
					arguments: JSON.stringify({
						command: "pwd",
						cwd: "",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						command: string
						cwd?: string
					}
					expect(nativeArgs.command).toBe("pwd")
					expect(nativeArgs.cwd).toBe("")
				}
			})

			it("should reject cwd as array (parse failure)", () => {
				const toolCall = {
					id: "toolu_exec_cwd_array",
					name: "execute_command" as const,
					arguments: JSON.stringify({
						command: "ls",
						cwd: ["/home/user"],
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).toBeNull()
				const failure = NativeToolCallParser.consumeParseFailure(toolCall.id)
				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("invalid_argument_shape")
				expect(failure!.toolName).toBe("execute_command")
			})

			it("should reject cwd as object with command key (parse failure, NOT executed)", () => {
				const toolCall = {
					id: "toolu_exec_cwd_obj_command",
					name: "execute_command" as const,
					arguments: JSON.stringify({
						command: "ls",
						cwd: { command: "rm -rf /" },
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).toBeNull()
				const failure = NativeToolCallParser.consumeParseFailure(toolCall.id)
				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("invalid_argument_shape")
				expect(failure!.toolName).toBe("execute_command")
			})

			it("should reject cwd as object with path key (parse failure)", () => {
				const toolCall = {
					id: "toolu_exec_cwd_obj_path",
					name: "execute_command" as const,
					arguments: JSON.stringify({
						command: "ls",
						cwd: { path: "/home/user" },
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).toBeNull()
				const failure = NativeToolCallParser.consumeParseFailure(toolCall.id)
				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("invalid_argument_shape")
				expect(failure!.toolName).toBe("execute_command")
			})

			it("should reject cwd as number (parse failure)", () => {
				const toolCall = {
					id: "toolu_exec_cwd_number",
					name: "execute_command" as const,
					arguments: JSON.stringify({
						command: "ls",
						cwd: 42,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).toBeNull()
				const failure = NativeToolCallParser.consumeParseFailure(toolCall.id)
				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("invalid_argument_shape")
				expect(failure!.toolName).toBe("execute_command")
			})

			it("should reject command as empty string (parse failure)", () => {
				const toolCall = {
					id: "toolu_exec_cmd_empty",
					name: "execute_command" as const,
					arguments: JSON.stringify({
						command: "",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).toBeNull()
				const failure = NativeToolCallParser.consumeParseFailure(toolCall.id)
				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("invalid_argument_shape")
				expect(failure!.toolName).toBe("execute_command")
			})

			it("should reject command as object (parse failure)", () => {
				const toolCall = {
					id: "toolu_exec_cmd_obj",
					name: "execute_command" as const,
					arguments: JSON.stringify({
						command: { cmd: "ls" },
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).toBeNull()
				const failure = NativeToolCallParser.consumeParseFailure(toolCall.id)
				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("invalid_argument_shape")
				expect(failure!.toolName).toBe("execute_command")
			})

			it("should reject timeout as string (parse failure)", () => {
				const toolCall = {
					id: "toolu_exec_timeout_str",
					name: "execute_command" as const,
					arguments: JSON.stringify({
						command: "ls",
						timeout: "30",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).toBeNull()
				const failure = NativeToolCallParser.consumeParseFailure(toolCall.id)
				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("invalid_argument_shape")
				expect(failure!.toolName).toBe("execute_command")
			})

			it("should not leak raw cwd value in failure descriptor", () => {
				const toolCall = {
					id: "toolu_exec_no_leak",
					name: "execute_command" as const,
					arguments: JSON.stringify({
						command: "ls",
						cwd: { secret: "API_KEY=abc123" },
					}),
				}

				NativeToolCallParser.parseToolCall(toolCall)
				const failure = NativeToolCallParser.consumeParseFailure(toolCall.id)

				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("invalid_argument_shape")
				const serialized = JSON.stringify(failure)
				expect(serialized).not.toContain("API_KEY")
				expect(serialized).not.toContain("abc123")
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

		describe("consumeParseFailure", () => {
			// Helper to parse and consume in one step
			function parseAndConsume(toolCall: {
				id: string
				name: string
				arguments: string
			}): NativeToolParseFailure | undefined {
				NativeToolCallParser.parseToolCall(toolCall as never)
				return NativeToolCallParser.consumeParseFailure(toolCall.id)
			}

			it("should classify invalid JSON syntax as json_syntax", () => {
				const failure = parseAndConsume({
					id: "toolu_syntax_err",
					name: "read_file",
					arguments: "{not valid json",
				})

				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("json_syntax")
				expect(failure!.toolName).toBe("read_file")
				// json_syntax failures do not set missingParameters or emptyArguments
				expect(failure!.missingParameters).toBeUndefined()
				expect(failure!.emptyArguments).toBeUndefined()
			})

			it("should classify empty object {} for a tool with required fields as missing_required_arguments with emptyArguments=true", () => {
				const failure = parseAndConsume({
					id: "toolu_empty_obj",
					name: "write_to_file",
					arguments: "{}",
				})

				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("missing_required_arguments")
				expect(failure!.toolName).toBe("write_to_file")
				expect(failure!.emptyArguments).toBe(true)
				// write_to_file requires path and content
				expect(failure!.missingParameters).toEqual(expect.arrayContaining(["path", "content"]))
				expect(failure!.missingParameters).toHaveLength(2)
			})

			it("should classify empty string arguments as missing_required_arguments with emptyArguments=true", () => {
				const failure = parseAndConsume({
					id: "toolu_empty_str",
					name: "apply_diff",
					arguments: "",
				})

				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("missing_required_arguments")
				expect(failure!.toolName).toBe("apply_diff")
				expect(failure!.emptyArguments).toBe(true)
				// apply_diff requires path and diff
				expect(failure!.missingParameters).toEqual(expect.arrayContaining(["path", "diff"]))
				expect(failure!.missingParameters).toHaveLength(2)
			})

			it("should classify missing one required field as missing_required_arguments", () => {
				// write_to_file requires path and content; provide only path
				const failure = parseAndConsume({
					id: "toolu_missing_one",
					name: "write_to_file",
					arguments: JSON.stringify({ path: "src/test.ts" }),
				})

				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("missing_required_arguments")
				expect(failure!.toolName).toBe("write_to_file")
				expect(failure!.emptyArguments).toBe(false)
				expect(failure!.missingParameters).toEqual(["content"])
			})

			it("should classify valid JSON with wrong structural shape (primitive) as invalid_argument_shape", () => {
				// read_file expects an object with path; provide a primitive string
				const failure = parseAndConsume({
					id: "toolu_primitive",
					name: "read_file",
					arguments: JSON.stringify("just a string"),
				})

				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("invalid_argument_shape")
				expect(failure!.toolName).toBe("read_file")
				expect(failure!.emptyArguments).toBe(false)
			})

			it("should classify valid JSON with wrong structural shape (array) as invalid_argument_shape", () => {
				// write_to_file expects an object; provide an array
				const failure = parseAndConsume({
					id: "toolu_array",
					name: "write_to_file",
					arguments: JSON.stringify([1, 2, 3]),
				})

				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("invalid_argument_shape")
				expect(failure!.toolName).toBe("write_to_file")
				expect(failure!.emptyArguments).toBe(false)
			})

			it("should not record a failure for a successful parse", () => {
				const toolCall = {
					id: "toolu_success",
					name: "read_file" as const,
					arguments: JSON.stringify({ path: "src/test.ts" }),
				}

				NativeToolCallParser.parseToolCall(toolCall)
				const failure = NativeToolCallParser.consumeParseFailure(toolCall.id)

				expect(failure).toBeUndefined()
			})

			it("should return undefined on second consume (atomic consume-and-delete)", () => {
				const toolCall = {
					id: "toolu_double_consume",
					name: "read_file" as const,
					arguments: "{invalid json",
				}

				NativeToolCallParser.parseToolCall(toolCall)

				// First consume should return the descriptor
				const first = NativeToolCallParser.consumeParseFailure(toolCall.id)
				expect(first).toBeDefined()
				expect(first!.kind).toBe("json_syntax")

				// Second consume should return undefined (already consumed)
				const second = NativeToolCallParser.consumeParseFailure(toolCall.id)
				expect(second).toBeUndefined()
			})

			it("should return undefined when no failure was recorded for the tool call ID", () => {
				const failure = NativeToolCallParser.consumeParseFailure("toolu_nonexistent")
				expect(failure).toBeUndefined()
			})

			it("should not leak raw argument body in the descriptor", () => {
				// The descriptor must not contain raw argument bodies, paths,
				// commands, task IDs, or secrets. Verify that a failure descriptor
				// for a tool with sensitive arguments does not include them.
				const sensitiveArgs = JSON.stringify({
					path: "/secret/path/to/file.ts",
					content: "super secret content with API_KEY=abc123",
				})
				// Missing required field (content is present but path is missing
				// — actually both are present here, so this should parse
				// successfully). Let's use a tool where we can trigger a failure.
				// Use execute_command with only cwd (missing command).
				const failure = parseAndConsume({
					id: "toolu_no_leak",
					name: "execute_command",
					arguments: JSON.stringify({ cwd: "/secret/working/dir", timeout: 5000 }),
				})

				expect(failure).toBeDefined()
				expect(failure!.kind).toBe("missing_required_arguments")
				expect(failure!.missingParameters).toEqual(["command"])

				// Serialize the descriptor and verify no sensitive data leaked
				const serialized = JSON.stringify(failure)
				expect(serialized).not.toContain("/secret/working/dir")
				expect(serialized).not.toContain("API_KEY")
				expect(serialized).not.toContain("super secret")
			})

			it("should keep consumeParseError as a compatibility wrapper returning string", () => {
				const toolCall = {
					id: "toolu_compat_wrapper",
					name: "read_file" as const,
					arguments: "{invalid json",
				}

				NativeToolCallParser.parseToolCall(toolCall)

				// consumeParseError should return a string (the legacy behavior)
				const errorString = NativeToolCallParser.consumeParseError(toolCall.id)
				expect(errorString).toBeDefined()
				expect(typeof errorString).toBe("string")

				// Second consume should return undefined (already consumed)
				const second = NativeToolCallParser.consumeParseError(toolCall.id)
				expect(second).toBeUndefined()
			})
	
			describe("ghost quarantine accessors", () => {
				it("getStreamingToolCallState returns undefined for untracked ID", () => {
					expect(NativeToolCallParser.getStreamingToolCallState("nonexistent_ghost")).toBeUndefined()
				})
	
				it("getStreamingToolCallState returns state snapshot for tracked ID", () => {
					NativeToolCallParser.startStreamingToolCall("call_tracked", "search_files")
					NativeToolCallParser.processStreamingChunk("call_tracked", '{"path":"src"')
	
					const state = NativeToolCallParser.getStreamingToolCallState("call_tracked")
					expect(state).toBeDefined()
					expect(state!.id).toBe("call_tracked")
					expect(state!.name).toBe("search_files")
					expect(state!.argumentsAccumulator).toContain('"path"')
	
					NativeToolCallParser.clearAllStreamingToolCalls()
				})
	
				it("getStreamingToolCallState does not remove the entry (non-destructive)", () => {
					NativeToolCallParser.startStreamingToolCall("call_persist", "read_file")
	
					const state1 = NativeToolCallParser.getStreamingToolCallState("call_persist")
					expect(state1).toBeDefined()
	
					// Second call should still return the state (not consumed).
					const state2 = NativeToolCallParser.getStreamingToolCallState("call_persist")
					expect(state2).toBeDefined()
	
					NativeToolCallParser.clearAllStreamingToolCalls()
				})
	
				it("discardStreamingToolCall removes the entry and returns true", () => {
					NativeToolCallParser.startStreamingToolCall("call_discard", "search_files")
	
					const result = NativeToolCallParser.discardStreamingToolCall("call_discard")
					expect(result).toBe(true)
	
					// State should be gone.
					expect(NativeToolCallParser.getStreamingToolCallState("call_discard")).toBeUndefined()
				})
	
				it("discardStreamingToolCall returns false for untracked ID", () => {
					const result = NativeToolCallParser.discardStreamingToolCall("nonexistent_discard")
					expect(result).toBe(false)
				})
	
				it("discardStreamingToolCall prevents finalizeStreamingToolCall from returning a tool use", () => {
					NativeToolCallParser.startStreamingToolCall("call_discard_before_finalize", "search_files")
					NativeToolCallParser.processStreamingChunk("call_discard_before_finalize", '{"path":"src"')
	
					// Discard the streaming state.
					NativeToolCallParser.discardStreamingToolCall("call_discard_before_finalize")
	
					// finalizeStreamingToolCall should return null since state was discarded.
					const result = NativeToolCallParser.finalizeStreamingToolCall("call_discard_before_finalize")
					expect(result).toBeNull()
				})
			})
		})
	})
})
