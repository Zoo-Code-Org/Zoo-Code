import axios from "axios"
import { z } from "zod"

import type { ModelInfo } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../../shared/api"
import { parseApiPrice } from "../../../shared/cost"

/**
 * FriendliPricing
 *
 * All prices are strings (USD per-token); `parseApiPrice` converts to per-1M-token numbers.
 * Some fields may be absent on some models (e.g. input_cache_read, cache_write).
 */
const friendliPricingSchema = z.object({
	input: z.string().optional(),
	output: z.string().optional(),
	prompt: z.string().optional(), // alias for input
	completion: z.string().optional(), // alias for output
	input_cache_read: z.string().optional(),
	cache_write: z.string().optional(),
})

/**
 * FriendliFunctionality
 *
 * Capability flags returned per-model. Several fields may be absent.
 */
const friendliFunctionalitySchema = z.object({
	tool_call: z.boolean().optional(),
	builtin_tool: z.boolean().optional(),
	parallel_tool_call: z.boolean().optional(),
	structured_output: z.boolean().optional(),
	tool_choice: z.boolean().optional(),
	system_messages: z.boolean().optional(),
})

/**
 * FriendliReasoningOption
 *
 * Each entry in `reasoning_options` describes one axis of reasoning control:
 *  - "toggle": on/off via chat_template_kwargs.enable_thinking
 *  - "effort": discrete effort enum (low/medium/high/default/...)
 *  - "budget_tokens": integer token budget with min/max bounds
 */
const friendliReasoningOptionSchema = z
	.object({
		type: z.string(),
		values: z.array(z.string()).optional(),
		min: z.number().optional(),
		max: z.number().optional(),
	})
	// Allow unknown option shapes the schema doesn't model yet so we don't
	// drop models that add new reasoning control axes.
	.passthrough()

/**
 * FriendliModel
 */
const friendliModelSchema = z
	.object({
		id: z.string(),
		name: z.string().optional(),
		created: z.number().optional(),
		context_length: z.number().optional(),
		max_completion_tokens: z.number().optional(),
		pricing: friendliPricingSchema.optional(),
		functionality: friendliFunctionalitySchema.optional(),
		description: z.string().optional(),
		reasoning: z.boolean().optional(),
		reasoning_options: z.array(friendliReasoningOptionSchema).optional(),
		input_modalities: z.array(z.string()).optional(),
		output_modalities: z.array(z.string()).optional(),
		mode: z.string().optional(),
		deprecation_date: z.string().nullable().optional(),
	})
	.passthrough()

export type FriendliModel = z.infer<typeof friendliModelSchema>

/**
 * FriendliModelsResponse
 */
export const friendliModelsResponseSchema = z.object({
	data: z.array(friendliModelSchema),
})

type FriendliModelsResponse = z.infer<typeof friendliModelsResponseSchema>

/**
 * Reasoning effort levels Zoo Code knows how to send. The Friendli API may
 * return additional values (e.g. "default", "ultracode"); those are dropped.
 */
const KNOWN_REASONING_EFFORTS = ["disable", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
type KnownReasoningEffort = (typeof KNOWN_REASONING_EFFORTS)[number]

function buildSupportsReasoningEffort(
	reasoning: boolean | undefined,
	reasoningOptions: FriendliModel["reasoning_options"],
): ModelInfo["supportsReasoningEffort"] {
	if (!reasoning && reasoningOptions === undefined) {
		// Non-reasoning model — omit the field.
		return undefined
	}

	const effortOption = reasoningOptions?.find((opt) => opt.type === "effort")
	if (effortOption && Array.isArray(effortOption.values) && effortOption.values.length > 0) {
		// Controllable reasoning model with a discrete effort enum. Preserve
		// the API-provided values that Zoo Code knows how to send, de-duplicated
		// and in API order. Drop "default" (a placeholder meaning "use the model
		// default" that the Friendli API rejects as a real effort value) and any
		// values not in KNOWN_REASONING_EFFORTS (e.g. "ultracode").
		const seen = new Set<string>()
		const filtered: KnownReasoningEffort[] = []
		for (const v of effortOption.values) {
			if (v === "default" || seen.has(v)) continue
			seen.add(v)
			if ((KNOWN_REASONING_EFFORTS as readonly string[]).includes(v)) {
				filtered.push(v as KnownReasoningEffort)
			}
		}
		return filtered
	}

	// Reasoning-capable model without a discrete effort enum — the handler can
	// still toggle thinking on/off, so expose a boolean capability.
	if (reasoning) {
		return true
	}

	return undefined
}

/**
 * getFriendliModels
 *
 * Fetches the live model list from the public Friendli API
 * (https://api.friendli.ai/serverless/v1/models — no auth required) and maps
 * each entry to a `ModelInfo`. Resilient: uses zod `safeParse` on the response
 * shape and logs (but does not throw on) per-model mapping errors, mirroring
 * the Vercel AI Gateway fetcher.
 */
export async function getFriendliModels(_options?: ApiHandlerOptions): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}
	const baseURL = "https://api.friendli.ai/serverless/v1"

	try {
		const response = await axios.get<FriendliModelsResponse>(`${baseURL}/models`, { timeout: 10_000 })
		const result = friendliModelsResponseSchema.safeParse(response.data)
		const data = result.success ? result.data.data : []

		if (!result.success) {
			console.error(`Friendli models response is invalid ${JSON.stringify(result.error.format())}`)
		}

		for (const model of data) {
			const { id } = model

			// Only include chat models. Embedding/vision-generation-only modes
			// are not surfaced through this path.
			if (model.mode && model.mode !== "chat") {
				continue
			}

			try {
				models[id] = parseFriendliModel({ id, model })
			} catch (error) {
				console.error(`[Friendli fetcher] Failed to parse model ${id}:`, error)
			}
		}
	} catch (error) {
		console.error(`Error fetching Friendli models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
	}

	return models
}

/**
 * parseFriendliModel
 *
 * Pure transform from a Friendli API model entry to a `ModelInfo`. Factored out
 * so tests can exercise it directly without going through axios.
 */
export const parseFriendliModel = ({ id, model }: { id: string; model: FriendliModel }): ModelInfo => {
	// Friendli returns both `input`/`output` and legacy `prompt`/`completion`
	// aliases. Prefer the canonical names and fall back to the aliases.
	const inputPriceStr = model.pricing?.input ?? model.pricing?.prompt
	const outputPriceStr = model.pricing?.output ?? model.pricing?.completion

	const cacheWritesPrice = model.pricing?.cache_write ? parseApiPrice(model.pricing.cache_write) : undefined
	const cacheReadsPrice = model.pricing?.input_cache_read ? parseApiPrice(model.pricing.input_cache_read) : undefined

	// supportsPromptCache is true when the API exposes cache pricing at all —
	// even a zero write price indicates the provider honors cached reads.
	const supportsPromptCache = typeof cacheWritesPrice !== "undefined" || typeof cacheReadsPrice !== "undefined"

	const supportsImages = Array.isArray(model.input_modalities) ? model.input_modalities.includes("image") : false

	const modelInfo: ModelInfo = {
		maxTokens: model.max_completion_tokens ?? 0,
		contextWindow: model.context_length ?? 0,
		supportsImages,
		supportsPromptCache,
		inputPrice: parseApiPrice(inputPriceStr),
		outputPrice: parseApiPrice(outputPriceStr),
		cacheWritesPrice,
		cacheReadsPrice,
		description: model.description && model.description.trim() !== "" ? model.description : undefined,
	}

	if (model.deprecation_date) {
		modelInfo.deprecated = true
	}

	const reasoningEffort = buildSupportsReasoningEffort(model.reasoning, model.reasoning_options)
	if (reasoningEffort !== undefined) {
		if (Array.isArray(reasoningEffort)) {
			// Controllable reasoning model with discrete effort enum — expose
			// the effort dropdown and default to "high".
			modelInfo.supportsReasoningEffort = reasoningEffort
			modelInfo.reasoningEffort = "high"
		} else {
			// Reasoning-capable model without a discrete effort enum. Friendli
			// only supports toggling thinking on/off via chat_template_kwargs for
			// these models, so expose a binary toggle instead of an effort
			// dropdown that would let the user pick values the API ignores.
			modelInfo.supportsReasoningBinary = true
		}
	}

	// Friendli's chat models honour a configurable max-output slider
	// (supportsMaxTokens). All Friendli models accept the max_tokens param,
	// so surface the slider for every reasoning-capable model, not just
	// controllable-reasoning ones with discrete effort enums.
	if (model.reasoning && model.max_completion_tokens) {
		modelInfo.supportsMaxTokens = true
	}

	// We intentionally do not map tool_call / structured_output capability flags
	// into ModelInfo — the OpenAI-compatible base class already sends tools for
	// all models and the Friendli backend ignores the fields it doesn't support.

	return modelInfo
}
