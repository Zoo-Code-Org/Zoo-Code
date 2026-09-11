import { describe, expect, it } from "vitest"

import { decideMidStreamFailure, MAX_MID_STREAM_RETRIES, shouldRemoveMidStreamRetryMessage } from "../midStreamRetry"

describe("decideMidStreamFailure", () => {
	it.each([0, 1, 2])("retries attempt %i", (attempt) => {
		expect(decideMidStreamFailure(attempt)).toBe("retry")
	})

	it("asks after the automatic retry budget is exhausted", () => {
		expect(decideMidStreamFailure(MAX_MID_STREAM_RETRIES)).toBe("ask")
	})
})

describe("shouldRemoveMidStreamRetryMessage", () => {
	it.each([
		{ added: true, role: "user", expected: true },
		{ added: false, role: "user", expected: false },
		{ added: true, role: "assistant", expected: false },
		{ added: true, role: undefined, expected: false },
	])("returns $expected when added=$added and role=$role", ({ added, role, expected }) => {
		expect(shouldRemoveMidStreamRetryMessage(added, role)).toBe(expected)
	})
})
