import path from "node:path"
import { defineConfig, mergeConfig } from "vitest/config"

import baseConfig from "./vitest.config"

const runDirectory = process.env.WEBVIEW_BENCHMARK_RUN_DIR

if (!runDirectory) {
	throw new Error("Run this configuration through scripts/ci/webview-benchmark.mjs")
}

export default mergeConfig(
	baseConfig,
	defineConfig({
		cacheDir: path.join(runDirectory, "vite-cache"),
		test: {
			coverage: {
				reportsDirectory: path.join(runDirectory, "coverage"),
			},
		},
	}),
)
