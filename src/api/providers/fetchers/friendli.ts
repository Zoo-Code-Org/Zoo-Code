import axios from "axios"
import { z } from "zod"

import {
	type ModelInfo,
	type ReasoningEffortExtended,
	openAiModelInfoSaneDefaults,
	reasoningEffortsExtended,
} from "@roo-code/types"

import { parseApiPrice } from "../../../shared/cost"
import { throwIfAborted } from "../utils/abort-signal"

const friendliModelSchema = z.object({
	id: z.string(),
	mode: z.string().optional(),
	description: z.string().optional(),
	context_length: z.number().optional(),
	max_completion_tokens: z.number().optional(),
	pricing: z
		.object({
			input: z.string().optional(),
			output: z.string().optional(),
			input_cache_read: z.string().optional(),
		})
		.optional(),
	input_modalities: z.array(z.string()).optional(),
	reasoning_options: z.array(z.object({ type: z.string(), values: z.array(z.string()).optional() })).nullish(),
})

type FriendliModel = z.infer<typeof friendliModelSchema>

const friendliModelsResponseSchema = z.object({ data: z.array(friendliModelSchema) })

const parseFriendliModel = (model: FriendliModel): ModelInfo => {
	const efforts = model.reasoning_options
		?.find((option) => option.type === "effort")
		?.values?.filter((v): v is ReasoningEffortExtended =>
			(reasoningEffortsExtended as readonly string[]).includes(v),
		)
	// A toggle without effort levels (e.g. GLM-5.1, Gemma) is an on/off switch, not an effort scale.
	const toggleOnly = !efforts?.length && !!model.reasoning_options?.some((option) => option.type === "toggle")

	return {
		maxTokens: model.max_completion_tokens,
		contextWindow: model.context_length ?? openAiModelInfoSaneDefaults.contextWindow,
		supportsImages: model.input_modalities?.includes("image") ?? false,
		supportsPromptCache: model.pricing?.input_cache_read !== undefined,
		supportsMaxTokens: true,
		inputPrice: parseApiPrice(model.pricing?.input),
		outputPrice: parseApiPrice(model.pricing?.output),
		cacheReadsPrice: parseApiPrice(model.pricing?.input_cache_read),
		...(efforts?.length && {
			supportsReasoningEffort: efforts,
			reasoningEffort: efforts.includes("high") ? "high" : efforts[0],
		}),
		...(toggleOnly && { supportsReasoningBinary: true }),
		description: model.description,
	}
}

/** Fetches the public (no auth) Friendli model catalog. */
export async function getFriendliModels(opts?: { signal?: AbortSignal }): Promise<Record<string, ModelInfo>> {
	// Null prototype: upstream IDs such as "__proto__" or "toString" must stay plain keys.
	const models: Record<string, ModelInfo> = Object.create(null)

	try {
		const response = await axios.get("https://api.friendli.ai/serverless/v1/models", { signal: opts?.signal })
		const result = friendliModelsResponseSchema.safeParse(response.data)

		if (!result.success) {
			console.error(`Friendli models response is invalid: ${JSON.stringify(result.error.format())}`)
			return models
		}

		for (const model of result.data.data) {
			if (model.mode && model.mode !== "chat") continue
			models[model.id] = parseFriendliModel(model)
		}
	} catch (error) {
		throwIfAborted(opts?.signal)
		console.error(`Error fetching Friendli models: ${error instanceof Error ? error.message : String(error)}`)
	}

	return models
}
