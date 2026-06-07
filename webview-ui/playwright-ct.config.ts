import path from "path"
import { fileURLToPath } from "url"

import { defineConfig } from "@playwright/experimental-ct-react"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	testDir: "./src",
	testMatch: "**/*.visual.tsx",
	outputDir: process.env.CI ? path.resolve(dirname, "test-results") : "/tmp/webview-ui-playwright-test-results",
	snapshotPathTemplate: "{testDir}/{testFileDir}/__screenshots__/{arg}{ext}",
	fullyParallel: true,
	reporter: process.env.CI
		? [["html", { open: "never", outputFolder: path.resolve(dirname, "playwright-report") }], ["github"], ["list"]]
		: [["html", { open: "never", outputFolder: "/tmp/webview-ui-playwright-report" }], ["list"]],
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
					"@": path.resolve(dirname, "./src"),
					"@src": path.resolve(dirname, "./src"),
					"@roo": path.resolve(dirname, "../src/shared"),
					vscode: path.resolve(dirname, "./src/__mocks__/vscode.ts"),
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
