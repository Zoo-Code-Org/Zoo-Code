import { configDefaults, defineConfig, mergeConfig } from "vitest/config"

import baseConfig from "./vitest.config"

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			exclude: [
				...configDefaults.exclude,
				"__tests__/dist_assets.spec.ts",
				"services/__tests__/pr-review-state-workflow.test.ts",
			],
			coverage: {
				reportsDirectory: "coverage/unit",
			},
		},
	}),
)
