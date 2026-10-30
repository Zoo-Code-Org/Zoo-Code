import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"

import { useRequestyKeyInfo } from "../useRequestyKeyInfo"

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
	name: "my-key",
	monthly_limit: "20",
	monthly_spend: "1.25",
	org_balance: "18.75",
	config: { aliases: { "gpt-4o": "openai/gpt-4o" } },
}

const wrapper = ({ children }: React.PropsWithChildren) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		{children}
	</QueryClientProvider>
)

describe("useRequestyKeyInfo", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("returns undefined and issues no request when apiKey is missing", async () => {
		const { calls } = stubTransport(() => ({ status: 200, body: KEY_INFO }))
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useRequestyKeyInfo(undefined, undefined), { wrapper })

		await waitFor(() => expect(result.current.fetchStatus).toBe("idle"))
		expect(result.current.data).toBeUndefined()
		expect(calls).toHaveLength(0)
		expect(consoleError).not.toHaveBeenCalled()
	})

	it("requests the default api key endpoint with bearer auth and returns the parsed key info", async () => {
		const { calls } = stubTransport(() => ({ status: 200, body: KEY_INFO }))

		const { result } = renderHook(() => useRequestyKeyInfo(undefined, "test-key"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(KEY_INFO)
		expect(calls).toEqual([
			{
				url: "https://api.requesty.ai/x/apikey",
				method: "GET",
				headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
			},
		])
	})

	it("keeps a caller-supplied host that does not contain 'router' and drops the version suffix", async () => {
		const { calls } = stubTransport(() => ({ status: 200, body: KEY_INFO }))

		const { result } = renderHook(() => useRequestyKeyInfo("https://custom.requesty.ai/v1", "test-key"), {
			wrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(calls[0].url).toBe("https://custom.requesty.ai/x/apikey")
	})

	it("returns null and logs a validation failure when the payload does not match the schema", async () => {
		stubTransport(() => ({ status: 200, body: { name: "my-key" } }))
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useRequestyKeyInfo(undefined, "test-key"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
		expect(consoleError).toHaveBeenCalledWith(
			"Requesty API key info validation failed:",
			expect.objectContaining({
				issues: expect.arrayContaining([expect.objectContaining({ path: ["monthly_limit"] })]),
			}),
		)
	})

	it("returns null and logs a fetch failure when the response is not 2xx", async () => {
		stubTransport(() => ({ status: 403, body: { detail: "forbidden" } }))
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useRequestyKeyInfo(undefined, "test-key"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
		expect(consoleError).toHaveBeenCalledWith(
			"Error fetching Requesty key info:",
			expect.objectContaining({ message: "Request failed with status code 403" }),
		)
	})

	it("returns null and logs a fetch failure when the request rejects", async () => {
		const failure = new Error("network down")
		stubTransport(() => {
			throw failure
		})
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useRequestyKeyInfo(undefined, "test-key"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
		expect(consoleError).toHaveBeenCalledWith("Error fetching Requesty key info:", failure)
	})

	it("returns null and logs a fetch failure when a 2xx body is not valid JSON", async () => {
		const parseFailure = new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON")
		stubTransport(() => ({ status: 200, body: undefined, jsonRejects: parseFailure }))
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useRequestyKeyInfo(undefined, "test-key"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
		expect(consoleError).toHaveBeenCalledWith("Error fetching Requesty key info:", parseFailure)
	})
})
