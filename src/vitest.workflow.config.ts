import { defineConfig, mergeConfig } from "vitest/config"

import baseConfig from "./vitest.config"

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["services/__tests__/pr-review-state-workflow.test.ts"],
			coverage: {
				reportsDirectory: "coverage/workflow",
			},
		},
	}),
)
