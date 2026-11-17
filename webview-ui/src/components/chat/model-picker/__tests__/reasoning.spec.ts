import { providerIdentifiers, type ModelInfo, type ProviderSettings } from "@roo-code/types"

import { createReasoningPatch, getReasoningSelection, type ReasoningOption } from "../reasoning"

const base: ModelInfo = { contextWindow: 128_000, supportsPromptCache: false }
const config: ProviderSettings = { apiProvider: providerIdentifiers.openaiNative }

describe("getReasoningSelection", () => {
	it.each([
		{
			name: "optional boolean",
			info: { supportsReasoningEffort: true },
			options: ["disable", "low", "medium", "high"],
			current: "disable",
			enabled: false,
		},
		{
			name: "required boolean",
			info: { supportsReasoningEffort: true, requiredReasoningEffort: true },
			options: ["low", "medium", "high"],
			current: "medium",
			enabled: true,
		},
		{
			name: "explicit array",
			info: { supportsReasoningEffort: ["none", "xhigh"], reasoningEffort: "xhigh" },
			options: ["none", "xhigh"],
			current: "xhigh",
			enabled: true,
		},
		{
			name: "invalid default",
			info: { supportsReasoningEffort: ["low", "high"], reasoningEffort: "xhigh" },
			options: ["low", "high"],
			current: "low",
			enabled: true,
		},
		{
			name: "required array",
			info: { supportsReasoningEffort: ["disable", "high"], requiredReasoningEffort: true },
			options: ["high"],
			current: "high",
			enabled: true,
		},
		{ name: "empty array", info: { supportsReasoningEffort: [] }, options: [], current: undefined, enabled: false },
		{ name: "unsupported", info: {}, options: [], current: undefined, enabled: false },
	] satisfies {
		name: string
		info: Partial<ModelInfo>
		options: ReasoningOption[]
		current: ReasoningOption | undefined
		enabled: boolean
	}[])("normalizes $name", ({ info, options, current, enabled }) => {
		expect(getReasoningSelection(config, { ...base, ...info })).toEqual({
			supportedOptions: options,
			currentEffort: current,
			reasoningEnabled: enabled,
		})
	})

	it.each([
		{ stored: "none", flag: true, current: "none", enabled: true },
		{ stored: "disable", flag: true, current: "disable", enabled: false },
		{ stored: "high", flag: false, current: "disable", enabled: false },
		{ stored: undefined, flag: undefined, current: "high", enabled: true },
		{ stored: "xhigh", flag: undefined, current: "high", enabled: true },
	] satisfies {
		stored: ProviderSettings["reasoningEffort"]
		flag: boolean | undefined
		current: ReasoningOption
		enabled: boolean
	}[])("resolves stored $stored / enabled $flag", ({ stored, flag, current, enabled }) => {
		const info: ModelInfo = {
			...base,
			supportsReasoningEffort: ["disable", "none", "low", "high"],
			reasoningEffort: "high",
		}
		expect(
			getReasoningSelection({ ...config, reasoningEffort: stored, enableReasoningEffort: flag }, info),
		).toMatchObject({ currentEffort: current, reasoningEnabled: enabled })
	})

	it("does not invent disable for arrays, but honors a false flag", () => {
		expect(
			getReasoningSelection(
				{ ...config, enableReasoningEffort: false },
				{ ...base, supportsReasoningEffort: ["none", "high"] },
			),
		).toEqual({ supportedOptions: ["none", "high"], currentEffort: undefined, reasoningEnabled: false })
	})

	it("required effort overrides stale disabled settings", () => {
		expect(
			getReasoningSelection(
				{ ...config, enableReasoningEffort: false, reasoningEffort: "disable" },
				{
					...base,
					supportsReasoningEffort: ["low", "high"],
					requiredReasoningEffort: true,
					reasoningEffort: "high",
				},
			),
		).toMatchObject({ currentEffort: "high", reasoningEnabled: true })
	})

	it.each([undefined, false, true])(
		"exposes manual OpenAI settings with enabled=%s even without capabilities",
		(flag) => {
			const manual: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				enableReasoningEffort: flag,
				reasoningEffort: "low",
				openAiCustomModelInfo: { ...base, reasoningEffort: "xhigh" },
			}
			expect(getReasoningSelection(manual, base)).toEqual({
				supportedOptions: ["disable", "low", "medium", "high", "xhigh", "max"],
				currentEffort: flag ? "xhigh" : "disable",
				reasoningEnabled: flag === true,
			})
		},
	)

	it("manual OpenAI default matches the Settings control", () => {
		expect(
			getReasoningSelection({ apiProvider: providerIdentifiers.openai, enableReasoningEffort: true }, base),
		).toMatchObject({ currentEffort: "low", reasoningEnabled: true })
	})

	it.each([
		{ info: { supportsReasoningBinary: true }, enabled: false },
		{ info: { supportsReasoningBinary: true }, enabled: true },
		{ info: { supportsReasoningBudget: true }, enabled: true },
		{ info: { supportsReasoningBudget: true, requiredReasoningBudget: true }, enabled: false },
	] satisfies { info: Partial<ModelInfo>; enabled: boolean }[])(
		"does not invent effort options for binary/budget reasoning",
		({ info, enabled }) => {
			expect(getReasoningSelection({ ...config, enableReasoningEffort: enabled }, { ...base, ...info })).toEqual({
				supportedOptions: [],
				currentEffort: undefined,
				reasoningEnabled: info.requiredReasoningBudget === true || enabled,
			})
		},
	)
})

describe("createReasoningPatch", () => {
	it.each(["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const)(
		"enables the wire effort %s",
		(effort) => {
			expect(createReasoningPatch(config, effort)).toEqual({
				reasoningEffort: effort,
				enableReasoningEffort: true,
			})
		},
	)

	it.each(["disable", null] as const)("keeps disable and reset %s distinct", (effort) => {
		expect(createReasoningPatch(config, effort)).toEqual({
			reasoningEffort: effort,
			enableReasoningEffort: effort === null ? null : false,
		})
	})

	it.each(["low", "xhigh"] as const)("accepts a capability-advertised %s", (effort) => {
		expect(createReasoningPatch(config, effort, { ...base, supportsReasoningEffort: ["low", "xhigh"] })).toEqual({
			reasoningEffort: effort,
			enableReasoningEffort: true,
		})
	})

	it.each(["disable", "none", "minimal", "medium", "high", "max"] as const)("rejects unadvertised %s", (effort) => {
		expect(() =>
			createReasoningPatch(config, effort, {
				...base,
				supportsReasoningEffort: ["low", "xhigh"],
				requiredReasoningEffort: true,
			}),
		).toThrow("Unsupported")
	})

	it("rejects efforts for a non-reasoning model", () => {
		expect(() => createReasoningPatch(config, "low", base)).toThrow("Unsupported")
	})

	it.each(["low", "medium", "high", "xhigh", "max", "disable", null] as const)(
		"patches only custom OpenAI effort for %s",
		(effort) => {
			const manual: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				openAiCustomModelInfo: { ...base, maxTokens: 123, reasoningEffort: "high" },
			}
			const before = structuredClone(manual)
			expect(createReasoningPatch(manual, effort)).toEqual({
				reasoningEffort: null,
				enableReasoningEffort: effort === null ? null : effort !== "disable",
				openAiCustomModelInfo: { reasoningEffort: effort === "disable" ? null : effort },
			})
			expect(manual).toEqual(before)
		},
	)

	it.each(["none", "minimal"] as const)("rejects %s not offered by manual OpenAI settings", (effort) => {
		expect(() => createReasoningPatch({ apiProvider: providerIdentifiers.openai }, effort)).toThrow("Unsupported")
	})
})
