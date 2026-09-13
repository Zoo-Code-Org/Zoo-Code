import fs from "node:fs"
import path from "node:path"

const wasmPattern = /^tree-sitter-.*\.wasm(?:\.\d+\.tmp)?$/

export function createWasmOutputSnapshot(destinationDir, filesystem = fs) {
	const transactionDir = `${destinationDir}.coverage-contract-backup`
	const backupDir = path.join(transactionDir, "backup")
	const generatedDir = path.join(transactionDir, "generated")
	filesystem.mkdirSync(destinationDir, { recursive: true })
	let ownsTransaction = false
	const movedFiles = []
	try {
		filesystem.mkdirSync(transactionDir)
		ownsTransaction = true
		filesystem.mkdirSync(backupDir)
		filesystem.mkdirSync(generatedDir)

		for (const filename of filesystem.readdirSync(destinationDir)) {
			if (!wasmPattern.test(filename)) continue
			filesystem.renameSync(path.join(destinationDir, filename), path.join(backupDir, filename))
			movedFiles.push(filename)
		}
	} catch (error) {
		const failures = []
		for (const filename of movedFiles.reverse()) {
			try {
				filesystem.renameSync(path.join(backupDir, filename), path.join(destinationDir, filename))
			} catch (rollbackError) {
				failures.push(rollbackError)
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(
				[error, ...failures],
				`WASM snapshot rollback incomplete; recovery retained at ${transactionDir}`,
			)
		}
		if (ownsTransaction) filesystem.rmSync(transactionDir, { recursive: true, force: true })
		throw error
	}

	let restored = false
	const restoredFiles = new Set()
	return {
		restore() {
			if (restored) return
			for (const filename of filesystem.readdirSync(destinationDir)) {
				if (wasmPattern.test(filename) && !restoredFiles.has(filename)) {
					filesystem.renameSync(path.join(destinationDir, filename), path.join(generatedDir, filename))
				}
			}
			for (const filename of filesystem.readdirSync(backupDir).sort()) {
				filesystem.renameSync(path.join(backupDir, filename), path.join(destinationDir, filename))
				restoredFiles.add(filename)
			}
			restored = true
			filesystem.rmSync(transactionDir, { recursive: true, force: true })
		},
	}
}
