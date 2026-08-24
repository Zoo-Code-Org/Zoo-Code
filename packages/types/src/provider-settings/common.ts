import { z } from "zod"

import { reasoningEffortExtendedSchema, reasoningEffortSettingSchema, verbosityLevelsSchema } from "../model.js"
import type { ProviderIdentifier } from "../provider-identifiers.js"

export const API_PROVIDER_FIELD = "apiProvider"
export const SETTINGS_SHAPE_FIELD = "settingsShape"
export const API_MODEL_ID_FIELD = "apiModelId"

export const baseProviderSettingsShape = {
	includeMaxTokens: z.boolean().optional(),
	todoListEnabled: z.boolean().optional(),
	modelTemperature: z.number().nullish(),
	rateLimitSeconds: z.number().optional(),
	consecutiveMistakeLimit: z.number().min(0).optional(),
	enableReasoningEffort: z.boolean().optional(),
	reasoningEffort: reasoningEffortSettingSchema.optional(),
	modelMaxTokens: z.number().optional(),
	modelMaxThinkingTokens: z.number().optional(),
	verbosity: verbosityLevelsSchema.optional(),
	/**
	 * F7: per-profile declaration of the canonical reasoning effort levels the
	 * selected model supports. Self-hosted / OpenAI-compatible models do not
	 * advertise `supportsReasoningEffort` in the model registry, so a profile can
	 * declare the levels its model accepts; the resolution rule fills the gap only
	 * where the model info has no value of its own (registry values are never
	 * overridden).
	 */
	supportedReasoningEfforts: z.array(reasoningEffortExtendedSchema).optional(),
}

export const apiModelIdProviderModelShape = {
	...baseProviderSettingsShape,
	[API_MODEL_ID_FIELD]: z.string().optional(),
}

type ModelId = string | undefined
type UntypedProviderSettings = Record<string, unknown>
type ProviderModelIdAccessor = (settings: UntypedProviderSettings) => ModelId
type ProviderSettingsFromSchema<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>
type TypedProviderModelIdAccessor<S extends z.ZodRawShape> = (settings: ProviderSettingsFromSchema<S>) => ModelId

type ProviderDefinitionInput<P extends ProviderIdentifier, S extends z.ZodRawShape> = {
	apiProvider: P
	schema: S
	modelIdKey?: Extract<keyof S, string>
	getModelId: TypedProviderModelIdAccessor<S>
}

export type ProviderDefinition = {
	apiProvider: ProviderIdentifier
	settingsShape: z.ZodRawShape
	modelIdKey?: string
	schema: z.ZodDiscriminatedUnionOption<typeof API_PROVIDER_FIELD>
	getModelId: ProviderModelIdAccessor
}

export const createModelIdAccessor =
	(modelIdKey: string): ProviderModelIdAccessor =>
	(settings) =>
		settings[modelIdKey] as ModelId

// `modelIdKey` supports deprecated exports. Remove it in favor of an accessor-only contract when those exports are removed.
export const createProviderDefinition = <P extends ProviderIdentifier, S extends z.ZodRawShape>({
	apiProvider,
	schema,
	...modelIdDefinition
}: ProviderDefinitionInput<P, S>) => {
	const settingsSchema = z.object(schema)
	const getModelId: ProviderModelIdAccessor = (settings) => {
		const parsedSettings = settingsSchema.safeParse(settings)
		return parsedSettings.success ? modelIdDefinition.getModelId(parsedSettings.data) : undefined
	}

	return {
		apiProvider,
		settingsShape: schema,
		modelIdKey: modelIdDefinition.modelIdKey,
		schema: z.object({
			...schema,
			[API_PROVIDER_FIELD]: z.literal(apiProvider),
		}),
		getModelId,
	}
}
