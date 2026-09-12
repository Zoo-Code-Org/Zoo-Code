import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const wasmDir = path.join(srcDir, "node_modules", "tree-sitter-wasms", "out")
const distDir = path.join(srcDir, "dist")

fs.mkdirSync(distDir, { recursive: true })

for (const filename of fs.readdirSync(wasmDir)) {
	if (filename.endsWith(".wasm")) {
		const destination = path.join(distDir, filename)
		const temporary = `${destination}.${process.pid}.tmp`

		try {
			fs.copyFileSync(path.join(wasmDir, filename), temporary)
			fs.renameSync(temporary, destination)
		} finally {
			fs.rmSync(temporary, { force: true })
		}
	}
}
