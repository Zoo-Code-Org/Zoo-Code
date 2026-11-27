import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		watch: false,
		include: ["src/**/*.integration.spec.ts"],
		exclude: configDefaults.exclude,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/integration",
			exclude: [
				"coverage/**",
				"**/*.config.*",
				"**/*.test.ts",
				"**/*.test.tsx",
				"**/*.spec.ts",
				"**/*.spec.tsx",
				"**/vitest.config.ts",
				"**/vitest.unit.config.ts",
				"**/vitest.integration.config.ts",
			],
		},
	},
})
