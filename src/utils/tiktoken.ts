import { Anthropic } from "@anthropic-ai/sdk"
import { Tiktoken } from "tiktoken/lite"
import o200kBase from "tiktoken/encoders/o200k_base"

const TOKEN_FUDGE_FACTOR = 1.5

let encoder: Tiktoken | null = null

/**
 * Serializes a tool_use block to text for token counting.
 * Approximates how the API sees the tool call.
 */
function serializeToolUse(block: Anthropic.Messages.ToolUseBlockParam): string {
	const parts = [`Tool: ${block.name}`]
	if (block.input !== undefined) {
		try {
			parts.push(`Arguments: ${JSON.stringify(block.input)}`)
		} catch {
			parts.push(`Arguments: [serialization error]`)
		}
	}
	return parts.join("\n")
}

/**
 * Serializes a tool_result block to text for token counting.
 * Handles both string content and array content.
 */
function serializeToolResult(block: Anthropic.Messages.ToolResultBlockParam): string {
	const parts = [`Tool Result (${block.tool_use_id})`]

	if (block.is_error) {
		parts.push(`[Error]`)
	}

	const content = block.content
	if (typeof content === "string") {
		parts.push(content)
	} else if (Array.isArray(content)) {
		// Handle array of content blocks recursively
		for (const item of content) {
			if (item.type === "text") {
				parts.push(item.text || "")
			} else if (item.type === "image") {
				parts.push("[Image content]")
			} else {
				parts.push(`[Unsupported content block: ${String((item as { type?: unknown }).type)}]`)
			}
		}
	}

	return parts.join("\n")
}

export async function tiktoken(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
	if (content.length === 0) {
		return 0
	}

	let totalTokens = 0

	// Lazily create and cache the encoder if it doesn't exist.
	if (!encoder) {
		encoder = new Tiktoken(o200kBase.bpe_ranks, o200kBase.special_tokens, o200kBase.pat_str)
	}

	// tiktoken's WASM encoder has two failure modes on very long strings
	// (issue 1254): a 4 MB single encode traps ("unreachable"), and long
	// separator-less runs — minified JSON, base64 blobs — encode
	// pathologically slowly (~250 ms per 1 000 chars, so a 4 MB blob would
	// hang recovery for minutes). Recovery must never hang on the oversized
	// result it exists to shrink, so: short strings encode exactly, and
	// longer strings are estimated by measuring tokens-per-char on three
	// 10 000-char slices and extrapolating. Natural text stays near-exact
	// (uniform density), the pathological worst case is bounded to three
	// short encodes, and no encode ever exceeds the trap range.
	const ENCODE_DIRECT_CHARS = 50_000
	const SAMPLE_CHARS = 10_000
	const SAMPLE_COUNT = 3
	const estimateTokens = (text: string): number => {
		if (text.length <= ENCODE_DIRECT_CHARS) {
			return encoder!.encode(text, undefined, []).length
		}
		let sampleTokens = 0
		let sampleChars = 0
		for (let s = 0; s < SAMPLE_COUNT; s++) {
			const start = Math.min(Math.floor((text.length / SAMPLE_COUNT) * s), text.length - SAMPLE_CHARS)
			const slice = text.slice(start, start + SAMPLE_CHARS)
			sampleTokens += encoder!.encode(slice, undefined, []).length
			sampleChars += slice.length
		}
		return Math.ceil((sampleTokens / sampleChars) * text.length)
	}

	// Process each content block using the cached encoder.
	for (const block of content) {
		if (block.type === "text") {
			const text = block.text || ""

			if (text.length > 0) {
				totalTokens += estimateTokens(text)
			}
		} else if (block.type === "image") {
			// For images, calculate based on data size.
			const imageSource = block.source

			if (imageSource && typeof imageSource === "object" && "data" in imageSource) {
				const base64Data = imageSource.data as string
				totalTokens += Math.ceil(Math.sqrt(base64Data.length))
			} else {
				totalTokens += 300 // Conservative estimate for unknown images
			}
		} else if (block.type === "tool_use") {
			// Serialize tool_use block to text and count tokens
			const serialized = serializeToolUse(block as Anthropic.Messages.ToolUseBlockParam)
			if (serialized.length > 0) {
				totalTokens += estimateTokens(serialized)
			}
		} else if (block.type === "tool_result") {
			// Serialize tool_result block to text and count tokens
			const serialized = serializeToolResult(block as Anthropic.Messages.ToolResultBlockParam)
			if (serialized.length > 0) {
				totalTokens += estimateTokens(serialized)
			}
		}
	}

	// Add a fudge factor to account for the fact that tiktoken is not always
	// accurate.
	return Math.ceil(totalTokens * TOKEN_FUDGE_FACTOR)
}
