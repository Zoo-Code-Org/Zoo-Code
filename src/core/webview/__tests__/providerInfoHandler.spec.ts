import type { WebviewMessage } from "@roo-code/types"

import type { ClineProvider } from "../ClineProvider"
import { getOpenRouterModelEndpoints } from "../../../api/providers/fetchers/openrouter"
import { handleRequestProviderInfo } from "../providerInfoHandler"

vi.mock("../../../api/providers/fetchers/openrouter", () => ({ getOpenRouterModelEndpoints: vi.fn() }))

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

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe("handleRequestProviderInfo", () => {
	const postMessageToWebview = vi.fn()
	const provider = { postMessageToWebview, log: vi.fn() } as unknown as ClineProvider // Only these two members are used.
	let fetchSpy: ReturnType<typeof vi.spyOn>

	const send = (values: WebviewMessage["values"]) =>
		handleRequestProviderInfo(provider, { type: "requestProviderInfo", requestId: "req-1", values })

	beforeEach(() => {
		postMessageToWebview.mockReset()
		vi.mocked(getOpenRouterModelEndpoints).mockReset()
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

	it("fetches Requesty key info from a custom base URL with auth headers", async () => {
		fetchSpy.mockResolvedValue(jsonResponse(REQUESTY_KEY_INFO))

		await send({ kind: "requestyKeyInfo", apiKey: "rk", baseUrl: "https://router.custom.example/v1" })

		const [url, init] = fetchSpy.mock.calls[0]!
		expect(url).not.toBe("https://api.requesty.ai/x/apikey")
		expect(String(url)).toMatch(/^https:\/\/[^/]*custom\.example\/.*x\/apikey$/)
		expect(init).toMatchObject({
			headers: { Authorization: "Bearer rk", "Content-Type": "application/json" },
		})
	})

	it("returns no providers and sends no request without a modelId", async () => {
		await send({ kind: "openRouterModelProviders" })

		expect(fetchSpy).not.toHaveBeenCalled()
		expect(getOpenRouterModelEndpoints).not.toHaveBeenCalled()
		expect(postMessageToWebview.mock.calls[0]![0].values).toEqual({ data: {} })
	})

	it("passes an abort signal with the request", async () => {
		fetchSpy.mockResolvedValue(jsonResponse({ data: KEY_INFO }))

		await send({ kind: "openRouterKeyInfo", apiKey: "k" })

		expect(fetchSpy.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal)
	})

	it("delegates OpenRouter model providers to the shared endpoint fetcher", async () => {
		const providers = { "provider-a": { contextWindow: 128000, supportsPromptCache: true } }
		vi.mocked(getOpenRouterModelEndpoints).mockResolvedValue(providers)

		await send({ kind: "openRouterModelProviders", modelId: "openai/gpt-4o", baseUrl: "https://proxy.test/v1" })

		expect(getOpenRouterModelEndpoints).toHaveBeenCalledWith(
			"openai/gpt-4o",
			{ openRouterBaseUrl: "https://proxy.test/v1" },
			{ untrustedBaseUrl: true, timeoutMs: 10_000 },
		)
		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "providerInfo",
			requestId: "req-1",
			values: { data: { "provider-a": { ...providers["provider-a"], label: "provider-a" } } },
		})
	})

	it.each([
		["openRouterKeyInfo", { apiKey: "k" }, { data: { label: 1 } }, null],
		["requestyKeyInfo", { apiKey: "k" }, { name: 1 }, null],
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

	it("accepts a body of exactly the size cap and rejects one byte more", async () => {
		const MAX = 1024 * 1024
		const padded = (bytes: number) => {
			const head = '{"data":null,"pad":"'
			const tail = '"}'
			return head + "a".repeat(bytes - head.length - tail.length) + tail
		}

		fetchSpy.mockResolvedValueOnce(new Response(padded(MAX), { status: 200 }))
		await send({ kind: "openRouterKeyInfo", apiKey: "k" })
		expect(postMessageToWebview.mock.calls[0]![0].error).toBeUndefined()

		fetchSpy.mockResolvedValueOnce(new Response(padded(MAX + 1), { status: 200 }))
		await send({ kind: "openRouterKeyInfo", apiKey: "k" })
		expect(postMessageToWebview.mock.calls[1]![0].error).toBe("Provider info request failed")
	})

	it.each([
		["a failed status", () => jsonResponse({}, 401)],
		["a non-JSON 2xx body", () => new Response("<html>", { status: 200 })],
		["a rejected fetch", () => Promise.reject(new Error("https://secret.example.com/key refused"))],
	])("posts a generic error that leaks no URL on %s", async (_name, makeResponse) => {
		fetchSpy.mockImplementation(async () => makeResponse())

		await send({ kind: "openRouterKeyInfo", apiKey: "k", baseUrl: "https://secret.example.com" })

		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "providerInfo",
			requestId: "req-1",
			error: "Provider info request failed",
		})
		const logged = JSON.stringify([vi.mocked(provider.log).mock.calls, vi.mocked(console.error).mock.calls])
		expect(logged).not.toContain("secret.example.com")
	})

	it.each([
		["apiKey", 5],
		["baseUrl", {}],
		["modelId", ["m"]],
	])("rejects a non-string %s without a request", async (field, value) => {
		await send({ kind: "openRouterKeyInfo", [field]: value })

		expect(fetchSpy).not.toHaveBeenCalled()
		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "providerInfo",
			requestId: "req-1",
			error: "Invalid provider info request",
		})
	})

	it.each([undefined, "unknown", "__proto__", "constructor"])("rejects unknown kind %s", async (kind) => {
		await send({ kind })

		expect(fetchSpy).not.toHaveBeenCalled()
		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "providerInfo",
			requestId: "req-1",
			error: "Invalid provider info request",
		})
	})
})
