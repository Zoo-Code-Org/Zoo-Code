// npx vitest run api/providers/__tests__/model-catalog-adapters.spec.ts

// Real-handler coverage for the model-catalog adapter surface: each dynamic-catalog
// provider must declare the correct cache scope and forward the right arguments to
// its fetcher. Only the fetcher modules are mocked; handlers are constructed for real.

import { providerIdentifiers, type ModelRecord } from "@roo-code/types"

import type { GetModelsOptions } from "../../../shared/api"
import type { ApiHandler, ModelCacheScope } from "../../index"

const fetchers = vi.hoisted(() => ({
	getDeepSeekModels: vi.fn(),
	getIOIntelligenceModels: vi.fn(),
	getKenariModels: vi.fn(),
	getKimiCodeModels: vi.fn(),
	getLiteLLMModels: vi.fn(),
	getLMStudioModels: vi.fn(),
	getMoonshotModels: vi.fn(),
	getNanoGptModels: vi.fn(),
	getOllamaModels: vi.fn(),
	getOpencodeGoModels: vi.fn(),
	getOpenRouterModels: vi.fn(),
	getPoeModels: vi.fn(),
	getRequestyModels: vi.fn(),
	getUnboundModels: vi.fn(),
	getVercelAiGatewayModels: vi.fn(),
	getZooGatewayModels: vi.fn(),
}))

// The pre-warm hook reaches the fetcher either directly (fetchModel) or through
// getModels(). Delegating to the handler's own fetchModels keeps the fetcher
// call counts in this file meaningful and avoids touching the real disk cache.
const modelCache = vi.hoisted(() => ({
	getModels: vi.fn(),
	getModelsFromCache: vi.fn(),
}))

vi.mock("../fetchers/modelCache", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/modelCache")>()),
	getModels: modelCache.getModels,
	getModelsFromCache: modelCache.getModelsFromCache,
}))

vi.mock("../fetchers/deepseek", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/deepseek")>()),
	getDeepSeekModels: fetchers.getDeepSeekModels,
}))
vi.mock("../fetchers/io-intelligence", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/io-intelligence")>()),
	getIOIntelligenceModels: fetchers.getIOIntelligenceModels,
}))
vi.mock("../fetchers/kenari", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/kenari")>()),
	getKenariModels: fetchers.getKenariModels,
}))
vi.mock("../fetchers/kimi-code", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/kimi-code")>()),
	getKimiCodeModels: fetchers.getKimiCodeModels,
}))
vi.mock("../fetchers/litellm", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/litellm")>()),
	getLiteLLMModels: fetchers.getLiteLLMModels,
}))
vi.mock("../fetchers/lmstudio", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/lmstudio")>()),
	getLMStudioModels: fetchers.getLMStudioModels,
}))
vi.mock("../fetchers/moonshot", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/moonshot")>()),
	getMoonshotModels: fetchers.getMoonshotModels,
}))
vi.mock("../fetchers/nanogpt", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/nanogpt")>()),
	getNanoGptModels: fetchers.getNanoGptModels,
}))
vi.mock("../fetchers/ollama", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/ollama")>()),
	getOllamaModels: fetchers.getOllamaModels,
}))
vi.mock("../fetchers/opencode-go", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/opencode-go")>()),
	getOpencodeGoModels: fetchers.getOpencodeGoModels,
}))
vi.mock("../fetchers/openrouter", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/openrouter")>()),
	getOpenRouterModels: fetchers.getOpenRouterModels,
}))
vi.mock("../fetchers/poe", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/poe")>()),
	getPoeModels: fetchers.getPoeModels,
}))
vi.mock("../fetchers/requesty", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/requesty")>()),
	getRequestyModels: fetchers.getRequestyModels,
}))
vi.mock("../fetchers/unbound", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/unbound")>()),
	getUnboundModels: fetchers.getUnboundModels,
}))
vi.mock("../fetchers/vercel-ai-gateway", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/vercel-ai-gateway")>()),
	getVercelAiGatewayModels: fetchers.getVercelAiGatewayModels,
}))
vi.mock("../fetchers/zoo-gateway", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fetchers/zoo-gateway")>()),
	getZooGatewayModels: fetchers.getZooGatewayModels,
}))

import { AnthropicHandler } from "../anthropic"
import { DeepSeekHandler } from "../deepseek"
import { IOIntelligenceHandler } from "../io-intelligence"
import { KenariHandler } from "../kenari"
import { KimiCodeHandler } from "../kimi-code"
import { LiteLLMHandler } from "../lite-llm"
import { LmStudioHandler } from "../lm-studio"
import { MoonshotHandler } from "../moonshot"
import { NanoGptHandler } from "../nanogpt"
import { NativeOllamaHandler } from "../native-ollama"
import { OpencodeGoHandler } from "../opencode-go"
import { OpenRouterHandler } from "../openrouter"
import { PoeHandler } from "../poe"
import { RequestyHandler } from "../requesty"
import { UnboundHandler } from "../unbound"
import { VercelAiGatewayHandler } from "../vercel-ai-gateway"
import { ZooGatewayHandler } from "../zoo-gateway"

const BASE_URL = "https://catalog.example.com/v1"
const API_KEY = "catalog-key"
const CATALOG: ModelRecord = {
	"test-model": { maxTokens: 1024, contextWindow: 8192, supportsPromptCache: false },
}

interface AdapterCase {
	name: string
	create: () => ApiHandler
	fetcher: keyof typeof fetchers
	scope: ModelCacheScope
	/** Positional arguments expected before the optional `{ signal }` options bag. */
	expectedArgs: unknown[]
	/** Whether the adapter forwards an AbortSignal to its fetcher. */
	forwardsSignal: boolean
	/** Whether the handler implements the ensureModelFetched pre-warm hook. */
	prewarms: boolean
}

const cases: AdapterCase[] = [
	{
		name: "DeepSeek",
		create: () => new DeepSeekHandler({ deepSeekApiKey: API_KEY }),
		fetcher: "getDeepSeekModels",
		scope: { urlScoped: true, keyScoped: false, authScoped: false },
		expectedArgs: [BASE_URL, API_KEY],
		forwardsSignal: true,
		prewarms: false,
	},
	{
		name: "IO Intelligence",
		create: () => new IOIntelligenceHandler({ ioIntelligenceApiKey: API_KEY }),
		fetcher: "getIOIntelligenceModels",
		scope: { urlScoped: false, keyScoped: true, authScoped: false },
		expectedArgs: [API_KEY],
		forwardsSignal: true,
		prewarms: false,
	},
	{
		name: "Kenari",
		create: () => new KenariHandler({ kenariApiKey: API_KEY }),
		fetcher: "getKenariModels",
		scope: { urlScoped: false, keyScoped: false, authScoped: false },
		expectedArgs: [API_KEY],
		forwardsSignal: true,
		prewarms: false,
	},
	{
		name: "Kimi Code",
		create: () => new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: API_KEY }),
		fetcher: "getKimiCodeModels",
		scope: { urlScoped: false, keyScoped: true, authScoped: true },
		expectedArgs: [API_KEY],
		forwardsSignal: false,
		prewarms: false,
	},
	{
		name: "LiteLLM",
		create: () => new LiteLLMHandler({ litellmApiKey: API_KEY, litellmBaseUrl: BASE_URL }),
		fetcher: "getLiteLLMModels",
		scope: { urlScoped: true, keyScoped: true, authScoped: false },
		expectedArgs: [API_KEY, BASE_URL],
		forwardsSignal: true,
		prewarms: false,
	},
	{
		name: "LM Studio",
		create: () => new LmStudioHandler({ lmStudioBaseUrl: BASE_URL }),
		fetcher: "getLMStudioModels",
		scope: { urlScoped: true, keyScoped: false, authScoped: false },
		expectedArgs: [BASE_URL],
		forwardsSignal: true,
		prewarms: true,
	},
	{
		name: "Moonshot",
		create: () => new MoonshotHandler({ moonshotApiKey: API_KEY }),
		fetcher: "getMoonshotModels",
		scope: { urlScoped: true, keyScoped: true, authScoped: false },
		expectedArgs: [BASE_URL, API_KEY],
		forwardsSignal: true,
		prewarms: false,
	},
	{
		name: "NanoGPT",
		create: () => new NanoGptHandler({ nanoGptApiKey: API_KEY }),
		fetcher: "getNanoGptModels",
		scope: { urlScoped: false, keyScoped: true, authScoped: false },
		expectedArgs: [API_KEY],
		forwardsSignal: true,
		prewarms: false,
	},
	{
		name: "Ollama",
		create: () => new NativeOllamaHandler({ ollamaBaseUrl: BASE_URL }),
		fetcher: "getOllamaModels",
		scope: { urlScoped: true, keyScoped: false, authScoped: false },
		expectedArgs: [BASE_URL, API_KEY],
		forwardsSignal: true,
		prewarms: true,
	},
	{
		name: "OpenCode Go",
		create: () => new OpencodeGoHandler({ opencodeGoApiKey: API_KEY }),
		fetcher: "getOpencodeGoModels",
		scope: { urlScoped: false, keyScoped: false, authScoped: false },
		expectedArgs: [API_KEY],
		forwardsSignal: true,
		prewarms: false,
	},
	{
		name: "OpenRouter",
		create: () => new OpenRouterHandler({ openRouterApiKey: API_KEY }),
		fetcher: "getOpenRouterModels",
		scope: { urlScoped: false, keyScoped: false, authScoped: false },
		expectedArgs: [undefined],
		forwardsSignal: true,
		prewarms: true,
	},
	{
		name: "Poe",
		create: () => new PoeHandler({ poeApiKey: API_KEY }),
		fetcher: "getPoeModels",
		scope: { urlScoped: true, keyScoped: true, authScoped: false },
		expectedArgs: [API_KEY, BASE_URL],
		forwardsSignal: true,
		prewarms: true,
	},
	{
		name: "Requesty",
		create: () => new RequestyHandler({ requestyApiKey: API_KEY }),
		fetcher: "getRequestyModels",
		scope: { urlScoped: true, keyScoped: true, authScoped: false },
		expectedArgs: [BASE_URL, API_KEY],
		forwardsSignal: true,
		prewarms: true,
	},
	{
		name: "Unbound",
		create: () => new UnboundHandler({ unboundApiKey: API_KEY }),
		fetcher: "getUnboundModels",
		scope: { urlScoped: false, keyScoped: false, authScoped: false },
		expectedArgs: [API_KEY],
		forwardsSignal: true,
		prewarms: true,
	},
	{
		name: "Vercel AI Gateway",
		create: () => new VercelAiGatewayHandler({ vercelAiGatewayApiKey: API_KEY }),
		fetcher: "getVercelAiGatewayModels",
		scope: { urlScoped: false, keyScoped: false, authScoped: false },
		expectedArgs: [undefined],
		forwardsSignal: true,
		prewarms: false,
	},
	{
		name: "Zoo Gateway",
		create: () => new ZooGatewayHandler({ zooSessionToken: API_KEY }),
		fetcher: "getZooGatewayModels",
		scope: { urlScoped: true, keyScoped: true, authScoped: true },
		expectedArgs: [{ zooSessionToken: API_KEY, zooGatewayBaseUrl: BASE_URL }],
		forwardsSignal: false,
		prewarms: false,
	},
]

describe("model catalog adapters", () => {
	const options: GetModelsOptions = { provider: providerIdentifiers.litellm, baseUrl: BASE_URL, apiKey: API_KEY }

	beforeEach(() => {
		for (const fetcher of Object.values(fetchers)) {
			fetcher.mockReset()
			fetcher.mockResolvedValue(CATALOG)
		}

		modelCache.getModels.mockReset()
		modelCache.getModels.mockImplementation((opts: GetModelsOptions, handler: ApiHandler) =>
			handler.fetchModels!(opts),
		)
		modelCache.getModelsFromCache.mockReset()
		modelCache.getModelsFromCache.mockReturnValue(undefined)
	})

	describe.each(cases)("$name", ({ create, fetcher, scope, expectedArgs, forwardsSignal, prewarms }) => {
		it("declares its model cache scope", () => {
			expect(create().getModelCacheScope()).toEqual(scope)
		})

		it("forwards fetch arguments without a signal", async () => {
			const handler = create()

			await expect(handler.fetchModels?.(options)).resolves.toBe(CATALOG)

			expect(fetchers[fetcher]).toHaveBeenCalledTimes(1)
			expect(fetchers[fetcher]).toHaveBeenCalledWith(...expectedArgs)
		})

		it(
			forwardsSignal ? "forwards the abort signal to its fetcher" : "does not forward an abort signal",
			async () => {
				const handler = create()
				const signal = new AbortController().signal

				await expect(handler.fetchModels?.(options, signal)).resolves.toBe(CATALOG)

				const expected = forwardsSignal ? [...expectedArgs, { signal }] : expectedArgs
				expect(fetchers[fetcher]).toHaveBeenCalledWith(...expected)
			},
		)

		it("propagates fetcher failures", async () => {
			fetchers[fetcher].mockRejectedValueOnce(new Error("catalog unavailable"))

			await expect(create().fetchModels?.(options)).rejects.toThrow("catalog unavailable")
		})

		if (prewarms) {
			it("implements the ensureModelFetched pre-warm hook", () => {
				expect(create().ensureModelFetched).toBeTypeOf("function")
			})
		}
	})

	describe.each(cases.filter(({ prewarms }) => prewarms))("$name pre-warm", ({ create, fetcher }) => {
		it("memoizes a successful load", async () => {
			const handler = create()

			await handler.ensureModelFetched!()
			await handler.ensureModelFetched!()

			expect(fetchers[fetcher]).toHaveBeenCalledTimes(1)
		})

		it("retries a failed load on the next call", async () => {
			const handler = create()
			fetchers[fetcher].mockRejectedValueOnce(new Error("catalog unavailable"))

			await expect(handler.ensureModelFetched!()).rejects.toThrow("catalog unavailable")
			await expect(handler.ensureModelFetched!()).resolves.toBeUndefined()

			expect(fetchers[fetcher]).toHaveBeenCalledTimes(2)
		})

		it("retries when the provider returns an empty catalog", async () => {
			const handler = create()
			// getModels() deliberately does not cache an empty response, so the
			// pre-warm must not memoize it either -- otherwise the handler would be
			// pinned to the fallback model info for the rest of its lifetime.
			fetchers[fetcher].mockResolvedValueOnce({})

			await handler.ensureModelFetched!()
			expect(fetchers[fetcher]).toHaveBeenCalledTimes(1)

			await handler.ensureModelFetched!()
			expect(fetchers[fetcher]).toHaveBeenCalledTimes(2)

			// The second response was non-empty, so it is memoized.
			await handler.ensureModelFetched!()
			expect(fetchers[fetcher]).toHaveBeenCalledTimes(2)
		})

		it("single-flights concurrent calls", async () => {
			const handler = create()

			await Promise.all([handler.ensureModelFetched!(), handler.ensureModelFetched!()])

			expect(fetchers[fetcher]).toHaveBeenCalledTimes(1)
		})

		it("rejects a pre-aborted caller without fetching", async () => {
			const handler = create()
			const controller = new AbortController()
			controller.abort(new Error("caller gave up"))

			await expect(handler.ensureModelFetched!(controller.signal)).rejects.toThrow("caller gave up")
			expect(fetchers[fetcher]).not.toHaveBeenCalled()
		})

		it("detaches only the aborted waiter while the shared fetch still settles", async () => {
			const handler = create()
			let settle: (models: ModelRecord) => void = () => {}
			fetchers[fetcher].mockImplementation(
				() =>
					new Promise<ModelRecord>((resolve) => {
						settle = resolve
					}),
			)

			const controller = new AbortController()
			const wait = handler.ensureModelFetched!(controller.signal)
			controller.abort(new Error("caller gave up"))

			await expect(wait).rejects.toThrow("caller gave up")

			settle(CATALOG)
			// Let the shared load's promise chain settle (load -> .then -> .finally).
			await new Promise((resolve) => setTimeout(resolve, 0))

			// The load completed despite the detached waiter, so the next call
			// is a memoized no-op rather than a second fetch.
			await expect(handler.ensureModelFetched!()).resolves.toBeUndefined()
			expect(fetchers[fetcher]).toHaveBeenCalledTimes(1)
		})
	})

	it("defaults to an unscoped cache and no catalog fetcher for static providers", () => {
		const handler: ApiHandler = new AnthropicHandler({ apiKey: API_KEY })

		expect(handler.getModelCacheScope()).toEqual({ urlScoped: false, keyScoped: false, authScoped: false })
		expect(handler.fetchModels).toBeUndefined()
		expect(handler.ensureModelFetched).toBeUndefined()
	})
})
