/**
 * Browser-safe stand-ins for the Node builtins that `src/i18n/setup.ts`
 * imports at module top level (`node:url`, `node:fs`, `node:path`).
 *
 * In a browser/Vite-dev context those builtins resolve to Vite's
 * `__vite-browser-external` proxy, which THROWS when the interop prelude
 * evaluates `nodeUrl["fileURLToPath"]` — i.e. merely importing setup.ts
 * crashes the whole gallery module graph, even though the disk-fallback
 * functions are never called there (the browser side always takes the
 * `import.meta.glob` branch). Aliasing the builtins to this module keeps the
 * imports resolvable and defers any actual use to a clear error.
 *
 * Only used by the Playwright gallery dev server (`playwright/vite.config.ts`);
 * the production webview bundle is unaffected (its `import.meta.glob` is
 * compiled away and the fallback is never reached at runtime).
 */
const unsupported = (name: string) => (): never => {
	throw new Error(`Node builtin "${name}" is not available in the Playwright gallery browser bundle`)
}

export const fileURLToPath = unsupported("url.fileURLToPath")
export const pathToFileURL = unsupported("url.pathToFileURL")
export const existsSync = unsupported("fs.existsSync")
export const readFileSync = unsupported("fs.readFileSync")
export const readdirSync = unsupported("fs.readdirSync")
export const join = unsupported("path.join")
export const dirname = unsupported("path.dirname")
export const resolve = unsupported("path.resolve")
export const sep = "/"
export const promises = {
	readFile: unsupported("fs/promises.readFile"),
	writeFile: unsupported("fs/promises.writeFile"),
}
