import path from "path"

import { defineConfig } from "@playwright/test"

export default defineConfig({
	testDir: "./src/visual",
	outputDir: path.resolve(__dirname, "test-results-electron"),
	snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
	fullyParallel: false,
	workers: 1,
	projects: [
		{ name: "visual", testMatch: "electron.visual.ts", repeatEach: process.env.CI ? 3 : 1 },
		{ name: "heartbeat", testMatch: "heartbeat.electron.ts", repeatEach: 1 },
	],
	timeout: 3 * 60 * 1_000,
	expect: {
		timeout: 60_000,
		toHaveScreenshot: {
			animations: "disabled",
			caret: "hide",
		},
	},
	use: {
		trace: "retain-on-failure",
	},
	reporter: process.env.CI
		? [
				["html", { open: "never", outputFolder: path.resolve(__dirname, "playwright-report-electron") }],
				["github"],
				["list"],
			]
		: [["html", { open: "never", outputFolder: path.resolve(__dirname, "playwright-report-electron") }], ["list"]],
})
