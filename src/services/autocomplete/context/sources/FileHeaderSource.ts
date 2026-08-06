import type { ResolvedAutocompleteConfig } from "@roo-code/types"

import type { AutocompleteSnippet } from "../../types"
import type { SnippetSource, SnippetSourceInput } from "../ContextGatherer"

/**
 * Supplies the current file's import block and top-level signatures.
 *
 * This is the cheapest and highest-value context there is. Without it a model
 * asked to complete `def calculate_mean` invents plausible-looking types it has
 * no basis for — `data: List[C]` referencing a `List` that was never imported
 * and a `C` that does not exist. Shown the real header it uses what is actually
 * in scope, or omits the annotation entirely.
 *
 * It reads only the text already in memory, so it costs no I/O and always
 * resolves inside the context budget.
 */
export class FileHeaderSource implements SnippetSource {
	readonly id = "file-header"

	isEnabled(config: ResolvedAutocompleteConfig): boolean {
		return config.useImportDefinitions
	}

	async gather(input: SnippetSourceInput): Promise<AutocompleteSnippet[]> {
		const { document, position } = input
		const snippets: AutocompleteSnippet[] = []

		// The windowed prefix may start below the imports on a long file, in which
		// case the model never sees them — the exact cause of invented types.
		const header = collectHeader(document.getText(), position.line)

		if (header.length > 0) {
			snippets.push({
				content: header,
				filePath: document.uri.fsPath,
				score: 1,
				source: this.id,
			})
		}

		return snippets
	}
}

/**
 * Collects import statements from the top of the file.
 *
 * Scans a bounded number of lines and stops at the first substantial run of
 * non-import code, so a file whose imports are interleaved with early
 * definitions still yields its header without walking the whole document.
 */
function collectHeader(text: string, cursorLine: number): string {
	const lines = text.split("\n")
	const limit = Math.min(lines.length, MAX_HEADER_LINES)
	const collected: string[] = []
	let sinceLastImport = 0

	for (let i = 0; i < limit; i++) {
		// Never echo the line being edited back as "context".
		if (i === cursorLine) {
			continue
		}

		const line = lines[i]

		if (IMPORT_LINE.test(line)) {
			collected.push(line)
			sinceLastImport = 0
			continue
		}

		if (line.trim().length === 0) {
			continue
		}

		if (++sinceLastImport > MAX_GAP_LINES) {
			break
		}
	}

	return collected.join("\n")
}

/** Import forms across the languages this feature is likely to meet. */
const IMPORT_LINE =
	/^\s*(import\s|from\s+[\w.]+\s+import\s|#include\s|using\s+[\w.]+;|require\s*\(|const\s+\{[^}]*\}\s*=\s*require\s*\(|package\s+[\w.]+;|use\s+[\w:]+;)/

const MAX_HEADER_LINES = 200
const MAX_GAP_LINES = 40
