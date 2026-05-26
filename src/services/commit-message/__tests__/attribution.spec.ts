import type { ProviderSettings } from "@roo-code/types"

import {
	appendCommitMessageAttribution,
	applyCommitMessageAttributionTemplate,
	createCommitMessageAttribution,
} from "../attribution"

describe("commit message attribution", () => {
	const apiConfiguration: ProviderSettings = {
		apiProvider: "anthropic",
		apiModelId: "claude-opus-4-7",
	}

	it("returns no attribution when disabled by default", () => {
		expect(createCommitMessageAttribution(undefined, apiConfiguration)).toBe("")
	})

	it("creates the default attribution with provider and model", () => {
		expect(createCommitMessageAttribution({ enabled: true }, apiConfiguration)).toBe(
			"Assisted-by: Zoo Code:anthropic/claude-opus-4-7 [Zoo Code]",
		)
	})

	it("applies custom attribution placeholders", () => {
		expect(
			applyCommitMessageAttributionTemplate("Co-authored-by: ${agentName} (${providerModel}) [${toolName}]", {
				agentName: "Zoo Code",
				toolName: "Zoo Code",
				provider: "openrouter",
				model: "openai/gpt-4",
				providerModel: "openrouter/openai/gpt-4",
			}),
		).toBe("Co-authored-by: Zoo Code (openrouter/openai/gpt-4) [Zoo Code]")
	})

	it("appends attribution with exactly one blank line", () => {
		expect(appendCommitMessageAttribution("feat(scm): generate commits\n", "Assisted-by: Zoo Code")).toBe(
			"feat(scm): generate commits\n\nAssisted-by: Zoo Code",
		)
	})

	it("returns only trimmed attribution when message is empty", () => {
		expect(appendCommitMessageAttribution("   ", "\nAssisted-by: Zoo Code\n")).toBe("Assisted-by: Zoo Code")
	})

	it("does not duplicate an existing attribution footer", () => {
		const message = "feat(scm): generate commits\n\nAssisted-by: Zoo Code"

		expect(appendCommitMessageAttribution(message, "Assisted-by: Zoo Code")).toBe(message)
	})
})
