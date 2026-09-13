import fs from "node:fs"
import path from "node:path"

const wasmPattern = /^tree-sitter-.*\.wasm(?:\.\d+\.tmp)?$/

export function createWasmOutputSnapshot(destinationDir, filesystem = fs) {
	const transactionDir = `${destinationDir}.coverage-contract-backup`
	const backupDir = path.join(transactionDir, "backup")
	const generatedDir = path.join(transactionDir, "generated")
	filesystem.mkdirSync(destinationDir, { recursive: true })
	filesystem.mkdirSync(transactionDir)
	filesystem.mkdirSync(backupDir)
	filesystem.mkdirSync(generatedDir)

	for (const filename of filesystem.readdirSync(destinationDir)) {
		if (wasmPattern.test(filename))
			filesystem.renameSync(path.join(destinationDir, filename), path.join(backupDir, filename))
	}

	let restored = false
	return {
		restore() {
			if (restored) return
			for (const filename of filesystem.readdirSync(destinationDir)) {
				if (wasmPattern.test(filename)) {
					filesystem.renameSync(path.join(destinationDir, filename), path.join(generatedDir, filename))
				}
			}
			for (const filename of filesystem.readdirSync(backupDir)) {
				filesystem.renameSync(path.join(backupDir, filename), path.join(destinationDir, filename))
			}
			restored = true
			filesystem.rmSync(transactionDir, { recursive: true, force: true })
		},
	}
}
