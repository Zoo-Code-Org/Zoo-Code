import { defineConfig, mergeConfig } from "vitest/config"

import baseConfig from "./vitest.config"

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			// These smoke tests validate emitted artifacts; source coverage remains in the unit lane.
			include: [
				"__tests__/dist_assets.spec.ts",
				"services/code-index/__tests__/parse-worker-client.real.spec.ts",
			],
		},
	}),
)
