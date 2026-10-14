import * as fs from "fs/promises"
import { constants, type BigIntStats } from "fs"
import path from "path"
import * as vscode from "vscode"

import type { ReadFileCancellation } from "./ReadFileCancellation"
import { ReadFileCancelledError } from "./ReadFileCancelledError"

/** Metadata only until approval; content consumers must never reopen fullPath. */
export class ReadFileTarget {
	private constructor(
		readonly fullPath: string,
		private readonly cancellation: ReadFileCancellation,
		private readonly identity?: BigIntStats,
		private readonly missingError?: unknown,
	) {}

	static async resolve(lexicalPath: string, cancellation: ReadFileCancellation): Promise<ReadFileTarget> {
		try {
			const fullPath = await cancellation.run(() => fs.realpath(lexicalPath))
			const identity = await cancellation.run(() => fs.lstat(fullPath, { bigint: true }))
			if (identity.isSymbolicLink()) {
				throw new Error(`File target changed before approval: ${lexicalPath}`)
			}
			const revalidatedPath = await cancellation.run(() => fs.realpath(fullPath))
			if (revalidatedPath !== fullPath) {
				throw new Error(`File target changed before approval: ${lexicalPath}`)
			}
			return new ReadFileTarget(fullPath, cancellation, identity)
		} catch (error) {
			if (error instanceof ReadFileCancelledError) throw error
			// Filesystem diagnostics, including inaccessible parents, require approval.
			// Code-less identity races and programmer errors must still fail closed.
			if (error instanceof Error && "code" in error && typeof error.code === "string") {
				return new ReadFileTarget(lexicalPath, cancellation, undefined, error)
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

	async withHandle<T>(read: (file: fs.FileHandle, stats: BigIntStats) => Promise<T>): Promise<T> {
		return this.cancellation.run(async () => {
			if (!this.identity) throw this.missingError
			const file = await fs.open(this.fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
			try {
				const stats = await this.cancellation.run(() => file.stat({ bigint: true }))
				if (stats.dev !== this.identity.dev || stats.ino !== this.identity.ino) {
					throw new Error(`File target changed after approval: ${this.fullPath}`)
				}
				return await read(file, stats)
			} finally {
				await file.close()
			}
		})
	}
}
