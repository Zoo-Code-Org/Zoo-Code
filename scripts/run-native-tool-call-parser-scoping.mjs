import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build } from "esbuild"

const entryPoint = fileURLToPath(new URL("./check-native-tool-call-parser-scoping.ts", import.meta.url))
const outfile = join(tmpdir(), `zoo-parser-scope-model-${process.pid}.cjs`)

try {
	await build({
		entryPoints: [entryPoint],
		bundle: true,
		platform: "node",
		format: "cjs",
		external: ["vscode"],
		outfile,
		logLevel: "info",
	})
	await import(pathToFileURL(outfile).href)
} finally {
	await rm(outfile, { force: true })
}
