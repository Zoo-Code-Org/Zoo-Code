import { DiagnosticsRequestBroker } from "../requestBroker"

describe("DiagnosticsRequestBroker", () => {
	it("releases pending requests on disposal and rejects late responses", async () => {
		const broker = new DiagnosticsRequestBroker()
		const ids: string[] = []
		const responses = [1, 2].map(() =>
			broker.request(async (id) => {
				ids.push(id)
			}, 1_000),
		)
		broker.dispose()
		await expect(Promise.all(responses)).resolves.toEqual([undefined, undefined])
		for (const id of ids) expect(broker.resolve(id, { capturedAt: "now" })).toBe(false)
	})

	it("returns unavailable when sending fails and ignores a later response", async () => {
		const broker = new DiagnosticsRequestBroker()
		let requestId = ""
		await expect(
			broker.request(async (id) => {
				requestId = id
				throw new Error("disconnected")
			}, 1_000),
		).resolves.toBeUndefined()
		expect(broker.resolve(requestId, { capturedAt: "now" })).toBe(false)
	})
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
