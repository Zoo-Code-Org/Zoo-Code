import axios from "axios"
import { z } from "zod"

import {
	STANDARD_COMPUTE_BASE_URL,
	standardComputeDefaultModelId,
	standardComputeDefaultModelInfo,
	type ModelInfo,
	type ModelRecord,
} from "@roo-code/types"

import { throwIfAborted } from "../utils/abort-signal"

const standardComputeModelSchema = z.object({
	id: z.string().min(1),
	display_name: z.string().optional(),
	context_length: z.number().int().positive().nullish(),
	architecture: z
		.object({
			input_modalities: z.array(z.string()).optional(),
		})
		.nullish(),
	supported_parameters: z.array(z.string()).optional(),
})

export type StandardComputeModel = z.infer<typeof standardComputeModelSchema>

function getSafeErrorMessage(error: unknown, apiKey?: string): string {
	const message = error instanceof Error ? error.message : String(error)
	return apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message
}

const standardComputeModelsResponseSchema = z.object({
	object: z.string().optional(),
	data: z.array(z.unknown()),
})

export const parseStandardComputeModel = (model: StandardComputeModel): ModelInfo => ({
	maxTokens: standardComputeDefaultModelInfo.maxTokens,
	contextWindow: model.context_length ?? standardComputeDefaultModelInfo.contextWindow,
	// The routed model sends image requests to a vision model, so it accepts
	// images although the catalog entry lists no modalities.
	supportsImages:
		model.architecture?.input_modalities?.includes("image") ?? model.id === standardComputeDefaultModelId,
	supportsPromptCache: false,
	// Catalog strings are remote and ModelInfo.description is rendered as
	// Markdown, so only the plain-text display name is copied.
	...(model.display_name !== undefined ? { displayName: model.display_name } : {}),
})

/**
 * Fetches the public Standard Compute model catalog.
 *
 * The catalog can be listed without an API key. A Bearer key is forwarded
 * when present, so the cache stays scoped to the key.
 *
 * @param apiKey - Optional Bearer token.
 * @param opts - Optional per-request controls; `signal` cancels the in-flight request.
 */
export async function getStandardComputeModels(apiKey?: string, opts?: { signal?: AbortSignal }): Promise<ModelRecord> {
	try {
		const response = await axios.get(`${STANDARD_COMPUTE_BASE_URL}/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			timeout: 10_000,
			signal: opts?.signal,
		})
		const responseResult = standardComputeModelsResponseSchema.safeParse(response.data)
		if (!responseResult.success) {
			console.warn("Standard Compute models response did not match the expected top-level schema")
			return {}
		}

		// Use null-prototype object to prevent prototype pollution
		const models: ModelRecord = Object.create(null)
		for (const rawModel of responseResult.data.data) {
			const modelResult = standardComputeModelSchema.safeParse(rawModel)
			if (!modelResult.success) {
				console.warn("Skipping invalid Standard Compute model entry")
				continue
			}

			// Zoo Code is agentic-first: a model whose supported_parameters list
			// omits "tools" is skipped. An absent list remains eligible.
			const supportedParameters = modelResult.data.supported_parameters
			if (supportedParameters !== undefined && !supportedParameters.includes("tools")) {
				continue
			}

			models[modelResult.data.id] = parseStandardComputeModel(modelResult.data)
		}

		return models
	} catch (error) {
		// Surface cancellation as a rejection: logging and returning here would
		// present an aborted fetch to callers as a successful (empty) catalog.
		throwIfAborted(opts?.signal)

		console.error(`Error fetching Standard Compute models: ${getSafeErrorMessage(error, apiKey)}`)
		return {}
	}
}
