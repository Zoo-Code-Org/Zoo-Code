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

function withTaskLock<T>(key: string, run: () => Promise<T>): Promise<T> {
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
		// Torn-tail repair: a crash can leave the final line unterminated - a
		// fragment of a lost write. The replacement truncates that fragment
		// instead of preserving it, so the journal only ever holds complete
		// records and a later entry can never mask the lost one.
		if (content && !content.endsWith("\n")) {
			content = content.slice(0, content.lastIndexOf("\n") + 1)
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
			await fs.rename(tmpPath, filePath)
			if (process.platform !== "win32") {
				// The rename replaced the directory entry: on POSIX the
				// directory itself must be synced for the new entry to
				// survive a crash (Windows cannot open directories).
				const dirHandle = await fs.open(dir, "r")
				try {
					await dirHandle.sync()
				} finally {
					await dirHandle.close()
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
 * Torn-tail repair: if the final line is truncated (JSON.parse fails), it is
 * silently discarded.  Lines that parse to valid JSON but are not
 * entry-shaped (non-object, missing string path/checkpointId, or an
 * unknown operation) are skipped for the same reason.  The rest of the file
 * is returned in order.  An absent
 * or empty journal returns [].
 */
export async function loadChanges(globalStorageDir: string, taskId: string): Promise<ChangeJournalEntry[]> {
	const filePath = journalPath(globalStorageDir, taskId)

	let content: string
	try {
		content = await fs.readFile(filePath, "utf8")
	} catch {
		// File absent or unreadable → empty journal.
		return []
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
