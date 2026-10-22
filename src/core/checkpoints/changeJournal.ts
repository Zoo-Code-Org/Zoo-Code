import fs from "fs/promises"
import * as path from "path"

/**
 * A single entry in the per-task change journal (changes.jsonl).
 *
 * One line is appended for every successful file write that goes through a
 * B1 per-write checkpoint hook.  WriteToFileTool and EditFileTool emit one
 * entry per write; ApplyPatchTool emits one entry per file actually written
 * by the patch (including the written subset of a partially failed patch) —
 * those entries all reference the single B1 checkpoint that the patch's
 * post-loop hook saves.  The task-start baseline never produces an entry
 * (it is not a file write).
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

const PENDING_FILENAME = "changes.pending.json"

/**
 * On-disk state for the checkpoint/journal transaction.
 *
 * `awaiting-checkpoint` is written before the Git checkpoint is created: if the
 * process dies before the checkpoint confirms, there is no durable commit to
 * attribute entries to. `ready` carries the complete entries (with their commit
 * id) and is written before any append: a crash or an append failure then leaves
 * a durable marker that the next read reconciles into the journal.
 */
export interface PendingJournalState {
	state: "awaiting-checkpoint" | "ready"
	createdAt: number
	entries?: ChangeJournalEntry[]
}

/** Pending-marker path for a given task. */
export function pendingJournalPath(globalStorageDir: string, taskId: string): string {
	assertSafeTaskId(taskId)
	return path.join(taskCheckpointDir(globalStorageDir, taskId), PENDING_FILENAME)
}

/** Write the pending marker atomically (staging file + rename in the same dir). */
export async function writePendingJournal(
	globalStorageDir: string,
	taskId: string,
	state: PendingJournalState,
): Promise<void> {
	const filePath = pendingJournalPath(globalStorageDir, taskId)
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	const stagingPath = `${filePath}.${process.pid}.${Date.now()}.staging`
	try {
		await fs.writeFile(stagingPath, JSON.stringify(state), "utf8")
		await fs.rename(stagingPath, filePath)
	} catch (error) {
		await fs.rm(stagingPath, { force: true }).catch(() => {})
		throw error
	}
}

/** Remove the pending marker after the journal has durably recorded it. */
export async function clearPendingJournal(globalStorageDir: string, taskId: string): Promise<void> {
	await fs.rm(pendingJournalPath(globalStorageDir, taskId), { force: true })
}

/**
 * Fold a durable pending marker into the journal.
 *
 * Idempotent: entries already present (same path, operation and checkpoint id)
 * are skipped, so a crash between the append and the marker removal cannot
 * duplicate them. A marker that is still `awaiting-checkpoint` is discarded —
 * there is no committed checkpoint whose id could be attributed to the writes.
 */
export async function reconcilePendingJournal(globalStorageDir: string, taskId: string): Promise<void> {
	const filePath = pendingJournalPath(globalStorageDir, taskId)
	let raw: string
	try {
		raw = await fs.readFile(filePath, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return
		}
		throw error
	}
	let marker: PendingJournalState | undefined
	try {
		marker = JSON.parse(raw) as PendingJournalState
	} catch {
		marker = undefined
	}
	if (!marker || typeof marker !== "object" || (marker.state !== "ready" && marker.state !== "awaiting-checkpoint")) {
		console.warn("[changeJournal] discarding an unreadable pending-journal marker")
		await clearPendingJournal(globalStorageDir, taskId)
		return
	}
	if (marker.state === "ready" && Array.isArray(marker.entries) && marker.entries.length > 0) {
		const existing = await readJournalEntries(globalStorageDir, taskId)
		const seen = new Set(existing.map((entry) => `${entry.path}\u0000${entry.operation}\u0000${entry.checkpointId}`))
		for (const entry of marker.entries) {
			const key = `${entry.path}\u0000${entry.operation}\u0000${entry.checkpointId}`
			if (seen.has(key)) {
				continue
			}
			await appendChange(globalStorageDir, taskId, entry)
			seen.add(key)
		}
	}
	await clearPendingJournal(globalStorageDir, taskId)
}

/**
 * Append one change-journal entry to the per-task changes.jsonl file.
 *
 * Torn-tail repair: a crash mid-append can leave the file without a trailing
 * newline; appending directly would splice the new entry into the fragment and
 * lose both at load time, so the tail is terminated before the new line is
 * written. The append is fsynced so a durable checkpoint implies a durable
 * journal entry; a crash mid-write can still tear the appended line itself,
 * which loadChanges tolerates as a torn tail. Creates parent directories if
 * they don't exist yet (e.g. first checkpoint).
 */
export async function appendChange(globalStorageDir: string, taskId: string, entry: ChangeJournalEntry): Promise<void> {
	const filePath = journalPath(globalStorageDir, taskId)
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	let payload = JSON.stringify(entry) + "\n"
	let journalWasCreated = false
	try {
		const stat = await fs.stat(filePath)
		if (stat.size > 0) {
			const tail = await fs.open(filePath, "r")
			try {
				const last = Buffer.alloc(1)
				await tail.read(last, 0, 1, stat.size - 1)
				if (last[0] !== 0x0a) {
					payload = "\n" + payload
				}
			} finally {
				await tail.close()
			}
		}
	} catch (error) {
		// A missing journal is a fresh append. Any other inspection failure
		// means we cannot know whether a separator is required, so propagate
		// instead of appending blind and losing the entry to a merged line.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error
		}
		journalWasCreated = true
	}
	const data = Buffer.from(payload)
	const handle = await fs.open(filePath, "a")
	try {
		// A single write can complete partially; sync only after the whole
		// record is on the handle, or a short write would persist a torn entry
		// while appendChange reports success.
		let written = 0
		while (written < data.length) {
			const res = await handle.write(data, written, data.length - written)
			written += res.bytesWritten
		}
		await handle.sync()
	} finally {
		await handle.close()
	}
	if (journalWasCreated) {
		// The append created the journal file (and possibly its parent
		// directory via fs.mkdir): fsync the containing directory so the new
		// file's directory entry survives a crash before the append is reported
		// as committed. Platforms that cannot open the directory for sync
		// degrade to a warning, mirroring the rename path's tolerance list.
		try {
			const dirHandle = await fs.open(path.dirname(filePath), "r")
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
				`[changeJournal] directory sync unsupported after journal creation (${syncCode}); crash durability reduced`,
			)
		}
	}
}

/**
 * Load all change-journal entries for a task.
 *
 * Torn-tail repair: if the final line is truncated (JSON.parse fails), it is
 * silently discarded.  Lines that parse to valid JSON but are not
 * entry-shaped (non-object, missing string path/checkpointId, or an
 * unknown operation) are skipped for the same reason.  The rest of the file is returned in order.  An absent
 * or empty journal returns [] — but only an ABSENT file. Any other read
 * failure (permissions, I/O) is rethrown: a journal that cannot be read must
 * not be indistinguishable from one that is legitimately empty.
 * @internal Wired by a later unit in the split chain; remove when the chain completes.
 */
async function readJournalEntries(globalStorageDir: string, taskId: string): Promise<ChangeJournalEntry[]> {
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
		try {
			const parsed: unknown = JSON.parse(lines[i])
			// A torn append or manual edit can leave valid JSON that is not an
			// entry (a bare number, null, or a differently-shaped object).
			// Consumers read path/checkpointId unguarded, so skip any line that
			// is not entry-shaped instead of returning it as an entry.
			if (
				parsed &&
				typeof parsed === "object" &&
				typeof (parsed as ChangeJournalEntry).path === "string" &&
				typeof (parsed as ChangeJournalEntry).checkpointId === "string" &&
				["create", "update", "delete"].includes((parsed as ChangeJournalEntry).operation)
			) {
				entries.push(parsed as ChangeJournalEntry)
			}
		} catch {
			// A corrupt line before the final line (e.g. a partially flushed
			// append) must not hide the valid entries after it. The final line
			// is still discarded as a torn tail — `continue` at the last index
			// ends the loop either way.
			continue
		}
	}

	return entries
}

/**
 * Load all change-journal entries for a task, first folding in a durable
 * pending marker left by a crash or a failed append (see reconcilePendingJournal).
 */
export async function loadChanges(globalStorageDir: string, taskId: string): Promise<ChangeJournalEntry[]> {
	await reconcilePendingJournal(globalStorageDir, taskId)
	return readJournalEntries(globalStorageDir, taskId)
}
