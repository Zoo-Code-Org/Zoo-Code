import type { ChatCompletionRequest, ChatMessage } from "@copilotkit/aimock"

export function toolResultContains(req: ChatCompletionRequest, toolCallId: string, expected: string[]) {
	const messages = Array.isArray(req?.messages) ? req.messages : []
	const toolMessage = messages.find(
		(message: ChatMessage) => message?.role === "tool" && message.tool_call_id === toolCallId,
	)

	const content = toolMessage?.content
	if (typeof content !== "string") {
		return false
	}

	return expected.every((text) => content.includes(text))
}
