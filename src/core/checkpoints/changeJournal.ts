import fs from "fs/promises"
import * as path from "path"

/**
 * A single entry in the per-task change journal (changes.jsonl).
 *
 * One line is appended for every successful file write that goes through a
 * B1 per-write checkpoint hook.  WriteToFileTool and EditFileTool emit one
 * entry per write; ApplyPatchTool emits one entry per file change of a fully
 * successful patch — those entries all reference the single B1 checkpoint
 * that the patch's post-loop hook saves for the whole patch.  The task-start
 * baseline never produces an entry (it is not a file write).
 */
export interface ChangeJournalEntry {
	/** The file path as the tool knows it (relative to task cwd). */
	path: string
	/** "create" | "update" | "delete" — derived from what the tool did. */
	operation: "create" | "update" | "delete"
	/** The B1 checkpoint commit SHA for this write (from checkpointSave result). */
	checkpointId: string
	/** { additions, deletions } from the approval diff; null/omit when not computable. */
	diffStats?: { additions: number; deletions: number }
}

const JOURNAL_FILENAME = "changes.jsonl"

/**
 * Task IDs arrive from task creation and are used as a single path segment
 * under <globalStorageDir>/tasks. Reject anything that could escape that
 * directory — separators, traversal, absolute paths, empty or dot-only IDs —
 * before any filesystem operation touches the journal path.
 */
function assertSafeTaskId(taskId: string): void {
	if (!/^[A-Za-z0-9._-]+$/.test(taskId) || taskId === "." || taskId === "..") {
		throw new Error(`Unsafe task ID for checkpoint journal path: ${JSON.stringify(taskId)}`)
	}
}

/** Derive the per-task checkpoint directory from globalStorageDir and taskId. */
function taskCheckpointDir(globalStorageDir: string, taskId: string): string {
	return path.join(globalStorageDir, "tasks", taskId, "checkpoints")
}

/** Journal file path for a given task. */
export function journalPath(globalStorageDir: string, taskId: string): string {
	assertSafeTaskId(taskId)
	return path.join(taskCheckpointDir(globalStorageDir, taskId), JOURNAL_FILENAME)
}

/**
 * Per-task update queue: journal replacements for one task never overlap,
 * so concurrent checkpoint saves cannot lose each other's entries through
 * the read-modify-write cycle below.
 */
const journalQueues = new Map<string, Promise<unknown>>()

export function withTaskLock<T>(key: string, run: () => Promise<T>): Promise<T> {
	const prev = journalQueues.get(key) ?? Promise.resolve()
	// The next update runs after the previous one settles, whatever it did.
	const next = prev.then(run, run)
	// The queued promise swallows its outcome so a failed update neither
	// blocks later updates nor surfaces as an unhandled rejection; callers
	// observe the failure through `next`.
	journalQueues.set(
		key,
		next.then(
			() => undefined,
			() => undefined,
		),
	)
	return next
}

/**
 * Append change-journal entries to the per-task changes.jsonl file as one
 * serialized, atomic update.
 *
 * The whole multi-entry update is a crash-safe replacement: the current
 * journal is read, a torn tail is terminated, the complete next content is
 * written to a temporary file in the same directory and fsynced, then
 * atomically renamed onto the journal, and the parent directory is fsynced
 * (POSIX; Windows cannot open directories). A crash at any point leaves
 * either the old complete journal or the new complete journal - never a
 * half-applied multi-file update - and a durable checkpoint implies a
 * durable journal entry. Creates parent directories if they don't exist
 * yet (e.g. first checkpoint).
 *
 * Failures propagate: callers must not report a fully durable checkpoint
 * when the journal update did not complete.
 */
/** True when a parsed JSON value is a complete journal record. */
function isEntryShaped(value: unknown): value is ChangeJournalEntry {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as ChangeJournalEntry).path === "string" &&
		typeof (value as ChangeJournalEntry).checkpointId === "string" &&
		["create", "update", "delete"].includes((value as ChangeJournalEntry).operation)
	)
}

export async function appendChanges(
	globalStorageDir: string,
	taskId: string,
	entries: ChangeJournalEntry[],
): Promise<void> {
	if (entries.length === 0) {
		return
	}
	const filePath = journalPath(globalStorageDir, taskId)
	return withTaskLock(filePath, async () => {
		const dir = path.dirname(filePath)
		await fs.mkdir(dir, { recursive: true })
		let content = ""
		try {
			content = await fs.readFile(filePath, "utf8")
		} catch (error) {
			// A missing journal is a fresh history. Any other read failure
			// means the complete next content cannot be built, so propagate
			// instead of replacing the journal with a partial view of it.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error
			}
		}
		// Torn-tail repair: a crash can leave the final line unterminated. If
		// that final line is a complete, entry-shaped JSON record it was fully
		// written and only its newline was lost - keep it and re-terminate.
		// Otherwise it is a fragment of a lost write and the replacement
		// truncates it, so the journal only ever holds complete records and a
		// later entry can never mask the lost one.
		if (content && !content.endsWith("\n")) {
			const cut = content.lastIndexOf("\n") + 1
			let tail: unknown
			try {
				tail = JSON.parse(content.slice(cut))
			} catch {
				tail = undefined
			}
			content = isEntryShaped(tail) ? content + "\n" : content.slice(0, cut)
		}
		const payload = entries.map((entry) => JSON.stringify(entry) + "\n").join("")
		const tmpPath = path.join(dir, `${JOURNAL_FILENAME}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
		const data = Buffer.from(content + payload)
		try {
			const handle = await fs.open(tmpPath, "w")
			try {
				// A single write can complete partially; sync only after the
				// whole content is on the handle, or a short write would
				// rename a torn journal into place.
				let written = 0
				while (written < data.length) {
					const res = await handle.write(data, written, data.length - written)
					written += res.bytesWritten
				}
				await handle.sync()
			} finally {
				await handle.close()
			}
			// Windows can transiently reject a rename onto the existing journal
			// (an antivirus or indexer holding the destination): retry with a
			// short backoff before failing. The destination is never unlinked
			// to make room, so atomicity is preserved on every failure.
			const renameAttempts = process.platform === "win32" ? 5 : 1
			for (let attempt = 1; ; attempt++) {
				try {
					await fs.rename(tmpPath, filePath)
					break
				} catch (error) {
					const renameCode = (error as NodeJS.ErrnoException).code
					if (
						process.platform !== "win32" ||
						attempt >= renameAttempts ||
						!["EPERM", "EBUSY", "EACCES"].includes(renameCode ?? "")
					) {
						throw error
					}
					await new Promise((resolve) => setTimeout(resolve, 20 * attempt))
				}
			}
			if (process.platform !== "win32") {
				// The rename replaced the directory entry: on POSIX the
				// directory itself must be synced for the new entry to
				// survive a crash (Windows cannot open directories). The
				// journal content is already in place at this point, so a
				// sync failure means reduced crash durability, not a lost
				// update: errnos that mean "fsync is unsupported on this
				// mount" are tolerated and logged; any other failure still
				// propagates.
				try {
					const dirHandle = await fs.open(dir, "r")
					try {
						await dirHandle.sync()
					} finally {
						await dirHandle.close()
					}
				} catch (error) {
					const syncCode = (error as NodeJS.ErrnoException).code
					if (!["EINVAL", "EISDIR", "EBADF", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(syncCode ?? "")) {
						throw error
					}
					console.warn(
						`[changeJournal] directory sync unsupported after journal rename (${syncCode}); crash durability reduced`,
					)
				}
			}
		} catch (error) {
			// Best-effort cleanup: the rename never completed, so the journal
			// still holds the previous complete content; drop the temp file.
			await fs.rm(tmpPath, { force: true }).catch(() => {})
			throw error
		}
	})
}

/** Append a single entry; see appendChanges for the durability contract. */
export async function appendChange(globalStorageDir: string, taskId: string, entry: ChangeJournalEntry): Promise<void> {
	await appendChanges(globalStorageDir, taskId, [entry])
}

/**
 * Load all change-journal entries for a task.
 *
 * Torn-tail repair: if the FINAL line is truncated (JSON.parse fails) it is
 * discarded - that is the verified crash tail.  Any other damage throws:
 * a corrupt or non-entry-shaped line before the last one means a write was
 * lost from the history, and a rollback that silently skipped it could
 * restore to the wrong target.  Callers treat the rejection as "journal
 * completeness unknown" and fail closed.  The rest of the file
 * is returned in order.  An absent
 * or empty journal returns [] — but only an ABSENT file. Any other read
 * failure (permissions, I/O) is rethrown: a journal that cannot be read must
 * not be indistinguishable from one that is legitimately empty.
 */
export async function loadChanges(globalStorageDir: string, taskId: string): Promise<ChangeJournalEntry[]> {
	const filePath = journalPath(globalStorageDir, taskId)

	let content: string
	try {
		content = await fs.readFile(filePath, "utf8")
	} catch (error) {
		// A missing journal is a legitimate empty history; any other read
		// failure (permissions, I/O) must propagate. Swallowing it would let
		// a rollback report a no-op success without reading the history.
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return []
		}
		throw error
	}

	if (!content.trim()) {
		return []
	}

	const lines = content.split("\n")
	// Remove trailing empty line from a file that ends with \n.
	if (lines[lines.length - 1] === "") {
		lines.pop()
	}

	const entries: ChangeJournalEntry[] = []
	for (let i = 0; i < lines.length; i++) {
		let parsed: unknown
		try {
			parsed = JSON.parse(lines[i])
		} catch {
			// Only the final line may be a torn tail from a crash mid-append;
			// truncating it is verified recovery. A corrupt MIDDLE line means a
			// write was lost from the history, so journal completeness is
			// unknown and rollback must fail loudly instead of picking an
			// older entry as the restore target.
			if (i === lines.length - 1) {
				break
			}
			throw new Error(`Corrupt change journal entry at line ${i + 1} of ${filePath}`)
		}
		// A parsed line that is not entry-shaped is malformed, not a torn
		// tail (a torn tail cannot parse at all) - reject it anywhere.
		if (!isEntryShaped(parsed)) {
			throw new Error(`Malformed change journal entry at line ${i + 1} of ${filePath}`)
		}
		entries.push(parsed as ChangeJournalEntry)
	}

	return entries
}
