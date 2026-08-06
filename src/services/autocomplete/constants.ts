/**
 * Inline autocomplete (ghost text) constants.
 *
 * Latency budgets mirror the plan: first ghost text should appear within ~350 ms
 * of the last keystroke, of which ~120 ms is the wall-clock budget shared by all
 * context sources.
 */

/** Keystrokes with multiple cursors active are rejected up front. */
export const MAX_CURSORS = 1

/** Largest document (bytes) the completion pipeline will consider. */
export const MAX_DOCUMENT_BYTES = 1_048_576

/**
 * Languages that are never worth completing, regardless of the user's
 * `disabledLanguages` override. The overridable list lives in the config.
 */
export const DEFAULT_DISABLED_LANGUAGES = ["markdown", "plaintext", "log", "jsonc"] as const

export const AUTOCOMPLETE_OUTPUT_CHANNEL_NAME = "Zoo-Code Autocomplete"
