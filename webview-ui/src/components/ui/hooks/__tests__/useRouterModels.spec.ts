// npx vitest src/components/ui/hooks/__tests__/useRouterModels.spec.ts

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

import { providerIdentifiers, RouterModelsMessageType } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

import { fetchRouterModels } from "../useRouterModels"

const postResponse = (provider: string | undefined, routerModels: Record<string, unknown>) => {
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

describe("fetchRouterModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("posts a provider-filtered request and resolves on the matching response", async () => {
		const promise = fetchRouterModels(providerIdentifiers.mimo)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.mimo },
		})

		postResponse(providerIdentifiers.mimo, { mimo: {} })
		await expect(promise).resolves.toEqual({ mimo: {} })
	})

	it("ignores responses for other providers", async () => {
		const promise = fetchRouterModels(providerIdentifiers.mimo)

		postResponse("openrouter", { openrouter: {} })
		postResponse(undefined, {})
		postResponse(providerIdentifiers.mimo, { mimo: { "mimo-v2.6-pro": {} } })

		await expect(promise).resolves.toEqual({ mimo: { "mimo-v2.6-pro": {} } })
	})

	it("rejects with an abort error when the signal aborts mid-flight", async () => {
		const controller = new AbortController()
		const promise = fetchRouterModels(providerIdentifiers.mimo, controller.signal)

		controller.abort()

		await expect(promise).rejects.toMatchObject({ name: "AbortError" })

		// A late response must not reach the removed listener or resolve anything.
		postResponse(providerIdentifiers.mimo, { mimo: {} })
		await Promise.resolve()
	})

	it("rejects immediately when the signal is already aborted, without posting", async () => {
		const controller = new AbortController()
		controller.abort()

		await expect(fetchRouterModels(providerIdentifiers.mimo, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(vscode.postMessage).not.toHaveBeenCalled()
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
