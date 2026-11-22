import type OpenAI from "openai"

import { stripUnsupportedStrictKeywords } from "../../../../../api/transform/strict-tool-schema"
import { getNativeTools } from ".."

type FunctionTool = OpenAI.Chat.ChatCompletionFunctionTool

describe("native tool strict schema subset", () => {
	const tools = getNativeTools().filter((tool): tool is FunctionTool => tool.type === "function")

	it.each(tools.map((tool) => [tool.function.name, tool] as const))(
		"keeps %s within the portable strict subset",
		(_name, tool) => {
			expect(stripUnsupportedStrictKeywords(tool.function.parameters)).toEqual(tool.function.parameters)
		},
	)
})
