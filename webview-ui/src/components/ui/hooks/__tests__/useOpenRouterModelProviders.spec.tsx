import React from "react"
import axios from "axios"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { z } from "zod"

import { useOpenRouterModelProviders } from "../useOpenRouterModelProviders"

vi.mock("axios")

const wrapper = ({ children }: React.PropsWithChildren) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		{children}
	</QueryClientProvider>
)

describe("useOpenRouterModelProviders", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("logs the zod issues and returns no providers when validation throws", async () => {
		const zodError = new z.ZodError([{ code: "custom", path: ["data"], message: "bad data" }])
		vi.mocked(axios.get).mockRejectedValue(zodError)
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useOpenRouterModelProviders("vendor/model"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual({})
		expect(consoleError).toHaveBeenCalledWith("OpenRouter API response validation failed:", zodError.issues)
	})

	it("logs other errors and returns no providers", async () => {
		const failure = new Error("network down")
		vi.mocked(axios.get).mockRejectedValue(failure)
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(() => useOpenRouterModelProviders("vendor/model"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual({})
		expect(consoleError).toHaveBeenCalledWith("Error fetching OpenRouter providers:", failure)
	})
})
