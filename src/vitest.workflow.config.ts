import { defineConfig, mergeConfig } from "vitest/config"

import baseConfig from "./vitest.config"

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: [
				"services/__tests__/pr-review-state-workflow.test.ts",
				"services/__tests__/stale-pr-clock-workflow.test.ts",
				"services/__tests__/fork-review-followup-workflow.test.ts",
				"services/__tests__/workflow-self-listen.test.ts",
			],
			coverage: {
				reportsDirectory: "coverage/workflow",
			},
		},
	}),
)
