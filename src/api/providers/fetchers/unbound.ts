import axios from "axios"

import type { ModelInfo } from "@roo-code/types"

import { parseApiPrice } from "../../../shared/cost"

import { throwIfAborted } from "../utils/abort-signal"

/**
 * Shape of a single entry in the real Unbound catalog
 * (GET https://api.getunbound.ai/models), which is a JSON object keyed by
 * model ID. Numeric fields arrive as strings, e.g. "maxTokens": "32000".
 */
interface UnboundCatalogEntry {
	maxTokens?: string
	contextWindow?: string
	supportsPromptCaching?: boolean
	supportsImages?: boolean
	inputTokenPrice?: string
	outputTokenPrice?: string
	cacheWritePrice?: string
	cacheReadPrice?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The live API returns the catalog as an object keyed by model ID. Treat the
 * payload as a catalog only when every value is an object, so error payloads
 * like `{ error: "..." }` still fall through to the unexpected-format guard.
 */
const isCatalogPayload = (value: unknown): value is Record<string, UnboundCatalogEntry> =>
	isRecord(value) && Object.values(value).every((entry) => isRecord(entry))

/** Converts the API's numeric strings to finite numbers; unparseable values yield `undefined`. */
const parseNumericString = (value: unknown): number | undefined => {
	if (value === undefined || value === null) {
		return undefined
	}
	const num = Number(value)
	return Number.isNaN(num) ? undefined : num
}

export async function getUnboundModels(
	apiKey?: string | null,
	opts?: { signal?: AbortSignal },
): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	try {
		const headers: Record<string, string> = {}

		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		const response = await axios.get("https://api.getunbound.ai/models", { headers, signal: opts?.signal })
		const rawModels = response.data?.data ?? response.data

		if (Array.isArray(rawModels)) {
			// Legacy envelope: prices arrive per token and are normalized to
			// per-1M-token prices via parseApiPrice.
			for (const rawModel of rawModels) {
				const modelInfo: ModelInfo = {
					maxTokens: rawModel.max_output_tokens ?? 8192,
					contextWindow: rawModel.context_window ?? 200_000,
					supportsPromptCache: rawModel.supports_caching ?? false,
					supportsImages: rawModel.supports_vision ?? false,
					inputPrice: parseApiPrice(rawModel.input_price),
					outputPrice: parseApiPrice(rawModel.output_price),
					description: rawModel.description,
					cacheWritesPrice: parseApiPrice(rawModel.caching_price),
					cacheReadsPrice: parseApiPrice(rawModel.cached_price),
				}

				models[rawModel.id] = modelInfo
			}
		} else if (isCatalogPayload(rawModels)) {
			// Real catalog shape: object keyed by model ID. Prices are already
			// quoted per 1M tokens (e.g. "5.000000" = $5/1M), matching the
			// per-1M convention stored in ModelInfo, so Number() is applied
			// directly instead of parseApiPrice's per-token scaling.
			for (const [modelId, rawModel] of Object.entries(rawModels)) {
				const modelInfo: ModelInfo = {
					maxTokens: parseNumericString(rawModel.maxTokens) ?? 8192,
					contextWindow: parseNumericString(rawModel.contextWindow) ?? 200_000,
					supportsPromptCache: rawModel.supportsPromptCaching ?? false,
					supportsImages: rawModel.supportsImages ?? false,
					inputPrice: parseNumericString(rawModel.inputTokenPrice),
					outputPrice: parseNumericString(rawModel.outputTokenPrice),
					cacheWritesPrice: parseNumericString(rawModel.cacheWritePrice),
					cacheReadsPrice: parseNumericString(rawModel.cacheReadPrice),
				}

				models[modelId] = modelInfo
			}
		} else {
			console.error("[getUnboundModels] Unexpected response format:", response.data)
			throw new Error("Failed to fetch Unbound models: Unexpected response format.")
		}
	} catch (error) {
		// Surface cancellation as a rejection: logging and returning here would
		// present an aborted fetch to callers as a successful (partial) catalog.
		throwIfAborted(opts?.signal)

		console.error(`Error fetching Unbound models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
	}

	return models
}
