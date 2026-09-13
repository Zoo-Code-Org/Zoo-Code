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

export async function publishTreeSitterWasms(
	sourceDir,
	destinationDir,
	{ filesystem = fs.promises, onStep = async () => {}, signalState = { requested: undefined } } = {},
) {
	const transactionDir = `${destinationDir}.tree-sitter-wasms-transaction`
	const stagedDir = path.join(transactionDir, "staged")
	const backupDir = path.join(transactionDir, "backup")
	const quarantineDir = path.join(transactionDir, "quarantine")
	const sourceFiles = (await filesystem.readdir(sourceDir)).filter((filename) => wasmPattern.test(filename)).sort()
	if (sourceFiles.length === 0) throw new Error("WASM source set is empty")
	const step = async (name, filename) => {
		await onStep(name, filename)
		if (signalState.requested) throw Object.assign(new Error("WASM publication cancelled"), { code: "CANCELLED" })
	}

	let commitStarted = false
	let committed = false
	let ownsTransaction = false
	const publishedFiles = []
	try {
		await filesystem.mkdir(destinationDir, { recursive: true })
		await step("initialized", destinationDir)
		await filesystem.mkdir(transactionDir)
		ownsTransaction = true
		await step("initialized", transactionDir)
		await filesystem.mkdir(stagedDir)
		await step("initialized", stagedDir)
		await filesystem.mkdir(backupDir)
		await step("initialized", backupDir)
		await filesystem.mkdir(quarantineDir)
		await step("initialized", quarantineDir)

		for (const filename of sourceFiles) {
			await filesystem.copyFile(path.join(sourceDir, filename), path.join(stagedDir, filename))
			await step("staged", filename)
		}

		const previousFiles = (await filesystem.readdir(destinationDir)).filter((filename) =>
			wasmPattern.test(filename),
		)
		commitStarted = true
		for (const filename of previousFiles) {
			await filesystem.rename(path.join(destinationDir, filename), path.join(backupDir, filename))
			await step("backed-up", filename)
		}
		for (const filename of sourceFiles) {
			await filesystem.rename(path.join(stagedDir, filename), path.join(destinationDir, filename))
			publishedFiles.push(filename)
			await step("published", filename)
		}
		for (const filename of await filesystem.readdir(destinationDir)) {
			if (temporaryPattern.test(filename)) {
				await filesystem.rm(path.join(destinationDir, filename), { force: true })
				await step("removed-temporary", filename)
			}
		}

		committed = true
		await filesystem.rm(transactionDir, { recursive: true, force: true })
		return { sourceFiles, cleanup: () => cleanPublishedTreeSitterWasms(destinationDir) }
	} catch (error) {
		if (committed) throw error
		if (!commitStarted && ownsTransaction) {
			await filesystem.rm(transactionDir, { recursive: true, force: true })
		}
		if (!commitStarted) throw error

		const failures = []
		for (const filename of publishedFiles) {
			try {
				await filesystem.rename(path.join(destinationDir, filename), path.join(quarantineDir, filename))
			} catch (rollbackError) {
				if (rollbackError.code !== "ENOENT") failures.push(rollbackError)
			}
		}
		for (const filename of await filesystem.readdir(backupDir)) {
			try {
				await filesystem.rename(path.join(backupDir, filename), path.join(destinationDir, filename))
				await onStep("restored", filename)
			} catch (rollbackError) {
				failures.push(rollbackError)
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(
				[error, ...failures],
				`WASM rollback incomplete; recovery retained at ${transactionDir}`,
			)
		}
		await filesystem.rm(transactionDir, { recursive: true, force: true })
		throw error
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const signalState = { requested: undefined }
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			signalState.requested ??= signal
		})
	}
	try {
		await publishTreeSitterWasms(wasmDir, distDir, { signalState })
		if (signalState.requested) process.exitCode = signalState.requested === "SIGINT" ? 130 : 143
	} catch (error) {
		if (!signalState.requested) throw error
		process.exitCode = signalState.requested === "SIGINT" ? 130 : 143
	}
}
