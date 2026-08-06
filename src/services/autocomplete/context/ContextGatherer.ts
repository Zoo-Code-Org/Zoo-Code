import * as vscode from "vscode"

import type { ResolvedAutocompleteConfig } from "@roo-code/types"

import type { AutocompleteSnippet } from "../types"

export interface SnippetSourceInput {
	readonly document: vscode.TextDocument
	readonly position: vscode.Position
	readonly prefix: string
	readonly suffix: string
}

export interface SnippetSource {
	readonly id: string
	isEnabled(config: ResolvedAutocompleteConfig): boolean
	gather(input: SnippetSourceInput, signal: AbortSignal): Promise<AutocompleteSnippet[]>
}

/**
 * Runs every enabled snippet source against a wall-clock budget.
 *
 * Sources are raced, never awaited in sequence: a slow language server must not
 * hold up a completion, and a source that throws must not take the others with
 * it. Whatever has arrived when the budget expires is what gets used.
 */
export class ContextGatherer {
	constructor(private readonly sources: readonly SnippetSource[]) {}

	async gather(
		input: SnippetSourceInput,
		config: ResolvedAutocompleteConfig,
		budgetMs: number,
	): Promise<AutocompleteSnippet[]> {
		const enabled = this.sources.filter((source) => source.isEnabled(config))

		if (enabled.length === 0) {
			return []
		}

		const controller = new AbortController()
		const collected: AutocompleteSnippet[][] = []

		const running = enabled.map(async (source, index) => {
			try {
				collected[index] = await source.gather(input, controller.signal)
			} catch {
				// One broken source must not deny the user every other kind of
				// context; an empty contribution is the correct degradation.
				collected[index] = []
			}
		})

		// Race the sources against the budget rather than awaiting them. A source
		// that ignores its abort signal keeps running, but its result is simply not
		// waited for — context that arrives after the next keystroke is worthless.
		let timer: ReturnType<typeof setTimeout> | undefined

		const budget = new Promise<void>((resolve) => {
			timer = setTimeout(() => {
				controller.abort()
				resolve()
			}, budgetMs)
		})

		try {
			await Promise.race([Promise.all(running), budget])
		} finally {
			clearTimeout(timer)
			controller.abort()
		}

		return dedupe(collected.filter(Boolean).flat())
	}
}

/**
 * Removes snippets with identical content, keeping the highest-scoring copy.
 *
 * The same definition legitimately arrives from more than one source (an import
 * that is also an open tab), and paying for it twice in the token budget crowds
 * out context the model has not already seen.
 */
function dedupe(snippets: AutocompleteSnippet[]): AutocompleteSnippet[] {
	const byContent = new Map<string, AutocompleteSnippet>()

	for (const snippet of snippets) {
		const key = snippet.content.trim()
		const existing = byContent.get(key)

		if (!existing || (snippet.score ?? 0) > (existing.score ?? 0)) {
			byContent.set(key, snippet)
		}
	}

	return [...byContent.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}
