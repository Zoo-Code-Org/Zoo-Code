import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"

import { useOpenRouterKeyInfo } from "../useOpenRouterKeyInfo"

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

const KEY_INFO = {
	label: "sk-or-v1-...abc",
	usage: 12.5,
	is_free_tier: false,
	is_provisioning_key: false,
	rate_limit: { requests: 60, interval: "1m" },
	limit: 100,
}

const wrapper = ({ children }: React.PropsWithChildren) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		{children}
	</QueryClientProvider>
)

describe("useOpenRouterKeyInfo", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("returns undefined and issues no request when apiKey is missing", async () => {
		const { calls } = stubTransport(() => ({ status: 200, body: { data: KEY_INFO } }))
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useOpenRouterKeyInfo(undefined), { wrapper })

		await waitFor(() => expect(result.current.fetchStatus).toBe("idle"))
		expect(result.current.data).toBeUndefined()
		expect(calls).toHaveLength(0)
		expect(consoleError).not.toHaveBeenCalled()
	})

	it("requests the default key endpoint with a bearer token and returns the parsed key info", async () => {
		const { calls } = stubTransport(() => ({ status: 200, body: { data: KEY_INFO } }))

		const { result } = renderHook(() => useOpenRouterKeyInfo("sk-or-v1-test"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(KEY_INFO)
		expect(calls).toEqual([
			{
				url: "https://openrouter.ai/api/v1/key",
				method: "GET",
				headers: { Authorization: "Bearer sk-or-v1-test" },
			},
		])
	})

	it("uses a caller-supplied baseUrl verbatim", async () => {
		const { calls } = stubTransport(() => ({ status: 200, body: { data: KEY_INFO } }))

		const { result } = renderHook(() => useOpenRouterKeyInfo("sk-or-v1-test", "https://proxy.example.com/api/v1"), {
			wrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(calls[0].url).toBe("https://proxy.example.com/api/v1/key")
	})

	it("returns null and logs a validation failure when the payload does not match the schema", async () => {
		stubTransport(() => ({ status: 200, body: { data: { label: "only-label" } } }))
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useOpenRouterKeyInfo("sk-or-v1-test"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
		expect(consoleError).toHaveBeenCalledWith(
			"OpenRouter API key info validation failed:",
			expect.objectContaining({
				issues: expect.arrayContaining([expect.objectContaining({ path: ["data", "usage"] })]),
			}),
		)
	})

	it("returns null and logs a fetch failure when the response is not 2xx", async () => {
		stubTransport(() => ({ status: 401, body: { error: { message: "No auth credentials found" } } }))
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useOpenRouterKeyInfo("sk-or-v1-test"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
		expect(consoleError).toHaveBeenCalledWith(
			"Error fetching OpenRouter key info:",
			expect.objectContaining({ message: "Request failed with status code 401" }),
		)
	})

	it("returns null and logs a fetch failure when the request rejects", async () => {
		const failure = new Error("network down")
		stubTransport(() => {
			throw failure
		})
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useOpenRouterKeyInfo("sk-or-v1-test"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
		expect(consoleError).toHaveBeenCalledWith("Error fetching OpenRouter key info:", failure)
	})

	it("returns null and logs a fetch failure when a 2xx body is not valid JSON", async () => {
		const parseFailure = new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON")
		stubTransport(() => ({ status: 200, body: undefined, jsonRejects: parseFailure }))
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useOpenRouterKeyInfo("sk-or-v1-test"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
		expect(consoleError).toHaveBeenCalledWith("Error fetching OpenRouter key info:", parseFailure)
	})
})
