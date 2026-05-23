import { t } from "i18next"
import { FunctionCallingConfigMode } from "@google/genai"

const mockCaptureException = vi.fn()

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: (...args: unknown[]) => mockCaptureException(...args),
		},
	},
}))

import { GeminiHandler } from "../gemini"
import type { ApiHandlerOptions } from "../../../shared/api"

describe("GeminiHandler backend support", () => {
	beforeEach(() => {
		mockCaptureException.mockClear()
	})

	it("createMessage uses function declarations (URL context and grounding are only for completePrompt)", async () => {
		// URL context and grounding are mutually exclusive with function declarations
		// in Gemini API, so createMessage only uses function declarations.
		// URL context/grounding are only added in completePrompt.
		const options = {
			apiProvider: "gemini",
			enableUrlContext: true,
			enableGrounding: true,
		} as ApiHandlerOptions
		const handler = new GeminiHandler(options)
		const stub = vi.fn().mockReturnValue((async function* () {})())
		// @ts-ignore access private client
		handler["client"].models.generateContentStream = stub
		await handler.createMessage("instr", [] as any).next()
		const config = stub.mock.calls[0][0].config
		// createMessage always uses function declarations only
		// (tools are always present from ALWAYS_AVAILABLE_TOOLS)
		expect(config.tools).toEqual([{ functionDeclarations: expect.any(Array) }])
	})

	it("completePrompt passes config overrides without tools when URL context and grounding disabled", async () => {
		const options = {
			apiProvider: "gemini",
			enableUrlContext: false,
			enableGrounding: false,
		} as ApiHandlerOptions
		const handler = new GeminiHandler(options)
		const stub = vi.fn().mockResolvedValue({ text: "ok" })
		// @ts-ignore access private client
		handler["client"].models.generateContent = stub
		const res = await handler.completePrompt("hi")
		expect(res).toBe("ok")
		const promptConfig = stub.mock.calls[0][0].config
		expect(promptConfig.tools).toBeUndefined()
	})

	describe("error scenarios", () => {
		it("should handle grounding metadata extraction failure gracefully", async () => {
			const options = {
				apiProvider: "gemini",
				enableGrounding: true,
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)

			const mockStream = async function* () {
				yield {
					candidates: [
						{
							groundingMetadata: {
								// Invalid structure - missing groundingChunks
							},
							content: { parts: [{ text: "test response" }] },
						},
					],
					usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
				}
			}

			const stub = vi.fn().mockReturnValue(mockStream())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			const messages = []
			for await (const chunk of handler.createMessage("test", [] as any)) {
				messages.push(chunk)
			}

			// Should still return the main content without sources
			expect(messages.some((m) => m.type === "text" && m.text === "test response")).toBe(true)
			expect(messages.some((m) => m.type === "text" && m.text?.includes("Sources:"))).toBe(false)
		})

		it("should handle malformed grounding metadata", async () => {
			const options = {
				apiProvider: "gemini",
				enableGrounding: true,
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)

			const mockStream = async function* () {
				yield {
					candidates: [
						{
							groundingMetadata: {
								groundingChunks: [
									{ web: null }, // Missing URI
									{ web: { uri: "https://example.com", title: "Example Site" } }, // Valid
									{}, // Missing web property entirely
								],
							},
							content: { parts: [{ text: "test response" }] },
						},
					],
					usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
				}
			}

			const stub = vi.fn().mockReturnValue(mockStream())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			const messages = []
			for await (const chunk of handler.createMessage("test", [] as any)) {
				messages.push(chunk)
			}

			// Should have the text response
			const textMessage = messages.find((m) => m.type === "text")
			expect(textMessage).toBeDefined()
			if (textMessage && "text" in textMessage) {
				expect(textMessage.text).toBe("test response")
			}

			// Should have grounding chunk with only valid sources
			const groundingMessage = messages.find((m) => m.type === "grounding")
			expect(groundingMessage).toBeDefined()
			if (groundingMessage && "sources" in groundingMessage) {
				expect(groundingMessage.sources).toHaveLength(1)
				expect(groundingMessage.sources[0].url).toBe("https://example.com")
				expect(groundingMessage.sources[0].title).toBe("Example Site")
			}
		})

		it("should handle API errors when tools are enabled", async () => {
			const options = {
				apiProvider: "gemini",
				enableUrlContext: true,
				enableGrounding: true,
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)

			const mockError = new Error("API rate limit exceeded")
			const stub = vi.fn().mockRejectedValue(mockError)
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await expect(async () => {
				const generator = handler.createMessage("test", [] as any)
				await generator.next()
			}).rejects.toThrow(t("common:errors.gemini.generate_stream", { error: "API rate limit exceeded" }))
		})
	})

	describe("allowedFunctionNames support", () => {
		const testTools = [
			{
				type: "function" as const,
				function: {
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: {} },
				},
			},
			{
				type: "function" as const,
				function: {
					name: "write_to_file",
					description: "Write to a file",
					parameters: { type: "object", properties: {} },
				},
			},
			{
				type: "function" as const,
				function: {
					name: "execute_command",
					description: "Execute a command",
					parameters: { type: "object", properties: {} },
				},
			},
		]

		it("should ignore allowedFunctionNames because Gemini rejects larger restriction lists", async () => {
			const options = {
				apiProvider: "gemini",
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: testTools,
					allowedFunctionNames: ["read_file", "write_to_file"],
				})
				.next()

			const config = stub.mock.calls[0][0].config
			expect(config.toolConfig).toBeUndefined()
		})

		it("should include all tools when allowedFunctionNames is provided", async () => {
			const options = {
				apiProvider: "gemini",
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: testTools,
					allowedFunctionNames: ["read_file"],
				})
				.next()

			const config = stub.mock.calls[0][0].config
			// All tools should be passed to the model
			expect(config.tools[0].functionDeclarations).toHaveLength(3)
			expect(config.toolConfig).toBeUndefined()
		})

		it("should not pass large allowedFunctionNames lists to Gemini", async () => {
			const options = {
				apiProvider: "gemini",
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			const manyTools = Array.from({ length: 30 }, (_, index) => ({
				type: "function" as const,
				function: {
					name: `tool_${index}`,
					description: `Tool ${index}`,
					parameters: { type: "object", properties: {} },
				},
			}))

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: manyTools,
					allowedFunctionNames: manyTools.map((tool) => tool.function.name),
				})
				.next()

			const config = stub.mock.calls[0][0].config
			expect(config.tools[0].functionDeclarations).toHaveLength(30)
			expect(config.toolConfig).toBeUndefined()
		})

		it("should not pass allowedFunctionNames even when history includes tool calls", async () => {
			const options = {
				apiProvider: "gemini",
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			const manyTools = Array.from({ length: 30 }, (_, index) => ({
				type: "function" as const,
				function: {
					name: `tool_${index}`,
					description: `Tool ${index}`,
					parameters: { type: "object", properties: {} },
				},
			}))
			const messages = [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tool-call-29", name: "tool_29", input: {} }],
				},
			]

			await handler
				.createMessage("test", messages as any, {
					taskId: "test-task",
					tools: manyTools,
					allowedFunctionNames: manyTools.slice(0, 29).map((tool) => tool.function.name),
				})
				.next()

			const config = stub.mock.calls[0][0].config
			expect(config.tools[0].functionDeclarations).toHaveLength(30)
			expect(config.toolConfig).toBeUndefined()
		})

		it("should fall back to tool_choice when allowedFunctionNames is provided", async () => {
			const options = {
				apiProvider: "gemini",
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: testTools,
					tool_choice: "auto",
					allowedFunctionNames: ["read_file"],
				})
				.next()

			const config = stub.mock.calls[0][0].config
			expect(config.toolConfig.functionCallingConfig.mode).toBe(FunctionCallingConfigMode.AUTO)
			expect(config.toolConfig.functionCallingConfig.allowedFunctionNames).toBeUndefined()
		})

		it("should fall back to tool_choice when allowedFunctionNames is empty", async () => {
			const options = {
				apiProvider: "gemini",
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: testTools,
					tool_choice: "auto",
					allowedFunctionNames: [],
				})
				.next()

			const config = stub.mock.calls[0][0].config
			// Empty allowedFunctionNames should fall back to tool_choice behavior
			expect(config.toolConfig.functionCallingConfig.mode).toBe(FunctionCallingConfigMode.AUTO)
			expect(config.toolConfig.functionCallingConfig.allowedFunctionNames).toBeUndefined()
		})

		it("should not set toolConfig when allowedFunctionNames is undefined and no tool_choice", async () => {
			const options = {
				apiProvider: "gemini",
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: testTools,
				})
				.next()

			const config = stub.mock.calls[0][0].config
			// No toolConfig should be set when neither allowedFunctionNames nor tool_choice is provided
			expect(config.toolConfig).toBeUndefined()
		})
	})

	describe("Gemini schema compatibility", () => {
		it("should strip broad JSON Schema metadata from function declarations", async () => {
			const options = {
				apiProvider: "gemini",
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: [
						{
							type: "function",
							function: {
								name: "mcp_tool",
								description: "MCP tool",
								parameters: {
									$schema: "https://json-schema.org/draft/2020-12/schema",
									type: "object",
									additionalProperties: false,
									default: {},
									properties: {
										query: {
											type: "string",
											default: "",
										},
										options: {
											type: "object",
											additionalProperties: true,
											properties: {
												limit: { type: "integer", default: 10 },
											},
										},
									},
								},
							},
						},
					],
				})
				.next()

			const schema = stub.mock.calls[0][0].config.tools[0].functionDeclarations[0].parametersJsonSchema
			expect(JSON.stringify(schema)).not.toContain("additionalProperties")
			expect(JSON.stringify(schema)).not.toContain('"default"')
			expect(JSON.stringify(schema)).not.toContain("$schema")
			expect(schema).toEqual({
				type: "object",
				properties: {
					query: { type: "string" },
					options: {
						type: "object",
						properties: {
							limit: { type: "integer" },
						},
					},
				},
			})
		})

		it("should collapse composition and type arrays in function declaration schemas", async () => {
			const options = {
				apiProvider: "gemini",
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: [
						{
							type: "function",
							function: {
								name: "union_tool",
								description: "Union tool",
								parameters: {
									type: "object",
									properties: {
										value: {
											anyOf: [{ type: "string", description: "A value" }, { type: "null" }],
										},
										mode: {
											type: ["string", "null"],
											enum: ["fast", "safe", null],
										},
										config: {
											allOf: [
												{ type: "object", properties: { enabled: { type: "boolean" } } },
												{ description: "Config object" },
											],
										},
									},
								},
							},
						},
					],
				})
				.next()

			const schema = stub.mock.calls[0][0].config.tools[0].functionDeclarations[0].parametersJsonSchema
			expect(JSON.stringify(schema)).not.toContain("anyOf")
			expect(JSON.stringify(schema)).not.toContain("oneOf")
			expect(JSON.stringify(schema)).not.toContain("allOf")
			expect(Array.isArray(schema.properties.mode.type)).toBe(false)
			expect(schema).toEqual({
				type: "object",
				properties: {
					value: { type: "string", description: "A value", nullable: true },
					mode: { type: "string", enum: ["fast", "safe", null], nullable: true },
					config: {
						type: "object",
						properties: { enabled: { type: "boolean" } },
						description: "Config object",
					},
				},
			})
		})

		it("should deep-merge allOf fragments instead of overwriting earlier properties", async () => {
			const options = { apiProvider: "gemini" } as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: [
						{
							type: "function",
							function: {
								name: "multi_allof_tool",
								description: "Tool with multi-fragment allOf",
								parameters: {
									allOf: [
										{
											type: "object",
											properties: { a: { type: "string" } },
											required: ["a"],
										},
										{
											type: "object",
											properties: { b: { type: "integer" } },
											required: ["b"],
										},
									],
								},
							},
						},
					],
				})
				.next()

			const schema = stub.mock.calls[0][0].config.tools[0].functionDeclarations[0].parametersJsonSchema
			// Both property blocks must survive the merge — previously `b` overwrote `a`
			expect(schema.properties).toEqual({
				a: { type: "string" },
				b: { type: "integer" },
			})
			expect(schema.required).toEqual(expect.arrayContaining(["a", "b"]))
		})

		it("should resolve $ref entries before dropping $defs", async () => {
			const options = { apiProvider: "gemini" } as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: [
						{
							type: "function",
							function: {
								name: "ref_tool",
								description: "Tool with $ref",
								parameters: {
									type: "object",
									$defs: {
										Config: {
											type: "object",
											properties: { timeout: { type: "integer" } },
											required: ["timeout"],
										},
									},
									properties: {
										cfg: { $ref: "#/$defs/Config" },
										name: { type: "string" },
									},
									required: ["cfg", "name"],
								},
							},
						},
					],
				})
				.next()

			const schema = stub.mock.calls[0][0].config.tools[0].functionDeclarations[0].parametersJsonSchema
			// $defs must be gone, $ref must be inlined
			expect(JSON.stringify(schema)).not.toContain("$defs")
			expect(JSON.stringify(schema)).not.toContain("$ref")
			expect(schema.properties.cfg).toEqual({
				type: "object",
				properties: { timeout: { type: "integer" } },
				required: ["timeout"],
			})
			expect(schema.properties.name).toEqual({ type: "string" })
		})

		it("should preserve top-level properties and required entries when allOf is also present", async () => {
			const options = { apiProvider: "gemini" } as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: [
						{
							type: "function",
							function: {
								name: "mixed_allof_tool",
								description: "Tool with top-level and allOf schema fragments",
								parameters: {
									type: "object",
									properties: { a: { type: "string" } },
									required: ["a"],
									allOf: [
										{
											type: "object",
											properties: { b: { type: "integer" } },
											required: ["b"],
										},
									],
								},
							},
						},
					],
				})
				.next()

			const schema = stub.mock.calls[0][0].config.tools[0].functionDeclarations[0].parametersJsonSchema
			expect(schema.properties).toEqual({
				a: { type: "string" },
				b: { type: "integer" },
			})
			expect(schema.required).toEqual(expect.arrayContaining(["a", "b"]))
		})

		it("should stop recursive $ref expansion before the sanitized schema becomes cyclic", async () => {
			const options = { apiProvider: "gemini" } as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: [
						{
							type: "function",
							function: {
								name: "recursive_ref_tool",
								description: "Tool with recursive $ref",
								parameters: {
									type: "object",
									$defs: {
										Node: {
											type: "object",
											properties: {
												value: { type: "string" },
												next: { $ref: "#/$defs/Node" },
											},
											required: ["value"],
										},
									},
									properties: {
										root: { $ref: "#/$defs/Node" },
									},
									required: ["root"],
								},
							},
						},
					],
				})
				.next()

			const schema = stub.mock.calls[0][0].config.tools[0].functionDeclarations[0].parametersJsonSchema
			expect(() => JSON.stringify(schema)).not.toThrow()
			expect(JSON.stringify(schema)).not.toContain("$ref")
			expect(schema.properties.root).toEqual({
				type: "object",
				properties: {
					value: { type: "string" },
					next: {},
				},
				required: ["value"],
			})
		})

		it("should preserve parameter names that collide with stripped schema keywords", async () => {
			const options = { apiProvider: "gemini" } as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: [
						{
							type: "function",
							function: {
								name: "keyword_param_tool",
								description: "Tool whose parameter names match JSON Schema keywords",
								parameters: {
									type: "object",
									properties: {
										default: { type: "string" },
										additionalProperties: { type: "boolean" },
										$schema: { type: "string" },
										normal: { type: "integer" },
									},
									required: ["default", "additionalProperties"],
								},
							},
						},
					],
				})
				.next()

			const schema = stub.mock.calls[0][0].config.tools[0].functionDeclarations[0].parametersJsonSchema
			expect(schema.properties).toEqual({
				default: { type: "string" },
				additionalProperties: { type: "boolean" },
				$schema: { type: "string" },
				normal: { type: "integer" },
			})
			expect(schema.required).toEqual(expect.arrayContaining(["default", "additionalProperties"]))
		})
	})
})
