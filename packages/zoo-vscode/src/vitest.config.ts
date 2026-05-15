import { defineConfig } from "vitest/config"
import path from "path"
import { resolveVerbosity } from "./utils/vitest-verbosity"

const { silent, reporters, onConsoleLog } = resolveVerbosity()
const isWindowsCI = process.platform === "win32" && process.env.CI === "true"

export default defineConfig({
	test: {
		globals: true,
		setupFiles: ["./vitest.setup.ts"],
		watch: false,
		reporters,
		silent,
		testTimeout: 20_000,
		hookTimeout: 20_000,
		onConsoleLog,
		poolOptions: isWindowsCI
			? {
					forks: {
						singleFork: true,
					},
				}
			: undefined,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			exclude: [
				"**/*.test.ts",
				"**/*.test.tsx",
				"**/*.spec.ts",
				"**/*.spec.tsx",
				"**/vitest.setup.ts",
				"**/vitest.config.ts",
				"**/__mocks__/**",
			],
		},
	},
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, "./__mocks__/vscode.js"),
		},
	},
})
