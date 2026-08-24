import type { ModelInfo, ProviderSettings } from "@roo-code/types"

/**
 * F7: fill-in-the-gap resolution of user-declared reasoning effort capability.
 *
 * Self-hosted / OpenAI-compatible models (custom OpenAI endpoints, LM Studio,
 * Ollama, and similar) do not advertise `supportsReasoningEffort` in the model
 * registry, so the dynamic thinking effort feature is disabled for them. A
 * profile can declare the canonical effort levels its model supports via the
 * `supportedReasoningEfforts` provider setting.
 *
 * Resolution rule (single semantic, mirrored on the webview side by
 * `resolveReasoningEffortCapability` in webview-ui/src/utils/thinkingEffort.ts):
 * when the resolved ModelInfo has no `supportsReasoningEffort` of its own
 * (`undefined`) AND the profile declares a non-empty
 * `supportedReasoningEfforts`, the model is treated as supporting exactly that
 * array. Registry values are NEVER overridden — this is a fill-in-the-gap only,
 * so models that already advertise a capability (boolean or array) keep it.
 *
 * The helper is pure and non-mutating: it returns the original ModelInfo when
 * nothing is filled in (callers may share catalog objects).
 */
export function withDeclaredReasoningEffort(modelInfo: ModelInfo, settings: ProviderSettings | undefined): ModelInfo {
	if (modelInfo.supportsReasoningEffort !== undefined) {
		return modelInfo
	}

	const declared = settings?.supportedReasoningEfforts
	if (!Array.isArray(declared) || declared.length === 0) {
		return modelInfo
	}

	return { ...modelInfo, supportsReasoningEffort: [...declared] }
}
