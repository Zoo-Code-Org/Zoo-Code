import type { WebviewMessage } from "@roo-code/types"

import type { ClineProvider } from "../ClineProvider"
import { handleRequestProviderInfo } from "../providerInfoHandler"

const KEY_INFO = {
	label: "sk-or-v1-...abc",
	usage: 12.5,
	is_free_tier: false,
	is_provisioning_key: false,
	rate_limit: { requests: 60, interval: "1m" },
	limit: 100,
}

const REQUESTY_KEY_INFO = {
	name: "key",
	monthly_limit: "100",
	monthly_spend: "5",
	org_balance: "95",
	config: {},
}

const ENDPOINTS = {
	data: {
		id: "openai/gpt-4o",
		name: "GPT-4o",
		description: "desc",
		architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
		endpoints: [
			{
				name: "OpenAI | gpt-4o",
				tag: "openai",
				context_length: 128000,
				max_completion_tokens: 16384,
				pricing: { prompt: "0.000005", completion: "0.000015", input_cache_read: "0.0000025" },
			},
		],
	},
}

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe("handleRequestProviderInfo", () => {
	const postMessageToWebview = vi.fn()
	const provider = { postMessageToWebview, log: vi.fn() } as unknown as ClineProvider // Only these two members are used.
	let fetchSpy: ReturnType<typeof vi.spyOn>

	const send = (values: WebviewMessage["values"]) =>
		handleRequestProviderInfo(provider, { type: "requestProviderInfo", requestId: "req-1", values })

	beforeEach(() => {
		postMessageToWebview.mockReset()
		fetchSpy = vi.spyOn(globalThis, "fetch")
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("fetches OpenRouter key info from the default endpoint with a bearer token", async () => {
		fetchSpy.mockResolvedValue(jsonResponse({ data: KEY_INFO }))

		await send({ kind: "openRouterKeyInfo", apiKey: "sk-or-v1-test" })

		expect(fetchSpy.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/key")
		expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: "Bearer sk-or-v1-test" } })
		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "providerInfo",
			requestId: "req-1",
			values: { data: KEY_INFO },
		})
	})

	it("uses a caller-supplied OpenRouter base URL", async () => {
		fetchSpy.mockResolvedValue(jsonResponse({ data: KEY_INFO }))

		await send({ kind: "openRouterKeyInfo", apiKey: "k", baseUrl: "https://proxy.example.com/api/v1" })

		expect(fetchSpy.mock.calls[0]![0]).toBe("https://proxy.example.com/api/v1/key")
	})

	it.each(["openRouterKeyInfo", "requestyKeyInfo"])(
		"returns null without a request when %s has no apiKey",
		async (kind) => {
			await send({ kind })

			expect(fetchSpy).not.toHaveBeenCalled()
			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "providerInfo",
				requestId: "req-1",
				values: { data: null },
			})
		},
	)

	it("fetches Requesty key info from the api service URL", async () => {
		fetchSpy.mockResolvedValue(jsonResponse(REQUESTY_KEY_INFO))

		await send({ kind: "requestyKeyInfo", apiKey: "rk" })

		expect(fetchSpy.mock.calls[0]![0]).toBe("https://api.requesty.ai/x/apikey")
		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "providerInfo",
			requestId: "req-1",
			values: { data: REQUESTY_KEY_INFO },
		})
	})

	it("maps OpenRouter endpoints to model info keyed by provider tag", async () => {
		fetchSpy.mockResolvedValue(jsonResponse(ENDPOINTS))

		await send({ kind: "openRouterModelProviders", modelId: "openai/gpt-4o" })

		expect(fetchSpy.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/models/openai/gpt-4o/endpoints")
		const { values } = postMessageToWebview.mock.calls[0]![0]
		expect(values.data.openai).toMatchObject({
			label: "openai",
			maxTokens: 16384,
			contextWindow: 128000,
			supportsImages: true,
			supportsPromptCache: true,
			inputPrice: 5,
			outputPrice: 15,
			cacheReadsPrice: 2.5,
		})
	})

	it("keys an untagged endpoint by its name next to a tagged one", async () => {
		const [tagged] = ENDPOINTS.data.endpoints
		const untagged = { name: "Provider B", context_length: 32000, pricing: { prompt: "0.000001" } }
		fetchSpy.mockResolvedValue(jsonResponse({ data: { ...ENDPOINTS.data, endpoints: [tagged, untagged] } }))

		await send({ kind: "openRouterModelProviders", modelId: "openai/gpt-4o" })

		const { values } = postMessageToWebview.mock.calls[0]![0]
		expect(Object.keys(values.data)).toEqual(["openai", "Provider B"])
		expect(values.data["Provider B"]).toMatchObject({
			label: "Provider B",
			maxTokens: 32000,
			contextWindow: 32000,
			inputPrice: 1,
			supportsPromptCache: false,
		})
	})

	it("returns no providers for an image-output model", async () => {
		const body = { data: { ...ENDPOINTS.data, architecture: { output_modalities: ["image"] } } }
		fetchSpy.mockResolvedValue(jsonResponse(body))

		await send({ kind: "openRouterModelProviders", modelId: "m" })

		expect(postMessageToWebview.mock.calls[0]![0].values).toEqual({ data: {} })
	})

	it.each([
		["openRouterKeyInfo", { apiKey: "k" }, { data: { label: 1 } }, null],
		["requestyKeyInfo", { apiKey: "k" }, { name: 1 }, null],
		["openRouterModelProviders", { modelId: "m" }, { data: { id: "m" } }, {}],
	])("returns the fallback and logs when %s gets a schema-invalid body", async (kind, params, body, fallback) => {
		fetchSpy.mockResolvedValue(jsonResponse(body))

		await send({ kind, ...params })

		expect(postMessageToWebview.mock.calls[0]![0].values).toEqual({ data: fallback })
		expect(console.error).toHaveBeenCalled()
	})

	it("rejects a response body above the size cap", async () => {
		const cancel = vi.fn()
		const oversized = new ReadableStream<Uint8Array>({
			pull: (controller) => controller.enqueue(new Uint8Array(512 * 1024)),
			cancel,
		})
		fetchSpy.mockResolvedValue(new Response(oversized, { status: 200 }))

		await send({ kind: "openRouterKeyInfo", apiKey: "k" })

		expect(cancel).toHaveBeenCalled()
		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "providerInfo",
			requestId: "req-1",
			error: "Provider info request failed",
		})
	})

	it("posts an error without the configured URL when the request fails", async () => {
		fetchSpy.mockResolvedValue(jsonResponse({}, 401))

		await send({ kind: "openRouterKeyInfo", apiKey: "k", baseUrl: "https://secret.example.com" })

		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "providerInfo",
			requestId: "req-1",
			error: "Provider info request failed",
		})
	})

	it.each([undefined, "unknown", "__proto__", "constructor"])("rejects unknown kind %s", async (kind) => {
		await send({ kind })

		expect(fetchSpy).not.toHaveBeenCalled()
		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "providerInfo",
			requestId: "req-1",
			error: "Unknown provider info kind",
		})
	})
})
