import * as fs from "fs/promises"
import * as path from "path"

import type { ClineMessage } from "@roo-code/types"

/**
 * A manually-triggered conversation checkpoint.
 *
 * Unlike the git-based file checkpoints (RepoPerTaskCheckpointService), a conversation
 * checkpoint snapshots the task's full message history so the user can restore the
 * conversation to this point later. Stored as JSON under `<taskDir>/checkpoints/`.
 */
export interface ConversationCheckpoint {
	/** Filename stem: epoch ms, with a `-N` suffix on same-millisecond collisions. */
	id: string
	taskId: string
	createdAt: number
	summary?: string
	messages: ClineMessage[]
}

const CHECKPOINT_DIR = "checkpoints"

function checkpointDir(taskDir: string): string {
	return path.join(taskDir, CHECKPOINT_DIR)
}

/**
 * Saves a conversation checkpoint to `<taskDir>/checkpoints/<id>.json`.
 *
 * The id is the creation timestamp; if that file already exists (two checkpoints in the
 * same millisecond) a `-1`, `-2`, ... suffix is appended so no data is lost.
 */
export async function saveConversationCheckpoint(opts: {
	taskDir: string
	taskId: string
	messages: ClineMessage[]
	summary?: string
	/** Injectable clock for deterministic tests. Defaults to Date.now(). */
	now?: number
}): Promise<ConversationCheckpoint> {
	const dir = checkpointDir(opts.taskDir)
	await fs.mkdir(dir, { recursive: true })

	const createdAt = opts.now ?? Date.now()
	let id = String(createdAt)
	// Same-millisecond collision guard: append a numeric suffix until the file is free.
	for (let n = 1; await fileExists(path.join(dir, `${id}.json`)); n++) {
		id = `${createdAt}-${n}`
	}

	const checkpoint: ConversationCheckpoint = {
		id,
		taskId: opts.taskId,
		createdAt,
		...(opts.summary !== undefined ? { summary: opts.summary } : {}),
		messages: structuredClone(opts.messages),
	}

	await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(checkpoint, null, 2), "utf8")
	return checkpoint
}

/** Lists all conversation checkpoints for a task, newest first. Missing dir → empty list. */
export async function listConversationCheckpoints(taskDir: string): Promise<ConversationCheckpoint[]> {
	const dir = checkpointDir(taskDir)
	let entries: string[]
	try {
		entries = await fs.readdir(dir)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return []
		}
		throw error
	}

	const checkpoints: ConversationCheckpoint[] = []
	for (const entry of entries) {
		if (!entry.endsWith(".json")) {
			continue
		}
		try {
			const raw = await fs.readFile(path.join(dir, entry), "utf8")
			checkpoints.push(JSON.parse(raw) as ConversationCheckpoint)
		} catch {
			// Skip corrupt/partial files rather than failing the whole listing.
		}
	}

	return checkpoints.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
}

/** Loads a single checkpoint by id. Returns undefined when not found or unreadable. */
export async function loadConversationCheckpoint(
	taskDir: string,
	id: string,
): Promise<ConversationCheckpoint | undefined> {
	const file = path.join(checkpointDir(taskDir), `${id}.json`)
	try {
		const raw = await fs.readFile(file, "utf8")
		return JSON.parse(raw) as ConversationCheckpoint
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined
		}
		throw error
	}
}

async function fileExists(file: string): Promise<boolean> {
	try {
		await fs.access(file)
		return true
	} catch {
		return false
	}
}
