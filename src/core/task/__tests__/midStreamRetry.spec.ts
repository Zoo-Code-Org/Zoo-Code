import { describe, expect, it } from "vitest"

import { decideMidStreamFailure, findRetryRequestMessageIndex, MAX_MID_STREAM_RETRIES } from "../midStreamRetry"

describe("decideMidStreamFailure", () => {
	it.each([0, 1, 2])("retries attempt %i", (attempt) => {
		expect(decideMidStreamFailure(attempt)).toBe("retry")
	})

	it("asks after the automatic retry budget is exhausted", () => {
		expect(decideMidStreamFailure(MAX_MID_STREAM_RETRIES)).toBe("ask")
	})
})

describe("findRetryRequestMessageIndex", () => {
	const messages = [
		{ messageId: "other-user", role: "user" },
		{ messageId: "request", role: "user" },
		{ messageId: "request", role: "assistant" },
	]

	it("finds the exact user request", () => {
		expect(findRetryRequestMessageIndex(messages, "request")).toBe(1)
	})

	it("does not match a different id or a non-user message", () => {
		expect(findRetryRequestMessageIndex(messages, "missing")).toBe(-1)
		expect(findRetryRequestMessageIndex([{ messageId: "request", role: "assistant" }], "request")).toBe(-1)
	})
})
