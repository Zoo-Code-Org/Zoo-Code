/**
 * Providers/models known to require reasoning_content on every tool-call
 * turn once their "thinking" mode is active. Mirrors preserveReasoning
 * in @roo-code/types model definitions — kept here as an explicit allowlist
 * so orchestration-level checks don't need to resolve full ModelInfo.
 *
 * Must be kept in sync with providers that have at least one model with
 * `preserveReasoning: true` and are covered by the Layer 1 guard in
 * `src/api/providers/utils/reasoning-history-guard.ts`.
 */
const STRICT_REASONING_MODE_PROVIDERS = new Set(["deepseek", "zai", "mimo"])

/**
 * Returns `true` if the given provider name is one of the known strict-
 * reasoning providers that enforce `reasoning_content` on tool-call turns.
 */
export function isStrictReasoningModeProvider(provider: string | undefined): boolean {
	return !!provider && STRICT_REASONING_MODE_PROVIDERS.has(provider)
}

/**
 * True when switching from `fromProvider` to `toProvider` risks carrying
 * over a conversation history that is incompatible with the target
 * provider's strict reasoning-mode formatting requirements — i.e. the
 * target enforces reasoning_content on tool-call turns but the source
 * provider's history was never built with that field.
 *
 * Returns `false` when switching within the same provider family (no
 * format mismatch) or when neither provider is strict.
 */
export function modeSwitchRisksReasoningIncompatibility(
	fromProvider: string | undefined,
	toProvider: string | undefined,
): boolean {
	if (fromProvider === toProvider) return false
	return isStrictReasoningModeProvider(toProvider) && !isStrictReasoningModeProvider(fromProvider)
}
