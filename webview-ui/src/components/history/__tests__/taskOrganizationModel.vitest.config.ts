import { defineConfig } from "vitest/config"
import path from "path"

// Minimal Vitest config for the pure-logic taskOrganizationModel tests.
// It avoids the full JSDOM/component setup and runs in Node so that the
// suite starts quickly without pulling in React or web component mocks.
export default defineConfig({
	test: {
		globals: true,
		setupFiles: [path.resolve(__dirname, "./taskOrganizationModel.setup.ts")],
		watch: false,
		reporters: ["verbose"],
		environment: "node",
		include: [path.resolve(__dirname, "./taskOrganizationModel.spec.ts")],
		maxWorkers: 1,
		fileParallelism: false,
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "../../.."),
			"@src": path.resolve(__dirname, "../../.."),
			"@roo": path.resolve(__dirname, "../../../../src/shared"),
		},
	},
})
