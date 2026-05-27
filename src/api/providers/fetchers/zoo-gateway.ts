import axios from "axios"

import type { ModelInfo } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../../shared/api"
import { getZooCodeBaseUrl } from "../../../services/zoo-code-auth"

// Reuse the same schemas and parsing logic from vercel-ai-gateway since the API format is identical
import { type VercelAiGatewayModel, parseVercelAiGatewayModel } from "./vercel-ai-gateway"

import { z } from "zod"

/**
 * ZooGatewayPricing (same format as Vercel AI Gateway)
 */

const zooGatewayPricingSchema = z.object({
	input: z.string().optional(),
	output: z.string().optional(),
	input_cache_write: z.string().optional(),
	input_cache_read: z.string().optional(),
	image: z.string().optional(),
})

/**
 * ZooGatewayModel (same format as Vercel AI Gateway)
 */

const zooGatewayModelSchema = z.object({
	id: z.string(),
	object: z.string(),
	created: z.number(),
	owned_by: z.string(),
	name: z.string(),
	description: z.string(),
	context_window: z.number(),
	max_tokens: z.number(),
	type: z.string(),
	pricing: zooGatewayPricingSchema,
})

/**
 * ZooGatewayModelsResponse
 */

const zooGatewayModelsResponseSchema = z.object({
	object: z.string(),
	data: z.array(zooGatewayModelSchema),
})

type ZooGatewayModelsResponse = z.infer<typeof zooGatewayModelsResponseSchema>

// Bound model discovery so a network stall can't hang provider initialization paths.
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000

/**
 * getZooGatewayModels
 *
 * Fetches models from the Zoo Gateway API. Requires authentication via the zoo_ext_ token.
 */

export async function getZooGatewayModels(options?: ApiHandlerOptions): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}
	const baseURL = options?.zooGatewayBaseUrl ?? `${getZooCodeBaseUrl()}/api/gateway/v1`

	// Build headers - Zoo Gateway requires authentication via the zoo_ext_ session token
	const headers: Record<string, string> = {}
	if (options?.zooSessionToken) {
		headers["Authorization"] = `Bearer ${options.zooSessionToken}`
	}

	try {
		const response = await axios.get<ZooGatewayModelsResponse>(`${baseURL}/models`, {
			headers,
			timeout: MODEL_DISCOVERY_TIMEOUT_MS,
		})
		const result = zooGatewayModelsResponseSchema.safeParse(response.data)

		// Fall back to the raw response only when it looks structurally sound; otherwise return
		// an empty list rather than crashing on `response.data.data` being undefined.
		const data = result.success ? result.data.data : Array.isArray(response.data?.data) ? response.data.data : []

		if (!result.success) {
			console.error(`Zoo Gateway models response is invalid ${JSON.stringify(result.error.format())}`)
		}

		for (const model of data) {
			const { id } = model

			// Only include language models for chat inference.
			// Embedding models are statically defined in embeddingModels.ts.
			if (model.type !== "language") {
				continue
			}

			// Parse model using the same logic as Vercel AI Gateway since formats are identical
			models[id] = parseZooGatewayModel({ id, model: model as VercelAiGatewayModel })
		}
	} catch (error) {
		// Log only safe fields; never serialize the full error object because it
		// includes request config/headers which carry the bearer session token.
		const err = error as {
			message?: string
			name?: string
			code?: string
			response?: { status?: number; statusText?: string }
		}
		console.error(
			`Error fetching Zoo Gateway models: name=${err.name ?? "Error"} code=${err.code ?? "unknown"} status=${err.response?.status ?? "unknown"} ${err.response?.statusText ?? ""} message=${err.message ?? "unknown error"}`,
		)
	}

	return models
}

/**
 * parseZooGatewayModel
 *
 * Parses a Zoo Gateway model into ModelInfo format.
 * Zoo Gateway returns the same format as Vercel AI Gateway, so we can reuse the parsing logic.
 */

export const parseZooGatewayModel = ({ id, model }: { id: string; model: VercelAiGatewayModel }): ModelInfo => {
	// Reuse the parsing logic from vercel-ai-gateway
	return parseVercelAiGatewayModel({ id, model })
}
