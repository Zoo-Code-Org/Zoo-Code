import type { ChatCompletionRequest, ChatMessage } from "@copilotkit/aimock"

export type ToolResultExpectation = { toolCallId: string; expected: string[] }

export function isToolResultExpectation(value: unknown): value is ToolResultExpectation {
	return typeof value === "object" && value !== null && "toolCallId" in value && "expected" in value
}

export function toolResultContains(req: ChatCompletionRequest, toolCallId: string, expected: string[]) {
	const messages = Array.isArray(req?.messages) ? req.messages : []
	const toolMessage = messages.find(
		(message: ChatMessage) =>
			(message?.role === "tool" && message.tool_call_id === toolCallId) ||
			(message?.role === "user" && JSON.stringify(message).includes(toolCallId)),
	)

	if (!toolMessage) {
		return false
	}

	const contentStr =
		typeof toolMessage.content === "string" ? toolMessage.content : JSON.stringify(toolMessage.content ?? "")

	return expected.every((text) => contentStr.includes(text))
}

export function toolResultsContain(req: ChatCompletionRequest, expectations: ToolResultExpectation[]) {
	return expectations.every(({ toolCallId, expected }) => toolResultContains(req, toolCallId, expected))
}
