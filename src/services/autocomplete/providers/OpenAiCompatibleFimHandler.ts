import OpenAI from "openai"
import { z } from "zod"

import type { AutocompleteModelSummary, AutocompleteValidationResult } from "@roo-code/types"

import type { FimCompletionHandler, FimRequest } from "./FimCompletionHandler"

const modelsSchema = z.object({
	data: z
		.array(
			z.object({
				id: z.string(),
				object: z.string().optional(),
			}),
		)
		.optional(),
})

/**
 * OpenAI-compatible FIM handler for LM Studio / llama.cpp / vLLM.
 *
 * Uses the `openai` SDK's `completions.create` with `suffix` (native FIM) and
 * `maxRetries: 0` — retries are a latency tax we can't afford at a 300 ms budget.
 * The API key is `"noop"` when unset (LM Studio's convention, mirroring
 * `lm-studio.ts`).
 *
 * llama.cpp ignores `suffix` on `/v1/completions` and returns a 400/422; on that
 * error we retry once with the rendered prompt and memoise the degraded mode per
 * baseUrl so subsequent keystrokes skip the wasted first request.
 */
export class OpenAiCompatibleFimHandler implements FimCompletionHandler {
	readonly id = "openai-compatible" as const
	readonly usesNativeFim = true
	readonly supportsStreaming = true

	/** Degraded-mode memo: baseUrl → needs rendered-prompt fallback. */
	private readonly degraded = new Set<string>()

	constructor(
		private readonly options: {
			getConfig: () => { readonly modelId?: string; readonly baseUrl: string }
			getApiKey: () => string | undefined
		},
	) {}

	async *streamFim(request: FimRequest): AsyncGenerator<string, void, undefined> {
		const baseUrl = this.normalizeBaseUrl(request.baseUrl)

		// Instruction-tuned models go through the chat endpoint so the instruction
		// lives in a system message the model cannot echo back as output.
		if (request.useChatEndpoint) {
			yield* this.streamChat(request, baseUrl)
			return
		}

		// A non-FIM model (instruct/none template) always takes the rendered prompt,
		// exactly like a server that rejected `suffix`.
		const degraded = !request.supportsFim || this.degraded.has(baseUrl)

		const client = this.createClient(baseUrl, request.apiKey, request.requestTimeoutMs)

		try {
			const stream = await client.completions.create(
				{
					model: request.modelId,
					prompt: degraded ? request.renderedPrompt : request.prefix,
					suffix: degraded ? undefined : request.suffix,
					stop: request.stopSequences.slice(0, 4),
					stream: true,
					temperature: request.temperature,
					max_tokens: request.maxOutputTokens,
				},
				{ signal: request.signal },
			)

			for await (const chunk of stream) {
				const delta = chunk.choices?.[0]?.text

				if (delta) {
					yield delta
				}
			}
		} catch (error) {
			if (isAbortError(error)) {
				return
			}

			if (isAuthError(error)) {
				throw new Error(AUTH_ERROR_MESSAGE)
			}

			// llama.cpp rejects `suffix` with 400/422; retry once with the rendered
			// prompt. Guarded on `supportsFim` as well as the memo so a non-FIM
			// request — which already sent the rendered prompt — cannot recurse.
			if (request.supportsFim && !degraded && isSuffixRejection(error)) {
				this.degraded.add(baseUrl)
				yield* this.streamFim(request)
				return
			}

			throw error
		}
	}

	/**
	 * Chat-endpoint path for instruction-tuned models.
	 *
	 * The system message carries the "code only" instruction; the user message
	 * carries just the code with a `<CURSOR>` marker. Because the server applies
	 * the model's chat template, the instruction is structurally separate from the
	 * content and cannot be continued as if it were text — which is exactly the
	 * failure mode of putting it in a raw `/v1/completions` prompt.
	 */
	private async *streamChat(request: FimRequest, baseUrl: string): AsyncGenerator<string, void, undefined> {
		const client = this.createClient(baseUrl, request.apiKey, request.requestTimeoutMs)

		try {
			const stream = await client.chat.completions.create(
				{
					model: request.modelId,
					messages: [
						...(request.systemPrompt ? [{ role: "system" as const, content: request.systemPrompt }] : []),
						{ role: "user" as const, content: request.renderedPrompt },
					],
					stop: request.stopSequences.filter((stop) => stop !== "```").slice(0, 4),
					stream: true,
					temperature: request.temperature,
					max_tokens: request.maxOutputTokens,
				},
				{ signal: request.signal },
			)

			for await (const chunk of stream) {
				const delta = chunk.choices?.[0]?.delta?.content

				if (delta) {
					yield delta
				}
			}
		} catch (error) {
			if (isAbortError(error)) {
				return
			}

			if (isAuthError(error)) {
				throw new Error(AUTH_ERROR_MESSAGE)
			}

			throw error
		}
	}

	async listModels(signal: AbortSignal): Promise<AutocompleteModelSummary[]> {
		const baseUrl = this.normalizeBaseUrl(this.options.getConfig().baseUrl)
		const client = this.createClient(baseUrl, this.options.getApiKey(), 15_000)

		const response = await client.models.list({ signal })

		const parsed = modelsSchema.safeParse(response)

		if (!parsed.success) {
			return []
		}

		return (parsed.data.data ?? []).map((model) => ({
			id: model.id,
			label: model.id,
			contextWindow: undefined,
			supportsFim: true,
		}))
	}

	async validate(signal: AbortSignal): Promise<AutocompleteValidationResult> {
		try {
			const models = await this.listModels(signal)
			const modelId = this.options.getConfig().modelId

			if (!modelId) {
				return { ok: false, error: "No model selected" }
			}

			if (models.some((model) => model.id === modelId)) {
				return { ok: true, detail: `Model "${modelId}" is available on the server` }
			}

			return { ok: false, error: `Model "${modelId}" was not found on the server` }
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) }
		}
	}

	private createClient(baseUrl: string, apiKey: string | undefined, timeoutMs = 5_000): OpenAI {
		return new OpenAI({
			baseURL: `${baseUrl}/v1`,
			apiKey: apiKey || "noop",
			maxRetries: 0,
			timeout: timeoutMs,
		})
	}

	/**
	 * Strips trailing slashes and a trailing `/v1`, since {@link createClient}
	 * appends it. Users legitimately paste either form (`https://ollama.com` and
	 * `https://ollama.com/v1` are both documented), and without this the latter
	 * became `/v1/v1` — a 404 on every completion while model listing still worked,
	 * which is exactly the "connected but never suggests" symptom.
	 */
	private normalizeBaseUrl(baseUrl: string): string {
		const url = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "")

		if (!url.startsWith("http://") && !url.startsWith("https://")) {
			return `http://${url}`
		}

		return url
	}
}

/**
 * Hosted endpoints reject completions with 401/403 while still serving their
 * model catalogue publicly (ollama.com does exactly this), so an unauthenticated
 * setup looks configured but silently produces nothing. Surfacing it as a clear
 * message is the difference between "broken" and "needs a key".
 */
const AUTH_ERROR_MESSAGE = "The endpoint rejected the request: check your API key."

function isAuthError(error: unknown): boolean {
	const status = (error as { status?: number } | undefined)?.status

	return status === 401 || status === 403
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || (error as { code?: string }).code === "ABORT_ERR")
}

/** Detects the 400/422 "suffix not supported" rejection from llama.cpp-style servers. */
function isSuffixRejection(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false
	}

	const status = (error as { status?: number }).status

	if (status === 400 || status === 422) {
		return true
	}

	const message = error.message.toLowerCase()

	return message.includes("suffix") && (message.includes("not support") || message.includes("invalid"))
}
