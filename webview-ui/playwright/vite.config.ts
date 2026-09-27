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
