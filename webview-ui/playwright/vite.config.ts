import path from "path"
import { fileURLToPath } from "url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const webviewRoot = path.resolve(dirname, "..")
const rooCodeTypesShim = path.resolve(dirname, "roo-code-types.ts")
const rooCodeTypesShimImporters = [
	"/src/shared/modes.ts",
	"/webview-ui/src/components/chat/CodeIndexPopover.tsx",
	"/webview-ui/src/components/chat/ModeSelector.tsx",
	"/webview-ui/src/components/settings/UISettings.tsx",
]

// Every story gets the Vitest toolkit mock, which draws a text field's label
// below its input. These importers get the real toolkit so the story looks
// like the extension. Add an importer here only with its own baseline.
const realToolkitImporters = ["/settings/providers/Ollama.tsx"]
const toolkitMock = path.resolve(webviewRoot, "src/__mocks__/@vscode/webview-ui-toolkit/react.tsx")

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
		{
			name: "playwright-gallery-toolkit-mock",
			enforce: "pre",
			resolveId(source, importer) {
				if (source !== "@vscode/webview-ui-toolkit/react") return
				if (importer && realToolkitImporters.some((suffix) => importer.endsWith(suffix))) return
				return toolkitMock
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
		// Pre-bundle the real toolkit (see realToolkitImporters). If Vite finds it
		// during the first page load, it re-optimizes and reloads mid-test.
		include: ["@vscode/webview-ui-toolkit/react"],
		exclude: ["@vscode/codicons"],
	},
	publicDir: path.resolve(webviewRoot, "../src/assets/images"),
	server: {
		host: "127.0.0.1",
		port: 4173,
		strictPort: true,
	},
})
