import { describe, it, expect, vi, beforeEach } from "vitest"
import { webviewMessageHandler } from "../webviewMessageHandler"
describe("webviewMessageHandler - requestRooCreditBalance", () => {
	let mockProvider: any

	beforeEach(() => {
		mockProvider = {
			postMessageToWebview: vi.fn(),
			contextProxy: {
				getValue: vi.fn(),
				setValue: vi.fn(),
			},
			getCurrentTask: vi.fn(),
			cwd: "/test/path",
		}

		vi.clearAllMocks()
	})

	it("returns compatibility error because Roo credit balance is retired", async () => {
		const requestId = "test-request-id"

		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRooCreditBalance",
				requestId,
			} as any,
		)

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "rooCreditBalance",
			requestId,
			values: { error: "Roo credit balance is no longer available." },
		})
	})
})
