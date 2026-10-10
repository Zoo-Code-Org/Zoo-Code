import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@roo-code/types"

import { BaseProvider } from "../base-provider"
import type { ApiStream } from "../../transform/stream"
import { expectNoLoneSurrogates } from "../../../test-utils/surrogates"
import { createReadFileTool } from "../../../core/prompts/tools/native-tools/read_file"

// Create a concrete implementation for testing
class TestProvider extends BaseProvider {
	createMessage(_systemPrompt: string, _messages: Anthropic.Messages.MessageParam[]): ApiStream {
		throw new Error("Not implemented")
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "test-model",
			info: {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsPromptCache: false,
			},
		}
	}

	// Expose protected method for testing
	public testConvertToolSchemaForOpenAI(schema: any): any {
		return this.convertToolSchemaForOpenAI(schema)
	}

	// Expose protected method for testing
	public testConvertToolsForOpenAI(tools: any[] | undefined, strict?: boolean): any[] | undefined {
		return this.convertToolsForOpenAI(tools, strict)
	}
}

describe("BaseProvider", () => {
	let provider: TestProvider

	beforeEach(() => {
		provider = new TestProvider()
	})

	describe("convertToolSchemaForOpenAI", () => {
		it("should add additionalProperties: false to object schemas", () => {
			const schema = {
				type: "object",
				properties: {
					name: { type: "string" },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.additionalProperties).toBe(false)
		})

		it("should add required array with all properties for strict mode", () => {
			const schema = {
				type: "object",
				properties: {
					name: { type: "string" },
					age: { type: "number" },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.required).toEqual(["name", "age"])
		})

		it("should recursively add additionalProperties: false to nested objects", () => {
			const schema = {
				type: "object",
				properties: {
					user: {
						type: "object",
						properties: {
							name: { type: "string" },
						},
					},
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.additionalProperties).toBe(false)
			expect(result.properties.user.additionalProperties).toBe(false)
		})

		it("should recursively add additionalProperties: false to array item objects", () => {
			const schema = {
				type: "object",
				properties: {
					users: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
							},
						},
					},
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.additionalProperties).toBe(false)
			expect(result.properties.users.items.additionalProperties).toBe(false)
		})

		it("should handle deeply nested objects", () => {
			const schema = {
				type: "object",
				properties: {
					level1: {
						type: "object",
						properties: {
							level2: {
								type: "object",
								properties: {
									level3: {
										type: "object",
										properties: {
											value: { type: "string" },
										},
									},
								},
							},
						},
					},
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.additionalProperties).toBe(false)
			expect(result.properties.level1.additionalProperties).toBe(false)
			expect(result.properties.level1.properties.level2.additionalProperties).toBe(false)
			expect(result.properties.level1.properties.level2.properties.level3.additionalProperties).toBe(false)
		})

		it("should convert nullable types to non-nullable", () => {
			const schema = {
				type: "object",
				properties: {
					name: { type: ["string", "null"] },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.properties.name.type).toBe("string")
		})

		it("should return non-object schemas unchanged", () => {
			const schema = { type: "string" }
			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result).toEqual(schema)
		})

		it("should return null/undefined unchanged", () => {
			expect(provider.testConvertToolSchemaForOpenAI(null)).toBeNull()
			expect(provider.testConvertToolSchemaForOpenAI(undefined)).toBeUndefined()
		})

		it("should handle empty properties object", () => {
			const schema = {
				type: "object",
				properties: {},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.additionalProperties).toBe(false)
			expect(result.required).toEqual([])
		})
	})

	it("leaves property entries that are not objects unchanged", () => {
		const schema = {
			type: "object",
			properties: {
				broken: null,
				list: ["string", "null"],
				note: "plain",
			},
		}

		const result = provider.testConvertToolSchemaForOpenAI(schema)

		// The clone guard only normalises object entries, so a null entry, an
		// array-valued entry and a plain string entry are passed through as declared.
		expect(result.properties.broken).toBe(null)
		expect(result.properties.list).toEqual(["string", "null"])
		expect(result.properties.note).toBe("plain")
	})

	it("keeps a nullable type with more than one non-null type as an array", () => {
		const schema = {
			type: "object",
			properties: {
				value: { type: ["string", "null", "number"] },
			},
		}

		const result = provider.testConvertToolSchemaForOpenAI(schema)

		expect(result.properties.value.type).toEqual(["string", "number"])
	})

	it("does not treat a plain property as an array of objects", () => {
		const schema = {
			type: "object",
			properties: {
				path: { type: "string" },
			},
		}

		const result = provider.testConvertToolSchemaForOpenAI(schema)

		// Only array properties get an items conversion, so a plain property
		// keeps exactly the keys it declared.
		expect(Object.keys(result.properties.path)).toEqual(["type"])
	})

	it("does not convert items on a non-array property that carries object items", () => {
		const schema = {
			type: "object",
			properties: {
				weird: {
					type: "string",
					items: { type: "object", properties: { a: { type: "string" } } },
				},
			},
		}

		const result = provider.testConvertToolSchemaForOpenAI(schema)

		expect(result.properties.weird.items.additionalProperties).toBeUndefined()
	})

	it("leaves an array property without items unchanged", () => {
		const schema = {
			type: "object",
			properties: {
				tags: { type: "array" },
			},
		}

		const result = provider.testConvertToolSchemaForOpenAI(schema)

		expect(Object.keys(result.properties.tags)).toEqual(["type"])
	})

	it("leaves a property whose type is only null unchanged", () => {
		const schema = {
			type: "object",
			properties: {
				only: { type: "null" },
			},
		}

		const result = provider.testConvertToolSchemaForOpenAI(schema)

		// The nullable branch only handles array types; a bare null type is not a
		// list to filter.
		expect(result.properties.only.type).toBe("null")
	})
	describe("convertToolsForOpenAI", () => {
		it("preserves read_file integer minima while requiring properties for strict mode", () => {
			const result = provider.testConvertToolsForOpenAI([createReadFileTool()])

			expect(result?.[0]).toMatchObject({
				function: {
					strict: true,
					parameters: {
						required: ["path", "mode", "offset", "limit", "indentation"],
						properties: {
							offset: { type: "integer", minimum: 1 },
							limit: { type: "integer", minimum: 1 },
							indentation: {
								required: [
									"anchor_line",
									"max_levels",
									"include_siblings",
									"include_header",
									"max_lines",
								],
								properties: {
									anchor_line: { type: "integer", minimum: 1 },
									max_levels: { type: "integer", minimum: 0 },
									max_lines: { type: "integer", minimum: 1 },
								},
							},
						},
					},
				},
			})
		})

		it("should return undefined for undefined input", () => {
			const result = provider.testConvertToolsForOpenAI(undefined)
			expect(result).toBeUndefined()
		})

		it("should set strict: true for non-MCP tools", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "Read a file",
						parameters: { type: "object", properties: {} },
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.strict).toBe(true)
		})

		it("should set strict: false for MCP tools (mcp-- prefix)", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "mcp--github--get_me",
						description: "Get current user",
						parameters: { type: "object", properties: {} },
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.strict).toBe(false)
		})

		it("should apply schema conversion to non-MCP tools", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "Read a file",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string" },
							},
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.parameters.additionalProperties).toBe(false)
			expect(result?.[0].function.parameters.required).toEqual(["path"])
		})

		it("should not apply schema conversion to MCP tools in base-provider", () => {
			// Note: In base-provider, MCP tools are passed through unchanged
			// The openai-native provider has its own handling for MCP tools
			const tools = [
				{
					type: "function",
					function: {
						name: "mcp--github--get_me",
						description: "Get current user",
						parameters: {
							type: "object",
							properties: {
								token: { type: "string" },
							},
							required: ["token"],
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			// MCP tools pass through original parameters in base-provider
			expect(result?.[0].function.parameters.additionalProperties).toBeUndefined()
		})

		it("should sanitize lone UTF-16 surrogates in name, description, and parameters (#461)", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "bad\uD800end",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string", description: "bad\uDC00end" },
							},
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.description).toBe("bad\uFFFDend")
			expect(result?.[0].function.parameters.properties.path.description).toBe("bad\uFFFDend")
			// Inspect the raw values: JSON.stringify escapes lone surrogates as \udXXX text,
			// so a regex over the serialized body can never fail. See expectNoLoneSurrogates.
			expectNoLoneSurrogates(result)
		})

		it("should sanitize lone UTF-16 surrogates in nested MCP tool parameters (#461)", () => {
			const lone = "bad\uD800end"
			const sanitized = "bad\uFFFDend"
			const tools = [
				{
					type: "function",
					function: {
						name: "mcp__srv__tool",
						description: "Run an MCP tool",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string" },
								nested: {
									type: "object",
									properties: {
										list: { type: "string", description: lone },
									},
								},
							},
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			// MCP tools keep their original schema (no strict-mode conversion) ...
			expect(result?.[0].function.strict).toBe(false)
			expect(result?.[0].function.parameters.additionalProperties).toBeUndefined()
			// ... but strings nested in the parameters are still sanitized.
			expect(result?.[0].function.parameters.properties.nested.properties.list.description).toBe(sanitized)
			expectNoLoneSurrogates(result)
		})

		it("should sanitize lone UTF-16 surrogates in tool names (#461)", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "read\uD800file",
						description: "Read a file",
						parameters: { type: "object", properties: {} },
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.name).toBe("read\uFFFDfile")
		})

		it("should set strict: false and preserve declared schema when strict is disabled", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "Read a file",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string" },
								offset: { type: "integer" },
							},
							required: ["path"],
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools, false)

			expect(result?.[0].function.strict).toBe(false)
			// Declared schema preserved: original required array, no additionalProperties coercion
			expect(result?.[0].function.parameters).toEqual(tools[0].function.parameters)
		})

		it("should not mutate caller-owned schemas during strict normalization", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "nullable_tool",
						description: "Tool with a nullable property",
						parameters: {
							type: "object",
							properties: {
								path: { type: ["string", "null"] },
							},
							required: ["path"],
						},
					},
				},
			]

			const strictResult = provider.testConvertToolsForOpenAI(tools, true)
			expect(strictResult?.[0].function.parameters.properties.path.type).toBe("string")

			// Caller-owned schema is untouched, so a later non-strict request
			// can still send the original nullable type.
			expect(tools[0].function.parameters.properties.path.type).toEqual(["string", "null"])

			const nonStrictResult = provider.testConvertToolsForOpenAI(tools, false)
			expect(nonStrictResult?.[0].function.parameters).toEqual(tools[0].function.parameters)
		})

		it("should still set strict: false for MCP tools when strict is disabled", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "mcp--github--get_me",
						description: "Get current user",
						parameters: {
							type: "object",
							properties: {
								token: { type: "string" },
							},
							required: ["token"],
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools, false)

			expect(result?.[0].function.strict).toBe(false)
			expect(result?.[0].function.parameters).toEqual(tools[0].function.parameters)
		})
		it("should preserve non-function tools unchanged", () => {
			const tools = [
				{
					type: "other_type",
					data: "some data",
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0]).toEqual(tools[0])
		})
	})
})
