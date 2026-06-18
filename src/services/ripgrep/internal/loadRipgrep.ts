/**
 * Loads `@vscode/ripgrep` via CommonJS `require()`. Lives in its own
 * module so unit tests can `vi.mock` the wrapper — vitest's mock registry
 * hooks the import graph, not Node's native CJS resolver, and
 * `@vscode/ripgrep` resolves through the latter at test time because it's
 * a real devDep installed in `node_modules`.
 *
 * On require failure returns `{ loadError }` so the diagnostic can surface
 * the actual error message instead of dropping it.
 */
export type LoadRipgrepResult = { rgPath?: string; loadError?: string }

export function loadRipgrep(): LoadRipgrepResult | undefined {
	try {
		return require("@vscode/ripgrep") as LoadRipgrepResult
	} catch (error) {
		return {
			loadError: error instanceof Error ? error.message : String(error),
		}
	}
}
