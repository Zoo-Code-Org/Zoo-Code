import { providerIdentifiers, retiredProviderIdentifiers, type ProviderSettings } from "@roo-code/types"

import * as providerModelConfig from "@/components/settings/utils/providerModelConfig"

import { createModelPatch } from "../profileModelPatches"

const resets = {
	reasoningEffort: null,
	enableReasoningEffort: null,
	modelMaxTokens: null,
	modelMaxThinkingTokens: null,
}

describe("createModelPatch", () => {
	afterEach(() => vi.restoreAllMocks())

	it.each(Object.values(retiredProviderIdentifiers))("rejects retired provider %s", (apiProvider) => {
		expect(() => createModelPatch({ apiProvider }, "model")).toThrow("A supported provider is required")
	})

	it("rejects a provider with no model configuration", () => {
		vi.spyOn(providerModelConfig, "getProviderModelConfig").mockReturnValue(undefined)
		expect(() => createModelPatch({}, "model")).toThrow("supported provider")
	})

	it("preserves non-empty side effect values in partial patches", () => {
		vi.spyOn(providerModelConfig, "handleModelChangeSideEffects").mockImplementation((_provider, _id, set) => {
			set("reasoningEffort", "high")
		})
		expect(createModelPatch({}, "model")).toEqual({
			openRouterModelId: "model",
			enableReasoningEffort: null,
			reasoningEffort: "high",
		})
	})
	it.each([
		{ provider: providerIdentifiers.anthropic, field: "apiModelId" },
		{ provider: providerIdentifiers.openrouter, field: "openRouterModelId" },
		{ provider: providerIdentifiers.requesty, field: "requestyModelId" },
		{ provider: providerIdentifiers.nanogpt, field: "nanoGptModelId" },
	] as const)("uses the shared model field for $provider", ({ provider, field }) => {
		const config: ProviderSettings = {
			apiProvider: provider,
			apiKey: "secret",
			modelMaxTokens: 120,
			reasoningEffort: "high",
			enableReasoningEffort: false,
		}
		const before = structuredClone(config)
		expect(createModelPatch(config, "new-model")).toEqual({ [field]: "new-model", ...resets })
		expect(config).toEqual(before)
	})

	it("matches the picker provider default", () => {
		expect(createModelPatch({}, "new-model")).toEqual({ openRouterModelId: "new-model", ...resets })
	})

	it("clears only the nested OpenAI reasoning effort", () => {
		expect(createModelPatch({ apiProvider: providerIdentifiers.openai }, "custom")).toEqual({
			openAiModelId: "custom",
			...resets,
			openAiCustomModelInfo: { reasoningEffort: null },
		})
	})

	it("converts all Bedrock side-effect clears to null", () => {
		expect(
			createModelPatch({ apiProvider: providerIdentifiers.bedrock, awsCustomArn: "arn:old" }, "new-model"),
		).toEqual({
			apiModelId: "new-model",
			...resets,
			awsCustomArn: null,
			awsCustomArnBaseModelId: null,
			awsModelContextWindow: null,
		})
	})

	it("allows an existing Bedrock custom ARN without patching its metadata", () => {
		expect(
			createModelPatch({ apiProvider: providerIdentifiers.bedrock, awsCustomArn: "arn:existing" }, "custom-arn"),
		).toEqual({ apiModelId: "custom-arn", ...resets })
	})

	it.each(["custom-arn", "arn:aws:bedrock:custom", "  arn:aws:bedrock:custom  "])(
		"rejects a Bedrock selection requiring new ARN settings: %s",
		(id) => {
			expect(() => createModelPatch({ apiProvider: providerIdentifiers.bedrock }, id)).toThrow("Settings")
		},
	)

	it.each(["", "   "])("rejects an empty model ID", (id) => {
		expect(() => createModelPatch({}, id)).toThrow("non-empty")
	})

	it("rejects compound providers without a scalar model field", () => {
		expect(() => createModelPatch({ apiProvider: providerIdentifiers.vscodeLm }, "model")).toThrow(
			"supported provider",
		)
	})
})
