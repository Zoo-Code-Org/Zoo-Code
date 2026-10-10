import type OpenAI from "openai"
import { createReadFileTool } from "../read_file"
import { normalizeToolSchema, ToolInputSchema } from "../../../../../utils/json-schema"

// Helper type to access function tools
type FunctionTool = OpenAI.Chat.ChatCompletionTool & { type: "function" }

// Helper to get function definition from tool
const getFunctionDef = (tool: OpenAI.Chat.ChatCompletionTool) => (tool as FunctionTool).function

describe("createReadFileTool", () => {
	it("keeps integer lower bounds in the native and normalized strict schemas", () => {
		const schema = getFunctionDef(createReadFileTool()).parameters
		if (!schema) throw new Error("read_file parameters are required")
		const expected = {
			properties: {
				offset: { type: "integer", minimum: 1 },
				limit: { type: "integer", minimum: 1 },
				indentation: {
					properties: {
						anchor_line: { type: "integer", minimum: 1 },
						max_levels: { type: "integer", minimum: 0 },
						max_lines: { type: "integer", minimum: 1 },
					},
					additionalProperties: false,
				},
			},
			required: ["path"],
			additionalProperties: false,
		}

		expect(schema).toMatchObject(expected)
		expect(ToolInputSchema.parse(schema)).toMatchObject(expected)
		expect(normalizeToolSchema(schema)).toMatchObject(expected)
	})

	describe("single-file-per-call documentation", () => {
		it("should indicate single-file-per-call and suggest parallel tool calls", () => {
			const tool = createReadFileTool()
			const description = getFunctionDef(tool).description

			expect(description).toContain("exactly one file per call")
			expect(description).toContain("multiple parallel read_file calls")
		})
	})

	describe("indentation mode", () => {
		it("should always include indentation mode in description", () => {
			const tool = createReadFileTool()
			const description = getFunctionDef(tool).description

			expect(description).toContain("indentation")
		})

		it("should always include indentation parameter in schema", () => {
			const tool = createReadFileTool()
			const schema = getFunctionDef(tool).parameters as any

			expect(schema.properties).toHaveProperty("indentation")
		})

		it("should include mode parameter in schema", () => {
			const tool = createReadFileTool()
			const schema = getFunctionDef(tool).parameters as any

			expect(schema.properties).toHaveProperty("mode")
			expect(schema.properties.mode.enum).toContain("slice")
			expect(schema.properties.mode.enum).toContain("indentation")
		})

		it("should include offset and limit parameters in schema", () => {
			const tool = createReadFileTool()
			const schema = getFunctionDef(tool).parameters as any

			expect(schema.properties).toHaveProperty("offset")
			expect(schema.properties).toHaveProperty("limit")
		})
	})

	describe("supportsImages option", () => {
		it("should advertise only shared-contract image formats when supportsImages is true", () => {
			const tool = createReadFileTool({ supportsImages: true })
			const description = getFunctionDef(tool).description

			expect(description).toContain(
				"Automatically processes and returns image files (PNG, JPG, JPEG, GIF, WEBP) for visual analysis",
			)
			expect(description).toContain("Other binary image formats are not supported")
		})

		it("should not include image format documentation when supportsImages is false", () => {
			const tool = createReadFileTool({ supportsImages: false })
			const description = getFunctionDef(tool).description

			expect(description).not.toContain("Automatically processes and returns image files")
			expect(description).toContain("may not handle other binary files properly")
		})

		it("should default supportsImages to false", () => {
			const tool = createReadFileTool({})
			const description = getFunctionDef(tool).description

			expect(description).not.toContain("Automatically processes and returns image files")
		})

		it("should always include PDF and DOCX support in description", () => {
			const toolWithImages = createReadFileTool({ supportsImages: true })
			const toolWithoutImages = createReadFileTool({ supportsImages: false })

			expect(getFunctionDef(toolWithImages).description).toContain(
				"Supports text extraction from PDF and DOCX files",
			)
			expect(getFunctionDef(toolWithoutImages).description).toContain(
				"Supports text extraction from PDF and DOCX files",
			)
		})
	})

	describe("tool structure", () => {
		it("should have correct tool name", () => {
			const tool = createReadFileTool()

			expect(getFunctionDef(tool).name).toBe("read_file")
		})

		it("should be a function type tool", () => {
			const tool = createReadFileTool()

			expect(tool.type).toBe("function")
		})

		it("should have strict mode enabled", () => {
			const tool = createReadFileTool()

			expect(getFunctionDef(tool).strict).toBe(true)
		})

		it("should require path parameter", () => {
			const tool = createReadFileTool()
			const schema = getFunctionDef(tool).parameters as any

			expect(schema.required).toContain("path")
		})
	})
})
