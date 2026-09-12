import { describe, expect, it } from "vitest"

import { captureError } from "../errors"

describe("error capture utility", () => {
	it("returns the rejecting Error instance untouched", async () => {
		const original = new Error("provider failed")

		expect(await captureError(Promise.reject(original))).toBe(original)
	})

	it("re-wraps a non-Error rejection so the original failure message stays visible", async () => {
		const captured = await captureError(Promise.reject("plain string failure"))

		expect(captured).toBeInstanceOf(Error)
		expect(captured.message).toBe("plain string failure")
	})

	it("rejects when the operation resolves, because resolving violates the contract", async () => {
		await expect(captureError(Promise.resolve("value"))).rejects.toThrow("Expected the operation to reject")
	})
})
