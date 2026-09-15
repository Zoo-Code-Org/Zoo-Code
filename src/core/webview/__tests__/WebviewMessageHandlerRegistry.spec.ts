import { WebviewMessageHandlerRegistry, type WebviewMessageFeatureHandler } from "../WebviewMessageHandlerRegistry"

describe("WebviewMessageHandlerRegistry", () => {
	it("routes a message to the first matching feature handler", async () => {
		const unmatchedHandler: WebviewMessageFeatureHandler = {
			canHandle: vi.fn().mockReturnValue(false),
			handle: vi.fn(),
		}
		const matchingHandler: WebviewMessageFeatureHandler = {
			canHandle: vi.fn().mockReturnValue(true),
			handle: vi.fn().mockResolvedValue(undefined),
		}
		const registry = new WebviewMessageHandlerRegistry([unmatchedHandler, matchingHandler])
		const message = { type: "requestIndexingStatus" } as const

		await expect(registry.handle(message)).resolves.toBe(true)
		expect(unmatchedHandler.handle).not.toHaveBeenCalled()
		expect(matchingHandler.handle).toHaveBeenCalledWith(message)
	})

	it("reports when no feature handler accepts the message", async () => {
		const registry = new WebviewMessageHandlerRegistry([])

		await expect(registry.handle({ type: "clearTask" })).resolves.toBe(false)
	})
})
