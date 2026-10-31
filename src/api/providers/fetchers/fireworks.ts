import type { ModelInfo, ModelRecord } from "@roo-code/types"
import { FIREWORKS_API_BASE_URL, FIREWORKS_INFERENCE_BASE_URL } from "@roo-code/types"

import { DEFAULT_HEADERS } from "../constants"
import { throwIfAborted } from "../utils/abort-signal"

export const FIREWORKS_MODELS_URL = `${FIREWORKS_INFERENCE_BASE_URL}/models`
export const FIREWORKS_ACCOUNTS_URL = `${FIREWORKS_API_BASE_URL}/v1/accounts`

// Fallbacks for fields the API omits.
const FIREWORKS_FALLBACK_CONTEXT_WINDOW = 128_000

// Historical output budget. It is a floor, not a cap: the models endpoint reports no
// separate output ceiling, so larger-context models get the project-wide 20% budget.
const FIREWORKS_MIN_OUTPUT_TOKENS = 16_384

// Upper bound on pricing pages. A single page (pageSize=200) currently covers every
// model; the cap only protects against a runaway `nextPageToken`.
const FIREWORKS_PRICING_MAX_PAGES = 10

/** Entry of the OpenAI-compatible `GET /inference/v1/models` response. */
type FireworksApiModel = {
	id?: unknown
	kind?: unknown
	supports_chat?: unknown
	supports_image_input?: unknown
	context_length?: unknown
}

/**
 * Pricing types returned by `ListServerlessModels`.
 *
 * Where this comes from: the `ListServerlessModels` RPC has no page of its own in the
 * Fireworks API reference, but its response is described in the Model schema published
 * with the "List Models" / "Get Model" docs
 * (https://docs.fireworks.ai/api-reference/list-models, field
 * `serverlessModes[].skuInfos`):
 *
 *   "Per-mode token pricing, sourced live from Orb on read. Reuses the same SKUInfo type
 *    as Model.sku_infos (e.g. "LLM input tokens (uncached)", ...). Empty on the stored
 *    config; only populated by ListServerlessModels."
 *
 * i.e. `GET /v1/accounts/{account_id}/models` always returns empty `serverlessModes`;
 * prices are only filled in by `GET /v1/accounts/{account_id}/serverlessModels`, which
 * must be called with the caller's own account id (other accounts return 403).
 */
type FireworksMoney = { currencyCode?: unknown; units?: unknown; nanos?: unknown }
type FireworksSkuInfo = { sku?: unknown; amount?: FireworksMoney; unit?: unknown }
type FireworksServerlessMode = {
	name?: unknown
	serviceTier?: unknown
	usageIdentifier?: unknown
	skuInfos?: unknown
}
type FireworksServerlessModel = {
	name?: unknown
	displayName?: unknown
	serverlessModes?: unknown
}

type FireworksPricing = Pick<ModelInfo, "inputPrice" | "outputPrice" | "cacheReadsPrice">

// SKU names as returned in `skuInfos[].sku` (prices are per `unit: "1M tokens"`).
const SKU_TO_PRICE_FIELD: Record<string, keyof FireworksPricing> = {
	"LLM input tokens (uncached)": "inputPrice",
	"LLM output tokens": "outputPrice",
	"LLM input tokens (cached)": "cacheReadsPrice",
}

const isPositiveNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** google.type.Money -> number (`units` is an int64 serialized as a string). */
function moneyToNumber(amount: FireworksMoney | undefined): number | undefined {
	if (!amount || (amount.currencyCode !== undefined && amount.currencyCode !== "USD")) {
		return undefined
	}

	const units = Number(amount.units ?? 0)
	const nanos = Number(amount.nanos ?? 0)
	const value = units + nanos / 1e9

	return Number.isFinite(value) ? value : undefined
}

function parseSkuPricing(skuInfos: unknown): FireworksPricing | undefined {
	if (!Array.isArray(skuInfos)) return undefined

	const pricing: FireworksPricing = {}

	for (const skuInfo of skuInfos as FireworksSkuInfo[]) {
		if (!isRecord(skuInfo) || typeof skuInfo.sku !== "string") continue
		if (skuInfo.unit !== undefined && skuInfo.unit !== "1M tokens") continue

		const field = SKU_TO_PRICE_FIELD[skuInfo.sku]
		const price = moneyToNumber(skuInfo.amount)

		if (field && price !== undefined) {
			pricing[field] = price
		}
	}

	// `calculateApiCostInternal` treats a missing rate as zero, so a partial price list
	// would silently drop the missing side from the recorded cost. Report no pricing at
	// all unless both token directions are known; cost then shows as unknown.
	if (pricing.inputPrice === undefined || pricing.outputPrice === undefined) return undefined

	return pricing
}

/**
 * Build a map of inference model id -> pricing from a `ListServerlessModels` response.
 *
 * - The `default` mode (empty `serviceTier`, empty `usageIdentifier`) prices the model's
 *   own id. `priority` tier modes are skipped: they are the same id requested with a
 *   `service_tier` flag, which this provider never sends.
 * - Modes with a `usageIdentifier` (e.g. `accounts/fireworks/routers/glm-5p3-fast`) price
 *   that router id.
 */
export function parseFireworksServerlessPricing(data: unknown): Map<string, FireworksPricing> {
	const pricing = new Map<string, FireworksPricing>()
	const models = isRecord(data) && Array.isArray(data.models) ? (data.models as FireworksServerlessModel[]) : []

	for (const model of models) {
		if (!isRecord(model) || typeof model.name !== "string" || !Array.isArray(model.serverlessModes)) continue

		for (const mode of model.serverlessModes as FireworksServerlessMode[]) {
			if (!isRecord(mode)) continue
			if (typeof mode.serviceTier === "string" && mode.serviceTier !== "") continue

			const modePricing = parseSkuPricing(mode.skuInfos)
			if (!modePricing) continue

			const usageIdentifier =
				typeof mode.usageIdentifier === "string" && mode.usageIdentifier ? mode.usageIdentifier : undefined
			const isDefaultMode = typeof mode.name === "string" && mode.name.endsWith("/serverlessModes/default")

			if (usageIdentifier) {
				pricing.set(usageIdentifier, modePricing)
			} else if (isDefaultMode) {
				pricing.set(model.name, modePricing)
			}
		}
	}

	return pricing
}

function authHeaders(apiKey?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...DEFAULT_HEADERS,
	}

	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`
	}

	return headers
}

/**
 * Fetch per-model pricing. Best-effort: any failure (no key, account lookup failure,
 * endpoint change) yields an empty map so the model list still loads and cost shows as
 * unknown. Aborts are re-thrown so a cancelled fetch never looks like a usable catalog.
 */
async function getFireworksPricing(
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
): Promise<Map<string, FireworksPricing>> {
	if (!apiKey) return new Map()

	try {
		const accountsResponse = await fetch(FIREWORKS_ACCOUNTS_URL, { headers: authHeaders(apiKey), signal })
		if (!accountsResponse.ok) return new Map()

		const accounts: unknown = await accountsResponse.json()
		const accountName =
			isRecord(accounts) &&
			Array.isArray(accounts.accounts) &&
			isRecord(accounts.accounts[0]) &&
			typeof accounts.accounts[0].name === "string"
				? accounts.accounts[0].name // e.g. "accounts/abc123"
				: undefined

		if (!accountName || !/^accounts\/[\w-]+$/.test(accountName)) return new Map()

		const pricing = new Map<string, FireworksPricing>()
		let pageToken: string | undefined

		// Paginate defensively; a single page (pageSize=200) currently covers all models.
		for (let page = 0; page < FIREWORKS_PRICING_MAX_PAGES; page++) {
			const url = new URL(`${FIREWORKS_API_BASE_URL}/v1/${accountName}/serverlessModels`)
			url.searchParams.set("pageSize", "200")
			if (pageToken) url.searchParams.set("pageToken", pageToken)

			const response = await fetch(url.toString(), { headers: authHeaders(apiKey), signal })
			if (!response.ok) break

			const data: unknown = await response.json()
			for (const [id, modelPricing] of parseFireworksServerlessPricing(data)) {
				pricing.set(id, modelPricing)
			}

			pageToken = isRecord(data) && typeof data.nextPageToken === "string" ? data.nextPageToken : undefined
			if (!pageToken) break
		}

		if (pageToken) {
			// The page cap was hit while more pages exist. Models on later pages keep their
			// entry in the catalog but have no price, so their cost is unknown rather than zero.
			console.warn(
				`[getFireworksModels] Pricing pagination truncated after ${FIREWORKS_PRICING_MAX_PAGES} pages; later models have unknown cost.`,
			)
		}

		return pricing
	} catch (error) {
		throwIfAborted(signal)
		console.warn("[getFireworksModels] Failed to fetch Fireworks pricing:", error)
		return new Map()
	}
}

function parseFireworksModel(modelId: string, model: FireworksApiModel, pricing?: FireworksPricing): ModelInfo {
	const contextWindow = isPositiveNumber(model.context_length)
		? model.context_length
		: FIREWORKS_FALLBACK_CONTEXT_WINDOW

	// Fireworks accepts `max_tokens` up to the model's context window and reports no
	// separate output ceiling, so the 20% output convention (used for OpenRouter models
	// without a reported limit) is the best available per-model value. The historical
	// 16,384 budget stays a floor so small-context models keep their previous allowance.
	const maxTokens = Math.min(contextWindow, Math.max(FIREWORKS_MIN_OUTPUT_TOKENS, Math.ceil(contextWindow * 0.2)))

	return {
		maxTokens,
		contextWindow,
		supportsImages: model.supports_image_input === true,
		supportsPromptCache: pricing?.cacheReadsPrice !== undefined,
		// Surface the max-output slider so users can lower the budget for costly models.
		supportsMaxTokens: true,
		...pricing,
	}
}

/**
 * Fetches the models available to the given API key from the Fireworks API.
 *
 * - Model list and capabilities: `GET /inference/v1/models` (OpenAI-compatible; returns
 *   `context_length`, `supports_image_input`, `supports_tools`, `supports_chat`).
 * - Pricing: `GET /v1/accounts/{account_id}/serverlessModels` (see `FireworksSkuInfo` for
 *   where this is documented). Models without a price are kept, with cost left unknown.
 *
 * Non-chat models (embeddings, rerankers) are skipped because they cannot back a task.
 * Note: embedding/reranker models currently report `supports_chat: true`, so `kind` is
 * checked as well.
 */
export async function getFireworksModels(apiKey?: string, opts?: { signal?: AbortSignal }): Promise<ModelRecord> {
	const signal = opts?.signal

	const [response, pricing] = await Promise.all([
		fetch(FIREWORKS_MODELS_URL, { headers: authHeaders(apiKey), signal }),
		getFireworksPricing(apiKey, signal),
	])

	if (!response.ok) {
		throwIfAborted(signal)

		let errorBody = ""
		try {
			errorBody = await response.text()
		} catch {
			errorBody = "(unable to read response body)"
		}

		console.error(`[getFireworksModels] HTTP error:`, {
			status: response.status,
			statusText: response.statusText,
			url: FIREWORKS_MODELS_URL,
			body: errorBody,
		})

		throw new Error(`HTTP ${response.status}: ${response.statusText}`)
	}

	const data = await response.json()

	if (!data?.data || !Array.isArray(data.data)) {
		console.error("[getFireworksModels] Unexpected response format:", data)
		throw new Error("Failed to fetch Fireworks models: Unexpected response format.")
	}

	// Use null-prototype object to prevent prototype pollution
	const models: ModelRecord = Object.create(null)

	for (const model of data.data as FireworksApiModel[]) {
		const modelId = typeof model?.id === "string" && model.id ? model.id : null
		if (!modelId) continue

		if (model.supports_chat === false || model.kind === "EMBEDDING_MODEL") continue

		models[modelId] = parseFireworksModel(modelId, model, pricing.get(modelId))
	}

	return models
}
