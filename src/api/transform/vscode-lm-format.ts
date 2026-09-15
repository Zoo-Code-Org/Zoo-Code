import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"

/**
 * Safely converts a value into a plain object.
 */
function asObjectSafe(value: unknown): object {
	// Handle null/undefined
	if (!value) {
		return {}
	}

	try {
		// Handle strings that might be JSON
		if (typeof value === "string") {
			return JSON.parse(value)
		}

		// Handle pre-existing objects
		if (typeof value === "object") {
			return { ...value }
		}

		return {}
	} catch (error) {
		console.warn("Zoo Code <Language Model API>: Failed to parse object:", error)
		return {}
	}
}

/**
 * Replaces unpaired UTF-16 surrogate code units with the Unicode replacement character (U+FFFD).
 *
 * The VS Code LM backend forwards requests to model APIs that require valid UTF-8. A lone surrogate
 * — e.g. left behind when some upstream step slices a string through an astral-plane character
 * (emoji, CJK extension, etc.) — cannot be encoded as UTF-8, so the backend rejects the entire
 * request with a 400 ("string contains an unpaired UTF-16 surrogate code point and cannot be
 * encoded as valid UTF-8"). Valid surrogate pairs are matched by the lookahead/lookbehind and left
 * untouched. The regex intentionally omits the `u` flag so it operates on UTF-16 code units.
 */
export function sanitizeSurrogates(text: string): string {
	if (!text) {
		return text
	}
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
}

/**
 * Applies {@link sanitizeSurrogates} to every string nested in a tool-call argument object. The
 * backend rejects the whole request for a lone surrogate anywhere in the JSON payload, so a tool
 * argument carrying a sliced astral character fails the request just as message text would.
 */
function sanitizeSurrogatesDeep(value: unknown): unknown {
	if (typeof value === "string") {
		return sanitizeSurrogates(value)
	}
	if (Array.isArray(value)) {
		return value.map(sanitizeSurrogatesDeep)
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
				sanitizeSurrogates(key),
				sanitizeSurrogatesDeep(nested),
			]),
		)
	}
	return value
}

export function convertToVsCodeLmMessages(
	anthropicMessages: Anthropic.Messages.MessageParam[],
): vscode.LanguageModelChatMessage[] {
	const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = []

	for (const anthropicMessage of anthropicMessages) {
		// Handle simple string messages
		if (typeof anthropicMessage.content === "string") {
			const safeContent = sanitizeSurrogates(anthropicMessage.content)
			vsCodeLmMessages.push(
				anthropicMessage.role === "assistant"
					? vscode.LanguageModelChatMessage.Assistant(safeContent)
					: vscode.LanguageModelChatMessage.User(safeContent),
			)
			continue
		}

		// Handle complex message structures
		switch (anthropicMessage.role) {
			case "user": {
				const { nonToolMessages, toolMessages } = anthropicMessage.content.reduce<{
					nonToolMessages: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]
					toolMessages: Anthropic.ToolResultBlockParam[]
				}>(
					(acc, part) => {
						if (part.type === "tool_result") {
							acc.toolMessages.push(part)
						} else if (part.type === "text" || part.type === "image") {
							acc.nonToolMessages.push(part)
						}
						return acc
					},
					{ nonToolMessages: [], toolMessages: [] },
				)

				// Process tool messages first then non-tool messages
				const contentParts = [
					// Convert tool messages to ToolResultParts
					...toolMessages.map((toolMessage) => {
						// Process tool result content into TextParts
						const toolContentParts: vscode.LanguageModelTextPart[] =
							typeof toolMessage.content === "string"
								? [new vscode.LanguageModelTextPart(sanitizeSurrogates(toolMessage.content))]
								: (toolMessage.content?.map((part) => {
										if (part.type === "image") {
											if (part.source.type === "base64") {
												return new vscode.LanguageModelTextPart(
													`[Image (base64): ${part.source.media_type} not supported by VSCode LM API]`,
												)
											}
											return new vscode.LanguageModelTextPart(
												`[Image (${part.source.type}): not supported by VSCode LM API]`,
											)
										}
										if (part.type === "text") {
											return new vscode.LanguageModelTextPart(sanitizeSurrogates(part.text))
										}
										return new vscode.LanguageModelTextPart("")
									}) ?? [new vscode.LanguageModelTextPart("")])

						return new vscode.LanguageModelToolResultPart(toolMessage.tool_use_id, toolContentParts)
					}),

					// Convert non-tool messages to TextParts after tool messages
					...nonToolMessages.map((part) => {
						if (part.type === "image") {
							if (part.source.type === "base64") {
								return new vscode.LanguageModelTextPart(
									`[Image (base64): ${part.source.media_type} not supported by VSCode LM API]`,
								)
							}
							return new vscode.LanguageModelTextPart(
								`[Image (${part.source.type}): not supported by VSCode LM API]`,
							)
						}
						return new vscode.LanguageModelTextPart(sanitizeSurrogates(part.text))
					}),
				]

				// Add single user message with all content parts
				vsCodeLmMessages.push(vscode.LanguageModelChatMessage.User(contentParts))
				break
			}

			case "assistant": {
				const { nonToolMessages, toolMessages } = anthropicMessage.content.reduce<{
					nonToolMessages: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]
					toolMessages: Anthropic.ToolUseBlockParam[]
				}>(
					(acc, part) => {
						if (part.type === "tool_use") {
							acc.toolMessages.push(part)
						} else if (part.type === "text" || part.type === "image") {
							acc.nonToolMessages.push(part)
						}
						return acc
					},
					{ nonToolMessages: [], toolMessages: [] },
				)

				// Process non-tool messages first, then tool messages
				// Tool calls must come at the end so they are properly followed by user message with tool results
				const contentParts = [
					// Convert non-tool messages to TextParts first
					...nonToolMessages.map((part) => {
						if (part.type === "image") {
							return new vscode.LanguageModelTextPart("[Image generation not supported by VSCode LM API]")
						}
						return new vscode.LanguageModelTextPart(sanitizeSurrogates(part.text))
					}),

					// Convert tool messages to ToolCallParts after text
					...toolMessages.map(
						(toolMessage) =>
							new vscode.LanguageModelToolCallPart(
								toolMessage.id,
								toolMessage.name,
								sanitizeSurrogatesDeep(asObjectSafe(toolMessage.input)) as object,
							),
					),
				]

				// Add the assistant message to the list of messages
				vsCodeLmMessages.push(vscode.LanguageModelChatMessage.Assistant(contentParts))
				break
			}
		}
	}

	return vsCodeLmMessages
}

export function convertToAnthropicRole(vsCodeLmMessageRole: vscode.LanguageModelChatMessageRole): string | null {
	switch (vsCodeLmMessageRole) {
		case vscode.LanguageModelChatMessageRole.Assistant:
			return "assistant"
		case vscode.LanguageModelChatMessageRole.User:
			return "user"
		default:
			return null
	}
}

/**
 * Extracts the text content from a VS Code Language Model chat message.
 * @param message A VS Code Language Model chat message.
 * @returns The extracted text content.
 */
export function extractTextCountFromMessage(message: vscode.LanguageModelChatMessage): string {
	let text = ""
	if (Array.isArray(message.content)) {
		for (const item of message.content) {
			if (item instanceof vscode.LanguageModelTextPart) {
				text += item.value
			}
			if (item instanceof vscode.LanguageModelToolResultPart) {
				text += item.callId
				for (const part of item.content) {
					if (part instanceof vscode.LanguageModelTextPart) {
						text += part.value
					}
				}
			}
			if (item instanceof vscode.LanguageModelToolCallPart) {
				text += item.name
				text += item.callId
				if (item.input && Object.keys(item.input).length > 0) {
					try {
						text += JSON.stringify(item.input)
					} catch (error) {
						console.error("Zoo Code <Language Model API>: Failed to stringify tool call input:", error)
					}
				}
			}
		}
	} else if (typeof message.content === "string") {
		text += message.content
	}
	return text
}
