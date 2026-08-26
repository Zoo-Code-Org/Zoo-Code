import path from "path"
import { fileURLToPath } from "url"

import { defineConfig } from "@playwright/experimental-ct-react"
import type { ReporterDescription } from "@playwright/test"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const rooCodeTypesShim = path.resolve(dirname, "./playwright/roo-code-types.ts")
const rooCodeTypesShimImporters = [
	"/src/shared/modes.ts",
	"/webview-ui/src/components/chat/CodeIndexPopover.tsx",
	"/webview-ui/src/components/chat/ModeSelector.tsx",
	"/webview-ui/src/components/settings/UISettings.tsx",
]

const monocartReporter: ReporterDescription = [
	"monocart-reporter",
	{
		name: "Webview Playwright CT",
		outputFile: path.resolve(dirname, "coverage-ct/index.html"),
		coverage: {
			outputDir: path.resolve(dirname, "coverage-ct"),
			reports: ["lcovonly", "v8"],
			// Entry URLs from Vite CT dev server or built bundle.
			entryFilter: (entry: { url: string }) => entry.url.includes("/src/") || entry.url.includes("/assets/"),
			sourceFilter: (sourcePath: string) =>
				sourcePath.includes("src/") &&
				!sourcePath.includes(".visual.") &&
				!sourcePath.includes(".spec.") &&
				!sourcePath.includes(".test."),
		},
	},
]

export default defineConfig({
	testDir: "./src",
	testMatch: "**/*.visual.tsx",
	outputDir: path.resolve(dirname, "test-results"),
	snapshotPathTemplate: "{testDir}/{testFileDir}/__screenshots__/{arg}{ext}",
	fullyParallel: true,
	reporter: process.env.CI
		? [
				["html", { open: "never", outputFolder: path.resolve(dirname, "playwright-report") }],
				["github"],
				["list"],
				monocartReporter,
			]
		: [
				["html", { open: "never", outputFolder: path.resolve(dirname, "playwright-report") }],
				["list"],
				monocartReporter,
			],
	use: {
		ctTemplateDir: "./playwright",
		ctViteConfig: {
			plugins: [
				{
					name: "playwright-ct-roo-code-types-shim",
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
						replacement: path.resolve(dirname, "./playwright/ExtensionStateContext.tsx"),
					},
					{
						find: "@src/context/ExtensionStateContext",
						replacement: path.resolve(dirname, "./playwright/ExtensionStateContext.tsx"),
					},
					{
						find: "@src/i18n/TranslationContext",
						replacement: path.resolve(dirname, "./playwright/TranslationContext.ts"),
					},
					{ find: "@", replacement: path.resolve(dirname, "./src") },
					{ find: "@src", replacement: path.resolve(dirname, "./src") },
					{ find: "@roo", replacement: path.resolve(dirname, "../src/shared") },
					{
						find: "@vscode/webview-ui-toolkit/react",
						replacement: path.resolve(dirname, "./src/__mocks__/@vscode/webview-ui-toolkit/react.tsx"),
					},
					{ find: "vscode", replacement: path.resolve(dirname, "../src/__mocks__/vscode.js") },
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
			publicDir: path.resolve(dirname, "../src/assets/images"),
		},
		viewport: { width: 520, height: 360 },
		deviceScaleFactor: 1,
		colorScheme: "dark",
	},
	expect: {
		toHaveScreenshot: {
			animations: "disabled",
			// Allow minor anti-aliasing differences between local and CI
			// rendering environments (different OS / font stacks).
			maxDiffPixelRatio: 0.02,
		},
	},
	projects: [
		{
			name: "chromium",
			use: { browserName: "chromium" },
		},
	],
})
