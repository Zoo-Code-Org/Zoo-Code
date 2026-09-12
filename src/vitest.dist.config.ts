import { defineConfig, mergeConfig } from "vitest/config"

import baseConfig from "./vitest.config"

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["__tests__/dist_assets.spec.ts"],
		},
	}),
)
