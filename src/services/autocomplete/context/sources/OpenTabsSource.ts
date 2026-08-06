import * as vscode from "vscode"

import type { ResolvedAutocompleteConfig } from "@roo-code/types"

import type { AutocompleteSnippet } from "../../types"
import type { SnippetSource, SnippetSourceInput } from "../ContextGatherer"

/**
 * Supplies top-level signatures from other open editors.
 *
 * Open tabs are a strong proxy for relevance: they are what the user is working
 * on right now. Only declaration lines are taken, never whole files — the point
 * is to tell the model which functions and classes exist, not to spend the
 * entire token budget on one neighbouring file's implementation details.
 */
export class OpenTabsSource implements SnippetSource {
	readonly id = "open-tabs"

	isEnabled(config: ResolvedAutocompleteConfig): boolean {
		return config.useOpenTabs
	}

	async gather(input: SnippetSourceInput, signal: AbortSignal): Promise<AutocompleteSnippet[]> {
		const current = input.document.uri.toString()
		const snippets: AutocompleteSnippet[] = []

		for (const editor of vscode.window.visibleTextEditors) {
			if (signal.aborted || snippets.length >= MAX_TABS) {
				break
			}

			const document = editor.document

			if (document.uri.toString() === current || document.uri.scheme !== "file") {
				continue
			}

			// Only same-language files: a Python completion learns nothing from a
			// JSON config, and the token budget is better spent elsewhere.
			if (document.languageId !== input.document.languageId) {
				continue
			}

			const declarations = collectDeclarations(document.getText())

			if (declarations.length > 0) {
				snippets.push({
					content: `# ${vscode.workspace.asRelativePath(document.uri)}\n${declarations.join("\n")}`,
					filePath: document.uri.fsPath,
					score: 0.5,
					source: this.id,
				})
			}
		}

		return snippets
	}
}

/** Top-level declaration lines, capped so one large file cannot dominate. */
function collectDeclarations(text: string): string[] {
	const found: string[] = []

	for (const line of text.split("\n")) {
		if (found.length >= MAX_DECLARATIONS_PER_TAB) {
			break
		}

		// Anchored to column zero: nested definitions are implementation detail.
		if (DECLARATION_LINE.test(line)) {
			found.push(line.trimEnd())
		}
	}

	return found
}

const DECLARATION_LINE =
	/^(export\s+)?(async\s+)?(def|class|function|interface|type|struct|enum|const|fn|public\s+\w+)\s+[\w$]/

const MAX_TABS = 5
const MAX_DECLARATIONS_PER_TAB = 30
