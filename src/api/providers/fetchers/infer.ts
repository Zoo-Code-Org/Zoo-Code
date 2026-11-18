import axios from "axios"
import { z } from "zod"

import { INFER_CATALOG_URL, openAiModelInfoSaneDefaults, type ModelInfo, type ModelRecord } from "@roo-code/types"

import { throwIfAborted } from "../utils/abort-signal"

// Each catalog route has an id. The model picker shows its label after the model name.
const INFER_ROUTE_LABELS = new Map([
	["low-cost", "Low cost"],
	["balanced", "Balanced"],
	["stable", "Stable"],
	["official", "Official"],
])

// Image and video generation models use their own endpoints, not chat completions.
const INFER_GENERATION_KINDS = new Set(["image_generation", "video_generation"])

const inferRuntimeSchema = z.object({
	max_context_tokens: z.number().nullish(),
	max_output_tokens: z.number().nullish(),
	vision: z.boolean().optional(),
	tools: z.boolean().optional(),
	streaming: z.boolean().optional(),
})

const inferRouteSchema = z.object({
	selector: z.string().min(1),
	available: z.boolean().optional(),
	input_per_million_usd: z.number().nonnegative().optional(),
	cached_input_per_million_usd: z.number().nonnegative().optional(),
	cache_write_per_million_usd: z.number().nonnegative().optional(),
	output_per_million_usd: z.number().nonnegative().optional(),
	runtime: inferRuntimeSchema.optional(),
})

const inferModelSchema = z.object({
	slug: z.string().min(1),
	name: z.string().optional(),
	kind: z.string().optional(),
	runtime: inferRuntimeSchema.optional(),
	tiers: z.record(z.string(), z.unknown()),
})

const inferCatalogSchema = z.object({
	models: z.array(z.unknown()),
})

type InferModel = z.infer<typeof inferModelSchema>
type InferRoute = z.infer<typeof inferRouteSchema>
type InferLimit = "max_context_tokens" | "max_output_tokens"

/** A route limit wins over the model limit. A missing or non-positive value means "not published". */
const getLimit = (model: InferModel, route: InferRoute, limit: InferLimit): number | undefined =>
	[route.runtime?.[limit], model.runtime?.[limit]].find(
		(value): value is number => typeof value === "number" && value > 0,
	)

/** Maps one catalog route to model info. Prices are published per 1M tokens in USD, as ModelInfo expects. */
export const parseInferRoute = (model: InferModel, routeId: string, route: InferRoute): ModelInfo => {
	const maxTokens = getLimit(model, route, "max_output_tokens")

	return {
		contextWindow: getLimit(model, route, "max_context_tokens") ?? openAiModelInfoSaneDefaults.contextWindow,
		...(maxTokens !== undefined ? { maxTokens } : {}),
		// Only some routes accept images, so the flag comes from the route, not the model.
		supportsImages: route.runtime?.vision === true,
		supportsPromptCache: (route.cached_input_per_million_usd ?? 0) > 0,
		...(route.input_per_million_usd !== undefined ? { inputPrice: route.input_per_million_usd } : {}),
		...(route.output_per_million_usd !== undefined ? { outputPrice: route.output_per_million_usd } : {}),
		...(route.cached_input_per_million_usd !== undefined
			? { cacheReadsPrice: route.cached_input_per_million_usd }
			: {}),
		...(route.cache_write_per_million_usd !== undefined
			? { cacheWritesPrice: route.cache_write_per_million_usd }
			: {}),
		// The name is a remote string and ModelInfo.description is rendered as Markdown,
		// so it is only surfaced as the plain-text displayName.
		displayName: `${model.name ?? model.slug} (${INFER_ROUTE_LABELS.get(routeId) ?? routeId})`,
	}
}

/**
 * Fetches the public Infer catalog and lists each available text route as a model.
 *
 * The catalog needs no API key and is the same for every account, so no key is sent.
 * The model id of a route is its `selector`, for example `infer/claude-opus-5-5:low-cost`.
 *
 * @param opts - Optional per-request controls; `signal` cancels the in-flight request.
 */
export async function getInferModels(opts?: { signal?: AbortSignal }): Promise<ModelRecord> {
	try {
		const response = await axios.get(INFER_CATALOG_URL, { timeout: 10_000, signal: opts?.signal })
		const catalogResult = inferCatalogSchema.safeParse(response.data)
		if (!catalogResult.success) {
			console.warn("Infer catalog response did not match the expected top-level schema")
			return {}
		}

		// Use null-prototype object to prevent prototype pollution
		const models: ModelRecord = Object.create(null)
		for (const rawModel of catalogResult.data.models) {
			const modelResult = inferModelSchema.safeParse(rawModel)
			if (!modelResult.success) {
				console.warn("Skipping invalid Infer catalog model entry")
				continue
			}

			const model = modelResult.data
			if (model.kind !== undefined && INFER_GENERATION_KINDS.has(model.kind)) {
				continue
			}

			// Gemini models need their thought signatures back on the turn after a tool call,
			// and this provider sends no reasoning back, so Gemini routes are left out for now.
			if (model.slug.startsWith("gemini-")) {
				continue
			}

			for (const [routeId, rawRoute] of Object.entries(model.tiers)) {
				const routeResult = inferRouteSchema.safeParse(rawRoute)
				if (!routeResult.success) {
					console.warn("Skipping invalid Infer catalog route entry")
					continue
				}

				const route = routeResult.data
				// Tasks stream their replies and depend on tool calls, so an explicit false
				// is authoritative. An omitted flag is unknown and stays eligible.
				if (route.available !== true || route.runtime?.tools === false || route.runtime?.streaming === false) {
					continue
				}

				models[route.selector] = parseInferRoute(model, routeId, route)
			}
		}

		return models
	} catch (error) {
		// Surface cancellation as a rejection: logging and returning here would
		// present an aborted fetch to callers as a successful (empty) catalog.
		throwIfAborted(opts?.signal)

		console.error(`Error fetching Infer models: ${error instanceof Error ? error.message : String(error)}`)
		return {}
	}
}
