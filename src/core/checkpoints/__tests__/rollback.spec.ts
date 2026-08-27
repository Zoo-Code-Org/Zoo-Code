import fs from "fs/promises"
import os from "os"
import path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import { getCheckpointService } from "../index"
import { appendChange } from "../changeJournal"
import { rollbackFile, rollbackStep } from "../rollback"

vi.mock("../index", () => ({
	getCheckpointService: vi.fn(),
	checkpointSave: vi.fn(),
	checkpointRestore: vi.fn(),
	checkpointDiff: vi.fn(),
}))

const mockedGetCheckpointService = getCheckpointService as unknown as ReturnType<typeof vi.fn>

function makeTask(): Task {
	return {
		taskId: "task-rollback",
		providerRef: {
			deref: vi.fn().mockReturnValue({ context: { globalStorageUri: { fsPath: globalStorageDir } } }),
		},
	} as unknown as Task
}

let globalStorageDir: string

beforeEach(async () => {
	globalStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), "b3a-rollback-"))
	mockedGetCheckpointService.mockReset()
})

afterEach(async () => {
	await fs.rm(globalStorageDir, { recursive: true, force: true })
})

describe("rollbackFile (B3a)", () => {
	it("restores the file through the task's checkpoint service", async () => {
		const restoreFile = vi.fn().mockResolvedValue(undefined)
		mockedGetCheckpointService.mockResolvedValue({ restoreFile })

		const outcome = await rollbackFile(makeTask(), "sha-1", "src/a.ts")

		expect(outcome).toEqual({ filePath: "src/a.ts", success: true })
		expect(restoreFile).toHaveBeenCalledWith("sha-1", "src/a.ts")
	})

	it("fails cleanly when checkpoints are not enabled", async () => {
		mockedGetCheckpointService.mockResolvedValue(undefined)

		const outcome = await rollbackFile(makeTask(), "sha-1", "src/a.ts")

		expect(outcome).toEqual({
			filePath: "src/a.ts",
			success: false,
			error: "Checkpoints are not enabled for this task",
		})
	})

	it("reports the service error without throwing", async () => {
		mockedGetCheckpointService.mockResolvedValue({
			restoreFile: vi.fn().mockRejectedValue(new Error("pathspec did not match")),
		})

		const outcome = await rollbackFile(makeTask(), "sha-bad", "src/a.ts")

		expect(outcome.success).toBe(false)
		expect(outcome.error).toContain("pathspec did not match")
	})

	it("stringifies non-Error rejections into the outcome", async () => {
		mockedGetCheckpointService.mockResolvedValue({
			restoreFile: vi.fn().mockRejectedValue("raw failure"),
		})

		const outcome = await rollbackFile(makeTask(), "sha-bad", "src/a.ts")

		expect(outcome).toEqual({ filePath: "src/a.ts", success: false, error: "raw failure" })
	})
})

describe("rollbackStep (B3a)", () => {
	it("restores every step file from the step's checkpoint via the journal", async () => {
		await appendChange(globalStorageDir, "task-rollback", {
			path: "src/a.ts",
			operation: "create",
			checkpointId: "sha-step",
		})
		await appendChange(globalStorageDir, "task-rollback", {
			path: "src/b.ts",
			operation: "update",
			checkpointId: "sha-step",
		})

		const restoreFile = vi.fn().mockResolvedValue(undefined)
		mockedGetCheckpointService.mockResolvedValue({ restoreFile })

		const outcome = await rollbackStep(makeTask(), ["src/a.ts", "src/b.ts"], "sha-step")

		expect(outcome.checkpointId).toBe("sha-step")
		expect(outcome.files).toEqual([
			{ filePath: "src/a.ts", success: true },
			{ filePath: "src/b.ts", success: true },
		])
		expect(restoreFile).toHaveBeenCalledTimes(2)
		expect(restoreFile).toHaveBeenNthCalledWith(1, "sha-step", "src/a.ts")
		expect(restoreFile).toHaveBeenNthCalledWith(2, "sha-step", "src/b.ts")
	})

	it("rejects a file that is not part of the given step checkpoint", async () => {
		await appendChange(globalStorageDir, "task-rollback", {
			path: "src/a.ts",
			operation: "create",
			checkpointId: "sha-step",
		})

		const restoreFile = vi.fn().mockResolvedValue(undefined)
		mockedGetCheckpointService.mockResolvedValue({ restoreFile })

		const outcome = await rollbackStep(makeTask(), ["src/a.ts", "src/other.ts"], "sha-step")

		expect(outcome.files[0]).toEqual({ filePath: "src/a.ts", success: true })
		expect(outcome.files[1].success).toBe(false)
		expect(outcome.files[1].error).toBe("File is not part of this step's checkpoint")
		expect(restoreFile).toHaveBeenCalledTimes(1)
	})

	it("falls back to the latest journal entry per file without a step checkpoint id", async () => {
		await appendChange(globalStorageDir, "task-rollback", {
			path: "src/a.ts",
			operation: "create",
			checkpointId: "sha-1",
		})
		await appendChange(globalStorageDir, "task-rollback", {
			path: "src/a.ts",
			operation: "update",
			checkpointId: "sha-2",
		})

		const restoreFile = vi.fn().mockResolvedValue(undefined)
		mockedGetCheckpointService.mockResolvedValue({ restoreFile })

		const outcome = await rollbackStep(makeTask(), ["src/a.ts"])

		expect(outcome.checkpointId).toBe("sha-2")
		expect(restoreFile).toHaveBeenCalledWith("sha-2", "src/a.ts")
	})

	it("fails listed files without journal entries and keeps the checkpoint when resolvable", async () => {
		await appendChange(globalStorageDir, "task-rollback", {
			path: "src/a.ts",
			operation: "create",
			checkpointId: "sha-1",
		})

		const restoreFile = vi.fn().mockResolvedValue(undefined)
		mockedGetCheckpointService.mockResolvedValue({ restoreFile })

		const outcome = await rollbackStep(makeTask(), ["src/a.ts", "src/missing.ts"])

		expect(outcome.checkpointId).toBe("sha-1")
		expect(outcome.files[0]).toEqual({ filePath: "src/a.ts", success: true })
		expect(outcome.files[1].success).toBe(false)
		expect(outcome.files[1].error).toBe("No change journal entry for this file")
	})

	it("treats a missing global storage directory as an empty journal", async () => {
		// No context on the provider double → no journal location to read.
		const task = {
			taskId: "task-rollback",
			providerRef: { deref: vi.fn().mockReturnValue(undefined) },
		} as unknown as Task

		const restoreFile = vi.fn().mockResolvedValue(undefined)
		mockedGetCheckpointService.mockResolvedValue({ restoreFile })

		const outcome = await rollbackStep(task, ["src/a.ts"], "sha-step")

		expect(outcome.checkpointId).toBe("sha-step")
		expect(outcome.files[0].success).toBe(false)
		expect(outcome.files[0].error).toBe("File is not part of this step's checkpoint")
		expect(restoreFile).not.toHaveBeenCalled()
	})
	it("fails every file when checkpoints are not enabled", async () => {
		mockedGetCheckpointService.mockResolvedValue(undefined)

		const outcome = await rollbackStep(makeTask(), ["src/a.ts"], "sha-step")

		expect(outcome.checkpointId).toBe("sha-step")
		expect(outcome.files).toEqual([
			{ filePath: "src/a.ts", success: false, error: "Checkpoints are not enabled for this task" },
		])
	})
})
