// npx vitest src/components/ui/hooks/__tests__/useRouterModels.spec.ts

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

import { providerIdentifiers, RouterModelsMessageType } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

import { fetchRouterModels } from "../useRouterModels"

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
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("posts a provider-filtered request with a request ID and resolves on the matching response", async () => {
		const { promise, requestId } = startRequest(providerIdentifiers.mimo)

		expect(requestId).toBeTruthy()
		expect(postMessageMock).toHaveBeenCalledWith({
			type: RouterModelsMessageType.requestRouterModels,
			values: { requestId, provider: providerIdentifiers.mimo },
		})

		postResponse(requestId, { mimo: {} })
		await expect(promise).resolves.toEqual({ mimo: {} })
	})

	it("posts an aggregate request without a provider filter", async () => {
		const { promise, requestId } = startRequest()

		expect(postMessageMock).toHaveBeenCalledWith({
			type: RouterModelsMessageType.requestRouterModels,
			values: { requestId },
		})

		postResponse(requestId, {})
		await expect(promise).resolves.toEqual({})
	})

	it("ignores responses carrying a different or missing request ID", async () => {
		const { promise, requestId } = startRequest(providerIdentifiers.mimo)

		postResponse("stale-request-id", { mimo: { stale: {} } })
		postResponse(undefined, { mimo: {} })

		postResponse(requestId, { mimo: { fresh: {} } })
		await expect(promise).resolves.toEqual({ mimo: { fresh: {} } })
	})

	it("resolves concurrent same-provider requests independently by request ID", async () => {
		const first = startRequest(providerIdentifiers.mimo)
		const second = startRequest(providerIdentifiers.mimo)

		expect(first.requestId).not.toBe(second.requestId)

		postResponse(second.requestId, { mimo: { second: {} } })
		postResponse(first.requestId, { mimo: { first: {} } })

		await expect(first.promise).resolves.toEqual({ mimo: { first: {} } })
		await expect(second.promise).resolves.toEqual({ mimo: { second: {} } })
	})

	it("rejects on abort and removes the exact registered listener and timer", async () => {
		vi.useFakeTimers()
		try {
			const addSpy = vi.spyOn(window, "addEventListener")
			const removeSpy = vi.spyOn(window, "removeEventListener")
			const controller = new AbortController()

			const { promise, requestId } = startRequest(providerIdentifiers.mimo, controller.signal)
			const registeredHandler = addSpy.mock.calls.find(([eventName]) => eventName === "message")?.[1]

			expect(vi.getTimerCount()).toBe(1)

			controller.abort()

			await expect(promise).rejects.toMatchObject({ name: "AbortError" })
			expect(removeSpy).toHaveBeenCalledWith("message", registeredHandler)
			expect(vi.getTimerCount()).toBe(0)

			// A stale response for the aborted request must find no listener.
			postResponse(requestId, { mimo: {} })
		} finally {
			vi.useRealTimers()
		}
	})

	it("rejects immediately when the signal is already aborted, without posting", async () => {
		const controller = new AbortController()
		controller.abort()

		await expect(fetchRouterModels(providerIdentifiers.mimo, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(postMessageMock).not.toHaveBeenCalled()
	})

	it("times out when no response arrives", async () => {
		vi.useFakeTimers()
		try {
			const promise = fetchRouterModels(providerIdentifiers.mimo)

			vi.advanceTimersByTime(10_000)

			await expect(promise).rejects.toThrow("Router models request timed out")
		} finally {
			vi.useRealTimers()
		}
	})
})
