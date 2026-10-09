import { createReadFileParameters } from "../readFileParameters"
import { createReadFileTool } from "../../read_file"
import readFiles from "../../read_files"
import { DEFAULT_LINE_LIMIT } from "../../../../../tools/file-reading/readFileConstants"

describe("independent shared file-reading parameter schema", () => {
	it("preserves single-file optionality and parameter descriptions", () => {
		const schema = createReadFileParameters()
		expect(schema.required).toEqual(["path"])
		expect(schema.properties?.mode).toMatchObject({ type: "string", enum: ["slice", "indentation"] })
		expect(schema.properties?.indentation).toMatchObject({
			type: "object",
			required: [],
			additionalProperties: false,
		})
		expect(schema.properties?.limit.description).toContain(String(DEFAULT_LINE_LIMIT))
		expect(schema).not.toHaveProperty("name")
		expect(schema).not.toHaveProperty("description")
	})

	it("supports strict providers without changing the meaning of optional fields", () => {
		const schema = createReadFileParameters({ strictOptionalFields: true })
		expect(schema.required).toEqual(["path", "mode", "offset", "limit", "indentation"])
		expect(schema.properties?.path.type).toBe("string")
		expect(schema.properties?.mode).toMatchObject({
			type: ["string", "null"],
			enum: ["slice", "indentation", null],
		})
		const indentation = schema.properties?.indentation
		expect(indentation).toMatchObject({ type: ["object", "null"], additionalProperties: false })
		expect(indentation?.required).toEqual(Object.keys(indentation?.properties ?? {}))
		for (const property of Object.values(indentation?.properties ?? {})) expect(property.type).toContain("null")
	})

	it("returns fresh nested schemas and does not share mutable state", () => {
		const original = createReadFileParameters()
		const first = createReadFileParameters()
		first.required?.push("unexpected")
		first.properties?.mode.enum?.push("unexpected")
		first.properties?.indentation.required?.push("unexpected")
		expect(createReadFileParameters()).toEqual(original)
		expect(createReadFileParameters({ strictOptionalFields: true }).properties?.mode.enum).not.toContain(
			"unexpected",
		)
	})

	it("is used directly by both tools while their top-level descriptions stay independent", () => {
		const single = createReadFileTool({ supportsImages: true })
		if (single.type !== "function") throw new Error("Expected a function tool")
		expect(single.function.parameters).toEqual(createReadFileParameters())
		expect(readFiles.function.parameters.properties.entries.items).toEqual(
			createReadFileParameters({ strictOptionalFields: true }),
		)
		expect(single.function.description).toContain("exactly one file per call")
		expect(readFiles.function.description).toContain("ONE native tool call")
		expect(readFiles.function.description).not.toContain("exactly one file per call")
		expect(readFiles.function.description).not.toBe(single.function.description)
	})
})
