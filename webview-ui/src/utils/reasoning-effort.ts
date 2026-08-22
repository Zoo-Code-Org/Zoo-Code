import type { ModelInfo } from "@roo-code/types/model"
import type { ProviderSettings } from "@roo-code/types"
import type { ReasoningEffortExtended } from "@roo-code/types/model"

// "disable" turns reasoning off entirely; "none" is a real reasoning level.
// Both render with the same "None" label in the UI, and arrays from
// supportsReasoningEffort may include "disable" (e.g. Z.ai GLM).
export type ReasoningEffortOption = ReasoningEffortExtended | "disable"

// The base effort levels for `supportsReasoningEffort === true`. Inlined here
// (rather than imported from `@roo-code/types/model`) because that module
// evaluates a Zod schema at import time, which the Playwright CT Vite build
// externalizes (`z` is not defined at runtime). Keeping this a local const makes
// the util CT-safe for visual tests that render ReasoningEffortSelector, while
// staying behavior-identical to the exported `reasoningEfforts` constant — if
// the source set changes in `packages/types/src/model.ts`, update this too.
const BASE_REASONING_EFFORTS = ["low", "medium", "high"] as const

export interface ReasoningEffortSelection {
	isReasoningEffortSupported: boolean
	availableOptions: ReadonlyArray<ReasoningEffortOption>
	currentReasoningEffort: ReasoningEffortOption
	storedReasoningEffort: ReasoningEffortOption | undefined
}

/**
 * Computes the reasoning-effort dropdown state shared by every selector in the
 * app (Providers settings tab, per-provider settings, chat input bar). All
 * selectors must agree on the option set and clamping so they never show
 * different values for the same stored field.
 *
 * Capability surface:
 * - modelInfo.supportsReasoningEffort: true → options ["low","medium","high"]
 * - array → options are exactly the provided values
 * - "disable" is prepended only when supportsReasoningEffort is boolean true
 *   and requiredReasoningEffort is not set; explicit arrays are respected as-is.
 *
 * The stored value is clamped to the option set so the trigger always renders
 * a valid option.
 */
export function getReasoningEffortSelection(
	apiConfiguration: ProviderSettings | undefined,
	modelInfo: ModelInfo | undefined,
): ReasoningEffortSelection {
	const isReasoningEffortSupported = !!modelInfo && !!modelInfo.supportsReasoningEffort

	const supports = modelInfo?.supportsReasoningEffort
	const baseAvailableOptions: ReadonlyArray<ReasoningEffortOption> =
		supports === true
			? (BASE_REASONING_EFFORTS as readonly ReasoningEffortOption[])
			: Array.isArray(supports)
				? (supports as ReadonlyArray<ReasoningEffortOption>)
				: (BASE_REASONING_EFFORTS as readonly ReasoningEffortOption[])

	// Add "disable" option only when:
	// 1. requiredReasoningEffort is not true, AND
	// 2. supportsReasoningEffort is boolean true (not an explicit array)
	// When the model provides an explicit array, respect those exact values.
	const shouldAutoAddDisable =
		!modelInfo?.requiredReasoningEffort && supports === true && !baseAvailableOptions.includes("disable")
	const availableOptions: ReadonlyArray<ReasoningEffortOption> = shouldAutoAddDisable
		? ["disable", ...baseAvailableOptions]
		: baseAvailableOptions

	// Default reasoning effort - use model's default if available
	// GPT-5 models have "medium" as their default in the model configuration
	const modelDefaultReasoningEffort = modelInfo?.reasoningEffort as ReasoningEffortExtended | undefined
	const defaultReasoningEffort: ReasoningEffortOption = modelInfo?.requiredReasoningEffort
		? modelDefaultReasoningEffort || "medium"
		: "disable"
	// Current reasoning effort from settings, or fall back to default.
	// Clamp to availableOptions so the Select trigger always renders a valid option.
	const storedReasoningEffort = apiConfiguration?.reasoningEffort as ReasoningEffortOption | undefined
	const rawReasoningEffort: ReasoningEffortOption = storedReasoningEffort || defaultReasoningEffort
	const fallbackReasoningEffort = availableOptions.includes(defaultReasoningEffort)
		? defaultReasoningEffort
		: (availableOptions[0] ?? rawReasoningEffort)
	const currentReasoningEffort: ReasoningEffortOption = availableOptions.includes(rawReasoningEffort)
		? rawReasoningEffort
		: fallbackReasoningEffort

	return { isReasoningEffortSupported, availableOptions, currentReasoningEffort, storedReasoningEffort }
}

/**
 * Builds the `ModelInfo` the Ollama settings page and chat selector feed into
 * `getReasoningEffortSelection`. This is the single shared Ollama normalization
 * so both surfaces advertise the same options and can't drift.
 *
 * Ollama reasoning levels are model-specific (see the fetcher's
 * `getOllamaThinkingEfforts`). When the selected model has already advertised a
 * capability array (e.g. qwen3 → ["disable","low","medium","high","max"],
 * gpt-oss → ["low","medium","high"]), it is passed through verbatim — no UI-side
 * "none"/"disable" prepend. The fetcher is responsible for including "disable"
 * in that array only for models that honor `think: false`, so off-support is
 * modeled explicitly per model rather than bolted on in the UI.
 *
 * When no model info has loaded yet (router still loading, or a local model
 * without thinking metadata), synthesize a fallback exposing the levels the
 * Ollama native `think` parameter supports by default, including "disable" so
 * the dropdown is usable immediately on app boot. The fallback is
 * self-contained (it does not import `ollamaDefaultModelInfo`, which lives in a
 * Zod-evaluating module) so this util stays Playwright-CT-safe for visual tests
 * that render ReasoningEffortSelector. `defaultModelInfo` is optional and only
 * spread when a caller (e.g. the settings page, which already imports it) wants
 * to preserve the full default ModelInfo shape.
 */
export function getOllamaReasoningModelInfo(
	selectedModelInfo: ModelInfo | undefined,
	defaultModelInfo?: ModelInfo,
): ModelInfo {
	if (selectedModelInfo?.supportsReasoningEffort) {
		// Preserve the advertised array exactly; do not prepend "none" or
		// "disable". The fetcher already includes "disable" for models that
		// honor think: false and omits it for models that don't (gpt-oss).
		return selectedModelInfo
	}

	return {
		// Minimal fallback shape for the reasoning selector; matches the
		// reasoning-relevant fields of ollamaDefaultModelInfo without importing
		// the Zod-evaluating providers/ollama module.
		contextWindow: defaultModelInfo?.contextWindow ?? 200_000,
		supportsPromptCache: defaultModelInfo?.supportsPromptCache ?? true,
		supportsReasoningEffort: ["disable", "low", "medium", "high"],
	}
}

/**
 * Maps a reasoning-effort option to its translation key. Both "disable" and
 * "none" display as "None" per UX, but "disable" omits reasoning parameters
 * while "none" sends an explicit none level.
 */
export function getReasoningEffortTranslationKey(option: ReasoningEffortOption): string {
	return option === "none" || option === "disable"
		? "settings:providers.reasoningEffort.none"
		: `settings:providers.reasoningEffort.${option}`
}
