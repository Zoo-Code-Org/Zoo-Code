import { defineConfig } from "tsup"

export default defineConfig({
	entry: ["src/child.ts", "src/index.ts"],
	format: ["esm"],
	clean: true,
	sourcemap: true,
	target: "node22",
	platform: "node",
	noExternal: ["@roo-code/types", "@roo-code/vscode-shim", "@roo-code/zoo-protocol"],
})
