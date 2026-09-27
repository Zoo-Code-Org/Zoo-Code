// pnpm --filter @roo-code/types test src/__tests__/telemetry.isTelemetryOptedIn.test.ts

import { isTelemetryOptedIn } from "../telemetry.js"

describe("isTelemetryOptedIn", () => {
	it("returns true for an explicit 'enabled' setting", () => {
		expect(isTelemetryOptedIn("enabled")).toBe(true)
	})

	it("returns false for an explicit 'disabled' setting", () => {
		expect(isTelemetryOptedIn("disabled")).toBe(false)
	})

	it("returns true for 'unset' (disclosed opt-out default applies)", () => {
		expect(isTelemetryOptedIn("unset")).toBe(true)
	})

	it("returns true for undefined (treated the same as unset)", () => {
		expect(isTelemetryOptedIn(undefined)).toBe(true)
	})
})
