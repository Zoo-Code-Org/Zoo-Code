import readFiles from "../read_files"
import { getNativeTools } from "../index"
import { filterNativeToolsForMode } from "../../filter-tools-for-mode"
import { MAX_READ_FILES, READ_FILES_TOOL_NAME } from "@roo-code/types"

describe(`native ${READ_FILES_TOOL_NAME} contract`, () => {
	it("advertises a bounded strict native call with the shared modern entry schema", () => {
		expect(readFiles.function.name).toBe(READ_FILES_TOOL_NAME)
		expect(readFiles.function.strict).toBe(true)
		const schema = readFiles.function.parameters
		expect(schema).toMatchObject({
			additionalProperties: false,
			required: ["entries"],
			properties: {
				entries: {
					type: "array",
					maxItems: MAX_READ_FILES,
					minItems: 1,
					items: {
						additionalProperties: false,
						required: ["path", "mode", "offset", "limit", "indentation"],
						properties: {
							mode: { type: ["string", "null"], enum: ["slice", "indentation", null] },
							indentation: {
								type: ["object", "null"],
								additionalProperties: false,
								required: [
									"anchor_line",
									"max_levels",
									"include_siblings",
									"include_header",
									"max_lines",
								],
							},
						},
					},
				},
			},
		})
		expect(readFiles.function.description).toContain(
			"images and unsupported binary formats are explicitly rejected",
		)
		expect(readFiles.function.description).not.toContain("parallel")
	})
	it("is offered in read modes but not when explicitly disabled", () => {
		const names = (disabledTools: string[]) =>
			filterNativeToolsForMode(getNativeTools(), "code", undefined, undefined, undefined, { disabledTools }).map(
				(tool) => (tool.type === "function" ? tool.function.name : ""),
			)
		expect(names([])).toContain(READ_FILES_TOOL_NAME)
		expect(names([READ_FILES_TOOL_NAME])).not.toContain(READ_FILES_TOOL_NAME)
	})
})
