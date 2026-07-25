import { z } from "zod"

import {
	KIMI_CODE_BASE_URL,
	kimiCodeDefaultModelInfo,
	kimiCodeReasoningEfforts,
	type ModelInfo,
	type ModelRecord,
} from "@roo-code/types"

const kimiCodeModelSchema = z.object({
	id: z.string().min(1),
	context_length: z.number().positive().optional(),
	supports_reasoning: z.boolean().optional(),
	supports_image_in: z.boolean().optional(),
	display_name: z.string().optional(),
})

const kimiCodeModelsResponseSchema = z.object({ data: z.array(kimiCodeModelSchema) })

const KIMI_CODE_MODELS_TIMEOUT_MS = 10_000

export function mapKimiCodeModel(model: z.infer<typeof kimiCodeModelSchema>): ModelInfo {
	const supportsReasoning = model.supports_reasoning ?? false
	return {
		...kimiCodeDefaultModelInfo,
		contextWindow: model.context_length ?? kimiCodeDefaultModelInfo.contextWindow,
		supportsReasoningEffort: supportsReasoning ? [...kimiCodeReasoningEfforts] : false,
		requiredReasoningEffort: supportsReasoning,
		reasoningEffort: supportsReasoning ? "max" : undefined,
		supportsImages: model.supports_image_in ?? false,
		displayName: model.display_name,
	}
}

export async function getKimiCodeModels(apiKey?: string): Promise<ModelRecord> {
	if (!apiKey) throw new Error("Kimi Code authentication is required to fetch models")
	const controller = new AbortController()
	const timeout = setTimeout(
		() => controller.abort(new Error("Kimi Code models request timed out")),
		KIMI_CODE_MODELS_TIMEOUT_MS,
	)
	try {
		const response = await fetch(`${KIMI_CODE_BASE_URL}/models`, {
			headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		})
		if (!response.ok) {
			const error = new Error(`Kimi Code models request failed: ${response.status} ${response.statusText}`)
			;(error as Error & { status?: number }).status = response.status
			throw error
		}
		const parsed = kimiCodeModelsResponseSchema.parse(await response.json())
		return Object.fromEntries(parsed.data.map((model) => [model.id, mapKimiCodeModel(model)]))
	} finally {
		clearTimeout(timeout)
	}
}
