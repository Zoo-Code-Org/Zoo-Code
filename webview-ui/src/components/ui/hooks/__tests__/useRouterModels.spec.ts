import { RouterModelsMessageType, providerIdentifiers } from "@roo-code/types"

import { fetchRouterModels } from "../useRouterModels"

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
