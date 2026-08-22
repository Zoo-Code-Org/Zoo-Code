import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

import type { ClineMessage } from "@roo-code/types"

// Mocks (use hoisted to avoid initialization ordering issues)
const hoisted = vi.hoisted(() => ({
	safeWriteJsonMock: vi.fn().mockResolvedValue(undefined),
	readFileMock: vi.fn(),
}))
vi.mock("fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs/promises")>()),
	readFile: hoisted.readFileMock,
}))
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: hoisted.safeWriteJsonMock,
}))

// Import after mocks
import { saveTaskMessages, readTaskMessages } from "../taskMessages"

let tmpBaseDir: string

beforeEach(async () => {
	hoisted.safeWriteJsonMock.mockClear()
	const actualFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	hoisted.readFileMock.mockReset().mockImplementation(actualFs.readFile)
	// Create a unique, writable temp directory to act as globalStoragePath
	tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-test-"))
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe("taskMessages.saveTaskMessages", () => {
	beforeEach(() => {
		hoisted.safeWriteJsonMock.mockClear()
	})

	it("persists messages as-is", async () => {
		const messages: any[] = [
			{
				role: "assistant",
				content: "Hello",
				metadata: {
					other: "keep",
				},
			},
			{ role: "user", content: "Do thing" },
		]

		await saveTaskMessages({
			messages,
			taskId: "task-1",
			globalStoragePath: tmpBaseDir,
		})

		expect(hoisted.safeWriteJsonMock).toHaveBeenCalledTimes(1)
		const [, persisted] = hoisted.safeWriteJsonMock.mock.calls[0]
		expect(persisted).toEqual(messages)
		expect(hoisted.safeWriteJsonMock.mock.calls[0][2]).toBeUndefined()
	})

	it("persists messages without modification when no metadata", async () => {
		const messages: any[] = [
			{ role: "assistant", content: "Hi" },
			{ role: "user", content: "Yo" },
		]

		await saveTaskMessages({
			messages,
			taskId: "task-2",
			globalStoragePath: tmpBaseDir,
		})

		const [, persisted] = hoisted.safeWriteJsonMock.mock.calls[0]
		expect(persisted).toEqual(messages)
	})

	it("passes the history merge callback only when requested", async () => {
		const messages: ClineMessage[] = [{ ts: 2, type: "say", say: "text", text: "incoming" }]
		await saveTaskMessages({
			messages,
			taskId: "task-merge",
			globalStoragePath: tmpBaseDir,
			merge: true,
		})

		const merge = hoisted.safeWriteJsonMock.mock.calls[0][2]?.merge
		expect(merge).toBeTypeOf("function")
		expect(merge([{ ts: 1, type: "say", say: "text", text: "disk" }], messages)).toEqual([
			expect.objectContaining({ ts: 1, text: "disk" }),
			expect.objectContaining({ ts: 2, text: "incoming" }),
		])
	})
})

describe("taskMessages.readTaskMessages", () => {
	it("rejects invalid JSON without treating it as empty history", async () => {
		const taskId = "task-corrupt-json"
		// Manually create the task directory and write corrupted JSON
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "ui_messages.json")
		await fs.writeFile(filePath, "{not valid json!!!", "utf8")

		await expect(readTaskMessages({ taskId, globalStoragePath: tmpBaseDir })).rejects.toMatchObject({
			kind: "invalid",
		})
	})

	it("rejects valid non-array JSON without treating it as empty history", async () => {
		const taskId = "task-non-array-json"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "ui_messages.json")
		await fs.writeFile(filePath, JSON.stringify("hello"), "utf8")

		await expect(readTaskMessages({ taskId, globalStoragePath: tmpBaseDir })).rejects.toMatchObject({
			kind: "invalid",
		})
	})

	it("distinguishes a missing history file from an empty history", async () => {
		await expect(readTaskMessages({ taskId: "task-missing", globalStoragePath: tmpBaseDir })).rejects.toMatchObject(
			{ kind: "not_found" },
		)
	})

	it("returns an explicitly persisted empty history", async () => {
		const taskId = "task-empty"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(path.join(taskDir, "ui_messages.json"), "[]", "utf8")

		await expect(readTaskMessages({ taskId, globalStoragePath: tmpBaseDir })).resolves.toEqual([])
	})

	it("retries one transient missing-file read after a jittered delay", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0)
		const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
		hoisted.readFileMock.mockRejectedValueOnce(missing).mockResolvedValueOnce("[]")

		await expect(readTaskMessages({ taskId: "task-retry", globalStoragePath: tmpBaseDir })).resolves.toEqual([])
		expect(hoisted.readFileMock).toHaveBeenCalledTimes(2)
	})

	it("throws when the missing-file retry also fails", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0)
		const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
		hoisted.readFileMock.mockRejectedValue(missing)

		await expect(
			readTaskMessages({ taskId: "task-still-missing", globalStoragePath: tmpBaseDir }),
		).rejects.toMatchObject({ kind: "not_found" })
		expect(hoisted.readFileMock).toHaveBeenCalledTimes(2)
	})

	it("does not retry non-ENOENT read failures", async () => {
		const denied = Object.assign(new Error("denied"), { code: "EACCES" })
		hoisted.readFileMock.mockRejectedValueOnce(denied)

		await expect(readTaskMessages({ taskId: "task-denied", globalStoragePath: tmpBaseDir })).rejects.toMatchObject({
			kind: "io_error",
		})
		expect(hoisted.readFileMock).toHaveBeenCalledTimes(1)
	})
})
