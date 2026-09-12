import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const wasmDir = path.join(srcDir, "node_modules", "tree-sitter-wasms", "out")
const distDir = path.join(srcDir, "dist")

fs.mkdirSync(distDir, { recursive: true })

for (const filename of fs.readdirSync(wasmDir)) {
	if (filename.endsWith(".wasm")) {
		fs.copyFileSync(path.join(wasmDir, filename), path.join(distDir, filename))
	}
}
