// npx vitest run shared/__tests__/reasoning-mode-compatibility.spec.ts

import { isStrictReasoningModeProvider, modeSwitchRisksReasoningIncompatibility } from "../reasoning-mode-compatibility"

describe("isStrictReasoningModeProvider", () => {
	it("returns true for deepseek", () => {
		expect(isStrictReasoningModeProvider("deepseek")).toBe(true)
	})

	it("returns true for zai", () => {
		expect(isStrictReasoningModeProvider("zai")).toBe(true)
	})

	it("returns true for mimo", () => {
		expect(isStrictReasoningModeProvider("mimo")).toBe(true)
	})

	it("returns false for anthropic", () => {
		expect(isStrictReasoningModeProvider("anthropic")).toBe(false)
	})

	it("returns false for undefined", () => {
		expect(isStrictReasoningModeProvider(undefined)).toBe(false)
	})

	it("returns false for a non-strict provider", () => {
		expect(isStrictReasoningModeProvider("openai-native")).toBe(false)
	})

	it("returns false for gemini", () => {
		expect(isStrictReasoningModeProvider("gemini")).toBe(false)
	})
})

describe("modeSwitchRisksReasoningIncompatibility", () => {
	it("returns false when from and to are the same provider", () => {
		expect(modeSwitchRisksReasoningIncompatibility("deepseek", "deepseek")).toBe(false)
		expect(modeSwitchRisksReasoningIncompatibility("anthropic", "anthropic")).toBe(false)
		expect(modeSwitchRisksReasoningIncompatibility("zai", "zai")).toBe(false)
	})

	it("returns true when switching from non-strict to strict provider", () => {
		expect(modeSwitchRisksReasoningIncompatibility("anthropic", "deepseek")).toBe(true)
		expect(modeSwitchRisksReasoningIncompatibility("openai-native", "zai")).toBe(true)
		expect(modeSwitchRisksReasoningIncompatibility("gemini", "mimo")).toBe(true)
	})

	it("returns false when switching from strict to non-strict provider", () => {
		expect(modeSwitchRisksReasoningIncompatibility("deepseek", "anthropic")).toBe(false)
		expect(modeSwitchRisksReasoningIncompatibility("zai", "openai-native")).toBe(false)
		expect(modeSwitchRisksReasoningIncompatibility("mimo", "gemini")).toBe(false)
	})

	it("returns false when switching between two strict providers", () => {
		expect(modeSwitchRisksReasoningIncompatibility("deepseek", "zai")).toBe(false)
		expect(modeSwitchRisksReasoningIncompatibility("zai", "mimo")).toBe(false)
		expect(modeSwitchRisksReasoningIncompatibility("mimo", "deepseek")).toBe(false)
	})

	it("returns true when going from undefined (unknown) provider to a strict provider (fail-safe)", () => {
		expect(modeSwitchRisksReasoningIncompatibility(undefined, "deepseek")).toBe(true)
	})

	it("returns false when going from strict to undefined", () => {
		expect(modeSwitchRisksReasoningIncompatibility("deepseek", undefined)).toBe(false)
	})

	it("returns false when both are undefined", () => {
		expect(modeSwitchRisksReasoningIncompatibility(undefined, undefined)).toBe(false)
	})
})
