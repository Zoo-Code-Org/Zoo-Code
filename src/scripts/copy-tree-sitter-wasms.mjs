import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const wasmDir = path.join(srcDir, "node_modules", "tree-sitter-wasms", "out")
const distDir = path.join(srcDir, "dist")
const wasmPattern = /^tree-sitter-.*\.wasm$/
const temporaryPattern = /^tree-sitter-.*\.wasm\.\d+\.tmp$/

export function cleanPublishedTreeSitterWasms(destinationDir, filesystem = fs) {
	if (!filesystem.existsSync(destinationDir)) return
	for (const filename of filesystem.readdirSync(destinationDir)) {
		if (wasmPattern.test(filename) || temporaryPattern.test(filename)) {
			filesystem.rmSync(path.join(destinationDir, filename), { force: true })
		}
	}
}

export function publishTreeSitterWasms(sourceDir, destinationDir, filesystem = fs) {
	const sourceFiles = filesystem
		.readdirSync(sourceDir)
		.filter((filename) => wasmPattern.test(filename))
		.sort()
	const cleanup = () => cleanPublishedTreeSitterWasms(destinationDir, filesystem)

	filesystem.mkdirSync(destinationDir, { recursive: true })
	for (const filename of filesystem.readdirSync(destinationDir)) {
		if (temporaryPattern.test(filename)) filesystem.rmSync(path.join(destinationDir, filename), { force: true })
	}

	try {
		for (const filename of sourceFiles) {
			const destination = path.join(destinationDir, filename)
			const temporary = `${destination}.${process.pid}.tmp`

			try {
				filesystem.copyFileSync(path.join(sourceDir, filename), temporary)
				filesystem.renameSync(temporary, destination)
			} finally {
				filesystem.rmSync(temporary, { force: true })
			}
		}

		for (const filename of filesystem.readdirSync(destinationDir)) {
			if ((!sourceFiles.includes(filename) && wasmPattern.test(filename)) || temporaryPattern.test(filename)) {
				filesystem.rmSync(path.join(destinationDir, filename), { force: true })
			}
		}
	} catch (error) {
		cleanup()
		throw error
	}

	return { sourceFiles, cleanup }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.once(signal, () => {
			cleanPublishedTreeSitterWasms(distDir)
			process.exit(1)
		})
	}
	publishTreeSitterWasms(wasmDir, distDir)
}
