import { renderHook, waitFor } from "@testing-library/react"
import { QueryClientProvider } from "@tanstack/react-query"
import React from "react"

import { createTestQueryClient, stubTransport } from "@src/utils/test-utils"

import { useOpenRouterModelProviders } from "../useOpenRouterModelProviders"

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
				pricing: {
					prompt: "0.000003",
					completion: "0.000015",
					input_cache_read: "0.0000003",
					input_cache_write: "0.0000036",
				},
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
	<QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
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
				cacheWritesPrice: expect.closeTo(3.6, 10),
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

	it.each([
		{ name: "text-only architecture", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
		{ name: "omitted architecture", architecture: undefined },
	])("disables image support for $name", async ({ architecture }) => {
		stubTransport(() => ({ status: 200, body: endpointsPayload({ architecture }) }))

		const { result } = renderHook(() => useOpenRouterModelProviders("vendor/model"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toMatchObject({
			"provider-a": { supportsImages: false },
			"Provider B": { supportsImages: false },
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
		expect(consoleError).toHaveBeenCalledWith(
			"OpenRouter API response validation failed:",
			expect.objectContaining({
				issues: expect.arrayContaining([expect.objectContaining({ path: ["data", "endpoints"] })]),
			}),
		)
	})

	it("logs a fetch failure and returns no providers when the response is not 2xx", async () => {
		stubTransport(() => ({ status: 500, body: { error: "boom" } }))
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useOpenRouterModelProviders("vendor/model"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual({})
		expect(consoleError).toHaveBeenCalledWith(
			"Error fetching OpenRouter providers:",
			expect.objectContaining({ message: "Request failed with status code 500" }),
		)
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
