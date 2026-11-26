import { resolveOpenAiCompatibleMaxTokens } from "../openai-compatible-max-tokens"

const limits = [
	{ custom: 456, model: 1000, enabled: 456 },
	{ custom: undefined, model: 1000, enabled: 1000 },
	{ custom: 0, model: 1000, enabled: 1000 },
	{ custom: undefined, model: -1, enabled: undefined },
	{ custom: -1, model: 1000, enabled: 1000 },
	{ custom: undefined, model: undefined, enabled: undefined },
]

const cases = [undefined, null, true, false].flatMap((include) =>
	limits.map(({ custom, model, enabled }) => ({
		include,
		custom,
		model,
		expected: include === false ? undefined : enabled,
	})),
)

it.each(cases)("resolves the output limit: %j", ({ include, custom, model, expected }) => {
	expect(
		resolveOpenAiCompatibleMaxTokens({ includeMaxTokens: include, modelMaxTokens: custom }, { maxTokens: model }),
	).toBe(expected)
})
