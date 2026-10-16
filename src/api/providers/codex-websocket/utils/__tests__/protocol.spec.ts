import { fingerprint } from "../protocol"

describe("Codex WebSocket fingerprints", () => {
	it("uses the null fingerprint when the input cannot be serialized", () => {
		expect(fingerprint(undefined)).toBe(fingerprint(null))
	})

	it("ignores object key ordering while distinguishing changed values", () => {
		expect(fingerprint({ model: "test", stream: true })).toBe(fingerprint({ stream: true, model: "test" }))
		expect(fingerprint({ model: "test" })).not.toBe(fingerprint({ model: "changed" }))
	})
})
