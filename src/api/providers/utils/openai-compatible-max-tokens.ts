import { DEFAULT_OPEN_AI_INCLUDE_MAX_TOKENS, type ModelInfo } from "@roo-code/types"

type MaxTokensOptions = {
	includeMaxTokens?: boolean | null
	modelMaxTokens?: number | null
}

/**
 * Returns the output-token limit to send for an OpenAI Compatible request.
 * An unset or null includeMaxTokens follows the checkbox default (checked).
 * Only positive limits are returned: profiles saved before #1847 can store
 * maxTokens: -1, which strict providers reject.
 */
export function resolveOpenAiCompatibleMaxTokens(
	options: Readonly<MaxTokensOptions>,
	modelInfo: Readonly<Pick<ModelInfo, "maxTokens">>,
): number | undefined {
	if (!(options.includeMaxTokens ?? DEFAULT_OPEN_AI_INCLUDE_MAX_TOKENS)) {
		return undefined
	}
	return [options.modelMaxTokens, modelInfo.maxTokens].find(
		(value): value is number => typeof value === "number" && value > 0,
	)
}
