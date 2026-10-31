import { providerIdentifiers } from "@roo-code/types"

import { providerLabel } from "../providerLabel"

describe("providerLabel", () => {
	it("returns the display name for a known provider", () => {
		expect(providerLabel(providerIdentifiers.githubCopilot)).toBe("GitHub Copilot")
		expect(providerLabel(providerIdentifiers.anthropic)).toBe("Anthropic")
	})

	it("falls back to the raw id for unknown or retired providers", () => {
		expect(providerLabel("some-retired-provider")).toBe("some-retired-provider")
	})
})
