import * as fs from "fs/promises"
import { constants, type BigIntStats } from "fs"
import path from "path"
import * as vscode from "vscode"

/** Metadata only until approval; content consumers must use the verified handle, never reopen fullPath. */
export class ReadFileTarget {
	private constructor(
		readonly fullPath: string,
		private readonly identity?: BigIntStats,
		private readonly missingError?: unknown,
	) {}

	static async resolve(lexicalPath: string, checkCancelled?: () => void): Promise<ReadFileTarget> {
		try {
			const fullPath = await fs.realpath(lexicalPath)
			checkCancelled?.()
			const identity = await fs.lstat(fullPath, { bigint: true })
			checkCancelled?.()
			if (identity.isSymbolicLink() || (await fs.realpath(fullPath)) !== fullPath) {
				throw new Error(`File target changed before approval: ${lexicalPath}`)
			}
			return new ReadFileTarget(fullPath, identity)
		} catch (error) {
			// Keep missing-file diagnostics at the historical post-approval boundary.
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				return new ReadFileTarget(lexicalPath, undefined, error)
			}
			throw error
		}
	}

	static async isOutsideWorkspace(fullPath: string): Promise<boolean> {
		const roots = await Promise.all(
			(vscode.workspace.workspaceFolders ?? []).map((folder) =>
				fs.realpath(folder.uri.fsPath).catch(() => undefined),
			),
		)
		return !roots.some((root) => {
			if (!root) return false
			const relative = path.relative(root, fullPath)
			return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
		})
	}

	async withHandle<T>(
		read: (file: fs.FileHandle, stats: BigIntStats) => Promise<T>,
		checkCancelled?: () => void,
	): Promise<T> {
		checkCancelled?.()
		if (!this.identity) throw this.missingError
		// O_NOFOLLOW rejects final-component substitutions on platforms that support it.
		// The identity comparison also guards replacements and parent-directory retargeting.
		const file = await fs.open(this.fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
		try {
			checkCancelled?.()
			const stats = await file.stat({ bigint: true })
			if (stats.dev !== this.identity.dev || stats.ino !== this.identity.ino) {
				throw new Error(`File target changed after approval: ${this.fullPath}`)
			}
			return await read(file, stats)
		} finally {
			await file.close()
		}
	}
}
