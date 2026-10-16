import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"

import { createImagePart, createUserMessage, type ImagePart } from "./vscode-lm-image-part"
import {
	HAS_LONE_SURROGATE,
	LONE_SURROGATE,
	sanitizeIdentifierSurrogates,
	sanitizeSurrogates,
	sanitizeSurrogatesDeep,
} from "./sanitize-surrogates"

// Re-exported so existing consumers keep a single import site; the shared definitions
// live in ./sanitize-surrogates so non-VS-Code transforms can use them too.
export { sanitizeIdentifierSurrogates, sanitizeSurrogates, sanitizeSurrogatesDeep }

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

/** Marks a name whose `_u` sequences would otherwise be read as encoding markers when decoded. */
const TOOL_NAME_MARKER = /_u(?:u|[0-9A-Fa-f]{4})/

/**
 * Sanitizes a request tool-definition name into Copilot's permitted `^[\w-]+$` alphabet.
 *
 * The U+FFFD produced by {@link sanitizeIdentifierSurrogates} would be rejected by that validation,
 * so each lone surrogate is encoded as `_u<HEX>`. Names that neither carry a lone surrogate nor
 * could be mistaken for this encoding are returned unchanged, so an ordinary `get_user` reaches the
 * model under its registry name; {@link decodeToolNameSurrogates} inverts the encoded form. Outputs
 * of the two branches are disjoint — an encoded name always contains a marker, an untouched one
 * never does — which keeps the whole mapping injective and the decode unambiguous. A surrogate-free
 * name that merely looks like a marker (`get_uuid`) is still escaped, so it reaches the model
 * slightly altered; it round-trips correctly, so dispatch is unaffected.
 */
export function sanitizeToolNameSurrogates(name: string): string {
	if (!HAS_LONE_SURROGATE.test(name) && !TOOL_NAME_MARKER.test(name)) {
		return name
	}
	// Escaping MUST precede encoding, or a literal "_u" would be indistinguishable from a marker.
	return name
		.replace(/_u/g, "_uu")
		.replace(LONE_SURROGATE, (unit) => `_u${unit.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Inverts {@link sanitizeToolNameSurrogates} so a returned tool call carries the name the tool is
 * registered under, which is what dispatch matches on.
 */
export function decodeToolNameSurrogates(name: string): string {
	let decoded = ""
	let index = 0
	while (index < name.length) {
		if (name[index] === "_" && name[index + 1] === "u") {
			if (name[index + 2] === "u") {
				decoded += "_u"
				index += 3
				continue
			}
			const hex = name.slice(index + 2, index + 6)
			if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
				decoded += String.fromCharCode(parseInt(hex, 16))
				index += 6
				continue
			}
		}
		decoded += name[index]
		index += 1
	}
	return decoded
}

function convertImageToVsCodeLmPart(image: Anthropic.Messages.ImageBlockParam, supportsImages: boolean) {
	if (supportsImages) {
		if (image.source.type !== "base64") {
			throw new Error("GitHub Copilot image input requires base64 image data, not an image URL.")
		}
		const part = createImagePart(Buffer.from(image.source.data, "base64"), image.source.media_type)
		if (!part) {
			throw new Error("Image input requires a newer version of VS Code that can send image data.")
		}
		return part
	}
	return new vscode.LanguageModelTextPart(
		image.source.type === "base64"
			? `[Image (base64): ${image.source.media_type} not supported by VSCode LM API]`
			: `[Image (${image.source.type}): not supported by VSCode LM API]`,
	)
}

export function convertToVsCodeLmMessages(
	anthropicMessages: Anthropic.Messages.MessageParam[],
	supportsImages = false,
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
						const toolContentParts: Array<vscode.LanguageModelTextPart | ImagePart> =
							typeof toolMessage.content === "string"
								? [new vscode.LanguageModelTextPart(sanitizeSurrogates(toolMessage.content))]
								: (toolMessage.content?.map((part) => {
										if (part.type === "image") {
											return convertImageToVsCodeLmPart(part, supportsImages)
										}
										if (part.type === "text") {
											return new vscode.LanguageModelTextPart(sanitizeSurrogates(part.text))
										}
										return new vscode.LanguageModelTextPart("")
									}) ?? [new vscode.LanguageModelTextPart("")])

						return new vscode.LanguageModelToolResultPart(
							sanitizeIdentifierSurrogates(toolMessage.tool_use_id),
							toolContentParts,
						)
					}),

					// Convert non-tool messages to TextParts after tool messages
					...nonToolMessages.map((part) => {
						if (part.type === "image") {
							return convertImageToVsCodeLmPart(part, supportsImages)
						}
						return new vscode.LanguageModelTextPart(sanitizeSurrogates(part.text))
					}),
				]

				// Add single user message with all content parts
				vsCodeLmMessages.push(createUserMessage(contentParts))
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
								// Deterministic, so a call id and its paired tool_use_id stay equal after sanitizing.
								sanitizeIdentifierSurrogates(toolMessage.id),
								// History MUST use the declaration encoding, or the replayed call names a tool
								// the model was never offered.
								sanitizeToolNameSurrogates(toolMessage.name),
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
