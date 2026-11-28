import { EXPERIMENT_IDS, experimentConfigsMap, experimentDefault, experiments } from "../experiments"

describe("PREVENT_FOCUS_DISRUPTION experiment", () => {
	it("should include PREVENT_FOCUS_DISRUPTION in EXPERIMENT_IDS", () => {
		expect(EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION).toBe("preventFocusDisruption")
	})

	it("should have PREVENT_FOCUS_DISRUPTION enabled by default (chat-diff is the default approval path)", () => {
		expect(experimentConfigsMap.PREVENT_FOCUS_DISRUPTION).toBeDefined()
		expect(experimentConfigsMap.PREVENT_FOCUS_DISRUPTION.enabled).toBe(true)
	})

	it("should have PREVENT_FOCUS_DISRUPTION enabled in experimentDefault", () => {
		expect(experimentDefault.preventFocusDisruption).toBe(true)
	})

	it("should correctly check if PREVENT_FOCUS_DISRUPTION is enabled", () => {
		// Test when experiment is disabled (default)
		const disabledConfig = { preventFocusDisruption: false }
		expect(experiments.isEnabled(disabledConfig, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)).toBe(false)

		// Test when experiment is enabled
		const enabledConfig = { preventFocusDisruption: true }
		expect(experiments.isEnabled(enabledConfig, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)).toBe(true)

		// Test when experiment is not in config (should use default — now enabled)
		const emptyConfig = {}
		expect(experiments.isEnabled(emptyConfig, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)).toBe(true)
	})
})
