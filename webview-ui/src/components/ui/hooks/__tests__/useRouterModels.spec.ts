import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import {
	allRouterModelsProvider,
	providerIdentifiers,
	RouterModelsMessageType,
	type RouterModels,
} from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { fetchRouterModels, useRouterModels } from "../useRouterModels"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

const mockRouterModels = {
	[providerIdentifiers.openrouter]: {
		"anthropic/claude-3.5-sonnet": {
			maxTokens: 8192,
			contextWindow: 200000,
			supportsImages: true,
			supportsPromptCache: true,
		},
	},
} as unknown as RouterModels

describe("fetchRouterModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useRealTimers()
	})

	it("posts requestRouterModels with provider when specified", async () => {
		const promise = fetchRouterModels(providerIdentifiers.openrouter)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.openrouter },
		})

		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: RouterModelsMessageType.routerModels,
					values: { provider: providerIdentifiers.openrouter },
					routerModels: mockRouterModels,
				},
			}),
		)

		const result = await promise
		expect(result).toEqual(mockRouterModels)
	})

	it("posts requestRouterModels without provider when omitted", async () => {
		const promise = fetchRouterModels()

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: RouterModelsMessageType.requestRouterModels,
		})

		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: RouterModelsMessageType.routerModels,
					values: { provider: undefined },
					routerModels: mockRouterModels,
				},
			}),
		)

		const result = await promise
		expect(result).toEqual(mockRouterModels)
	})

	it("ignores mismatched provider messages and resolves when matching message arrives", async () => {
		const promise = fetchRouterModels(providerIdentifiers.openrouter)

		// Send message with different provider - should be ignored
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: RouterModelsMessageType.routerModels,
					values: { provider: providerIdentifiers.ollama },
					routerModels: {},
				},
			}),
		)

		// Send matching message
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: RouterModelsMessageType.routerModels,
					values: { provider: providerIdentifiers.openrouter },
					routerModels: mockRouterModels,
				},
			}),
		)

		const result = await promise
		expect(result).toEqual(mockRouterModels)
	})

	it("ignores unrelated messages", async () => {
		const promise = fetchRouterModels(providerIdentifiers.openrouter)

		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "unrelatedMessageType",
				},
			}),
		)

		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: RouterModelsMessageType.routerModels,
					values: { provider: providerIdentifiers.openrouter },
					routerModels: mockRouterModels,
				},
			}),
		)

		const result = await promise
		expect(result).toEqual(mockRouterModels)
	})

	it("rejects when routerModels field is missing in matching response", async () => {
		const promise = fetchRouterModels(providerIdentifiers.openrouter)

		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: RouterModelsMessageType.routerModels,
					values: { provider: providerIdentifiers.openrouter },
				},
			}),
		)

		await expect(promise).rejects.toThrow("No router models in response")
	})

	it("rejects immediately if signal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort()

		await expect(fetchRouterModels(providerIdentifiers.openrouter, controller.signal)).rejects.toThrow(
			"Router models request aborted",
		)

		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("rejects and cleans up when signal aborts while waiting", async () => {
		const controller = new AbortController()
		const addWindowListenerSpy = vi.spyOn(window, "addEventListener")
		const removeWindowListenerSpy = vi.spyOn(window, "removeEventListener")
		const addSignalListenerSpy = vi.spyOn(controller.signal, "addEventListener")
		const removeSignalListenerSpy = vi.spyOn(controller.signal, "removeEventListener")

		const promise = fetchRouterModels(providerIdentifiers.openrouter, controller.signal)
		const addedMessageHandler = addWindowListenerSpy.mock.calls.find(([type]) => type === "message")?.[1]
		const addedAbortHandler = addSignalListenerSpy.mock.calls.find(([type]) => type === "abort")?.[1]

		controller.abort()

		await expect(promise).rejects.toThrow("Router models request aborted")
		expect(typeof addedMessageHandler).toBe("function")
		expect(removeWindowListenerSpy).toHaveBeenCalledWith("message", addedMessageHandler)
		expect(typeof addedAbortHandler).toBe("function")
		expect(removeSignalListenerSpy).toHaveBeenCalledWith("abort", addedAbortHandler)
	})

	it("rejects and cleans up abort listener when timeout expires", async () => {
		vi.useFakeTimers()
		const controller = new AbortController()
		const addSignalListenerSpy = vi.spyOn(controller.signal, "addEventListener")
		const removeSignalListenerSpy = vi.spyOn(controller.signal, "removeEventListener")
		const addWindowListenerSpy = vi.spyOn(window, "addEventListener")
		const removeWindowListenerSpy = vi.spyOn(window, "removeEventListener")

		const promise = fetchRouterModels(providerIdentifiers.openrouter, controller.signal)
		const addedAbortHandler = addSignalListenerSpy.mock.calls.find(([type]) => type === "abort")?.[1]
		const addedMessageHandler = addWindowListenerSpy.mock.calls.find(([type]) => type === "message")?.[1]

		vi.advanceTimersByTime(10000)

		await expect(promise).rejects.toThrow("Router models request timed out")
		expect(typeof addedAbortHandler).toBe("function")
		expect(removeSignalListenerSpy).toHaveBeenCalledWith("abort", addedAbortHandler)
		expect(typeof addedMessageHandler).toBe("function")
		expect(removeWindowListenerSpy).toHaveBeenCalledWith("message", addedMessageHandler)
	})

	it("removes abort listener and cleans up timer on successful response", async () => {
		vi.useFakeTimers()
		const controller = new AbortController()
		const addSignalListenerSpy = vi.spyOn(controller.signal, "addEventListener")
		const removeSignalListenerSpy = vi.spyOn(controller.signal, "removeEventListener")
		const addWindowListenerSpy = vi.spyOn(window, "addEventListener")
		const removeWindowListenerSpy = vi.spyOn(window, "removeEventListener")

		const promise = fetchRouterModels(providerIdentifiers.openrouter, controller.signal)
		const addedAbortHandler = addSignalListenerSpy.mock.calls.find(([type]) => type === "abort")?.[1]
		const addedMessageHandler = addWindowListenerSpy.mock.calls.find(([type]) => type === "message")?.[1]

		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: RouterModelsMessageType.routerModels,
					values: { provider: providerIdentifiers.openrouter },
					routerModels: mockRouterModels,
				},
			}),
		)

		const result = await promise
		expect(result).toEqual(mockRouterModels)
		expect(typeof addedAbortHandler).toBe("function")
		expect(removeSignalListenerSpy).toHaveBeenCalledWith("abort", addedAbortHandler)
		expect(typeof addedMessageHandler).toBe("function")
		expect(removeWindowListenerSpy).toHaveBeenCalledWith("message", addedMessageHandler)

		// Advancing timers should not cause rejection or error
		vi.advanceTimersByTime(15000)
		// Aborting afterwards should not trigger rejection
		controller.abort()
	})

	it("cleans up successfully when called without an abort signal", async () => {
		const addWindowListenerSpy = vi.spyOn(window, "addEventListener")
		const removeWindowListenerSpy = vi.spyOn(window, "removeEventListener")

		const promise = fetchRouterModels(providerIdentifiers.openrouter)
		const addedMessageHandler = addWindowListenerSpy.mock.calls.find(([type]) => type === "message")?.[1]

		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: RouterModelsMessageType.routerModels,
					values: { provider: providerIdentifiers.openrouter },
					routerModels: mockRouterModels,
				},
			}),
		)

		const result = await promise
		expect(result).toEqual(mockRouterModels)
		expect(typeof addedMessageHandler).toBe("function")
		expect(removeWindowListenerSpy).toHaveBeenCalledWith("message", addedMessageHandler)
	})

	it("times out and cleans up when called without an abort signal", async () => {
		vi.useFakeTimers()
		const addWindowListenerSpy = vi.spyOn(window, "addEventListener")
		const removeWindowListenerSpy = vi.spyOn(window, "removeEventListener")

		const promise = fetchRouterModels(providerIdentifiers.openrouter)
		const addedMessageHandler = addWindowListenerSpy.mock.calls.find(([type]) => type === "message")?.[1]

		vi.advanceTimersByTime(10000)

		await expect(promise).rejects.toThrow("Router models request timed out")
		expect(typeof addedMessageHandler).toBe("function")
		expect(removeWindowListenerSpy).toHaveBeenCalledWith("message", addedMessageHandler)
	})
})

describe("useRouterModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useRealTimers()
	})

	const makeQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

	it("fetches router models with the specified provider", async () => {
		const queryClient = makeQueryClient()
		const wrapper = ({ children }: { children: React.ReactNode }) =>
			React.createElement(QueryClientProvider, { client: queryClient }, children)

		const { result } = renderHook(() => useRouterModels({ provider: providerIdentifiers.openrouter }), { wrapper })

		await waitFor(() =>
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: RouterModelsMessageType.requestRouterModels,
				values: { provider: providerIdentifiers.openrouter },
			}),
		)

		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: RouterModelsMessageType.routerModels,
					values: { provider: providerIdentifiers.openrouter },
					routerModels: mockRouterModels,
				},
			}),
		)

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockRouterModels)
	})

	it("uses allRouterModelsProvider in query key when provider is not specified", async () => {
		const queryClient = makeQueryClient()
		const wrapper = ({ children }: { children: React.ReactNode }) =>
			React.createElement(QueryClientProvider, { client: queryClient }, children)

		const { result } = renderHook(() => useRouterModels(), { wrapper })

		await waitFor(() =>
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: RouterModelsMessageType.requestRouterModels,
			}),
		)

		const queryState = queryClient.getQueryCache().findAll()
		expect(queryState[0].queryKey).toEqual([RouterModelsMessageType.routerModels, allRouterModelsProvider])

		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: RouterModelsMessageType.routerModels,
					values: { provider: undefined },
					routerModels: mockRouterModels,
				},
			}),
		)

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
	})

	it("does not fetch when enabled is false", async () => {
		const queryClient = makeQueryClient()
		const wrapper = ({ children }: { children: React.ReactNode }) =>
			React.createElement(QueryClientProvider, { client: queryClient }, children)

		renderHook(() => useRouterModels({ provider: providerIdentifiers.openrouter, enabled: false }), { wrapper })

		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("aborts pending router model fetch and cleans up listener when query is cancelled or unmounted", async () => {
		const removeListenerSpy = vi.spyOn(window, "removeEventListener")
		const queryClient = makeQueryClient()
		const wrapper = ({ children }: { children: React.ReactNode }) =>
			React.createElement(QueryClientProvider, { client: queryClient }, children)

		const { unmount } = renderHook(() => useRouterModels({ provider: providerIdentifiers.openrouter }), { wrapper })

		await waitFor(() =>
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: RouterModelsMessageType.requestRouterModels,
				values: { provider: providerIdentifiers.openrouter },
			}),
		)

		unmount()
		queryClient.cancelQueries()

		await waitFor(() => {
			expect(removeListenerSpy).toHaveBeenCalledWith("message", expect.any(Function))
		})
	})
})
