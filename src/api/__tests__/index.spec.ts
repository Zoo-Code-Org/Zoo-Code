// npx vitest run src/api/__tests__/index.spec.ts

// Mock vscode first to avoid import errors
vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}))

// Handler constructors can require credentials or initialize SDK clients. Replace them
// with inert classes so these tests exercise only the factory's routing behavior.
vitest.mock("../providers", async () => {
	const providers = await vitest.importActual<Record<string, unknown>>("../providers")

	return Object.fromEntries(Object.keys(providers).map((name) => [name, class {}]))
})

vitest.mock("../providers/native-ollama", () => ({
	NativeOllamaHandler: class {},
}))

import {
	providerIdentifiers,
	retiredProviderIdentifiers,
	type ProviderName,
	type ProviderNameWithRetired,
} from "@roo-code/types"

import { buildApiHandler } from "../index"
import {
	AnthropicHandler,
	AnthropicVertexHandler,
	AwsBedrockHandler,
	BasetenHandler,
	DeepSeekHandler,
	FakeAIHandler,
	FireworksHandler,
	FriendliHandler,
	GeminiHandler,
	KenariHandler,
	KimiCodeHandler,
	LiteLLMHandler,
	LmStudioHandler,
	MiniMaxHandler,
	MimoHandler,
	MistralHandler,
	MoonshotHandler,
	NanoGptHandler,
	OpenAiCodexHandler,
	OpenAiHandler,
	OpenAiNativeHandler,
	OpencodeGoHandler,
	OpenRouterHandler,
	PoeHandler,
	QwenCodeHandler,
	RequestyHandler,
	SambaNovaHandler,
	UnboundHandler,
	VercelAiGatewayHandler,
	VertexHandler,
	VsCodeLmHandler,
	XAIHandler,
	ZAiHandler,
	ZooGatewayHandler,
} from "../providers"
import { NativeOllamaHandler } from "../providers/native-ollama"

type HandlerConstructor = new (...args: never[]) => object

const expectedHandlers = {
	[providerIdentifiers.anthropic]: AnthropicHandler,
	[providerIdentifiers.openrouter]: OpenRouterHandler,
	[providerIdentifiers.bedrock]: AwsBedrockHandler,
	[providerIdentifiers.openai]: OpenAiHandler,
	[providerIdentifiers.ollama]: NativeOllamaHandler,
	[providerIdentifiers.lmstudio]: LmStudioHandler,
	[providerIdentifiers.gemini]: GeminiHandler,
	// Gemini CLI currently relies on the factory's default Anthropic handler.
	[providerIdentifiers.geminiCli]: AnthropicHandler,
	[providerIdentifiers.openaiCodex]: OpenAiCodexHandler,
	[providerIdentifiers.openaiNative]: OpenAiNativeHandler,
	[providerIdentifiers.deepseek]: DeepSeekHandler,
	[providerIdentifiers.qwenCode]: QwenCodeHandler,
	[providerIdentifiers.moonshot]: MoonshotHandler,
	[providerIdentifiers.kimiCode]: KimiCodeHandler,
	[providerIdentifiers.vscodeLm]: VsCodeLmHandler,
	[providerIdentifiers.mistral]: MistralHandler,
	[providerIdentifiers.requesty]: RequestyHandler,
	[providerIdentifiers.unbound]: UnboundHandler,
	[providerIdentifiers.fakeAi]: FakeAIHandler,
	[providerIdentifiers.xai]: XAIHandler,
	[providerIdentifiers.litellm]: LiteLLMHandler,
	[providerIdentifiers.sambanova]: SambaNovaHandler,
	[providerIdentifiers.mimo]: MimoHandler,
	[providerIdentifiers.zai]: ZAiHandler,
	[providerIdentifiers.fireworks]: FireworksHandler,
	[providerIdentifiers.friendli]: FriendliHandler,
	[providerIdentifiers.vercelAiGateway]: VercelAiGatewayHandler,
	[providerIdentifiers.opencodeGo]: OpencodeGoHandler,
	[providerIdentifiers.kenari]: KenariHandler,
	[providerIdentifiers.nanogpt]: NanoGptHandler,
	[providerIdentifiers.zooGateway]: ZooGatewayHandler,
	[providerIdentifiers.minimax]: MiniMaxHandler,
	[providerIdentifiers.baseten]: BasetenHandler,
	[providerIdentifiers.poe]: PoeHandler,
} satisfies Record<Exclude<ProviderName, typeof providerIdentifiers.vertex>, HandlerConstructor>

const expectedHandlerEntries = Object.entries(expectedHandlers) as Array<
	[Exclude<ProviderName, typeof providerIdentifiers.vertex>, HandlerConstructor]
>

describe("buildApiHandler", () => {
	it.each(expectedHandlerEntries)("returns the expected handler for %s", (apiProvider, Handler) => {
		const handler = buildApiHandler({ apiProvider })

		expect(handler).toBeInstanceOf(Handler)
	})

	it.each([
		["an unspecified model", undefined, VertexHandler],
		["non-Claude models", "non-claude-test-model", VertexHandler],
		["Claude models", "claude-test-model", AnthropicVertexHandler],
	] as const)("returns the expected Vertex handler for %s", (_description, apiModelId, Handler) => {
		const handler = buildApiHandler({
			apiProvider: providerIdentifiers.vertex,
			apiModelId,
		})

		expect(handler).toBeInstanceOf(Handler)
	})

	it("preserves the dedicated removal error for the retired Roo provider", () => {
		expect(() =>
			buildApiHandler({
				apiProvider: retiredProviderIdentifiers.roo,
			}),
		).toThrow("Roo Code Router has been removed")
	})

	it("rejects other retired providers", () => {
		expect(() =>
			buildApiHandler({
				apiProvider: retiredProviderIdentifiers.cerebras,
			}),
		).toThrow("this provider is no longer supported")
	})

	it("falls back to Anthropic for an unsupported provider value", () => {
		const handler = buildApiHandler({
			apiProvider: "unsupported-provider" as ProviderNameWithRetired,
		})

		expect(handler).toBeInstanceOf(AnthropicHandler)
	})
})
