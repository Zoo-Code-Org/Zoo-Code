import path from "path"
import { defineConfig } from "vitest/config"

import config from "./vitest.config"

export default defineConfig({
	...config,
	root: path.resolve(__dirname, ".."),
	test: {
		...config.test,
		setupFiles: ["webview-ui/vitest.setup.ts"],
		include: ["webview-ui/src/**/*.spec.{ts,tsx}", "webview-ui/src/**/*.test.{ts,tsx}"],
	},
})
