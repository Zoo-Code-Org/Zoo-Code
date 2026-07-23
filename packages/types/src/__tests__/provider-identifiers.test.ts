import {
	isProviderName,
	isRetiredProvider,
	providerIdentifiers,
	providerNames,
	providerNamesSchema,
	providerNamesWithRetiredSchema,
	retiredProviderIdentifiers,
	retiredProviderNames,
	retiredProviderNamesSchema,
} from "../index.js"

const expectedProviderIdentifiers = [
	"openrouter",
	"vercel-ai-gateway",
	"zoo-gateway",
	"litellm",
	"requesty",
	"unbound",
	"poe",
	"deepseek",
	"opencode-go",
	"kenari",
	"ollama",
	"lmstudio",
	"vscode-lm",
	"openai",
	"fake-ai",
	"anthropic",
	"bedrock",
	"baseten",
	"fireworks",
	"friendli",
	"gemini",
	"gemini-cli",
	"mistral",
	"moonshot",
	"minimax",
	"mimo",
	"openai-codex",
	"openai-native",
	"qwen-code",
	"sambanova",
	"vertex",
	"xai",
	"zai",
]

const expectedRetiredProviderIdentifiers = [
	"cerebras",
	"chutes",
	"deepinfra",
	"doubao",
	"featherless",
	"groq",
	"huggingface",
	"io-intelligence",
	"roo",
]

describe("provider identifiers", () => {
	it("preserves active provider serialized values", () => {
		const identifiers = Object.values(providerIdentifiers)

		expect(identifiers).toEqual(expectedProviderIdentifiers)
		expect(new Set(identifiers).size).toBe(identifiers.length)
	})

	it("preserves retired provider serialized values", () => {
		const identifiers = Object.values(retiredProviderIdentifiers)

		expect(identifiers).toEqual(expectedRetiredProviderIdentifiers)
		expect(new Set(identifiers).size).toBe(identifiers.length)
	})

	it("preserves provider-settings compatibility exports", () => {
		const identifiers = Object.values(providerIdentifiers)
		const retiredIdentifiers = Object.values(retiredProviderIdentifiers)

		expect(providerNames).toEqual(identifiers)
		expect(retiredProviderNames).toEqual(retiredIdentifiers)
	})

	it("keeps active and retired providers separate", () => {
		const activeIdentifiers = new Set<string>(Object.values(providerIdentifiers))
		const retiredIdentifiers = Object.values(retiredProviderIdentifiers)

		expect(retiredIdentifiers.every((identifier) => !activeIdentifiers.has(identifier))).toBe(true)
	})

	it("derives runtime validation from the canonical registries", () => {
		for (const identifier of expectedProviderIdentifiers) {
			expect(providerNamesSchema.safeParse(identifier).success).toBe(true)
			expect(providerNamesWithRetiredSchema.safeParse(identifier).success).toBe(true)
		}

		for (const identifier of expectedRetiredProviderIdentifiers) {
			expect(providerNamesSchema.safeParse(identifier).success).toBe(false)
			expect(retiredProviderNamesSchema.safeParse(identifier).success).toBe(true)
			expect(providerNamesWithRetiredSchema.safeParse(identifier).success).toBe(true)
		}

		expect(providerNamesSchema.safeParse("unknown-provider").success).toBe(false)
		expect(retiredProviderNamesSchema.safeParse("unknown-provider").success).toBe(false)
		expect(providerNamesWithRetiredSchema.safeParse("unknown-provider").success).toBe(false)
	})

	it("preserves provider-settings type guards", () => {
		for (const identifier of expectedProviderIdentifiers) {
			expect(isProviderName(identifier)).toBe(true)
			expect(isRetiredProvider(identifier)).toBe(false)
		}

		for (const identifier of expectedRetiredProviderIdentifiers) {
			expect(isProviderName(identifier)).toBe(false)
			expect(isRetiredProvider(identifier)).toBe(true)
		}

		expect(isProviderName("unknown-provider")).toBe(false)
		expect(isProviderName(undefined)).toBe(false)
		expect(isRetiredProvider("unknown-provider")).toBe(false)
	})
})
