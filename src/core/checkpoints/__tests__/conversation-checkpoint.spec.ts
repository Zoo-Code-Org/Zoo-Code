// npx vitest run core/checkpoints/__tests__/conversation-checkpoint.spec.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { ClineMessage } from "@roo-code/types"
import {
	saveConversationCheckpoint,
	listConversationCheckpoints,
	loadConversationCheckpoint,
} from "../conversation-checkpoint"

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
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "conv-checkpoint-"))
})

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("saveConversationCheckpoint", () => {
	it("writes a JSON file named by the creation timestamp and returns the checkpoint", async () => {
		const messages = makeMessages(3)

		const cp = await saveConversationCheckpoint({ taskDir: tmpDir, taskId: "task-1", messages, now: 2000 })

		expect(cp.id).toBe("2000")
		expect(cp.taskId).toBe("task-1")
		expect(cp.createdAt).toBe(2000)
		const raw = await fs.readFile(path.join(tmpDir, "checkpoints", "2000.json"), "utf8")
		const parsed = JSON.parse(raw) as { id: string; taskId: string; messages: unknown[] }
		expect(parsed.id).toBe("2000")
		expect(parsed.taskId).toBe("task-1")
		expect(parsed.messages).toHaveLength(3)
	})

	it("omits the summary field when none is provided and includes it when given", async () => {
		const noSummary = await saveConversationCheckpoint({
			taskDir: tmpDir,
			taskId: "t",
			messages: makeMessages(1),
			now: 100,
		})
		expect(noSummary.summary).toBeUndefined()

		const withSummary = await saveConversationCheckpoint({
			taskDir: tmpDir,
			taskId: "t",
			messages: makeMessages(1),
			summary: "halfway done",
			now: 200,
		})
		expect(withSummary.summary).toBe("halfway done")

		const raw = await fs.readFile(path.join(tmpDir, "checkpoints", "100.json"), "utf8")
		expect(JSON.parse(raw) as Record<string, unknown>).not.toHaveProperty("summary")
	})

	it("appends a numeric suffix on same-millisecond collisions instead of overwriting", async () => {
		await saveConversationCheckpoint({ taskDir: tmpDir, taskId: "t", messages: makeMessages(1), now: 500 })
		const second = await saveConversationCheckpoint({
			taskDir: tmpDir,
			taskId: "t",
			messages: makeMessages(2),
			now: 500,
		})

		expect(second.id).toBe("500-1")
		// Both files coexist.
		await expect(fs.access(path.join(tmpDir, "checkpoints", "500.json"))).resolves.toBeUndefined()
		await expect(fs.access(path.join(tmpDir, "checkpoints", "500-1.json"))).resolves.toBeUndefined()
	})

	it("does not mutate the caller's messages array (deep clone)", async () => {
		const messages = makeMessages(2)
		await saveConversationCheckpoint({ taskDir: tmpDir, taskId: "t", messages, now: 300 })
		;(messages[0] as { text?: string }).text = "mutated"

		const loaded = await loadConversationCheckpoint(tmpDir, "300")
		expect((loaded?.messages[0] as { text?: string }).text).toBe("message 0")
	})
})

describe("listConversationCheckpoints", () => {
	it("returns an empty list when the checkpoints directory does not exist", async () => {
		const result = await listConversationCheckpoints(tmpDir)
		expect(result).toEqual([])
	})

	it("lists checkpoints newest first (createdAt desc, then id desc on ties)", async () => {
		await saveConversationCheckpoint({ taskDir: tmpDir, taskId: "t", messages: makeMessages(1), now: 100 })
		await saveConversationCheckpoint({ taskDir: tmpDir, taskId: "t", messages: makeMessages(1), now: 300 })
		await saveConversationCheckpoint({ taskDir: tmpDir, taskId: "t", messages: makeMessages(1), now: 200 })

		const result = await listConversationCheckpoints(tmpDir)
		expect(result.map((c) => c.id)).toEqual(["300", "200", "100"])
	})

	it("skips corrupt files rather than failing the listing", async () => {
		await saveConversationCheckpoint({ taskDir: tmpDir, taskId: "t", messages: makeMessages(1), now: 100 })
		const dir = path.join(tmpDir, "checkpoints")
		await fs.writeFile(path.join(dir, "999.json"), "{ not valid json", "utf8")

		const result = await listConversationCheckpoints(tmpDir)
		expect(result.map((c) => c.id)).toEqual(["100"])
	})
})

describe("loadConversationCheckpoint", () => {
	it("loads a saved checkpoint by id and returns undefined when missing", async () => {
		await saveConversationCheckpoint({
			taskDir: tmpDir,
			taskId: "t",
			messages: makeMessages(2),
			summary: "s",
			now: 400,
		})

		const loaded = await loadConversationCheckpoint(tmpDir, "400")
		expect(loaded?.taskId).toBe("t")
		expect(loaded?.summary).toBe("s")
		expect(loaded?.messages).toHaveLength(2)

		const missing = await loadConversationCheckpoint(tmpDir, "does-not-exist")
		expect(missing).toBeUndefined()
	})
})
