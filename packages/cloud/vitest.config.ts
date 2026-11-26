import { defineConfig } from "vitest/config"

// VITEST_MAX_WORKERS caps workers for local and Docker runs so the fork pool
// stays inside the container memory budget. CI behavior is unchanged.
const localMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "", 10)

export default defineConfig({
	test: {
		globals: true,
		maxWorkers: Number.isFinite(localMaxWorkers) && localMaxWorkers > 0 ? localMaxWorkers : undefined,
		environment: "node",
		watch: false,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			include: ["src/**/*.ts", "src/**/*.tsx"],
			exclude: [
				"**/*.test.ts",
				"**/*.test.tsx",
				"**/*.spec.ts",
				"**/*.spec.tsx",
				"**/vitest.config.ts",
				"**/__mocks__/**",
			],
		},
	},
	resolve: {
		alias: {
			vscode: new URL("./src/__mocks__/vscode.ts", import.meta.url).pathname,
		},
	},
})
