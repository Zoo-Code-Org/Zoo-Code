import { z } from "zod"

import type { AutocompleteModelSummary, AutocompleteValidationResult } from "@roo-code/types"

import type { FimCompletionHandler, FimRequest } from "./FimCompletionHandler"
import { readNdjson } from "../stream/streamReaders"

/** Ollama `/api/generate` streaming chunk. */
const generateChunkSchema = z.object({
	response: z.string().optional(),
	done: z.boolean().optional(),
	error: z.string().optional(),
})

const tagsSchema = z.object({
	models: z
		.array(
			z.object({
				name: z.string(),
				model: z.string().optional(),
				capabilities: z.array(z.string()).optional(),
				details: z
					.object({
						parameter_size: z.string().optional(),
						family: z.string().optional(),
					})
					.optional(),
			}),
		)
		.optional(),
})

/** `does not support insert` appears when the model has no native FIM training. */
const NO_FIM_ERROR = /does not support insert/i

/**
 * Ollama FIM handler. Uses raw `fetch` (not the `ollama` npm SDK, whose
 * `Ollama.abort()` cancels *every* in-flight stream on the client instance —
 * breaking per-keystroke cancellation).
 *
 * Sends `{ model, prompt, suffix, stream: true, options: {...} }` to
 * `POST {base}/api/generate`. On a `400 "does not support insert"`, retries once
 * with `{ prompt: renderedPrompt, raw: true }` and memoises the degraded mode
 * per `(baseUrl, modelId)` so subsequent keystrokes skip the wasted first request.
 */
export class OllamaFimHandler implements FimCompletionHandler {
	readonly id = "ollama" as const
	readonly usesNativeFim = true
	readonly supportsStreaming = true

	/** Degraded-mode memo: `${baseUrl}|${modelId}` → needs raw-prompt fallback. */
	private readonly degraded = new Set<string>()

	async *streamFim(request: FimRequest): AsyncGenerator<string, void, undefined> {
		const cacheKey = `${request.baseUrl}|${request.modelId}`
		// A non-FIM model (instruct/none template) always takes the raw rendered
		// prompt — Ollama accepts `suffix` for such models without erroring, and
		// the model then free-runs into prose.
		const degraded = !request.supportsFim || this.degraded.has(cacheKey)

		const body = degraded ? this.rawBody(request) : this.fimBody(request)

		const response = await this.fetchGenerate(request, body)

		if (!response.ok) {
			const errorText = await this.safeReadText(response)

			// First-time 400 "does not support insert": retry once with the rendered
			// prompt. Guarded on `supportsFim` so a request that already sent the raw
			// prompt cannot recurse.
			if (request.supportsFim && !degraded && response.status === 400 && NO_FIM_ERROR.test(errorText)) {
				this.degraded.add(cacheKey)
				yield* this.streamFim(request)
				return
			}

			throw new Error(`Ollama generate failed (${response.status}): ${errorText}`)
		}

		if (!response.body) {
			throw new Error("Ollama returned no response body")
		}

		yield* this.readGenerateStream(response.body, request.signal)
	}

	async listModels(signal: AbortSignal): Promise<AutocompleteModelSummary[]> {
		const response = await fetch(`${this.normalizeBaseUrl()}/api/tags`, { signal })

		if (!response.ok) {
			throw new Error(`Ollama /api/tags failed (${response.status})`)
		}

		const parsed = tagsSchema.safeParse(await response.json())

		if (!parsed.success) {
			return []
		}

		return (parsed.data.models ?? [])
			.filter((model) => !model.capabilities || model.capabilities.includes("completion"))
			.map((model) => ({
				id: model.name,
				label: model.name,
				contextWindow: undefined,
				supportsFim: true,
			}))
	}

	async validate(signal: AbortSignal): Promise<AutocompleteValidationResult> {
		try {
			const models = await this.listModels(signal)
			const config = this.options.getConfig()

			if (models.some((model) => model.id === config.modelId)) {
				return { ok: true, detail: `Model "${config.modelId}" is available on the Ollama server` }
			}

			return { ok: false, error: `Model "${config.modelId}" was not found on the Ollama server` }
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) }
		}
	}

	constructor(
		private readonly options: {
			getConfig: () => { readonly modelId?: string; readonly baseUrl: string }
			getApiKey: () => string | undefined
		},
	) {}

	private fimBody(request: FimRequest): string {
		return JSON.stringify({
			model: request.modelId,
			prompt: request.prefix,
			suffix: request.suffix,
			stream: true,
			options: {
				temperature: request.temperature,
				num_predict: request.maxOutputTokens,
				num_ctx: request.contextLength,
				stop: request.stopSequences,
			},
		})
	}

	private rawBody(request: FimRequest): string {
		return JSON.stringify({
			model: request.modelId,
			prompt: request.renderedPrompt,
			stream: true,
			// `raw: true` bypasses the model's chat template, which is correct for a
			// FIM base model that rejected `suffix` (the rendered prompt already
			// carries its control tokens) but wrong for an instruction-tuned model,
			// whose prompt needs the template applied to be understood as a turn.
			raw: request.supportsFim,
			options: {
				temperature: request.temperature,
				num_predict: request.maxOutputTokens,
				num_ctx: request.contextLength,
				stop: request.stopSequences,
			},
		})
	}

	private async fetchGenerate(request: FimRequest, body: string): Promise<Response> {
		const url = `${this.normalizeBaseUrl(request.baseUrl)}/api/generate`
		const signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.requestTimeoutMs)])

		return fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			signal,
		})
	}

	private async *readGenerateStream(
		body: ReadableStream<Uint8Array>,
		signal: AbortSignal,
	): AsyncGenerator<string, void, undefined> {
		for await (const payload of readNdjson(body, signal)) {
			const parsed = generateChunkSchema.safeParse(payload)

			if (!parsed.success) {
				continue
			}

			if (parsed.data.error) {
				throw new Error(parsed.data.error)
			}

			if (parsed.data.response) {
				yield parsed.data.response
			}

			if (parsed.data.done) {
				return
			}
		}
	}

	private normalizeBaseUrl(baseUrl?: string): string {
		const url = (baseUrl ?? this.options.getConfig().baseUrl).replace(/\/$/, "")

		if (!url.startsWith("http://") && !url.startsWith("https://")) {
			return `http://${url}`
		}

		return url
	}

	private async safeReadText(response: Response): Promise<string> {
		try {
			return await response.text()
		} catch {
			return response.statusText
		}
	}
}
