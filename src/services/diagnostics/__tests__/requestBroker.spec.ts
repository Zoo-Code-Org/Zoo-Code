import { DiagnosticsRequestBroker } from "../requestBroker"

describe("DiagnosticsRequestBroker", () => {
	it("correlates a live webview response", async () => {
		const broker = new DiagnosticsRequestBroker()
		let requestId = ""
		const response = broker.request(async (id) => {
			requestId = id
		}, 100)

		expect(requestId).not.toBe("")
		expect(broker.resolve(requestId, { capturedAt: "2026-01-01T00:00:00.000Z", activeView: "chat" })).toBe(true)
		await expect(response).resolves.toMatchObject({ activeView: "chat" })
	})

	it("returns unavailable after the response timeout", async () => {
		vi.useFakeTimers()
		try {
			const broker = new DiagnosticsRequestBroker()
			const response = broker.request(async () => {}, 1_000)
			await vi.advanceTimersByTimeAsync(1_000)
			await expect(response).resolves.toBeUndefined()
		} finally {
			vi.useRealTimers()
		}
	})
})
