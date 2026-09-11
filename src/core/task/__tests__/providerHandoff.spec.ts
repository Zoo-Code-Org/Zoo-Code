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

	it("keeps the parent configuration when a configured saved profile is locked", () => {
		const selected = selectHandoffExecutionContext(parent, "ask", "code", true, {
			name: "ask-profile",
			apiConfiguration: savedConfiguration,
		})

		expect(selected.apiConfigName).toBeUndefined()
		expect(selected.apiConfiguration).toEqual(parentConfiguration)
	})

	it("keeps the parent configuration when the requested mode is unchanged", () => {
		const selected = selectHandoffExecutionContext(parent, "code", "code", false, {
			name: "ask-profile",
			apiConfiguration: savedConfiguration,
		})

		expect(selected.apiConfigName).toBeUndefined()
		expect(selected.apiConfiguration).toEqual(parentConfiguration)
	})
})
