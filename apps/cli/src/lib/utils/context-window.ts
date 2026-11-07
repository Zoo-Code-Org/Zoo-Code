const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * Resolves the context window to display for the current model.
 *
 * The extension resolves the model through its provider handler and posts the result as
 * `ExtensionState.contextWindow`, so this covers static and router providers alike.
 *
 * @param contextWindow - The context window reported by the extension state, if any
 * @returns The reported context window, or DEFAULT_CONTEXT_WINDOW (200K) when it is missing or invalid
 */
export function getContextWindow(contextWindow: number | null | undefined): number {
	// Reject non-finite values (NaN, Infinity) as well as non-positive ones, so the
	// progress bar never divides by an infinite window and reports 0% usage.
	return typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow > 0
		? contextWindow
		: DEFAULT_CONTEXT_WINDOW
}

export { DEFAULT_CONTEXT_WINDOW }
