import React from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"

import { RouterModelsMessageType, providerIdentifiers } from "@roo-code/types"

import { createTestQueryClient } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import { fetchRouterModels, useRouterModels } from "../useRouterModels"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

describe("fetchRouterModels", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	const handlerOf = (spy: { mock: { calls: unknown[][] } }) =>
		spy.mock.calls.find((args) => args[0] === "message")?.[1] as EventListener

	test("resolves with the router models of the matching provider and removes its listener", async () => {
		const addSpy = vi.spyOn(window, "addEventListener")
		const removeSpy = vi.spyOn(window, "removeEventListener")

		const promise = fetchRouterModels(providerIdentifiers.openrouter)
		const handler = handlerOf(addSpy)

		handler(
			new MessageEvent("message", {
				data: {
					type: RouterModelsMessageType.routerModels,
					values: { provider: providerIdentifiers.openrouter },
					routerModels: { [providerIdentifiers.openrouter]: {} },
				},
			}),
		)

		await expect(promise).resolves.toEqual({ [providerIdentifiers.openrouter]: {} })
		expect(removeSpy).toHaveBeenCalledWith("message", handler)
	})

	test("on abort, rejects, removes the same message listener, and clears the timeout", async () => {
		vi.useFakeTimers()
		const addSpy = vi.spyOn(window, "addEventListener")
		const removeSpy = vi.spyOn(window, "removeEventListener")
		const controller = new AbortController()

		const promise = fetchRouterModels(providerIdentifiers.openrouter, controller.signal)
		const handler = handlerOf(addSpy)
		expect(typeof handler).toBe("function")
		expect(vi.getTimerCount()).toBe(1)

		controller.abort()

		await expect(promise).rejects.toMatchObject({ name: "AbortError" })
		expect(removeSpy).toHaveBeenCalledWith("message", handler)
		expect(vi.getTimerCount()).toBe(0)
	})

	test("rejects at once without adding a listener when the signal is already aborted", async () => {
		vi.useFakeTimers()
		const addSpy = vi.spyOn(window, "addEventListener")
		const controller = new AbortController()
		controller.abort()

		await expect(fetchRouterModels(providerIdentifiers.openrouter, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(handlerOf(addSpy)).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)
	})

	test("on timeout, rejects and removes the same message listener", async () => {
		vi.useFakeTimers()
		const addSpy = vi.spyOn(window, "addEventListener")
		const removeSpy = vi.spyOn(window, "removeEventListener")

		const promise = fetchRouterModels(providerIdentifiers.openrouter)
		const handler = handlerOf(addSpy)
		const assertion = expect(promise).rejects.toThrow("timed out")

		await vi.advanceTimersByTimeAsync(10_000)

		await assertion
		expect(removeSpy).toHaveBeenCalledWith("message", handler)
	})
})

describe("useRouterModels", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	test("keeps an own __proto__ model ID when a refetch replaces an empty catalog", async () => {
		const provider = providerIdentifiers.friendli
		// JSON.parse keeps "__proto__" as an own key, as a message from the extension host does.
		const responses = [
			{ [provider]: {} },
			JSON.parse(
				`{"${provider}": {"__proto__": {"contextWindow": 1000}, "vendor/model": {"contextWindow": 2000}}}`,
			),
		]
		vi.mocked(vscode.postMessage).mockImplementation(() => {
			const routerModels = responses.shift()
			queueMicrotask(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: RouterModelsMessageType.routerModels, values: { provider }, routerModels },
					}),
				),
			)
		})
		const queryClient = createTestQueryClient()
		const wrapper = ({ children }: { children: React.ReactNode }) =>
			React.createElement(QueryClientProvider, { client: queryClient }, children)

		const { result } = renderHook(() => useRouterModels({ provider }), { wrapper })
		await waitFor(() => expect(result.current.data).toEqual({ [provider]: {} }))
		await result.current.refetch()

		await waitFor(() => expect(Object.hasOwn(result.current.data?.[provider] ?? {}, "__proto__")).toBe(true))
		const catalog = result.current.data?.[provider]
		expect(Object.keys(catalog ?? {})).toEqual(["__proto__", "vendor/model"])
		expect(Object.getOwnPropertyDescriptor(catalog, "__proto__")?.value).toEqual({ contextWindow: 1000 })
		expect(catalog?.["vendor/model"]).toEqual({ contextWindow: 2000 })
	})
})
