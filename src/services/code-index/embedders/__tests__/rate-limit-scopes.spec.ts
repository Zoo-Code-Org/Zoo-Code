import "../../__tests__/mock-code-index-log"
import { OpenAiEmbedder } from "../openai"
import { OpenAICompatibleEmbedder } from "../openai-compatible"
import { OpenRouterEmbedder } from "../openrouter"
import { GeminiEmbedder } from "../gemini"
import { MistralEmbedder } from "../mistral"
import { VercelAiGatewayEmbedder } from "../vercel-ai-gateway"
import { CodeIndexOllamaEmbedder } from "../ollama"
import { BedrockEmbedder } from "../bedrock"
import { ProviderPacerRegistry } from "../../provider-pacer"

vi.mock("../../../../api/providers/openai-native", () => ({
	OpenAiNativeHandler: class {
		constructor(protected options: unknown) {}
	},
}))
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({ BedrockRuntimeClient: vi.fn(), InvokeModelCommand: vi.fn() }))
vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))

const factories = [
	["openai", (key: string) => new OpenAiEmbedder({ openAiNativeApiKey: key })],
	["openai-compatible", (key: string) => new OpenAICompatibleEmbedder("https://example.test/v1", key)],
	["openrouter", (key: string) => new OpenRouterEmbedder(key)],
	["gemini", (key: string) => new GeminiEmbedder(key)],
	["mistral", (key: string) => new MistralEmbedder(key)],
	["vercel-ai-gateway", (key: string) => new VercelAiGatewayEmbedder(key)],
] as const

it.each(factories)("%s shares identical allowances and isolates credentials", (provider, createEmbedder) => {
	const first = createEmbedder("first-secret")
	const recreated = createEmbedder("first-secret")
	const other = createEmbedder("second-secret")
	expect(first.rateLimitScope).toMatch(new RegExp(`^${provider}:[a-f0-9]{64}$`))
	expect(first.rateLimitScope).toBe(recreated.rateLimitScope)
	expect(first.rateLimitScope).not.toBe(other.rateLimitScope)
	expect(first.rateLimitScope).not.toContain("first-secret")
	const registry = new ProviderPacerRegistry()
	expect(registry.get(first.rateLimitScope)).toBe(registry.get(recreated.rateLimitScope))
	expect(registry.get(first.rateLimitScope)).not.toBe(registry.get(other.rateLimitScope))
})

it("normalizes equivalent URLs while isolating different endpoints", () => {
	const first = new OpenAICompatibleEmbedder("https://EXAMPLE.test:443/v1/", "key")
	const same = new OpenAICompatibleEmbedder("https://example.test/v1", "key")
	const other = new OpenAICompatibleEmbedder("https://example.test/v2", "key")
	expect(first.rateLimitScope).toBe(same.rateLimitScope)
	expect(first.rateLimitScope).not.toBe(other.rateLimitScope)
})

it("Ollama scopes depend only on the normalized endpoint", () => {
	const first = new CodeIndexOllamaEmbedder({ ollamaBaseUrl: "http://LOCALHOST:11434/" })
	const same = new CodeIndexOllamaEmbedder({ ollamaModelId: "another-model" })
	const other = new CodeIndexOllamaEmbedder({ ollamaBaseUrl: "http://localhost:11435" })
	expect(first.rateLimitScope).toBe(same.rateLimitScope)
	expect(first.rateLimitScope).not.toBe(other.rateLimitScope)
})

it("Bedrock isolates region and profile, not model", () => {
	const first = new BedrockEmbedder("us-east-1", "profile")
	expect(first.rateLimitScope).toBe(new BedrockEmbedder("us-east-1", "profile", "other-model").rateLimitScope)
	expect(first.rateLimitScope).not.toBe(new BedrockEmbedder("us-west-2", "profile").rateLimitScope)
	expect(first.rateLimitScope).not.toBe(new BedrockEmbedder("us-east-1", "other-profile").rateLimitScope)
	expect(first.rateLimitScope).toMatch(/^bedrock:[a-f0-9]{64}$/)
	expect(first.rateLimitScope).not.toContain("profile")
})

it("wrapped providers retain their own provider identity", () => {
	const gemini = new GeminiEmbedder("key")
	const compatible = new OpenAICompatibleEmbedder("https://generativelanguage.googleapis.com/v1beta/openai/", "key")
	expect(gemini.rateLimitScope).not.toBe(compatible.rateLimitScope)
})
