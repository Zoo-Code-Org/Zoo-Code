// npx vitest run __tests__/conversation-checkpoint-task.spec.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { ClineMessage } from "@roo-code/types"
import { Task } from "../core/task/Task"

function makeMessages(n: number): ClineMessage[] {
	return Array.from(
		{ length: n },
		(_, i) =>
			({
				type: "user",
				text: `message ${i}`,
				ts: 1000 + i,
			}) as unknown as ClineMessage,
	)
}

let tmpDir: string

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "conv-checkpoint-task-"))
})

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true })
})

/**
 * Task double carrying only the fields the checkpoint trigger methods read.
 * The real prototype methods are bound onto the stub so we exercise the actual
 * Task code path (getTaskDirectoryPath + storage module) without instantiating a Task.
 */
function makeTaskDouble(taskId: string, messages: ClineMessage[]) {
	const proto = Task.prototype as unknown as {
		createConversationCheckpoint: (this: object, summary?: string) => Promise<unknown>
		listConversationCheckpoints: (this: object) => Promise<unknown[]>
	}
	const stub = { taskId, globalStoragePath: tmpDir, clineMessages: messages }
	return Object.assign(stub, {
		createConversationCheckpoint: proto.createConversationCheckpoint.bind(stub),
		listConversationCheckpoints: proto.listConversationCheckpoints.bind(stub),
	}) as unknown as Task
}

describe("Task.createConversationCheckpoint", () => {
	it("persists the full message history under <taskDir>/checkpoints and returns the checkpoint", async () => {
		const task = makeTaskDouble("task-1", makeMessages(2))

		const cp = await task.createConversationCheckpoint("halfway")

		expect(cp.taskId).toBe("task-1")
		expect(cp.summary).toBe("halfway")
		expect(cp.messages).toHaveLength(2)

		// Lands in the standard task directory layout: <storage>/tasks/<taskId>/checkpoints/<id>.json
		const raw = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", "task-1", "checkpoints", `${cp.id}.json`), "utf8"),
		) as { taskId: string; messages: unknown[] }
		expect(raw.taskId).toBe("task-1")
		expect(raw.messages).toHaveLength(2)
	})

	it("lists checkpoints newest first via listConversationCheckpoints", async () => {
		const task = makeTaskDouble("task-1", makeMessages(1))

		const cp1 = await task.createConversationCheckpoint()
		// Ensure a distinct timestamp so ordering is unambiguous.
		await new Promise((resolve) => setTimeout(resolve, 5))
		const cp2 = await task.createConversationCheckpoint("second")

		const list = await task.listConversationCheckpoints()
		expect(list.map((c) => c.id)).toEqual([cp2.id, cp1.id])
	})
})
