import type { ProviderName } from "../provider-settings.js"

vi.mock("../provider-identifiers.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../provider-identifiers.js")>()

	return {
		...actual,
		providerIdentifiers: {
			...actual.providerIdentifiers,
			openrouter: "canonical-openrouter-test-value",
		},
	}
})

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	anthropicDefaultModelId,
	getZAiDefaultModelId,
	internationalZAiDefaultModelId,
	kimiCodeDefaultModelId,
	mainlandZAiDefaultModelId,
	openAiNativeDefaultModelId,
	openRouterDefaultModelId,
	vscodeLlmDefaultModelId,
	zooGatewayDefaultModelId,
} from "../providers/index.js"
import { getProviderDefaultModelId } from "../provider-settings.js"

const zaiApiLineCases = [
	["china_coding", "china"],
	["china_api", "china"],
	["international_coding", "international"],
	["international_api", "international"],
] as const

describe("getProviderDefaultModelId", () => {
	it("selects a static default through the canonical provider identifier", () => {
		expect(getProviderDefaultModelId(providerIdentifiers.openrouter as ProviderName, {})).toBe(
			openRouterDefaultModelId,
		)
	})

	it("triangulates static selection with another provider category", () => {
		expect(getProviderDefaultModelId(providerIdentifiers.vscodeLm, {})).toBe(vscodeLlmDefaultModelId)
	})

	it("gives GitHub Copilot the same default as the VS Code LM provider", () => {
		expect(getProviderDefaultModelId(providerIdentifiers.githubCopilot, {})).toBe(vscodeLlmDefaultModelId)
	})

	it("uses the canonical OpenAI Native default model", () => {
		expect(getProviderDefaultModelId(providerIdentifiers.openaiNative, {})).toBe(openAiNativeDefaultModelId)
	})

	it.each([
		[providerIdentifiers.kimiCode, kimiCodeDefaultModelId],
		[providerIdentifiers.zooGateway, zooGatewayDefaultModelId],
	])("preserves the %s default added on main", (provider, expectedModelId) => {
		expect(getProviderDefaultModelId(provider, {})).toBe(expectedModelId)
	})

	it.each(zaiApiLineCases)("resolves the %s Z.ai default through the provider definition", (zaiApiLine, region) => {
		const expected = region === "china" ? mainlandZAiDefaultModelId : internationalZAiDefaultModelId

		expect(getProviderDefaultModelId(providerIdentifiers.zai, { zaiApiLine })).toBe(expected)
	})

	it("falls back to the international Z.ai default when the API line is unset", () => {
		expect(getProviderDefaultModelId(providerIdentifiers.zai, {})).toBe(internationalZAiDefaultModelId)
	})

	describe("Z.ai region mapping", () => {
		// Both regional catalogs currently share a default model ID, so inject
		// distinct values to prove the mainland/international arms are not swapped.
		const distinctDefaults = { china: "test-china-model", international: "test-international-model" }

		it.each(zaiApiLineCases)("maps %s to the %s default", (zaiApiLine, region) => {
			expect(getZAiDefaultModelId(zaiApiLine, distinctDefaults)).toBe(distinctDefaults[region])
		})

		it.each([undefined, null, "bogus"])(
			"falls back to the international default for the invalid API line %s",
			(zaiApiLine) => {
				expect(getZAiDefaultModelId(zaiApiLine, distinctDefaults)).toBe(distinctDefaults.international)
			},
		)
	})

	it.each([providerIdentifiers.openai, providerIdentifiers.ollama, providerIdentifiers.lmstudio])(
		"returns an empty default for custom or locally selected models from %s",
		(provider) => {
			expect(getProviderDefaultModelId(provider, {})).toBe("")
		},
	)

	it.each([providerIdentifiers.anthropic, providerIdentifiers.geminiCli, providerIdentifiers.fakeAi])(
		"preserves the Anthropic fallback for %s",
		(provider) => {
			expect(getProviderDefaultModelId(provider, {})).toBe(anthropicDefaultModelId)
		},
	)
})
