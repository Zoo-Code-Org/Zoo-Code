import path from "path"
import { fileURLToPath } from "url"

import { defineConfig, type ReporterDescription } from "@playwright/test"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const galleryUrl = "http://127.0.0.1:4173"

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
	webServer: {
		command: "pnpm exec vite --config playwright/vite.config.ts",
		url: galleryUrl,
		reuseExistingServer: !process.env.CI,
	},
})
