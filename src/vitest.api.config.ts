import { defineConfig, mergeConfig } from "vitest/config"

import baseConfig from "./vitest.config"

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["api/**/*.{test,spec}.{ts,tsx}"],
			coverage: {
				reportsDirectory: "coverage/api",
			},
		},
	}),
)
