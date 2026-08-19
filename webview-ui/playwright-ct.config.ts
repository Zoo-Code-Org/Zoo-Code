import path from "path"
import { fileURLToPath } from "url"

import { defineConfig } from "@playwright/experimental-ct-react"
import type { ReporterDescription } from "@playwright/test"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const dirname = path.dirname(fileURLToPath(import.meta.url))

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
				react({
					babel: {
						plugins: [["babel-plugin-react-compiler", { target: "18" }]],
					},
				}),
				tailwindcss(),
			],
			resolve: {
				alias: {
					"@/context/ExtensionStateContext": path.resolve(dirname, "./playwright/ExtensionStateContext.tsx"),
					"@src/context/ExtensionStateContext": path.resolve(
						dirname,
						"./playwright/ExtensionStateContext.tsx",
					),
					"@src/i18n/TranslationContext": path.resolve(dirname, "./playwright/TranslationContext.ts"),
					"@": path.resolve(dirname, "./src"),
					"@src": path.resolve(dirname, "./src"),
					"@roo": path.resolve(dirname, "../src/shared"),
					"@vscode/webview-ui-toolkit/react": path.resolve(
						dirname,
						"./src/__mocks__/@vscode/webview-ui-toolkit/react.tsx",
					),
					vscode: path.resolve(dirname, "../src/__mocks__/vscode.js"),
				},
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
		},
	},
	projects: [
		{
			name: "chromium",
			use: { browserName: "chromium" },
		},
	],
})
