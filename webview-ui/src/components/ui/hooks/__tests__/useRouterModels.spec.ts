// npx vitest src/components/ui/hooks/__tests__/useRouterModels.spec.ts

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"

import { RouterModelsMessageType, providerIdentifiers, type RouterModels } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

import { fetchRouterModels, useRouterModels } from "../useRouterModels"

const modelInfo = {
	maxTokens: 8192,
	contextWindow: 200_000,
	supportsImages: false,
	supportsPromptCache: false,
}

// Test fixtures intentionally carry a single provider key; RouterModels requires
// every provider key, so cast through unknown for these partial literals.
const asRouterModels = (value: Record<string, Record<string, typeof modelInfo>>) => value as unknown as RouterModels

const respondWithRouterModels = (routerModels: RouterModels, provider?: string) => {
	window.dispatchEvent(
		new MessageEvent("message", {
			data: {
				type: RouterModelsMessageType.routerModels,
				routerModels,
				values: provider ? { provider } : undefined,
			},
		}),
	)
}

const makeQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

const makeWrapper = (queryClient: QueryClient) => {
	return ({ children }: { children: React.ReactNode }) =>
		React.createElement(QueryClientProvider, { client: queryClient }, children)
}

describe("fetchRouterModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("posts a provider request and resolves with the matching response", async () => {
		const removeSpy = vi.spyOn(window, "removeEventListener")
		const routerModels = asRouterModels({ openrouter: { "model-a": modelInfo } })

		const promise = fetchRouterModels(providerIdentifiers.openrouter)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.openrouter },
		})

		respondWithRouterModels(routerModels, providerIdentifiers.openrouter)

		await expect(promise).resolves.toEqual(routerModels)
		// Success must not leave the window listener or the abort listener attached.
		expect(removeSpy).toHaveBeenCalledWith("message", expect.any(Function))
		removeSpy.mockRestore()
	})

	it("requests the full catalog when no provider is given", async () => {
		const routerModels = asRouterModels({ openrouter: { "model-a": modelInfo } })
		const promise = fetchRouterModels()

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: RouterModelsMessageType.requestRouterModels })

		respondWithRouterModels(routerModels)

		await expect(promise).resolves.toEqual(routerModels)
	})

	it("ignores responses addressed to a different provider", async () => {
		const routerModels = asRouterModels({ openrouter: { "model-a": modelInfo } })
		const promise = fetchRouterModels(providerIdentifiers.openrouter)

		respondWithRouterModels(asRouterModels({ requesty: { "model-b": modelInfo } }), "requesty")
		respondWithRouterModels(routerModels, providerIdentifiers.openrouter)

		await expect(promise).resolves.toEqual(routerModels)
	})

	it("rejects after the 10s timeout and removes the listener", async () => {
		vi.useFakeTimers()
		const removeSpy = vi.spyOn(window, "removeEventListener")

		const promise = fetchRouterModels(providerIdentifiers.openrouter)
		vi.advanceTimersByTime(10_000)

		await expect(promise).rejects.toThrow("Router models request timed out")
		expect(removeSpy).toHaveBeenCalledWith("message", expect.any(Function))
		removeSpy.mockRestore()
	})

	it("rejects with an AbortError, removes the listener, and clears the timeout when aborted", async () => {
		vi.useFakeTimers()
		const removeSpy = vi.spyOn(window, "removeEventListener")
		const controller = new AbortController()

		const promise = fetchRouterModels(providerIdentifiers.openrouter, controller.signal)
		expect(vi.getTimerCount()).toBe(1)

		controller.abort()

		await expect(promise).rejects.toMatchObject({ name: "AbortError", message: "Aborted" })
		expect(removeSpy).toHaveBeenCalledWith("message", expect.any(Function))
		// The 10s timeout must not fire after an abort.
		expect(vi.getTimerCount()).toBe(0)
		removeSpy.mockRestore()
	})

	it("rejects immediately without posting the request when the signal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort()

		await expect(fetchRouterModels(providerIdentifiers.openrouter, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})

describe("useRouterModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("fetches router models through the query", async () => {
		const queryClient = makeQueryClient()
		const routerModels = asRouterModels({ openrouter: { "model-a": modelInfo } })

		const { result } = renderHook(() => useRouterModels({ provider: providerIdentifiers.openrouter }), {
			wrapper: makeWrapper(queryClient),
		})

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.openrouter },
		})

		respondWithRouterModels(routerModels, providerIdentifiers.openrouter)

		await waitFor(() => expect(result.current.data).toEqual(routerModels))
		expect(result.current.isError).toBe(false)
	})

	it("does not fetch when disabled", async () => {
		const queryClient = makeQueryClient()

		renderHook(() => useRouterModels({ enabled: false }), { wrapper: makeWrapper(queryClient) })

		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("forwards the query cancellation to the in-flight fetch", async () => {
		vi.useFakeTimers()
		const queryClient = makeQueryClient()
		const removeSpy = vi.spyOn(window, "removeEventListener")

		const { result } = renderHook(() => useRouterModels({ provider: providerIdentifiers.openrouter }), {
			wrapper: makeWrapper(queryClient),
		})
		expect(vscode.postMessage).toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(1)

		// A cancelled query (e.g. a refetch handoff or explicit cancelQueries)
		// must remove the window listener instead of leaking it until the
		// extension answers. (The companion timeout-clearing assertion lives in
		// the fetchRouterModels abort tests; after a cancel React Query also
		// schedules its own stale/GC timers, so getTimerCount is not exact here.)
		await queryClient.cancelQueries({
			queryKey: [RouterModelsMessageType.routerModels, providerIdentifiers.openrouter],
		})

		expect(removeSpy).toHaveBeenCalledWith("message", expect.any(Function))
		// The abort rejection is swallowed by React Query's cancellation path.
		expect(result.current.isError).toBe(false)

		removeSpy.mockRestore()
	})
})
