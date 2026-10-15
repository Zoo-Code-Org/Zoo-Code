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

/** Derive the per-task checkpoint directory from globalStorageDir and taskId. */
function taskCheckpointDir(globalStorageDir: string, taskId: string): string {
	return path.join(globalStorageDir, "tasks", taskId, "checkpoints")
}

/** Journal file path for a given task. */
export function journalPath(globalStorageDir: string, taskId: string): string {
	return path.join(taskCheckpointDir(globalStorageDir, taskId), JOURNAL_FILENAME)
}

/**
 * Append one change-journal entry to the per-task changes.jsonl file.
 *
 * Uses appendFile so each write is a single syscall — minimal torn-write risk.
 * Creates parent directories if they don't exist yet (e.g. first checkpoint).
 */
export async function appendChange(globalStorageDir: string, taskId: string, entry: ChangeJournalEntry): Promise<void> {
	const filePath = journalPath(globalStorageDir, taskId)
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	const line = JSON.stringify(entry) + "\n"
	await fs.appendFile(filePath, line)
}

/**
 * Load all change-journal entries for a task.
 *
 * Torn-tail repair: if the final line is truncated (JSON.parse fails), it is
 * silently discarded.  Lines that parse to valid JSON but are not
 * entry-shaped (non-object, missing string path/checkpointId, or an
 * unknown operation) are skipped for the same reason.  The rest of the file is returned in order.  An absent
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
