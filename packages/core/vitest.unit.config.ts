import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		watch: false,
		exclude: [...configDefaults.exclude, "**/*.integration.spec.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/unit",
			exclude: [
				"coverage/**",
				"**/*.config.*",
				"**/*.test.ts",
				"**/*.test.tsx",
				"**/*.spec.ts",
				"**/*.spec.tsx",
				"**/vitest.config.ts",
				"**/vitest.integration.config.ts",
				"**/vitest.unit.config.ts",
			],
		},
	},
})
