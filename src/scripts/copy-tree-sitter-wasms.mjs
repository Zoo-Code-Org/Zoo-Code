import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const wasmDir = path.join(srcDir, "node_modules", "tree-sitter-wasms", "out")
const distDir = path.join(srcDir, "dist")
const wasmPattern = /^tree-sitter-.*\.wasm$/

export async function publishTreeSitterWasms(
	sourceDir,
	destinationDir,
	{ filesystem = fs.promises, onStep = async () => {}, signalState = { requested: undefined } } = {},
) {
	const stagingDir = `${destinationDir}.tree-sitter-wasms-staging`
	const sourceFiles = (await filesystem.readdir(sourceDir)).filter((filename) => wasmPattern.test(filename)).sort()
	if (sourceFiles.length === 0) throw new Error("WASM source set is empty")
	const checkpoint = async (name, filename) => {
		await onStep(name, filename)
		if (signalState.requested) throw new Error("WASM publication cancelled")
	}

	await filesystem.rm(stagingDir, { recursive: true, force: true })
	await filesystem.mkdir(stagingDir, { recursive: true })
	await filesystem.mkdir(destinationDir, { recursive: true })
	try {
		for (const filename of sourceFiles) {
			await filesystem.copyFile(path.join(sourceDir, filename), path.join(stagingDir, filename))
			await checkpoint("staged", filename)
		}
		for (const filename of await filesystem.readdir(stagingDir)) {
			if (!wasmPattern.test(filename)) throw new Error(`Unexpected staged WASM: ${filename}`)
		}
		await checkpoint("validated", stagingDir)

		for (const filename of await filesystem.readdir(destinationDir)) {
			if (wasmPattern.test(filename) || (filename.includes("tree-sitter-") && filename.endsWith(".tmp"))) {
				await filesystem.rm(path.join(destinationDir, filename), { force: true })
			}
		}
		for (const filename of sourceFiles) {
			await filesystem.rename(path.join(stagingDir, filename), path.join(destinationDir, filename))
			await checkpoint("published", filename)
		}
		await checkpoint("completed", destinationDir)
	} catch (error) {
		try {
			for (const filename of await filesystem.readdir(destinationDir)) {
				if (wasmPattern.test(filename))
					await filesystem.rm(path.join(destinationDir, filename), { force: true })
			}
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				`WASM publication and cleanup failed; remove ${stagingDir} and rerun to rebuild`,
			)
		}
		throw error
	} finally {
		await filesystem.rm(stagingDir, { recursive: true, force: true })
	}
	return { sourceFiles }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const signalState = { requested: undefined }
	for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => (signalState.requested ??= signal))
	try {
		await publishTreeSitterWasms(wasmDir, distDir, { signalState })
		if (signalState.requested) process.exitCode = signalState.requested === "SIGINT" ? 130 : 143
	} catch (error) {
		if (!signalState.requested) throw error
		process.exitCode = signalState.requested === "SIGINT" ? 130 : 143
	}
}
