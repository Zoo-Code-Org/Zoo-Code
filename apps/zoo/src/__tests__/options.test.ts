import { describe, expect, it } from "vitest"

import { parseDuration, runOverrides } from "../options.js"

describe("automation options", () => {
	it("parses bounded duration units", () => {
		expect(parseDuration("250ms")).toBe(250)
		expect(parseDuration("2m")).toBe(120_000)
		expect(() => parseDuration("2 minutes")).toThrow("Invalid duration")
	})

	it("rejects mutually exclusive provider sources", () => {
		expect(() => runOverrides({ provider: "anthropic", profile: "work" })).toThrow(
			"profile and provider are mutually exclusive",
		)
	})
})
