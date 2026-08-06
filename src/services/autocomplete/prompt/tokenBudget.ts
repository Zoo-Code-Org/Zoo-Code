import type { AutocompleteSnippet } from "../types"

/**
 * Rough token estimate: ~4 chars per token with a small fudge for code (which
 * tends to be denser per token than prose). Deliberately *under*-estimates so the
 * prompt budget is conservative and we never silently drop needed context.
 */
export function estimateTokens(text: string): number {
	if (text.length === 0) {
		return 0
	}

	return Math.ceil((text.length / 3.5) * 1.2)
}

export interface PrunedSnippets {
	readonly snippets: AutocompleteSnippet[]
	readonly dropped: number
}

/**
 * Prunes snippets to fit a token budget, keeping the most valuable first.
 *
 * Phase 2 has no snippets (same-file only); Phase 4 supplies the sources. The
 * prune order is stable: sources already arrive in priority order (recently-edited
 * → open-tabs → import-definitions), so we keep them in order and drop from the
 * tail until the budget is met, then trim the last-kept snippet's trailing chars.
 */
export function pruneSnippets(snippets: readonly AutocompleteSnippet[], budgetTokens: number): PrunedSnippets {
	const kept: AutocompleteSnippet[] = []
	let used = 0

	for (const snippet of snippets) {
		const cost = estimateTokens(snippet.content)

		if (used + cost > budgetTokens) {
			const remaining = Math.max(0, budgetTokens - used)

			if (remaining < 8) {
				// Not worth trimming; drop the rest.
				break
			}

			const maxChars = Math.floor(remaining * 3.5)
			kept.push({ ...snippet, content: snippet.content.slice(0, maxChars) })
			used += remaining
			break
		}

		kept.push(snippet)
		used += cost
	}

	return { snippets: kept, dropped: snippets.length - kept.length }
}

/**
 * Trims text to a token budget from the end nearest the cursor.
 * Prefixes keep their tail (the part right before the cursor); suffixes keep
 * their head (the part right after).
 */
export function trimToTokenBudget(text: string, budgetTokens: number, from: "tail" | "head"): string {
	const maxChars = Math.ceil(budgetTokens * 3.5)

	if (text.length <= maxChars) {
		return text
	}

	return from === "tail" ? text.slice(text.length - maxChars) : text.slice(0, maxChars)
}
