import {
	modelIdKeys,
	openAiModelInfoSaneDefaults,
	providerDefinitionList,
	providerIdentifiers,
	reasoningEffortSettingValues,
	reasoningEffortsExtended,
	type ProviderDefinition,
	type ProviderSettings,
} from "@roo-code/types"

import { mergeProfileModelPatch } from "../profileModelPatch"

const stored: ProviderSettings = {
	apiProvider: providerIdentifiers.openrouter,
	openRouterModelId: "old-model",
	openRouterApiKey: "secret",
	rateLimitSeconds: 5,
	reasoningEffort: "high",
	enableReasoningEffort: true,
}

const customInfo = {
	...openAiModelInfoSaneDefaults,
	contextWindow: 12345,
	description: "Keep custom metadata",
	supportsReasoningEffort: true,
	inputPrice: 0.25,
	reasoningEffort: "low",
} satisfies NonNullable<ProviderSettings["openAiCustomModelInfo"]>

describe("mergeProfileModelPatch", () => {
	it.each<ProviderDefinition>(providerDefinitionList)(
		"only permits the primary model field for $apiProvider",
		(definition) => {
			const profile: ProviderSettings = { apiProvider: definition.apiProvider }
			for (const key of modelIdKeys) {
				const merge = () => mergeProfileModelPatch(profile, definition.apiProvider, { [key]: "new-model" })
				if (key === definition.modelIdKey) expect(merge()).toMatchObject({ [key]: "new-model" })
				else expect(merge).toThrow()
			}
		},
	)

	it.each(reasoningEffortSettingValues)(
		"accepts top-level effort %s without changing the model",
		(reasoningEffort) => {
			const merged = mergeProfileModelPatch(stored, providerIdentifiers.openrouter, { reasoningEffort })
			expect(merged).toEqual({ ...stored, reasoningEffort })
			expect(stored.reasoningEffort).toBe("high")
		},
	)

	it.each([true, false])("accepts enableReasoningEffort=%s", (enableReasoningEffort) => {
		expect(mergeProfileModelPatch(stored, providerIdentifiers.openrouter, { enableReasoningEffort })).toEqual({
			...stored,
			enableReasoningEffort,
		})
	})

	it.each([null, undefined])("clears controls and reset-only fields using %s", (value) => {
		const profile: ProviderSettings = {
			...stored,
			modelMaxTokens: 10,
			modelMaxThinkingTokens: 5,
			awsCustomArn: "existing-arn",
			awsCustomArnBaseModelId: "base-model",
			awsModelContextWindow: 100,
		}
		const keys = [
			"reasoningEffort",
			"enableReasoningEffort",
			"modelMaxTokens",
			"modelMaxThinkingTokens",
			"awsCustomArn",
			"awsCustomArnBaseModelId",
			"awsModelContextWindow",
		]
		const patch = Object.fromEntries(keys.map((key) => [key, value]))
		const merged = mergeProfileModelPatch(profile, providerIdentifiers.openrouter, patch)
		for (const key of keys) expect(merged).not.toHaveProperty(key)
		expect(profile).toHaveProperty("awsCustomArn", "existing-arn")
	})

	it.each(reasoningEffortsExtended)(
		"merges nested effort %s without replacing custom metadata",
		(reasoningEffort) => {
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				openAiCustomModelInfo: Object.freeze({ ...customInfo }),
			}
			const merged = mergeProfileModelPatch(Object.freeze(profile), providerIdentifiers.openai, {
				openAiCustomModelInfo: { reasoningEffort },
			})
			expect(merged.openAiCustomModelInfo).toEqual({ ...customInfo, reasoningEffort })
			expect(profile.openAiCustomModelInfo?.reasoningEffort).toBe("low")
		},
	)

	it.each([null, undefined])("clears only the nested effort using %s", (reasoningEffort) => {
		const { reasoningEffort: _effort, ...rest } = customInfo
		const merged = mergeProfileModelPatch(
			{ apiProvider: providerIdentifiers.openai, openAiCustomModelInfo: customInfo },
			providerIdentifiers.openai,
			{ openAiCustomModelInfo: { reasoningEffort } },
		)
		expect(merged.openAiCustomModelInfo).toEqual(rest)
	})

	it.each([null, undefined])("uses existing sane defaults when nested metadata is %s", (openAiCustomModelInfo) => {
		const profile: ProviderSettings = { apiProvider: providerIdentifiers.openai, openAiCustomModelInfo }
		expect(
			mergeProfileModelPatch(profile, providerIdentifiers.openai, {
				openAiCustomModelInfo: { reasoningEffort: "high" },
			}).openAiCustomModelInfo,
		).toEqual({ ...openAiModelInfoSaneDefaults, reasoningEffort: "high" })
		expect(
			mergeProfileModelPatch(profile, providerIdentifiers.openai, {
				openAiCustomModelInfo: { reasoningEffort: null },
			}).openAiCustomModelInfo,
		).toBe(openAiCustomModelInfo)
	})

	it.each([null, undefined, [], "patch", 1, false])("rejects non-object patches: %s", (patch) => {
		expect(() => mergeProfileModelPatch(stored, providerIdentifiers.openrouter, patch)).toThrow()
	})

	it.each([
		{ openRouterModelId: "" },
		{ openRouterModelId: "  " },
		{ openRouterModelId: 1 },
		{ openRouterModelId: null },
		{ openRouterModelId: undefined },
		{ reasoningEffort: "invalid" },
		{ reasoningEffort: 1 },
		{ reasoningEffort: false },
		{ reasoningEffort: {} },
		{ enableReasoningEffort: "false" },
		{ enableReasoningEffort: 0 },
		{ enableReasoningEffort: [] },
		{ apiProvider: providerIdentifiers.openai },
		{ openRouterApiKey: "replacement" },
		{ openAiApiKey: "replacement" },
		{ rateLimitSeconds: 1 },
		{ modelTemperature: 0.5 },
		{ modelMaxTokens: 1 },
		{ modelMaxThinkingTokens: 1 },
		{ awsCustomArn: "new-arn" },
		{ awsCustomArnBaseModelId: "new-model" },
		{ awsModelContextWindow: 1 },
		{ openAiCustomModelInfo: { reasoningEffort: "high" } },
	])("rejects invalid or restricted fields: %j", (patch) => {
		expect(() => mergeProfileModelPatch(stored, providerIdentifiers.openrouter, patch)).toThrow()
	})

	it.each([
		null,
		undefined,
		[],
		"high",
		{ reasoningEffort: "disable" },
		{ reasoningEffort: "invalid" },
		{ reasoningEffort: 1 },
		{ reasoningEffort: false },
		{ reasoningEffort: "high", contextWindow: 1 },
		{ reasoningEffort: "high", openAiApiKey: "secret" },
		{ supportsReasoningEffort: false },
	])("rejects unsafe custom metadata patches: %j", (openAiCustomModelInfo) => {
		expect(() =>
			mergeProfileModelPatch({ apiProvider: providerIdentifiers.openai }, providerIdentifiers.openai, {
				openAiCustomModelInfo,
			}),
		).toThrow()
	})

	it("rejects a mismatched or unsupported provider and resolves an unset provider to anthropic", () => {
		expect(() => mergeProfileModelPatch(stored, providerIdentifiers.openai, {})).toThrow()
		expect(() => mergeProfileModelPatch(stored, "unknown", {})).toThrow()
		expect(mergeProfileModelPatch({}, providerIdentifiers.anthropic, { apiModelId: "claude" })).toEqual({
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude",
		})
	})

	it("keeps empty patches as no-ops without clearing custom metadata", () => {
		expect(mergeProfileModelPatch(stored, providerIdentifiers.openrouter, {})).toEqual(stored)
		const profile: ProviderSettings = { apiProvider: providerIdentifiers.openai, openAiCustomModelInfo: customInfo }
		expect(mergeProfileModelPatch(profile, providerIdentifiers.openai, { openAiCustomModelInfo: {} })).toEqual(
			profile,
		)
	})

	it("preserves Bedrock ARN defenses for model and reasoning-only changes", () => {
		const profile: ProviderSettings = {
			apiProvider: providerIdentifiers.bedrock,
			apiModelId: "custom-arn",
			awsCustomArn: "stored-arn",
			awsCustomArnBaseModelId: "base-model",
			awsModelContextWindow: 100,
		}
		expect(mergeProfileModelPatch(profile, providerIdentifiers.bedrock, { reasoningEffort: "high" })).toEqual({
			...profile,
			reasoningEffort: "high",
		})
		const merged = mergeProfileModelPatch(profile, providerIdentifiers.bedrock, { apiModelId: "catalog-model" })
		expect(merged).not.toHaveProperty("awsCustomArn")
		expect(merged).not.toHaveProperty("awsCustomArnBaseModelId")
		expect(merged).not.toHaveProperty("awsModelContextWindow")
		expect(() => mergeProfileModelPatch(profile, providerIdentifiers.bedrock, { awsCustomArn: null })).toThrow()
		expect(() =>
			mergeProfileModelPatch({ apiProvider: providerIdentifiers.bedrock }, providerIdentifiers.bedrock, {
				apiModelId: "custom-arn",
			}),
		).toThrow()
	})
})
