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
	const previousFiles = new Map(
		filesystem
			.readdirSync(destinationDir)
			.filter((filename) => wasmPattern.test(filename))
			.map((filename) => [filename, filesystem.readFileSync(path.join(destinationDir, filename))]),
	)
	for (const filename of filesystem.readdirSync(destinationDir)) {
		if (temporaryPattern.test(filename)) filesystem.rmSync(path.join(destinationDir, filename), { force: true })
	}

	const temporaryFiles = []
	try {
		for (const filename of sourceFiles) {
			const destination = path.join(destinationDir, filename)
			const temporary = `${destination}.${process.pid}.tmp`
			temporaryFiles.push(temporary)
			filesystem.copyFileSync(path.join(sourceDir, filename), temporary)
		}
		for (const [index, filename] of sourceFiles.entries()) {
			filesystem.renameSync(temporaryFiles[index], path.join(destinationDir, filename))
		}

		for (const filename of filesystem.readdirSync(destinationDir)) {
			if ((!sourceFiles.includes(filename) && wasmPattern.test(filename)) || temporaryPattern.test(filename)) {
				filesystem.rmSync(path.join(destinationDir, filename), { force: true })
			}
		}
	} catch (error) {
		cleanup()
		for (const [filename, content] of previousFiles) {
			filesystem.writeFileSync(path.join(destinationDir, filename), content)
		}
		throw error
	} finally {
		for (const temporary of temporaryFiles) filesystem.rmSync(temporary, { force: true })
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
