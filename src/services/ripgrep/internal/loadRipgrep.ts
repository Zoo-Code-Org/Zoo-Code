/**
 * Loads `@vscode/ripgrep` via CommonJS `require()`. Lives in its own
 * module so unit tests can `vi.mock` the wrapper — vitest's mock registry
 * hooks the import graph, not Node's native CJS resolver, and
 * `@vscode/ripgrep` resolves through the latter at test time because it's
 * a real devDep installed in `node_modules`.
 *
 * Returns `undefined` if the package can't be loaded for any reason.
 */
export function loadRipgrep(): { rgPath?: string } | undefined {
	try {
		return require("@vscode/ripgrep") as { rgPath?: string }
	} catch {
		return undefined
	}
}
