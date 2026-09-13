import fs from "node:fs"

export function createDistSandbox(distDir, filesystem = fs) {
	const backupDir = `${distDir}.coverage-contract-backup`
	if (filesystem.existsSync(backupDir)) {
		filesystem.rmSync(distDir, { recursive: true, force: true })
		filesystem.renameSync(backupDir, distDir)
	}
	const hadDist = filesystem.existsSync(distDir)
	if (hadDist) filesystem.renameSync(distDir, backupDir)
	filesystem.mkdirSync(distDir, { recursive: true })
	return {
		restore() {
			filesystem.rmSync(distDir, { recursive: true, force: true })
			if (hadDist) filesystem.renameSync(backupDir, distDir)
		},
	}
}
