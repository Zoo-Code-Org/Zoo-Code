import { defineConfig, mergeConfig } from "vitest/config"

import baseConfig from "./vitest.config"

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: [
				"__tests__/**/*.{test,spec}.{ts,tsx}",
				"activate/**/*.{test,spec}.{ts,tsx}",
				"extension/**/*.{test,spec}.{ts,tsx}",
				"i18n/**/*.{test,spec}.{ts,tsx}",
				"integrations/**/*.{test,spec}.{ts,tsx}",
				"scripts/**/*.{test,spec}.{mjs,ts}",
				"shared/**/*.{test,spec}.{ts,tsx}",
				"test-utils/**/*.{test,spec}.{ts,tsx}",
				"utils/**/*.{test,spec}.{ts,tsx}",
			],
			exclude: ["__tests__/dist_assets.spec.ts"],
			coverage: {
				reportsDirectory: "coverage/misc",
			},
		},
	}),
)
