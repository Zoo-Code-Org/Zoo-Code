import path from "path"
import { fileURLToPath } from "url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const webviewRoot = path.resolve(dirname, "..")
const rooCodeTypesShim = path.resolve(dirname, "roo-code-types.ts")
const nodeBuiltinStubs = path.resolve(dirname, "node-builtin-browser-stubs.ts")
const rooCodeTypesShimImporters = [
	"/src/shared/modes.ts",
	"/webview-ui/src/components/chat/CodeIndexPopover.tsx",
	"/webview-ui/src/components/chat/ModeSelector.tsx",
	"/webview-ui/src/components/settings/UISettings.tsx",
]

export default defineConfig({
	root: path.resolve(dirname, "gallery"),
	plugins: [
		{
			name: "playwright-gallery-roo-code-types-shim",
			enforce: "pre",
			resolveId(source, importer) {
				if (
					source === "@roo-code/types" &&
					importer &&
					rooCodeTypesShimImporters.some((suffix) => importer.endsWith(suffix))
				) {
					return rooCodeTypesShim
				}
			},
		},
		react({
			babel: {
				plugins: [["babel-plugin-react-compiler", { target: "18" }]],
			},
		}),
		tailwindcss(),
	],
	resolve: {
		alias: [
			// `src/i18n/setup.ts` imports `node:fs`/`node:path`/`node:url` at top
			// level for its Node-side disk fallback. Vite dev externalizes those
			// builtins to a proxy that THROWS the moment the browser evaluates the
			// eager CJS-interop access (`node:url.fileURLToPath`), which crashes
			// every gallery story that loads i18n. Aliasing them to plain stub
			// modules keeps the browser graph importable; the disk-fallback branch
			// never executes there (Vite rewrites `import.meta.glob` instead).
			{ find: "node:url", replacement: nodeBuiltinStubs },
			{ find: "node:fs/promises", replacement: nodeBuiltinStubs },
			{ find: "node:fs", replacement: nodeBuiltinStubs },
			{ find: "node:path", replacement: nodeBuiltinStubs },
			{
				find: "@/context/ExtensionStateContext",
				replacement: path.resolve(dirname, "ExtensionStateContext.tsx"),
			},
			{
				find: "@src/context/ExtensionStateContext",
				replacement: path.resolve(dirname, "ExtensionStateContext.tsx"),
			},
			{
				find: "@src/i18n/TranslationContext",
				replacement: path.resolve(dirname, "TranslationContext.ts"),
			},
			{ find: "@", replacement: path.resolve(webviewRoot, "src") },
			{ find: "@src", replacement: path.resolve(webviewRoot, "src") },
			{ find: "@roo", replacement: path.resolve(webviewRoot, "../src/shared") },
			{
				find: "@vscode/webview-ui-toolkit/react",
				replacement: path.resolve(webviewRoot, "src/__mocks__/@vscode/webview-ui-toolkit/react.tsx"),
			},
			{ find: "vscode", replacement: path.resolve(webviewRoot, "../src/__mocks__/vscode.js") },
		],
	},
	define: {
		"process.platform": JSON.stringify(process.platform),
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "test"),
		"process.env.PKG_NAME": JSON.stringify("zoo-code"),
		"process.env.PKG_VERSION": JSON.stringify("0.0.0-test"),
		"process.env.PKG_OUTPUT_CHANNEL": JSON.stringify("Zoo-Code"),
		"process.env.PKG_RELEASE_CHANNEL": JSON.stringify("stable"),
	},
	optimizeDeps: {
		exclude: ["@vscode/codicons"],
	},
	publicDir: path.resolve(webviewRoot, "../src/assets/images"),
	server: {
		host: "127.0.0.1",
		port: 4173,
		strictPort: true,
	},
})
