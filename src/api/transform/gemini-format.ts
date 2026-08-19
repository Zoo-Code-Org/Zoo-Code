import { Anthropic } from "@anthropic-ai/sdk"
import { Content, Part } from "@google/genai"

// Gemini documents Part.thoughtSignature as "Encoded as base64 string". Vertex AI enforces
// this strictly — sending the plain string causes empty responses after the first tool call.
// This bypass token tells Gemini to skip signature validation for cross-model history entries.
export const GEMINI_THOUGHT_SIGNATURE_BYPASS = Buffer.from("skip_thought_signature_validator").toString("base64")

type ThoughtSignatureContentBlock = {
	type: "thoughtSignature"
	thoughtSignature?: string
}

type ReasoningContentBlock = {
	type: "reasoning"
	text: string
}

type ExtendedContentBlockParam = Anthropic.ContentBlockParam | ThoughtSignatureContentBlock | ReasoningContentBlock
type ExtendedAnthropicContent = string | ExtendedContentBlockParam[]

// Extension type to safely add thoughtSignature to Part
type PartWithThoughtSignature = Part & {
	thoughtSignature?: string
}

function isThoughtSignatureContentBlock(block: ExtendedContentBlockParam): block is ThoughtSignatureContentBlock {
	return block.type === "thoughtSignature"
}

export function convertAnthropicContentToGemini(
	content: ExtendedAnthropicContent,
	options?: { includeThoughtSignatures?: boolean; toolIdToName?: Map<string, string> },
): Part[] {
	const includeThoughtSignatures = options?.includeThoughtSignatures ?? true
	const toolIdToName = options?.toolIdToName

	// First pass: find thoughtSignature if it exists in the content blocks
	let activeThoughtSignature: string | undefined
	if (Array.isArray(content)) {
		const sigBlock = content.find((block) => isThoughtSignatureContentBlock(block)) as ThoughtSignatureContentBlock
		if (sigBlock?.thoughtSignature) {
			activeThoughtSignature = sigBlock.thoughtSignature
		}
	}

	// Determine the signature to attach to function calls.
	// If we're in a mode that expects signatures (includeThoughtSignatures is true):
	// 1. Use the actual signature if we found one in the history/content.
	// 2. Fallback to a base64-encoded bypass token if missing (e.g. cross-model history).
	//    Part.thoughtSignature is documented as "Encoded as base64 string" — Vertex AI validates
	//    this strictly and returns empty responses when a non-base64 value is sent.
	let functionCallSignature: string | undefined
	if (includeThoughtSignatures) {
		functionCallSignature = activeThoughtSignature || GEMINI_THOUGHT_SIGNATURE_BYPASS
	}

	if (typeof content === "string") {
		return [{ text: content }]
	}

	const hasToolResults =
		Array.isArray(content) &&
		content.some(
			(block) => typeof block === "object" && block !== null && "type" in block && block.type === "tool_result",
		)

	let siblingText: string | undefined
	let lastToolResultIndex = -1

	if (hasToolResults && Array.isArray(content)) {
		const textBlocks = content.filter(
			(block): block is Anthropic.Messages.TextBlockParam =>
				typeof block === "object" && block !== null && "type" in block && block.type === "text",
		)
		const joinedText = textBlocks
			.map((b) => b.text)
			.filter(Boolean)
			.join("\n\n")
		if (joinedText) {
			siblingText = joinedText
		}

		for (let i = content.length - 1; i >= 0; i--) {
			const block = content[i]
			if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_result") {
				lastToolResultIndex = i
				break
			}
		}
	}

	const parts = content.flatMap((block, index): Part | Part[] => {
		// Handle thoughtSignature blocks first
		if (isThoughtSignatureContentBlock(block)) {
			// We process thought signatures globally and attach them to the relevant parts
			// or create a placeholder part if no other content exists.
			return []
		}

		switch (block.type) {
			case "text":
				// If the turn contains tool_result blocks, sibling text (such as environment_details)
				// is merged into the last functionResponse part to avoid polluting function call turns
				// with invalid text parts.
				if (hasToolResults) {
					return []
				}
				return { text: block.text }
			case "image":
				if (block.source.type !== "base64") {
					throw new Error("Unsupported image source type")
				}

				return { inlineData: { data: block.source.data, mimeType: block.source.media_type } }
			case "tool_use":
				// Gemini 3 validation rules:
				// - In a parallel function calling response, only the FIRST functionCall part has a signature.
				// - In sequential steps, each step's first functionCall must include its signature.
				// When converting from our history, we don't always have enough information to perfectly
				// recreate the original per-part distribution, but we can and should avoid attaching the
				// signature to every parallel call in a single assistant message.
				return {
					functionCall: {
						name: block.name,
						args: block.input as Record<string, unknown>,
					},
					// Inject the thoughtSignature into the functionCall part if required.
					// This is necessary for Gemini 3+ thinking models to validate the tool call.
					...(functionCallSignature ? { thoughtSignature: functionCallSignature } : {}),
				} as Part
			case "tool_result": {
				// Get tool name from the map (built from tool_use blocks in message history).
				// The map must contain the tool name - if it doesn't, this indicates a bug
				// where the conversation history is incomplete or tool_use blocks are missing.
				const toolName = toolIdToName?.get(block.tool_use_id)
				if (!toolName) {
					throw new Error(
						`Unable to find tool name for tool_use_id "${block.tool_use_id}". ` +
							`This indicates the conversation history is missing the corresponding tool_use block. ` +
							`Available tool IDs: ${Array.from(toolIdToName?.keys() ?? []).join(", ") || "none"}`,
					)
				}

				let contentText = ""
				const imageParts: Part[] = []

				if (typeof block.content === "string") {
					contentText = block.content
				} else if (Array.isArray(block.content)) {
					const textParts: string[] = []

					for (const item of block.content) {
						if (item.type === "text") {
							textParts.push(item.text)
						} else if (item.type === "image" && item.source.type === "base64") {
							const { data, media_type } = item.source
							imageParts.push({ inlineData: { data, mimeType: media_type } })
						}
					}

					contentText =
						textParts.join("\n\n") + (imageParts.length > 0 ? "\n\n(See next part for image)" : "")
				}

				// If this is the last tool result in the message, append any sibling text (e.g. environment_details)
				if (index === lastToolResultIndex && siblingText) {
					contentText = contentText ? `${contentText}\n\n${siblingText}` : siblingText
				}

				// Return function response followed by any images
				return [
					{
						functionResponse: {
							name: toolName,
							response: { name: toolName, content: contentText || "(empty)" },
						},
					},
					...imageParts,
				]
			}
			default:
				// Skip unsupported content block types (e.g., "reasoning", "thinking", "redacted_thinking", "document")
				// These are typically metadata from other providers that don't need to be sent to Gemini
				console.warn(`Skipping unsupported content block type: ${block.type}`)
				return []
		}
	})

	// Post-processing:
	// 1) Ensure thought signature is attached if required
	// 2) For multiple function calls in a single message, keep the signature only on the first
	//    functionCall part to match Gemini 3 parallel-calling behavior.
	if (includeThoughtSignatures && activeThoughtSignature) {
		const hasSignature = parts.some((p) => "thoughtSignature" in p)

		if (!hasSignature) {
			if (parts.length > 0) {
				// Attach to the first part (usually text)
				// We use the intersection type to allow adding the property safely
				;(parts[0] as PartWithThoughtSignature).thoughtSignature = activeThoughtSignature
			} else {
				// Create a placeholder part if no other content exists
				const placeholder: PartWithThoughtSignature = { text: "", thoughtSignature: activeThoughtSignature }
				parts.push(placeholder)
			}
		}
	}

	if (includeThoughtSignatures) {
		let seenFirstFunctionCall = false
		for (const part of parts) {
			if (part && typeof part === "object" && "functionCall" in part && (part as any).functionCall) {
				const partWithSig = part as PartWithThoughtSignature
				if (!seenFirstFunctionCall) {
					seenFirstFunctionCall = true
				} else {
					// Remove signature from subsequent function calls in this message.
					delete partWithSig.thoughtSignature
				}
			}
		}
	}

	return parts
}

export function convertAnthropicMessageToGemini(
	message: Anthropic.Messages.MessageParam,
	options?: { includeThoughtSignatures?: boolean; toolIdToName?: Map<string, string> },
): Content[] {
	const parts = convertAnthropicContentToGemini(message.content, options)

	if (parts.length === 0) {
		return []
	}

	return [
		{
			role: message.role === "assistant" ? "model" : "user",
			parts,
		},
	]
}
