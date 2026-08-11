// src/services/stats/costRecalculation.ts
//
// Feature 1: Recalculate cost for old usage events at query time.
//
// Problem: Old usage events have `costUsd: undefined` because the providers
// did not calculate `totalCost` at recording time. The NDJSON store is
// append-only, so we cannot modify existing events.
//
// Solution: Compute cost on-the-fly when `costUsd` is missing, using the
// model's pricing info from the provider's static model registry.
//
// Key constraint: This module NEVER modifies the NDJSON file. It only
// computes a derived cost value at query/display time.

import type { ModelInfo, UsageEventV1 } from "@roo-code/types"

// ── Custom Model Pricing (query-time) ──────────────────────────────────────

/**
 * Pricing fields for a custom/user-configured model.
 *
 * Used at query time when the model is NOT in the static provider registry.
 * The dashboard builds a {@link CustomModelPricingMap} from extension
 * settings (e.g. `openAiCustomModelInfo`) and threads it through the query
 * chain so `computeCacheDiscountBase` and `getEffectiveCost` can resolve
 * pricing for custom models without relying on capture-time persistence.
 */
export interface CustomModelPricing {
	inputPrice?: number
	cacheReadsPrice?: number
	cacheWritesPrice?: number
	outputPrice?: number
}

/**
 * Map key: `"provider|model"`. Built by the message handler from
 * `ContextProxy.getProviderSettings()` and passed through the query chain.
 */
export type CustomModelPricingMap = Map<string, CustomModelPricing>

/**
 * Builds the map key for a provider+model pair.
 */
export function customPricingKey(provider: string, model: string): string {
	return `${provider}|${model}`
}

import {
	anthropicModels,
	openAiNativeModels,
	bedrockModels,
	deepSeekModels,
	fireworksModels,
	friendliModels,
	geminiModels,
	mistralModels,
	moonshotModels,
	minimaxModels,
	mimoModels,
	qwenCodeModels,
	sambaNovaModels,
	vertexModels,
	xaiModels,
	internationalZAiModels,
	mainlandZAiModels,
	vscodeLlmModels,
	opencodeGoModels,
} from "@roo-code/types"

import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "../../shared/cost"

// ── Provider → Model Registry Mapping ──────────────────────────────────────

/**
 * Maps a provider name (as stored in `UsageEventV1.provider`) to its static
 * model registry. Only providers with a static, locally-known model registry
 * are included here. Dynamic providers (openrouter, requesty, etc.) fetch
 * models at runtime and cannot be resolved at query time without network
 * access, so they are excluded — cost stays 0 for those events (per the
 * task spec: "If pricing info is not available for the model, leave cost as 0").
 */
const PROVIDER_MODEL_REGISTRIES: Record<string, Record<string, ModelInfo>> = {
	anthropic: anthropicModels,
	openai: openAiNativeModels,
	"openai-native": openAiNativeModels,
	// openai-codex uses ChatGPT Plus/Pro subscription (no per-token billing),
	// but we map to openAiNativeModels so users can see the equivalent API cost
	// for comparison purposes. The actual charge is covered by the subscription.
	"openai-codex": openAiNativeModels,
	bedrock: bedrockModels,
	deepseek: deepSeekModels,
	fireworks: fireworksModels,
	friendli: friendliModels,
	gemini: geminiModels,
	vertex: vertexModels,
	mistral: mistralModels,
	moonshot: moonshotModels,
	minimax: minimaxModels,
	mimo: mimoModels,
	"qwen-code": qwenCodeModels,
	sambanova: sambaNovaModels,
	xai: xaiModels,
	zai: { ...internationalZAiModels, ...mainlandZAiModels },
	"vscode-llm": vscodeLlmModels,
	"opencode-go": opencodeGoModels,
}

/**
 * Providers whose usage semantics follow the Anthropic convention:
 * `inputTokens` does NOT include cached tokens (cache reads + cache writes
 * are reported separately and added to the total).
 *
 * All other providers follow the OpenAI convention where `inputTokens`
 * already includes cached tokens.
 */
const ANTHROPIC_SEMANTIC_PROVIDERS = new Set(["anthropic", "bedrock", "vertex"])

// ── Model Info Lookup ────────────────────────────────────────────────────────

/**
 * Looks up the {@link ModelInfo} for a given provider + model combination.
 *
 * Strategy:
 *  1. Direct lookup in the provider's static registry by exact model ID.
 *  2. If not found, attempt case-insensitive substring matching against
 *     known model IDs (handles versioned variants like
 *     "claude-sonnet-4-20250514" matching "claude-sonnet-4").
 *  3. Fallback to event-level `modelPricing` (capture-time snapshot for
 *     custom models). Only used when the model is NOT in the static registry.
 *  4. Fallback to query-time `customPricing` map (built from extension
 *     settings at query time). Used when neither the static registry nor
 *     the event-level snapshot has pricing.
 *  5. If still not found, return `undefined` (cost stays 0).
 *
 * @param provider The provider name from the usage event.
 * @param model The model ID from the usage event.
 * @param modelPricing Optional capture-time pricing snapshot from the event.
 * @param customPricing Optional query-time pricing map (key: `"provider|model"`).
 * @returns The matching ModelInfo, or undefined if not found.
 */
export function lookupModelInfo(
	provider: string,
	model: string,
	modelPricing?: UsageEventV1["modelPricing"],
	customPricing?: CustomModelPricingMap,
): ModelInfo | undefined {
	const registry = PROVIDER_MODEL_REGISTRIES[provider]

	// 1. Static registry lookup (exact + substring match)
	if (registry) {
		// 1a. Exact match
		if (model in registry) return registry[model]

		// 1b. Case-insensitive substring match (longest known ID first for specificity)
		const knownIds = Object.keys(registry)
		const lowerModel = model.toLowerCase()
		const sortedIds = [...knownIds].sort((a, b) => b.length - a.length)
		for (const knownId of sortedIds) {
			if (lowerModel.includes(knownId.toLowerCase())) {
				return registry[knownId]
			}
		}
	}

	// 2. Fallback to event-level modelPricing (capture-time snapshot)
	//    Only used when the model is NOT in the static registry, so static
	//    registry prices always take precedence.
	if (modelPricing) {
		return {
			inputPrice: modelPricing.inputPrice,
			outputPrice: modelPricing.outputPrice,
			cacheWritesPrice: modelPricing.cacheWritesPrice,
			cacheReadsPrice: modelPricing.cacheReadsPrice,
		} as ModelInfo
	}

	// 3. Fallback to query-time customPricing map (from extension settings)
	if (customPricing) {
		const cp = customPricing.get(customPricingKey(provider, model))
		if (cp) {
			return {
				inputPrice: cp.inputPrice,
				outputPrice: cp.outputPrice,
				cacheWritesPrice: cp.cacheWritesPrice,
				cacheReadsPrice: cp.cacheReadsPrice,
			} as ModelInfo
		}
	}

	// 4. Not found
	return undefined
}

// ── Cost Computation ─────────────────────────────────────────────────────────

/**
 * Computes the cost (in USD) for a single usage event using the model's
 * pricing info. Returns 0 if:
 *  - The event already has a `costUsd` value (caller should use that instead).
 *  - The model info cannot be resolved for the provider/model combination.
 *  - The token counts are all zero.
 *
 * The function respects the event's inclusion semantics:
 *  - For Anthropic-semantic providers: `inputTokens` does NOT include cached
 *    tokens, so cache reads/writes are added to the total input.
 *  - For OpenAI-semantic providers: `inputTokens` already includes cached
 *    tokens, so the non-cached portion is computed before applying pricing.
 *
 * @param event The usage event to compute cost for.
 * @returns The computed cost in USD, or 0 if it cannot be computed.
 */
export function computeEventCost(event: UsageEventV1, customPricing?: CustomModelPricingMap): number {
	// If the event already has a cost, the caller should use it directly.
	// This function is only for computing MISSING costs.
	if (event.usage.costUsd !== undefined && event.usage.costUsd.value > 0) {
		return event.usage.costUsd.value
	}

	const modelInfo = lookupModelInfo(event.provider, event.model, event.modelPricing, customPricing)
	if (!modelInfo) return 0

	const inputTokens = event.usage.inputTokens?.value ?? 0
	const outputTokens = event.usage.outputTokens?.value ?? 0
	const cacheWriteTokens = event.usage.cacheWriteTokens?.value ?? 0
	const cacheReadTokens = event.usage.cacheReadTokens?.value ?? 0

	// If there are no tokens at all, cost is 0.
	if (inputTokens === 0 && outputTokens === 0 && cacheWriteTokens === 0 && cacheReadTokens === 0) {
		return 0
	}

	const isAnthropicSemantic = ANTHROPIC_SEMANTIC_PROVIDERS.has(event.provider)

	let result
	if (isAnthropicSemantic) {
		result = calculateApiCostAnthropic(modelInfo, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)
	} else {
		result = calculateApiCostOpenAI(modelInfo, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)
	}

	return result.totalCost
}

/**
 * Returns the effective cost for a usage event: the stored cost if present,
 * or the computed cost if missing.
 *
 * This is the primary entry point for query-time cost resolution. It never
 * modifies the event — it returns a derived number.
 *
 * @param event The usage event.
 * @returns The effective cost in USD (stored or computed; 0 if unresolvable).
 */
export function getEffectiveCost(event: UsageEventV1, customPricing?: CustomModelPricingMap): number {
	if (event.usage.costUsd !== undefined) {
		return event.usage.costUsd.value
	}
	return computeEventCost(event, customPricing)
}

// ── Cache-Ratio Cost Discount ────────────────────────────────────────────────

/**
 * Determines whether a provider+model combination is KNOWN to report
 * cache-read tokens in its usage response.
 *
 * This is a capability check based on the static model registry: if the
 * model is found in the registry AND has a `cacheReadsPrice` defined, the
 * provider reports cache info. For such providers, `cacheReadTokens == 0`
 * is a TRUE cache miss (not "unreported"), so the slider must NOT vary
 * the cost.
 *
 * For providers/models not in the static registry (custom endpoints,
 * dynamic providers), this returns false — the provider is treated as
 * non-reporting, and the slider may estimate cache reads.
 *
 * @param provider The provider name from the usage event.
 * @param model The model ID from the usage event.
 * @returns True if the provider+model is known to report cache info.
 */
export function providerReportsCache(
	provider: string,
	model: string,
	_modelPricing?: UsageEventV1["modelPricing"],
	_customPricing?: CustomModelPricingMap,
): boolean {
	// Only check the STATIC provider registry. Custom/user-configured models
	// may define cacheReadsPrice (for cost estimation), but that does NOT mean
	// the provider's API actually returns cacheReadTokens in its response.
	// The slider should still work for those models.
	const registry = PROVIDER_MODEL_REGISTRIES[provider]
	if (!registry) return false

	// Try exact match first, then case-insensitive substring match
	let modelInfo: ModelInfo | undefined
	if (model in registry) {
		modelInfo = registry[model]
	} else {
		const lowerModel = model.toLowerCase()
		const sortedIds = Object.keys(registry).sort((a, b) => b.length - a.length)
		for (const knownId of sortedIds) {
			if (lowerModel.includes(knownId.toLowerCase())) {
				modelInfo = registry[knownId]
				break
			}
		}
	}

	if (!modelInfo) return false
	return typeof modelInfo.cacheReadsPrice === "number" && Number.isFinite(modelInfo.cacheReadsPrice)
}

/**
 * Computes the per-event discount base for the dashboard cacheRatio
 * simulation, in USD.
 *
 * When the provider does NOT report cacheReadTokens, the dashboard estimates
 * that `cacheRatio` of the input tokens were cache reads. Those estimated
 * tokens should be priced at the (cheaper) cache-read rate instead of the
 * full input rate, so the event's cost is reduced by
 * `cacheRatio × discountBase`, where:
 *
 *   discountBase = (inputTokens / 1_000_000) × max(0, inputPrice − cacheReadsPrice)
 *
 * Returns 0 when:
 *  - The provider+model is KNOWN to report cache info (via
 *    {@link providerReportsCache}). For such providers, `cacheReadTokens == 0`
 *    is a true cache miss — cost stays verbatim, slider has no effect.
 *  - The model info cannot be resolved for the provider/model combination.
 *  - The model's input or cache-read price is missing or not a finite number.
 *
 * Prices come from the same static registries used by {@link computeEventCost}
 * (via {@link lookupModelInfo}); no prices are invented here.
 *
 * @param event The usage event to compute the discount base for.
 * @returns The discount base in USD (0 when not applicable).
 */
export function computeCacheDiscountBase(event: UsageEventV1, customPricing?: CustomModelPricingMap): number {
	// Capability check: if the provider+model is known to report cache info,
	// cacheReadTokens == 0 is a true cache miss — no discount, no estimation.
	if (providerReportsCache(event.provider, event.model, event.modelPricing, customPricing)) {
		return 0
	}

	const modelInfo = lookupModelInfo(event.provider, event.model, event.modelPricing, customPricing)
	if (!modelInfo) return 0

	const { inputPrice, cacheReadsPrice } = modelInfo
	if (
		typeof inputPrice !== "number" ||
		!Number.isFinite(inputPrice) ||
		typeof cacheReadsPrice !== "number" ||
		!Number.isFinite(cacheReadsPrice)
	) {
		return 0
	}

	const inputTokens = event.usage.inputTokens?.value ?? 0
	return (inputTokens / 1_000_000) * Math.max(0, inputPrice - cacheReadsPrice)
}

/**
 * Computes the cache discount base from aggregated input tokens and a
 * provider+model pair, using the same pricing lookup as
 * {@link computeCacheDiscountBase}.
 *
 * This is the query-time counterpart for rollup rows: when the stored
 * `cache_discount_base` is 0 (because it was computed at write time without
 * `customPricing`), the fast path can recompute the correct value from the
 * aggregated input token sum and the current `customPricing` map.
 *
 * Returns 0 when:
 * - The provider+model is a reporting provider (cacheRead=0 is a true miss).
 * - No pricing info is available (not in registry, no modelPricing, not in
 *   customPricing).
 * - `inputPrice` or `cacheReadsPrice` is missing or non-finite.
 *
 * @param provider The provider ID (e.g. "openai", "anthropic").
 * @param model The model name.
 * @param inputTokens The sum of input tokens for this provider+model pair.
 * @param customPricing Optional query-time pricing map.
 * @returns The discount base in USD (0 when not applicable).
 */
export function computeCacheDiscountBaseFromAggregated(
	provider: string,
	model: string,
	inputTokens: number,
	customPricing?: CustomModelPricingMap,
): number {
	// Capability check: reporting providers keep verbatim cost — no discount.
	if (providerReportsCache(provider, model, undefined, customPricing)) {
		return 0
	}

	const modelInfo = lookupModelInfo(provider, model, undefined, customPricing)
	if (!modelInfo) return 0

	const { inputPrice, cacheReadsPrice } = modelInfo
	if (
		typeof inputPrice !== "number" ||
		!Number.isFinite(inputPrice) ||
		typeof cacheReadsPrice !== "number" ||
		!Number.isFinite(cacheReadsPrice)
	) {
		return 0
	}

	return (inputTokens / 1_000_000) * Math.max(0, inputPrice - cacheReadsPrice)
}

/**
 * Applies the cacheRatio cost discount to a cost value.
 *
 * The discount is proportional to the cache ratio:
 * `cost(ratio) = costUsd − cacheRatio × discountBase`, floored at 0.
 * A missing or non-positive ratio leaves the cost unchanged.
 *
 * @param costUsd The undiscounted cost (stored or computed).
 * @param discountBase The discount base from {@link computeCacheDiscountBase}
 *   (or a sum of per-event bases for rollup rows).
 * @param cacheRatio The dashboard cache-read ratio (0–1).
 * @returns The discounted cost in USD.
 */
export function applyCacheDiscount(costUsd: number, discountBase: number, cacheRatio?: number): number {
	return cacheRatio !== undefined && cacheRatio > 0 ? Math.max(0, costUsd - cacheRatio * discountBase) : costUsd
}
