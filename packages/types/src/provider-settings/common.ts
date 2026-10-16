import { z } from "zod"

import { reasoningEffortSettingSchema, verbosityLevelsSchema } from "../model.js"
import type { ProviderIdentifier } from "../provider-identifiers.js"

export const API_PROVIDER_FIELD = "apiProvider"
export const SETTINGS_SHAPE_FIELD = "settingsShape"
export const API_MODEL_ID_FIELD = "apiModelId"

// Treat a persisted `null` as an unset value. Previously persisted or imported
// profiles may store `null` for these fields; converting `null` to `undefined`
// before validation keeps the inferred type as `NonNull<T> | undefined` (so
// consumers don't need to handle `null`) while ensuring the whole profile is not
// dropped during per-profile `safeParse` in ProviderSettingsManager.load().
//
// The argument is a nullish schema (accepts `null` and `undefined`). At runtime we
// map `null` to `undefined` before validation; the return type strips `null` from
// the output because it can never survive the preprocessing step.
const nullableOptional = <Schema extends z.ZodTypeAny>(schema: Schema) =>
	z.preprocess((value) => (value === null ? undefined : value), schema) as unknown as z.ZodType<
		Exclude<z.infer<Schema>, null>,
		z.ZodTypeDef,
		z.input<Schema>
	>

export const baseProviderSettingsShape = {
	includeMaxTokens: z.boolean().optional(),
	todoListEnabled: z.boolean().optional(),
	modelTemperature: z.number().nullish(),
	rateLimitSeconds: z.number().optional(),
	consecutiveMistakeLimit: nullableOptional(z.number().min(0).nullish()),
	toolRepetitionSoftLimit: nullableOptional(z.number().min(0).nullish()),
	enableReasoningEffort: z.boolean().optional(),
	reasoningEffort: reasoningEffortSettingSchema.optional(),
	modelMaxTokens: z.number().optional(),
	modelMaxThinkingTokens: z.number().optional(),
	verbosity: verbosityLevelsSchema.optional(),
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
