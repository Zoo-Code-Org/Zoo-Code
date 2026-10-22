import * as fs from "fs/promises"

/**
 * Write a file so readers only ever observe the previous bytes or the complete
 * new bytes: the content goes to a sibling staging file first and is renamed into
 * place (same directory, so the rename is atomic on one volume).
 *
 * The destination is resolved first so a symlink is updated through its target
 * instead of being replaced by a regular file, and the resolved target's mode (and,
 * where permitted, ownership) is applied to the staging file: a fresh staging file
 * carries the process defaults, which would otherwise widen a 0600 or executable
 * destination.
 */
export async function writeFileAtomically(absolutePath: string, content: string, mode?: number): Promise<void> {
	let targetPath = absolutePath
	let targetMode = mode
	let targetOwnership: { uid: number; gid: number } | undefined
	try {
		targetPath = await fs.realpath(absolutePath)
		const stat = await fs.stat(targetPath)
		targetMode = targetMode ?? (stat.mode & 0o7777)
		targetOwnership = { uid: stat.uid, gid: stat.gid }
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			throw error
		}
	}
	// Derive the sibling staging path with plain string operations so the helper stays
	// usable in unit tests that mock the "path" module down to a few functions.
	const separatorIndex = Math.max(targetPath.lastIndexOf("/"), targetPath.lastIndexOf("\\"))
	const directory = separatorIndex >= 0 ? targetPath.slice(0, separatorIndex) : "."
	const baseName = separatorIndex >= 0 ? targetPath.slice(separatorIndex + 1) : targetPath
	const stagingPath = `${directory}/.${baseName}.${process.pid}.${Date.now()}.staging`
	try {
		// Owner-only from creation: staged content must never be readable by others,
		// even between this write and the final rename.
		await fs.writeFile(stagingPath, content, { encoding: "utf-8", mode: 0o600 })
		if (targetMode !== undefined) {
			await fs.chmod(stagingPath, targetMode)
		}
		if (targetOwnership !== undefined) {
			// Preserve ownership where the platform permits it; a chown the writer may
			// not perform (EPERM without privileges) leaves the writer as owner, which is
			// also the normal outcome for newly created files.
			await fs.chown(stagingPath, targetOwnership.uid, targetOwnership.gid).catch(() => {})
		}
		await fs.rename(stagingPath, targetPath)
	} catch (error) {
		await fs.rm(stagingPath, { force: true }).catch(() => {})
		throw error
	}
}
