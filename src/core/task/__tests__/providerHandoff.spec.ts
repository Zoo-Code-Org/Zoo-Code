import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { getEffectiveTaskApiConfiguration, selectHandoffExecutionContext } from "../providerHandoff"

const parentConfiguration: ProviderSettings = {
	apiProvider: providerIdentifiers.anthropic,
	consecutiveMistakeLimit: 3,
}
const savedConfiguration: ProviderSettings = {
	apiProvider: providerIdentifiers.openrouter,
	consecutiveMistakeLimit: 7,
}
const parent = { mode: "code", apiConfigName: undefined, apiConfiguration: parentConfiguration }

describe("provider handoff decisions", () => {
	it.each([
		{ name: "unsaved", locked: false, saved: undefined, expected: parentConfiguration },
		{
			name: "saved",
			locked: false,
			saved: { name: "ask-profile", apiConfiguration: savedConfiguration },
			expected: savedConfiguration,
		},
		{
			name: "locked",
			locked: true,
			saved: { name: "ask-profile", apiConfiguration: savedConfiguration },
			expected: parentConfiguration,
		},
		{ name: "stale", locked: false, saved: undefined, expected: parentConfiguration },
	])("selects the $name profile path without mutating the parent", ({ locked, saved, expected }) => {
		const selected = selectHandoffExecutionContext(parent, "ask", "code", locked, saved)

		expect(selected.apiConfiguration).toEqual(expected)
		expect(selected.apiConfiguration).not.toBe(expected)
		expect(parent.apiConfiguration).toBe(parentConfiguration)
	})

	it("derives task limits from the effective handoff configuration", () => {
		const handoff = selectHandoffExecutionContext(parent, "ask", "code", false, {
			name: "ask-profile",
			apiConfiguration: savedConfiguration,
		})

		expect(getEffectiveTaskApiConfiguration(parentConfiguration, handoff).consecutiveMistakeLimit).toBe(7)
		expect(getEffectiveTaskApiConfiguration(parentConfiguration).consecutiveMistakeLimit).toBe(3)
	})
})
