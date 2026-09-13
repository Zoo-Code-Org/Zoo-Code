import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const wasmDir = path.join(srcDir, "node_modules", "tree-sitter-wasms", "out")
const generatedDir = path.join(srcDir, "generated", "tree-sitter-wasms")
const wasmPattern = /^tree-sitter-.*\.wasm$/

export async function prepareTreeSitterWasms(sourceDir, destinationDir, { filesystem = fs.promises } = {}) {
	const sourceFiles = (await filesystem.readdir(sourceDir)).filter((filename) => wasmPattern.test(filename)).sort()
	if (sourceFiles.length === 0) throw new Error("WASM source set is empty")

	await filesystem.rm(destinationDir, { recursive: true, force: true })
	await filesystem.mkdir(destinationDir, { recursive: true })
	try {
		for (const filename of sourceFiles) {
			await filesystem.copyFile(path.join(sourceDir, filename), path.join(destinationDir, filename))
		}
	} catch (error) {
		await filesystem.rm(destinationDir, { recursive: true, force: true })
		throw error
	}
	return { sourceFiles }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await prepareTreeSitterWasms(wasmDir, generatedDir)
}
