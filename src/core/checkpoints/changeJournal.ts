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
	let created = false
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
		created = true
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
	if (created && process.platform !== "win32") {
		// The append created the file: on POSIX the new directory entry needs
		// its own sync to survive a crash (Windows cannot open directories).
		const dir = await fs.open(path.dirname(filePath), "r")
		try {
			await dir.sync()
		} finally {
			await dir.close()
		}
	}
}

/**
 * Load all change-journal entries for a task.
 *
 * Torn-tail repair: if the final line is truncated (JSON.parse fails), it is
 * silently discarded.  Lines that parse to valid JSON but are not
 * entry-shaped (non-object, missing string path/checkpointId, or an
 * unknown operation) are skipped for the same reason.  The rest of the file
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
