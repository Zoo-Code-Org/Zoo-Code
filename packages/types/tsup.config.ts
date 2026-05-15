import { defineConfig } from "tsup"

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["cjs", "esm"],
	dts: true,
	splitting: false,
	sourcemap: true,
	clean: true,
	outDir: "dist",
	// ai-sdk-provider-poe is ESM-only (./code subpath has no "require" condition)
	// so tsup must bundle it inline rather than emit a runtime require() call.
	noExternal: ["ai-sdk-provider-poe"],
})
