import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"

import { useOpenRouterModelProviders } from "../useOpenRouterModelProviders"

// --- transport seam (phase 2: fetch) -----------------------------------------
// Only this block changed between phase 1 (axios) and phase 2 (fetch). Every
// assertion below is shared by both phases, so the unchanged green run is the
// behavior-preservation proof.
type TransportCall = { url: string; method: string; headers: Record<string, string> }
type TransportResult = { status: number; body: unknown; jsonRejects?: Error }

const stubTransport = (handler: (call: TransportCall) => TransportResult | Promise<TransportResult>) => {
	const calls: TransportCall[] = []

	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string, init?: RequestInit) => {
		const call: TransportCall = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: { ...((init?.headers ?? {}) as Record<string, string>) },
		}
		calls.push(call)
		const result = await handler(call)

		return {
			ok: result.status >= 200 && result.status < 300,
			status: result.status,
			json: async () => {
				if (result.jsonRejects) {
					throw result.jsonRejects
				}
				return result.body
			},
		} as Response
	}) as typeof fetch)

	return { calls }
}
// -----------------------------------------------------------------------------

const endpointsPayload = (overrides: Record<string, unknown> = {}) => ({
	data: {
		id: "vendor/model",
		name: "Vendor Model",
		description: "A test model",
		architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
		endpoints: [
			{
				name: "Provider A",
				tag: "provider-a",
				context_length: 128000,
				max_completion_tokens: 4096,
				pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
			},
			{
				name: "Provider B",
				context_length: 32000,
				pricing: { prompt: "0.000001", completion: "0.000002" },
			},
		],
		...overrides,
	},
})

const wrapper = ({ children }: React.PropsWithChildren) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		{children}
	</QueryClientProvider>
)

describe("useOpenRouterModelProviders", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("returns an empty record without a request when modelId is missing", async () => {
		const { calls } = stubTransport(() => ({ status: 200, body: endpointsPayload() }))

		const { result } = renderHook(() => useOpenRouterModelProviders(undefined), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual({})
		expect(calls).toHaveLength(0)
	})

	it("requests the endpoints URL and maps each endpoint to provider model info", async () => {
		const { calls } = stubTransport(() => ({ status: 200, body: endpointsPayload() }))

		const { result } = renderHook(() => useOpenRouterModelProviders("vendor/model"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(calls).toEqual([
			{ url: "https://openrouter.ai/api/v1/models/vendor/model/endpoints", method: "GET", headers: {} },
		])

		expect(result.current.data).toEqual({
			"provider-a": {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsImages: true,
				supportsPromptCache: true,
				cacheReadsPrice: 0.3,
				cacheWritesPrice: undefined,
				inputPrice: 3,
				outputPrice: 15,
				description: "A test model",
				label: "provider-a",
			},
			"Provider B": {
				maxTokens: 32000,
				contextWindow: 32000,
				supportsImages: true,
				supportsPromptCache: false,
				cacheReadsPrice: undefined,
				cacheWritesPrice: undefined,
				inputPrice: 1,
				outputPrice: 2,
				description: "A test model",
				label: "Provider B",
			},
		})
	})

	it("uses a caller-supplied baseUrl", async () => {
		const { calls } = stubTransport(() => ({ status: 200, body: endpointsPayload() }))

		const { result } = renderHook(
			() => useOpenRouterModelProviders("vendor/model", "https://proxy.example.com/api/v1"),
			{ wrapper },
		)

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(calls[0].url).toBe("https://proxy.example.com/api/v1/models/vendor/model/endpoints")
	})

	it("returns no providers for image-generation models", async () => {
		stubTransport(() => ({
			status: 200,
			body: endpointsPayload({ architecture: { input_modalities: ["text"], output_modalities: ["image"] } }),
		}))

		const { result } = renderHook(() => useOpenRouterModelProviders("vendor/model"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual({})
	})

	it("logs a validation failure and returns no providers when the payload does not match the schema", async () => {
		stubTransport(() => ({ status: 200, body: { data: { id: "vendor/model" } } }))
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useOpenRouterModelProviders("vendor/model"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual({})
		expect(consoleError).toHaveBeenCalledWith("OpenRouter API response validation failed:", expect.anything())
	})

	it("logs a fetch failure and returns no providers when the response is not 2xx", async () => {
		stubTransport(() => ({ status: 500, body: { error: "boom" } }))
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useOpenRouterModelProviders("vendor/model"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual({})
		expect(consoleError).toHaveBeenCalledWith("Error fetching OpenRouter providers:", expect.anything())
	})

	it("logs a fetch failure and returns no providers when the request rejects", async () => {
		const failure = new Error("network down")
		stubTransport(() => {
			throw failure
		})
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useOpenRouterModelProviders("vendor/model"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual({})
		expect(consoleError).toHaveBeenCalledWith("Error fetching OpenRouter providers:", failure)
	})

	it("logs a fetch failure and returns no providers when a 2xx body is not valid JSON", async () => {
		const parseFailure = new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON")
		stubTransport(() => ({ status: 200, body: undefined, jsonRejects: parseFailure }))
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useOpenRouterModelProviders("vendor/model"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual({})
		expect(consoleError).toHaveBeenCalledWith("Error fetching OpenRouter providers:", parseFailure)
	})
})
