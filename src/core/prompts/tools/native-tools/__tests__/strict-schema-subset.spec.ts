import type OpenAI from "openai"

import { getNativeTools } from ".."

type FunctionTool = OpenAI.Chat.ChatCompletionFunctionTool

const UNSUPPORTED_KEYWORDS = new Set([
	"maxItems",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"uniqueItems",
	"contains",
	"minContains",
	"maxContains",
	"minProperties",
	"maxProperties",
])

function collectUnsupportedKeywords(schema: unknown, path = "$"): string[] {
	if (typeof schema !== "object" || schema === null) {
		return []
	}

	const issues: string[] = []
	for (const [key, value] of Object.entries(schema)) {
		if (
			UNSUPPORTED_KEYWORDS.has(key) ||
			(key === "minItems" && value !== 0 && value !== 1) ||
			(key === "additionalProperties" && value !== false)
		) {
			issues.push(`${path}.${key}`)
		}
		if (key === "properties" && typeof value === "object" && value !== null && !Array.isArray(value)) {
			for (const [propertyName, propertySchema] of Object.entries(value)) {
				issues.push(...collectUnsupportedKeywords(propertySchema, `${path}.properties.${propertyName}`))
			}
		} else if (Array.isArray(value)) {
			issues.push(
				...value.flatMap((entry, index) => collectUnsupportedKeywords(entry, `${path}.${key}[${index}]`)),
			)
		} else if (typeof value === "object" && value !== null) {
			issues.push(...collectUnsupportedKeywords(value, `${path}.${key}`))
		}
	}
	return issues
}

describe("native tool strict schema subset", () => {
	const tools = getNativeTools().filter((tool): tool is FunctionTool => tool.type === "function")

	it.each(tools.map((tool) => [tool.function.name, tool] as const))(
		"keeps %s within the portable strict subset",
		(_name, tool) => {
			expect(collectUnsupportedKeywords(tool.function.parameters)).toEqual([])
		},
	)
})
