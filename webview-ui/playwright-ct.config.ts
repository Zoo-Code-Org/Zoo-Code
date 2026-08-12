import path from "path"
import { fileURLToPath } from "url"

import { defineConfig, type ReporterDescription } from "@playwright/test"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const galleryUrl = "http://127.0.0.1:4173"

const TRANSLATION_CONTEXT_STUB = path.resolve(dirname, "./playwright/TranslationContext.ts")

const monocartReporter: ReporterDescription = [
	"monocart-reporter",
	{
		name: "Webview Playwright Gallery",
		outputFile: path.resolve(dirname, "coverage-ct/index.html"),
		coverage: {
			outputDir: path.resolve(dirname, "coverage-ct"),
			reports: ["lcovonly", "v8"],
			// Entry URLs from the Vite gallery dev server or built bundle.
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
		baseURL: galleryUrl,
		ctTemplateDir: "./playwright",
		ctViteConfig: {
			plugins: [
				react({
					babel: {
						plugins: [["babel-plugin-react-compiler", { target: "18" }]],
					},
				}),
				tailwindcss(),
			],
			resolve: {
				// Use the array form so exact-match entries are guaranteed to win
				// over the `@`/`@src` prefix aliases regardless of evaluation order.
				alias: [
					// Only the `@src/` spelling of the translation context is stubbed
					// (used by TaskList). The dashboard tests intentionally use the REAL
					// `@/i18n/TranslationContext` to render real locale labels, so it is
					// NOT aliased here.
					{
						find: /^@src\/i18n\/TranslationContext$/,
						replacement: TRANSLATION_CONTEXT_STUB,
					},
					// `TabContent` (rendered by DashboardView) and the real
					// `TranslationContext` both call `useExtensionState()`. The real
					// `ExtensionStateContext` module imports `@roo-code/types` → Zod,
					// which crashes the Playwright CT browser bundle with
					// `ReferenceError: z is not defined`. Redirect BOTH spellings of the
					// context module to a lightweight browser-safe mock so the whole
					// Zod chain is severed at the source.
					{
						find: /^@\/context\/ExtensionStateContext$/,
						replacement: path.resolve(dirname, "./playwright/ExtensionStateContext.mock.tsx"),
					},
					{
						find: /^@src\/context\/ExtensionStateContext$/,
						replacement: path.resolve(dirname, "./playwright/ExtensionStateContext.mock.tsx"),
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
		video: "retain-on-failure",
		trace: "retain-on-failure",
	},
	expect: {
		toHaveScreenshot: {
			animations: "disabled",
		},
	},
	projects: [
		{
			name: "chromium",
			use: { browserName: "chromium" },
		},
	],
	webServer: {
		command: "pnpm exec vite --config playwright/vite.config.ts",
		url: galleryUrl,
		reuseExistingServer: !process.env.CI,
	},
})
