import { DiagnosticsRecorder } from "../recorder"

describe("DiagnosticsRecorder", () => {
	it("keeps a bounded structural trail without payload fields", () => {
		const recorder = new DiagnosticsRecorder(3)
		for (let index = 0; index < 5; index++) {
			recorder.record({ boundary: "webview-out", phase: "success", type: `message-${index}` })
		}

		const snapshot = recorder.snapshot(2)
		expect(snapshot.truncated).toBe(true)
		expect(snapshot.events.map((event) => event.type)).toEqual(["message-3", "message-4"])
		expect(JSON.stringify(snapshot)).not.toContain("payload")
	})
})
