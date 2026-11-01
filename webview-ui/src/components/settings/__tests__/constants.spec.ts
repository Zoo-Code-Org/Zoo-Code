import { getProviderLabel, providerIdentifiers } from "@roo-code/types"

import { PROVIDERS } from "../constants"

describe("PROVIDERS", () => {
	it("derives every label from the provider definition", () => {
		for (const { value, label } of PROVIDERS) {
			expect(label).toBe(getProviderLabel(value as Parameters<typeof getProviderLabel>[0]))
		}
	})

	it("keeps the labels the settings UI shows for well-known providers", () => {
		const labelsByValue = new Map(PROVIDERS.map(({ value, label }) => [value, label]))

		expect(labelsByValue.get(providerIdentifiers.anthropic)).toBe("Anthropic")
		expect(labelsByValue.get(providerIdentifiers.bedrock)).toBe("Amazon Bedrock")
		expect(labelsByValue.get(providerIdentifiers.gemini)).toBe("Google Gemini")
		expect(labelsByValue.get(providerIdentifiers.openaiCodex)).toBe("OpenAI - ChatGPT Plus/Pro")
		expect(labelsByValue.get(providerIdentifiers.openai)).toBe("OpenAI Compatible")
		expect(labelsByValue.get(providerIdentifiers.fireworks)).toBe("Fireworks AI")
	})

	it("sorts providers by label", () => {
		const labels = PROVIDERS.map(({ label }) => label)

		expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)))
	})

	it("marks only the user-configured proxy providers as proxy", () => {
		const proxyValues = PROVIDERS.filter(({ proxy }) => proxy).map(({ value }) => value)

		expect(new Set(proxyValues)).toEqual(
			new Set([
				providerIdentifiers.openai,
				providerIdentifiers.lmstudio,
				providerIdentifiers.ollama,
				providerIdentifiers.litellm,
			]),
		)
	})
})
