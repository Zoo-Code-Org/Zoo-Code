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

const postMessageMock = vi.mocked(vscode.postMessage)

const postResponse = (requestId: string | undefined, routerModels: Record<string, unknown>) => {
	window.dispatchEvent(
		new MessageEvent("message", {
			data: {
				type: RouterModelsMessageType.routerModels,
				routerModels,
				values: { requestId },
			},
		}),
	)
}

const startRequest = (provider?: string, signal?: AbortSignal) => {
	const promise = fetchRouterModels(provider, signal)
	const requestId = postMessageMock.mock.calls.at(-1)?.[0]?.values?.requestId as string
	return { promise, requestId }
}

describe("fetchRouterModels", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	test("posts a provider-filtered request with a request ID and resolves on the matching response", async () => {
		const { promise, requestId } = startRequest(providerIdentifiers.mimo)

		expect(requestId).toBeTruthy()
		expect(postMessageMock).toHaveBeenCalledWith({
			type: RouterModelsMessageType.requestRouterModels,
			values: { requestId, provider: providerIdentifiers.mimo },
		})

		postResponse(requestId, { [providerIdentifiers.mimo]: {} })
		await expect(promise).resolves.toEqual({ [providerIdentifiers.mimo]: {} })
	})

	test("posts an aggregate request without a provider filter", async () => {
		const { promise, requestId } = startRequest()

		expect(postMessageMock).toHaveBeenCalledWith({
			type: RouterModelsMessageType.requestRouterModels,
			values: { requestId },
		})

		postResponse(requestId, {})
		await expect(promise).resolves.toEqual({})
	})

	test("ignores responses carrying a different or missing request ID", async () => {
		const { promise, requestId } = startRequest(providerIdentifiers.mimo)

		postResponse("stale-request-id", { [providerIdentifiers.mimo]: { stale: {} } })
		postResponse(undefined, { [providerIdentifiers.mimo]: {} })

		postResponse(requestId, { [providerIdentifiers.mimo]: { fresh: {} } })
		await expect(promise).resolves.toEqual({ [providerIdentifiers.mimo]: { fresh: {} } })
	})

	test("resolves concurrent same-provider requests independently by request ID", async () => {
		const first = startRequest(providerIdentifiers.mimo)
		const second = startRequest(providerIdentifiers.mimo)

		expect(first.requestId).not.toBe(second.requestId)

		postResponse(second.requestId, { [providerIdentifiers.mimo]: { second: {} } })
		postResponse(first.requestId, { [providerIdentifiers.mimo]: { first: {} } })

		await expect(first.promise).resolves.toEqual({ [providerIdentifiers.mimo]: { first: {} } })
		await expect(second.promise).resolves.toEqual({ [providerIdentifiers.mimo]: { second: {} } })
	})

	test("on abort, rejects, removes the same message listener, and clears the timeout", async () => {
		vi.useFakeTimers()
		const addSpy = vi.spyOn(window, "addEventListener")
		const removeSpy = vi.spyOn(window, "removeEventListener")
		const controller = new AbortController()

		const { promise, requestId } = startRequest(providerIdentifiers.mimo, controller.signal)
		const handler = addSpy.mock.calls.find((args) => args[0] === "message")?.[1]
		expect(vi.getTimerCount()).toBe(1)

		controller.abort()

		await expect(promise).rejects.toMatchObject({ name: "AbortError" })
		expect(removeSpy).toHaveBeenCalledWith("message", handler)
		expect(vi.getTimerCount()).toBe(0)

		// A stale response for the aborted request must find no listener.
		postResponse(requestId, { [providerIdentifiers.mimo]: {} })
	})

	test("rejects at once without adding a listener when the signal is already aborted", async () => {
		vi.useFakeTimers()
		const addSpy = vi.spyOn(window, "addEventListener")

		const controller = new AbortController()
		controller.abort()
		postMessageMock.mockClear()

		await expect(fetchRouterModels(providerIdentifiers.mimo, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(addSpy.mock.calls.find((args) => args[0] === "message")?.[1]).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)
		// The already-aborted signal must not even post the request.
		expect(postMessageMock).not.toHaveBeenCalled()
	})

	test("on timeout, rejects and removes the same message listener", async () => {
		vi.useFakeTimers()
		const addSpy = vi.spyOn(window, "addEventListener")
		const removeSpy = vi.spyOn(window, "removeEventListener")

		const promise = fetchRouterModels(providerIdentifiers.mimo)
		const handler = addSpy.mock.calls.find((args) => args[0] === "message")?.[1]
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
		postMessageMock.mockImplementation(() => {
			const routerModels = responses.shift()
			const requestId = postMessageMock.mock.calls.at(-1)?.[0]?.values?.requestId as string
			queueMicrotask(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: RouterModelsMessageType.routerModels,
							values: { requestId, provider },
							routerModels,
						},
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
