import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@roo-code/types"

import type { ApiHandlerCreateMessageMetadata } from "../index"
import { ApiStream } from "../transform/stream"
import { BaseProvider } from "./base-provider"

const ZOO_GATEWAY_MODEL = "google/gemini-2.5-flash"

/**
 * ZooGatewayApiHandler
 *
 * Routes compression calls through the Zoo Code website backend,
 * which internally uses Vercel AI Gateway + gemini-2.5-flash.
 *
 * Used exclusively by ToolResultProcessor for LLM-assisted compression.
 * NOT a general-purpose provider for user tasks.
 */
export class ZooGatewayApiHandler extends BaseProvider {
	private readonly baseUrl: string
	private readonly apiKey: string

	constructor(baseUrl: string, apiKey: string) {
		super()
		this.baseUrl = baseUrl.replace(/\/$/, "") // strip trailing slash
		this.apiKey = apiKey
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Extract the raw text content from the last user message
		const lastUserMsg = [...messages].reverse().find((m: Anthropic.Messages.MessageParam) => m.role === "user")
		const rawResult = extractTextContent(lastUserMsg?.content ?? "")

		let compressed = rawResult // fallback

		try {
			const response = await fetch(`${this.baseUrl}/api/proxy/internal/compress`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					systemPrompt,
					rawResult,
					toolName: metadata?.toolName ?? "unknown",
				}),
				signal: AbortSignal.timeout(15_000), // 15s timeout
			})

			if (response.ok) {
				const data = await response.json()
				compressed = data.compressed ?? rawResult
			}
		} catch (err) {
			// Network error, timeout, etc. — gracefully fall back to raw
			console.warn("[ZooGatewayApiHandler] Compression request failed, using raw result", err)
		}

		yield { type: "text", text: compressed }
		yield {
			type: "usage",
			inputTokens: 0,
			outputTokens: 0,
		}
	}

	override getModel(): { id: string; info: ModelInfo } {
		return {
			id: ZOO_GATEWAY_MODEL,
			info: {
				maxTokens: 600,
				contextWindow: 1_000_000,
				supportsImages: false,
				supportsPromptCache: false,
			} as ModelInfo,
		}
	}

	override async countTokens(_content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		return 0 // not needed for compression use case
	}
}

function extractTextContent(content: Anthropic.Messages.ContentBlockParam[] | string): string {
	if (typeof content === "string") return content
	return content
		.filter((b) => b.type === "text")
		.map((b) => (b as Anthropic.Messages.TextBlockParam).text)
		.join("\n")
}
