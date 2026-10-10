import * as fs from "fs/promises"
import { constants, type BigIntStats } from "fs"
import path from "path"
import * as vscode from "vscode"

/** Metadata only until approval; content consumers must never reopen fullPath. */
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
			checkCancelled?.()
			return new ReadFileTarget(fullPath, identity)
		} catch (error) {
			checkCancelled?.()
			// Filesystem diagnostics, including inaccessible parents, require approval.
			// Code-less identity races and programmer errors must still fail closed.
			if (error instanceof Error && "code" in error && typeof error.code === "string") {
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
		const file = await fs.open(this.fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
		try {
			checkCancelled?.()
			const stats = await file.stat({ bigint: true })
			checkCancelled?.()
			if (stats.dev !== this.identity.dev || stats.ino !== this.identity.ino) {
				throw new Error(`File target changed after approval: ${this.fullPath}`)
			}
			return await read(file, stats)
		} finally {
			await file.close()
		}
	}
}
