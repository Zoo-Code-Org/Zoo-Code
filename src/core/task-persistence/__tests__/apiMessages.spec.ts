// cd src && npx vitest run core/task-persistence/__tests__/apiMessages.spec.ts

import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

const hoisted = vi.hoisted(() => ({ readFileMock: vi.fn() }))
vi.mock("fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs/promises")>()),
	readFile: hoisted.readFileMock,
}))

import { readApiMessages, saveApiMessages } from "../apiMessages"

let tmpBaseDir: string

beforeEach(async () => {
	const actualFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	hoisted.readFileMock.mockReset().mockImplementation(actualFs.readFile)
	tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-test-api-"))
})

describe("apiMessages.readApiMessages", () => {
	it("rejects invalid api_conversation_history.json without treating it as empty history", async () => {
		const taskId = "task-corrupt-api"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "api_conversation_history.json")
		await fs.writeFile(filePath, "<<<corrupt data>>>", "utf8")

		await expect(readApiMessages({ taskId, globalStoragePath: tmpBaseDir })).rejects.toMatchObject({
			kind: "invalid",
		})
	})

	it("rejects invalid claude_messages.json without deleting it", async () => {
		const taskId = "task-corrupt-fallback"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })

		// Only write the old fallback file (claude_messages.json), NOT the new one
		const oldPath = path.join(taskDir, "claude_messages.json")
		await fs.writeFile(oldPath, "not json at all {[!", "utf8")

		await expect(readApiMessages({ taskId, globalStoragePath: tmpBaseDir })).rejects.toMatchObject({
			kind: "invalid",
		})

		// The corrupted fallback file should NOT be deleted
		const stillExists = await fs
			.access(oldPath)
			.then(() => true)
			.catch(() => false)
		expect(stillExists).toBe(true)
	})

	it("rejects valid non-array JSON in the current file", async () => {
		const taskId = "task-non-array-api"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "api_conversation_history.json")
		await fs.writeFile(filePath, JSON.stringify("hello"), "utf8")

		await expect(readApiMessages({ taskId, globalStoragePath: tmpBaseDir })).rejects.toMatchObject({
			kind: "invalid",
		})
	})

	it("rejects valid non-array JSON in the fallback file", async () => {
		const taskId = "task-non-array-fallback"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })

		// Only write the old fallback file, NOT the new one
		const oldPath = path.join(taskDir, "claude_messages.json")
		await fs.writeFile(oldPath, JSON.stringify({ key: "value" }), "utf8")

		await expect(readApiMessages({ taskId, globalStoragePath: tmpBaseDir })).rejects.toMatchObject({
			kind: "invalid",
		})
	})

	it("returns empty history only when current and legacy files are both missing", async () => {
		await expect(readApiMessages({ taskId: "task-missing", globalStoragePath: tmpBaseDir })).resolves.toEqual([])
	})

	it("migrates valid legacy history before deleting its source", async () => {
		const taskId = "task-legacy-api"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const oldPath = path.join(taskDir, "claude_messages.json")
		const currentPath = path.join(taskDir, "api_conversation_history.json")
		const legacyMessages = [{ role: "user", content: "legacy", ts: 1 }]
		await fs.writeFile(oldPath, JSON.stringify(legacyMessages), "utf8")

		await expect(readApiMessages({ taskId, globalStoragePath: tmpBaseDir })).resolves.toEqual(legacyMessages)
		await expect(fs.readFile(currentPath, "utf8").then(JSON.parse)).resolves.toEqual(legacyMessages)
		await expect(fs.access(oldPath)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("retries one transient missing-file read", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0)
		const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
		hoisted.readFileMock.mockRejectedValueOnce(missing).mockResolvedValueOnce("[]")

		await expect(readApiMessages({ taskId: "task-retry", globalStoragePath: tmpBaseDir })).resolves.toEqual([])
		expect(hoisted.readFileMock).toHaveBeenCalledTimes(2)
	})

	it("does not retry non-ENOENT read failures", async () => {
		const denied = Object.assign(new Error("denied"), { code: "EACCES" })
		hoisted.readFileMock.mockRejectedValueOnce(denied)

		await expect(readApiMessages({ taskId: "task-denied", globalStoragePath: tmpBaseDir })).rejects.toMatchObject({
			kind: "io_error",
		})
		expect(hoisted.readFileMock).toHaveBeenCalledTimes(1)
	})
})

describe("apiMessages.saveApiMessages", () => {
	it("merges a concurrent disk suffix when requested", async () => {
		const taskId = "task-merge-api"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "api_conversation_history.json")
		await fs.writeFile(
			filePath,
			JSON.stringify([
				{ role: "user", content: "disk prefix", ts: 1 },
				{ role: "assistant", content: "disk suffix", ts: 3 },
			]),
			"utf8",
		)

		await saveApiMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
			merge: true,
			messages: [
				{ role: "user", content: "updated prefix", ts: 1 },
				{ role: "assistant", content: "incoming", ts: 2 },
			],
		})

		expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual([
			expect.objectContaining({ content: "updated prefix", ts: 1 }),
			expect.objectContaining({ content: "incoming", ts: 2 }),
			expect.objectContaining({ content: "disk suffix", ts: 3 }),
		])
	})

	it("replaces the persisted snapshot when merge is false", async () => {
		const taskId = "task-replace-api"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "api_conversation_history.json")
		await fs.writeFile(
			filePath,
			JSON.stringify([
				{ role: "user", content: "A", ts: 1 },
				{ role: "assistant", content: "B", ts: 2 },
			]),
			"utf8",
		)

		await saveApiMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
			merge: false,
			messages: [{ role: "user", content: "C", ts: 3 }],
		})

		expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual([{ role: "user", content: "C", ts: 3 }])
	})
})
