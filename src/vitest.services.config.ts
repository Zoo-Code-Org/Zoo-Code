import { defineConfig, mergeConfig } from "vitest/config"

import baseConfig from "./vitest.config"

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["services/**/*.{test,spec}.{ts,tsx}"],
			exclude: [
				"services/tree-sitter/**/*.{test,spec}.{ts,tsx}",
				"services/__tests__/pr-review-state-workflow.test.ts",
			],
			coverage: {
				reportsDirectory: "coverage/services",
			},
		},
	}),
)
