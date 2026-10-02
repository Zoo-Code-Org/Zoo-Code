// npx vitest run src/api/transform/__tests__/dte-effective-reasoning-effort.spec.ts

import { ADAPTIVE_OUTPUT_CONFIG_EFFORTS, resolveEffectiveReasoningEffort } from "../reasoning"

describe("DTE series 2/5 — resolveEffectiveReasoningEffort", () => {
	const settingsEffort = "high"
	const modelDefault = "medium"

	it("returns the per-request override when present (strongest precedence)", () => {
		expect(
			resolveEffectiveReasoningEffort({
				override: "xhigh",
				settingsReasoningEffort: settingsEffort,
				modelDefaultEffort: modelDefault,
			}),
		).toBe("xhigh")
	})

	it("lets the override win even when it is out-of-range for the adaptive envelope", () => {
		// "minimal" is a valid override value but outside the adaptive envelope set;
		// resolution still returns it — envelope gating is the caller's concern.
		expect(
			resolveEffectiveReasoningEffort({
				override: "minimal",
				settingsReasoningEffort: settingsEffort,
				modelDefaultEffort: modelDefault,
			}),
		).toBe("minimal")
	})

	it("falls back to the settings value when no override is present", () => {
		expect(
			resolveEffectiveReasoningEffort({ settingsReasoningEffort: "low", modelDefaultEffort: modelDefault }),
		).toBe("low")
	})

	it("preserves the settings 'disable' sentinel when no override is present", () => {
		expect(
			resolveEffectiveReasoningEffort({ settingsReasoningEffort: "disable", modelDefaultEffort: modelDefault }),
		).toBe("disable")
	})

	it("an explicit override wins over a settings 'disable' sentinel", () => {
		expect(resolveEffectiveReasoningEffort({ override: "low", settingsReasoningEffort: "disable" })).toBe("low")
	})

	it("falls back to the model default when neither override nor settings is set", () => {
		expect(resolveEffectiveReasoningEffort({ modelDefaultEffort: "low" })).toBe("low")
	})

	it("returns undefined when nothing is set", () => {
		expect(resolveEffectiveReasoningEffort({})).toBeUndefined()
	})

	it("exposes exactly the in-range adaptive envelope efforts", () => {
		expect([...ADAPTIVE_OUTPUT_CONFIG_EFFORTS]).toEqual(["low", "medium", "high", "xhigh", "max"])
	})
})
