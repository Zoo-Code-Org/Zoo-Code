import { defineConfig, mergeConfig } from "vitest/config"

import baseConfig from "./vitest.config"

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			// This smoke test validates emitted artifacts; source coverage remains in the unit lane.
			include: ["__tests__/dist_assets.spec.ts"],
		},
	}),
)
