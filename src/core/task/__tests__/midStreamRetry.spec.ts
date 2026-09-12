import { describe, expect, it } from "vitest"

import { decideMidStreamFailure, MAX_MID_STREAM_RETRIES } from "../midStreamRetry"

describe("decideMidStreamFailure", () => {
	it.each([0, 1, 2])("retries attempt %i", (attempt) => {
		expect(decideMidStreamFailure(attempt)).toBe("retry")
	})

	it("asks after the automatic retry budget is exhausted", () => {
		expect(decideMidStreamFailure(MAX_MID_STREAM_RETRIES)).toBe("ask")
	})
})
