import * as fs from "fs/promises"
import * as path from "path"

import { getErrorCode } from "./errorCode"
import { tracePersistenceEvent } from "../core/task-persistence/persistenceTrace"

import { withFileLock } from "./fileLock"

function getTempFilePrefix(absoluteFilePath: string, kind: "new" | "bak"): string {
	return `.${path.basename(absoluteFilePath)}.${kind}_`
}

function isReplacementLeftover(absoluteFilePath: string, entry: string): boolean {
	return (
		entry.endsWith(".tmp") &&
		(entry.startsWith(getTempFilePrefix(absoluteFilePath, "new")) ||
			entry.startsWith(getTempFilePrefix(absoluteFilePath, "bak")))
	)
}

/**
 * Recover a missing canonical file for a reader or startup scan, without a new
 * write. A live writer retains its lock; a crashed writer's lock must age out.
 * The unlocked scan is only a hint: recovery rechecks everything under the lock.
 */
export async function recoverMissingJsonFile(
	filePath: string,
	options: { waitForStaleLock?: boolean } = {},
): Promise<boolean> {
	const absoluteFilePath = path.resolve(filePath)
	let entries: string[]
	try {
		entries = await fs.readdir(path.dirname(absoluteFilePath))
	} catch (error: unknown) {
		if (getErrorCode(error) === "ENOENT") return false
		tracePersistenceEvent("json-recovery", {
			filePath: absoluteFilePath,
			result: "failed",
			detail: getErrorCode(error),
		})
		throw error
	}
	if (!entries.some((entry) => isReplacementLeftover(absoluteFilePath, entry))) return false
	try {
		return await withFileLock(
			absoluteFilePath,
			async (lockedPath) => {
				const recovery = await recoverInterruptedReplacement(lockedPath)
				if (recovery.restoredFrom) {
					tracePersistenceEvent("json-recovery", { filePath: absoluteFilePath, result: "restored" })
					return true
				}
				// A peer may have committed while this reader waited for the lock.
				try {
					await fs.access(lockedPath)
					return true
				} catch (error) {
					if (getErrorCode(error) === "ENOENT") return false
					throw error
				}
			},
			{ waitForStaleLock: options.waitForStaleLock ?? true, immediate: options.waitForStaleLock === false },
		)
	} catch (error) {
		tracePersistenceEvent("json-recovery", {
			filePath: absoluteFilePath,
			result: "failed",
			detail: getErrorCode(error),
		})
		throw error
	}
}

/**
 * Delete recoverable leftovers before the canonical file under the writer's
 * lock. Failure preserves the canonical copy, rather than authorizing recovery
 * of a stale backup after a successful deletion. Missing files are harmless.
 */
export async function deleteJsonFile(filePath: string): Promise<void> {
	await withFileLock(filePath, async (absoluteFilePath) => {
		let entries: string[]
		try {
			entries = await fs.readdir(path.dirname(absoluteFilePath))
		} catch (error: unknown) {
			if (getErrorCode(error) === "ENOENT") return
			throw error
		}
		const leftovers = entries.filter((entry) => isReplacementLeftover(absoluteFilePath, entry))
		for (const target of [
			...leftovers.map((entry) => path.join(path.dirname(absoluteFilePath), entry)),
			absoluteFilePath,
		]) {
			try {
				await fs.unlink(target)
			} catch (error: unknown) {
				if (getErrorCode(error) !== "ENOENT") throw error
			}
		}
	})
}

/**
 * Two leftover backups whose mtimes are exactly equal carry no evidence about which
 * one is the newer committed state - mtime is the only recency signal recovery has -
 * so choosing between them would be the order readdir happened to list them in, and
 * the loser of that order is garbage-collected below. Recovery refuses instead, the
 * same fail-closed decision it already makes for a backup it cannot stat: nothing is
 * restored and nothing is deleted, so both copies stay on disk for a human to read.
 */
class AmbiguousBackupRecencyError extends Error {
	readonly code = "AMBIGUOUS_BACKUP_RECENCY"
	readonly targetPath: string
	readonly mtimeMs: number
	readonly firstBackupPath: string
	readonly secondBackupPath: string
	constructor(targetPath: string, mtimeMs: number, firstBackupPath: string, secondBackupPath: string) {
		super(
			// Basenames, not absolute paths: this error travels to callers that report it, and error
			// telemetry captures message and stack, so a workspace path here would carry the local
			// username into that capture. The full paths stay on the properties for whoever has to
			// decide between the two tied copies.
			`Cannot tell which backup of ${path.basename(targetPath)} is the newest committed state: ${path.basename(firstBackupPath)} and ${path.basename(secondBackupPath)} share mtime ${mtimeMs}. Nothing was restored or deleted.`,
		)
		this.name = "AmbiguousBackupRecencyError"
		this.targetPath = targetPath
		this.mtimeMs = mtimeMs
		this.firstBackupPath = firstBackupPath
		this.secondBackupPath = secondBackupPath
	}
}

/**
 * Heals the canonical path after an interrupted previous write. Must run
 * under the advisory lock and before any data is read or written: temp and
 * backup files are only ever created while that lock is held, so anything
 * matching their name patterns belongs to a writer that can no longer
 * commit or clean it up (a crashed process, or a stale lock that was
 * stolen).
 *
 * The two-step replacement used by the EPERM fallback (and by versions
 * before the single-rename commit) can be interrupted after the target was
 * renamed to its backup but before the replacement landed. A process exit
 * at that point leaves the canonical path absent, which readers see as a
 * permanent ENOENT that no retry can repair, so the newest backup is
 * restored first, chosen by mtime. Two backups that share an exact mtime are
 * refused rather than split by directory order; see AmbiguousBackupRecencyError.
 * Leftover replacement and backup files are garbage collected afterwards.
 *
 * @returns Whether leftover files were found, and the backup path that was
 * restored, if any.
 */
export async function recoverInterruptedReplacement(
	absoluteFilePath: string,
): Promise<{ foundLeftovers: boolean; restoredFrom: string | null }> {
	const dirPath = path.dirname(absoluteFilePath)
	const backupPrefix = getTempFilePrefix(absoluteFilePath, "bak")

	let entries: string[]
	try {
		entries = await fs.readdir(dirPath)
	} catch (error: unknown) {
		if (getErrorCode(error) === "ENOENT") {
			return { foundLeftovers: false, restoredFrom: null }
		}
		// A failed scan cannot establish that no committed backups need recovery.
		throw error
	}

	const orphanedPaths = entries
		.filter((entry) => isReplacementLeftover(absoluteFilePath, entry))
		.map((entry) => path.join(dirPath, entry))

	if (orphanedPaths.length === 0) {
		return { foundLeftovers: false, restoredFrom: null }
	}

	let restoredFrom: string | null = null
	let canonicalPathMissing = false

	try {
		await fs.access(absoluteFilePath)
	} catch (error: unknown) {
		if (getErrorCode(error) !== "ENOENT") {
			// Unknown canonical state must not authorize deleting committed backups.
			throw error
		}
		canonicalPathMissing = true
	}

	if (canonicalPathMissing) {
		// The canonical path is absent. An interrupted two-step replacement
		// leaves the committed content in the newest backup, so restore it
		// and keep readers on the last committed state.
		const backupStats = (
			await Promise.all(
				orphanedPaths
					.filter((orphanPath) => path.basename(orphanPath).startsWith(backupPrefix))
					.map(async (backupPath) => {
						try {
							return { backupPath, mtimeMs: (await fs.stat(backupPath)).mtimeMs }
						} catch (error: unknown) {
							if (getErrorCode(error) === "ENOENT") {
								return null
							}
							// An unreadable backup could be the newest committed state.
							// Intentionally block writes until it becomes readable or is
							// explicitly removed, rather than risk losing committed history.
							throw error
						}
					}),
			)
		).filter((entry): entry is { backupPath: string; mtimeMs: number } => entry !== null)
		if (backupStats.length > 0) {
			backupStats.sort((a, b) => b.mtimeMs - a.mtimeMs)
			if (backupStats.length > 1 && backupStats[1].mtimeMs === backupStats[0].mtimeMs) {
				// mtime is the only recency signal here, and an exact tie carries none: the
				// winner would be the order readdir happened to list the two in, and the
				// loser is unlinked below. Refuse, as recovery already refuses a backup it
				// cannot stat.
				throw new AmbiguousBackupRecencyError(
					absoluteFilePath,
					backupStats[0].mtimeMs,
					backupStats[0].backupPath,
					backupStats[1].backupPath,
				)
			}
			const newestBackupPath = backupStats[0].backupPath
			try {
				await fs.rename(newestBackupPath, absoluteFilePath)
				restoredFrom = newestBackupPath
			} catch (restoreError) {
				console.error(
					`Failed to restore interrupted-write backup ${newestBackupPath} to ${absoluteFilePath}:`,
					restoreError,
				)
				throw restoreError
			}
		}
	}

	for (const orphanPath of orphanedPaths) {
		if (orphanPath === restoredFrom) {
			continue
		}
		try {
			await fs.unlink(orphanPath)
		} catch (cleanupError) {
			console.error(`Failed to clean up interrupted-write leftover ${orphanPath}:`, cleanupError)
		}
	}

	return { foundLeftovers: true, restoredFrom }
}
