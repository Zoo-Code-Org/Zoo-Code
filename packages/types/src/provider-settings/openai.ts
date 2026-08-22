import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { modelInfoSchema } from "../model.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

export const OPEN_AI_MODEL_ID_FIELD = "openAiModelId"

export const OPENAI_EXTRA_BODY_RESERVED_KEYS = [
	"__proto__",
	"constructor",
	"max_completion_tokens",
	"max_tokens",
	"messages",
	"model",
	"parallel_tool_calls",
	"prototype",
	"reasoning",
	"reasoning_effort",
	"stream",
	"stream_options",
	"temperature",
	"tool_choice",
	"tools",
] as const

type OpenAiExtraBodyParseResult =
	| { success: true; data: Record<string, unknown> }
	| {
			success: false
			reason: "invalidJson" | "objectRequired" | "reservedKeys"
			data: Record<string, unknown>
			reservedKeys?: string[]
	  }

export function parseOpenAiExtraBody(value: string | undefined): OpenAiExtraBodyParseResult {
	if (!value?.trim()) {
		return { success: true, data: {} }
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		return { success: false, reason: "invalidJson", data: {} }
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { success: false, reason: "objectRequired", data: {} }
	}

	const entries = Object.entries(parsed)
	const reservedKeys = entries
		.map(([key]) => key)
		.filter((key) => (OPENAI_EXTRA_BODY_RESERVED_KEYS as readonly string[]).includes(key))
	const data = Object.fromEntries(entries.filter(([key]) => !reservedKeys.includes(key)))

	if (reservedKeys.length > 0) {
		return { success: false, reason: "reservedKeys", reservedKeys, data }
	}

	return { success: true, data }
}

const openAiExtraBodySchema = z
	.string()
	.superRefine((value, ctx) => {
		const result = parseOpenAiExtraBody(value)
		if (!result.success) {
			ctx.addIssue({ code: "custom", message: result.reason })
		}
	})
	.optional()

export const openAiProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.openai,
	modelIdKey: OPEN_AI_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(OPEN_AI_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		openAiBaseUrl: z.string().optional(),
		openAiApiKey: z.string().optional(),
		openAiR1FormatEnabled: z.boolean().optional(),
		[OPEN_AI_MODEL_ID_FIELD]: z.string().optional(),
		openAiCustomModelInfo: modelInfoSchema.nullish(),
		openAiUseAzure: z.boolean().optional(),
		azureApiVersion: z.string().optional(),
		openAiStreamingEnabled: z.boolean().optional(),
		openAiHostHeader: z.string().optional(), // Keep temporarily for backward compatibility during migration.
		openAiHeaders: z.record(z.string(), z.string()).optional(),
		openAiExtraBody: openAiExtraBodySchema,
	},
})
