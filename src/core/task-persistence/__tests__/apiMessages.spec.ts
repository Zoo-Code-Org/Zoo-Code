// cd src && npx vitest run core/task-persistence/__tests__/apiMessages.spec.ts

import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

const hoisted = vi.hoisted(() => ({ readFileMock: vi.fn() }))
vi.mock("fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs/promises")>()),
	readFile: hoisted.readFileMock,
}))

import {
	createResumeHistoryRecoveryCopy,
	type ApiMessage,
	readApiMessages,
	removeResumeHistoryRecoveryCopy,
	restoreApiMessagesIfUnchanged,
	saveApiMessages,
} from "../apiMessages"

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

		const savedMessages = await saveApiMessages({
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
		expect(savedMessages).toEqual([
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

		expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual([
			expect.objectContaining({ role: "user", content: "C", ts: 3, messageId: expect.any(String) }),
		])
	})
})

describe("apiMessages.createResumeHistoryRecoveryCopy", () => {
	it("writes the original history to a unique identifiable copy without mutating the caller", async () => {
		const taskId = "task-recovery-copy"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const messages: ApiMessage[] = [{ role: "user", content: "original", ts: 1 }]

		const copyPath = await createResumeHistoryRecoveryCopy({ taskId, globalStoragePath: tmpBaseDir, messages })

		expect(path.dirname(copyPath)).toBe(taskDir)
		expect(path.basename(copyPath)).toMatch(/^api_conversation_history\.json\.pre-resume-/)
		// The copy carries message identifiers while the caller's objects stay
		// untouched, because the helper clones before it ensures identifiers.
		expect(await fs.readFile(copyPath, "utf8")).toBe(
			JSON.stringify([{ role: "user", content: "original", ts: 1, messageId: "legacy:1:0" }]),
		)
		expect(messages[0].messageId).toBeUndefined()
	})

	it("never overwrites a peer recovery copy", async () => {
		const taskId = "task-recovery-peer"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const messages: ApiMessage[] = [{ role: "user", content: "original", ts: 1, messageId: "m-1" }]

		const firstPath = await createResumeHistoryRecoveryCopy({ taskId, globalStoragePath: tmpBaseDir, messages })
		const secondPath = await createResumeHistoryRecoveryCopy({ taskId, globalStoragePath: tmpBaseDir, messages })

		expect(firstPath).not.toBe(secondPath)
		expect(await fs.readFile(firstPath, "utf8")).toBe(JSON.stringify(messages))
		expect(await fs.readFile(secondPath, "utf8")).toBe(JSON.stringify(messages))
	})
})

describe("apiMessages.removeResumeHistoryRecoveryCopy", () => {
	it("removes the copy and ignores an already missing copy", async () => {
		const taskId = "task-recovery-remove"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const copyPath = await createResumeHistoryRecoveryCopy({
			taskId,
			globalStoragePath: tmpBaseDir,
			messages: [{ role: "user", content: "original", ts: 1, messageId: "m-1" }],
		})

		await removeResumeHistoryRecoveryCopy(copyPath)
		await expect(fs.access(copyPath)).rejects.toMatchObject({ code: "ENOENT" })
		await expect(removeResumeHistoryRecoveryCopy(copyPath)).resolves.toBeUndefined()
	})
})

describe("apiMessages.restoreApiMessagesIfUnchanged", () => {
	const prepared: ApiMessage[] = [
		{ role: "user", content: "first", ts: 1, messageId: "m-1" },
		{ role: "assistant", content: "reply", ts: 2, messageId: "m-2" },
	]
	const original: ApiMessage[] = [...prepared, { role: "user", content: "last", ts: 3, messageId: "m-3" }]

	async function seedDisk(taskId: string, content: ApiMessage[]): Promise<string> {
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "api_conversation_history.json")
		await fs.writeFile(filePath, JSON.stringify(content), "utf8")
		return filePath
	}

	function proceedGate() {
		return async () => "proceed" as const
	}

	it("restores the replacement when the disk still holds the prepared content", async () => {
		const taskId = "task-restore-ok"
		const filePath = await seedDisk(taskId, prepared)
		const gate = vi.fn(proceedGate())

		const result = await restoreApiMessagesIfUnchanged({
			taskId,
			globalStoragePath: tmpBaseDir,
			expected: prepared,
			replacement: original,
			verifyCanRestore: gate,
		})

		expect(result).toEqual({ outcome: "restored" })
		// The gate ran inside the lock scope, before the write.
		expect(gate).toHaveBeenCalledTimes(1)
		expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(original)
	})

	it("keeps a foreign history that is written inside the lock window", async () => {
		const taskId = "task-restore-foreign"
		const filePath = await seedDisk(taskId, prepared)
		const foreign: ApiMessage[] = [...prepared, { role: "assistant", content: "foreign", ts: 4, messageId: "m-9" }]

		const result = await restoreApiMessagesIfUnchanged({
			taskId,
			globalStoragePath: tmpBaseDir,
			expected: prepared,
			replacement: original,
			// A non-locking foreign writer lands after the gate passed and
			// before the compare runs at commit time. The compare must reject.
			verifyCanRestore: async () => {
				await fs.writeFile(filePath, JSON.stringify(foreign), "utf8")
				return "proceed" as const
			},
		})

		expect(result).toMatchObject({ outcome: "foreign_write" })
		expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(foreign)
	})

	it("fails closed without writing when the disk file is missing", async () => {
		const taskId = "task-restore-missing"
		const filePath = path.join(tmpBaseDir, "tasks", taskId, "api_conversation_history.json")

		const result = await restoreApiMessagesIfUnchanged({
			taskId,
			globalStoragePath: tmpBaseDir,
			expected: prepared,
			replacement: original,
			verifyCanRestore: proceedGate(),
		})

		expect(result).toMatchObject({ outcome: "unreadable" })
		await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("fails closed without writing when the disk content is unreadable", async () => {
		const taskId = "task-restore-corrupt"
		const filePath = await seedDisk(taskId, [])
		await fs.writeFile(filePath, "not json", "utf8")

		const result = await restoreApiMessagesIfUnchanged({
			taskId,
			globalStoragePath: tmpBaseDir,
			expected: prepared,
			replacement: original,
			verifyCanRestore: proceedGate(),
		})

		expect(result).toMatchObject({ outcome: "unreadable" })
		expect(await fs.readFile(filePath, "utf8")).toBe("not json")
	})

	it("fails closed without writing when the status gate throws", async () => {
		const taskId = "task-restore-gate-error"
		const filePath = await seedDisk(taskId, prepared)

		const result = await restoreApiMessagesIfUnchanged({
			taskId,
			globalStoragePath: tmpBaseDir,
			expected: prepared,
			replacement: original,
			verifyCanRestore: async () => {
				throw new Error("no valid disk record")
			},
		})

		expect(result).toMatchObject({ outcome: "record_state_unknown" })
		expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(prepared)
	})

	it("skips the write when the gate reports the record committed elsewhere", async () => {
		const taskId = "task-restore-active"
		const filePath = await seedDisk(taskId, prepared)

		const result = await restoreApiMessagesIfUnchanged({
			taskId,
			globalStoragePath: tmpBaseDir,
			expected: prepared,
			replacement: original,
			verifyCanRestore: async () => "committed_elsewhere" as const,
		})

		expect(result).toEqual({ outcome: "committed_elsewhere" })
		expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(prepared)
	})

	it("skips the write when the gate aborts on a conflicting record state", async () => {
		const taskId = "task-restore-conflict"
		const filePath = await seedDisk(taskId, prepared)

		const result = await restoreApiMessagesIfUnchanged({
			taskId,
			globalStoragePath: tmpBaseDir,
			expected: prepared,
			replacement: original,
			verifyCanRestore: async () => "abort" as const,
		})

		expect(result).toEqual({ outcome: "record_state_conflict" })
		expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(prepared)
	})

	it("rethrows an unexpected write failure after the rollback restored the disk content", async () => {
		const taskId = "task-restore-write-error"
		const filePath = await seedDisk(taskId, prepared)
		const realRename = fs.rename.bind(fs)
		const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
			if (String(newPath).endsWith("api_conversation_history.json") && String(oldPath).includes(".new_")) {
				throw new Error("injected disk full")
			}
			return realRename(oldPath as string, newPath as string)
		})

		await expect(
			restoreApiMessagesIfUnchanged({
				taskId,
				globalStoragePath: tmpBaseDir,
				expected: prepared,
				replacement: original,
				verifyCanRestore: proceedGate(),
			}),
		).rejects.toThrow("injected disk full")

		renameSpy.mockRestore()
		// The safeWriteJson rollback put the prepared content back.
		expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(prepared)
	})
})
