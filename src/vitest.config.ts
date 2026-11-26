import { defineConfig } from "vitest/config"
import path from "path"
import { resolveVerbosity } from "./utils/vitest-verbosity"

const { silent, reporters, onConsoleLog } = resolveVerbosity()
const isWindowsCI = process.platform === "win32" && process.env.CI === "true"
// CI keeps its lane limits above. Local and Docker runs cap workers through
// VITEST_MAX_WORKERS so the fork pool stays inside the container memory budget.
const localMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "", 10)

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
		// Turbo runs two test lanes concurrently, so two workers per lane
		// fill the four runner vCPUs on Windows CI.
		maxWorkers: isWindowsCI
			? 2
			: Number.isFinite(localMaxWorkers) && localMaxWorkers > 0
				? localMaxWorkers
				: undefined,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			include: ["src/**/*.ts", "src/**/*.tsx", "eslint-rules/**/*.mjs"],
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
