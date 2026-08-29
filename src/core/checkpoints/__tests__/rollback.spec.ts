import fs from "fs/promises"
import os from "os"
import path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import type { ChangeJournalEntry } from "../changeJournal"
import { getCheckpointService } from "../index"
import * as changeJournal from "../changeJournal"
import { appendChange, journalPath } from "../changeJournal"
import { restoreLatestFile, rollbackFile, rollbackStep } from "../rollback"

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

/** A checkpoint-service double with a recording restoreFile and a baseline. */
function serviceWith(baseHash: string | undefined) {
	const restoreFile = vi.fn().mockResolvedValue(undefined)
	return { baseHash, restoreFile }
}

async function seedJournal(entries: ChangeJournalEntry[]): Promise<void> {
	for (const entry of entries) {
		await appendChange(globalStorageDir, "task-rollback", entry)
	}
}

let globalStorageDir: string

beforeEach(async () => {
	globalStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), "b3c-rollback-"))
	mockedGetCheckpointService.mockReset()
})

afterEach(async () => {
	await fs.rm(globalStorageDir, { recursive: true, force: true })
})

describe("rollbackFile (B3c: undo the step's write to the file)", () => {
	it("restores the file to the PREVIOUS step's checkpoint when an earlier entry exists", async () => {
		await seedJournal([
			{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" },
			{ path: "src/a.ts", operation: "update", checkpointId: "sha-2" },
		])
		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackFile(makeTask(), "sha-2", "src/a.ts")

		expect(outcome).toEqual({ filePath: "src/a.ts", success: true })
		// The pre-step state is the previous step's post-write checkpoint — not
		// the step's own (post-write) checkpoint.
		expect(service.restoreFile).toHaveBeenCalledTimes(1)
		expect(service.restoreFile).toHaveBeenCalledWith("sha-1", "src/a.ts")
	})

	it("restores from the task-start baseline when the file has no earlier entry", async () => {
		await seedJournal([{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" }])
		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackFile(makeTask(), "sha-1", "src/a.ts")

		expect(outcome).toEqual({ filePath: "src/a.ts", success: true })
		expect(service.restoreFile).toHaveBeenCalledWith("base-0", "src/a.ts")
	})

	it("resolves through the first entry of a multi-write step", async () => {
		// One patch writes the same file twice: two entries share the step
		// checkpoint. The pre-step state is still the entry before the first
		// one of the step.
		await seedJournal([
			{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" },
			{ path: "src/a.ts", operation: "update", checkpointId: "sha-2" },
			{ path: "src/a.ts", operation: "update", checkpointId: "sha-2" },
		])
		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackFile(makeTask(), "sha-2", "src/a.ts")

		expect(outcome.success).toBe(true)
		expect(service.restoreFile).toHaveBeenCalledWith("sha-1", "src/a.ts")
	})

	it("rejects rolling back a step that is not the file's latest change", async () => {
		// The file was written again by a later step (sha-2): rolling back the
		// older step (sha-1) would overwrite the newer state, so it is
		// rejected instead of silently destroying it.
		await seedJournal([
			{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" },
			{ path: "src/a.ts", operation: "update", checkpointId: "sha-2" },
		])
		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackFile(makeTask(), "sha-1", "src/a.ts")

		expect(outcome).toEqual({
			filePath: "src/a.ts",
			success: false,
			error: "File was modified in a later step; roll back the latest change card first",
		})
		expect(service.restoreFile).not.toHaveBeenCalled()
	})

	it("fails when the journal location is unavailable (no global storage)", async () => {
		// No context on the provider double → the journal cannot even be
		// located: a clear failure, not a silent miss on the file lookup.
		const task = {
			taskId: "task-rollback",
			providerRef: { deref: vi.fn().mockReturnValue(undefined) },
		} as unknown as Task

		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackFile(task, "sha-1", "src/a.ts")

		expect(outcome).toEqual({
			filePath: "src/a.ts",
			success: false,
			error: "Change journal is unavailable for this task",
		})
		expect(service.restoreFile).not.toHaveBeenCalled()
	})

	it("fails cleanly when the file is not part of the given step checkpoint", async () => {
		await seedJournal([{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" }])
		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackFile(makeTask(), "sha-2", "src/a.ts")

		expect(outcome).toEqual({
			filePath: "src/a.ts",
			success: false,
			error: "File is not part of this step's checkpoint",
		})
		expect(service.restoreFile).not.toHaveBeenCalled()
	})

	it("fails cleanly when no earlier checkpoint exists and the baseline is unavailable", async () => {
		await seedJournal([{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" }])
		const service = serviceWith(undefined)
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackFile(makeTask(), "sha-1", "src/a.ts")

		expect(outcome).toEqual({
			filePath: "src/a.ts",
			success: false,
			error: "No checkpoint available to restore",
		})
		expect(service.restoreFile).not.toHaveBeenCalled()
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
		await seedJournal([{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" }])
		const service = serviceWith("base-0")
		service.restoreFile.mockRejectedValue(new Error("pathspec did not match"))
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackFile(makeTask(), "sha-1", "src/a.ts")

		expect(outcome.success).toBe(false)
		expect(outcome.error).toContain("pathspec did not match")
	})

	it("stringifies non-Error rejections into the outcome", async () => {
		await seedJournal([{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" }])
		const service = serviceWith("base-0")
		service.restoreFile.mockRejectedValue("raw failure")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackFile(makeTask(), "sha-1", "src/a.ts")

		expect(outcome).toEqual({ filePath: "src/a.ts", success: false, error: "raw failure" })
	})
})

describe("rollbackStep (B3c: undo every file of the step)", () => {
	it("restores every step file to its pre-step state", async () => {
		await seedJournal([
			{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" },
			{ path: "src/a.ts", operation: "update", checkpointId: "sha-2" },
			{ path: "src/b.ts", operation: "update", checkpointId: "sha-2" },
		])
		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackStep(makeTask(), ["src/a.ts", "src/b.ts"], "sha-2")

		expect(outcome.checkpointId).toBe("sha-2")
		expect(outcome.files).toEqual([
			{ filePath: "src/a.ts", success: true },
			{ filePath: "src/b.ts", success: true },
		])
		expect(service.restoreFile).toHaveBeenCalledTimes(2)
		expect(service.restoreFile).toHaveBeenNthCalledWith(1, "sha-1", "src/a.ts")
		// src/b.ts has no earlier entry: its pre-step state is the baseline.
		expect(service.restoreFile).toHaveBeenNthCalledWith(2, "base-0", "src/b.ts")
	})

	it("keeps per-file failures isolated from the other step files", async () => {
		await seedJournal([
			{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" },
			{ path: "src/a.ts", operation: "update", checkpointId: "sha-2" },
			{ path: "src/b.ts", operation: "create", checkpointId: "sha-2" },
		])
		const service = serviceWith("base-0")
		service.restoreFile.mockRejectedValueOnce(new Error("pathspec did not match"))
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackStep(makeTask(), ["src/a.ts", "src/b.ts"], "sha-2")

		expect(outcome.files[0].success).toBe(false)
		expect(outcome.files[0].error).toContain("pathspec did not match")
		expect(outcome.files[1]).toEqual({ filePath: "src/b.ts", success: true })
	})

	it("fails the file cleanly when no earlier checkpoint exists and the baseline is unavailable", async () => {
		await seedJournal([{ path: "src/a.ts", operation: "create", checkpointId: "sha-2" }])
		const service = serviceWith(undefined)
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackStep(makeTask(), ["src/a.ts"], "sha-2")

		expect(outcome.checkpointId).toBe("sha-2")
		expect(outcome.files).toEqual([
			{ filePath: "src/a.ts", success: false, error: "No checkpoint available to restore" },
		])
		expect(service.restoreFile).not.toHaveBeenCalled()
	})

	it("rejects a file that is not part of the given step checkpoint", async () => {
		await seedJournal([{ path: "src/a.ts", operation: "create", checkpointId: "sha-2" }])
		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackStep(makeTask(), ["src/a.ts", "src/other.ts"], "sha-2")

		expect(outcome.files[0]).toEqual({ filePath: "src/a.ts", success: true })
		expect(outcome.files[1].success).toBe(false)
		expect(outcome.files[1].error).toBe("File is not part of this step's checkpoint")
		expect(service.restoreFile).toHaveBeenCalledTimes(1)
	})

	it("rejects the stale file of a step while restoring the others", async () => {
		// src/a.ts was written again after this step's checkpoint, so its
		// sha-2 entry is no longer the file's latest: only src/b.ts (whose
		// latest entry IS sha-2) is restored.
		await seedJournal([
			{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" },
			{ path: "src/a.ts", operation: "update", checkpointId: "sha-2" },
			{ path: "src/b.ts", operation: "create", checkpointId: "sha-2" },
			{ path: "src/a.ts", operation: "update", checkpointId: "sha-3" },
		])
		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackStep(makeTask(), ["src/a.ts", "src/b.ts"], "sha-2")

		expect(outcome.files[0].success).toBe(false)
		expect(outcome.files[0].error).toBe("File was modified in a later step; roll back the latest change card first")
		expect(outcome.files[1]).toEqual({ filePath: "src/b.ts", success: true })
		expect(service.restoreFile).toHaveBeenCalledTimes(1)
		expect(service.restoreFile).toHaveBeenCalledWith("base-0", "src/b.ts")
	})

	it("falls back to the latest journal entry per file without a step checkpoint id", async () => {
		await seedJournal([
			{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" },
			{ path: "src/a.ts", operation: "update", checkpointId: "sha-2" },
		])
		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackStep(makeTask(), ["src/a.ts"])

		expect(outcome.checkpointId).toBeUndefined()
		expect(outcome.files).toEqual([{ filePath: "src/a.ts", success: true }])
		expect(service.restoreFile).toHaveBeenCalledWith("sha-2", "src/a.ts")
	})

	it("fails listed files without journal entries", async () => {
		await seedJournal([{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" }])
		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackStep(makeTask(), ["src/a.ts", "src/missing.ts"])

		expect(outcome.files[0]).toEqual({ filePath: "src/a.ts", success: true })
		expect(outcome.files[1].success).toBe(false)
		expect(outcome.files[1].error).toBe("No change journal entry for this file")
	})

	it("fails per file when the journal location is unavailable (no global storage)", async () => {
		// No context on the provider double → the journal cannot even be
		// located. That is a failure, not an empty journal: reporting the
		// step as merely "not part of this checkpoint" would be misleading.
		const task = {
			taskId: "task-rollback",
			providerRef: { deref: vi.fn().mockReturnValue(undefined) },
		} as unknown as Task

		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await rollbackStep(task, ["src/a.ts"], "sha-2")

		expect(outcome.checkpointId).toBe("sha-2")
		expect(outcome.files[0].success).toBe(false)
		expect(outcome.files[0].error).toBe("Change journal is unavailable for this task")
		expect(service.restoreFile).not.toHaveBeenCalled()
	})

	it("fails every file when checkpoints are not enabled", async () => {
		mockedGetCheckpointService.mockResolvedValue(undefined)

		const outcome = await rollbackStep(makeTask(), ["src/a.ts"], "sha-2")

		expect(outcome.checkpointId).toBe("sha-2")
		expect(outcome.files).toEqual([
			{ filePath: "src/a.ts", success: false, error: "Checkpoints are not enabled for this task" },
		])
	})
})

describe("restoreLatestFile (B3c: forward direction)", () => {
	it("restores the file to its most recent recorded write checkpoint", async () => {
		await seedJournal([
			{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" },
			{ path: "src/b.ts", operation: "update", checkpointId: "sha-1" },
			{ path: "src/a.ts", operation: "update", checkpointId: "sha-2" },
		])
		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await restoreLatestFile(makeTask(), "src/a.ts")

		expect(outcome).toEqual({ filePath: "src/a.ts", success: true })
		expect(service.restoreFile).toHaveBeenCalledWith("sha-2", "src/a.ts")
	})

	it("is a successful no-op for a file the task never wrote", async () => {
		await seedJournal([{ path: "src/b.ts", operation: "update", checkpointId: "sha-1" }])
		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await restoreLatestFile(makeTask(), "src/a.ts")

		expect(outcome).toEqual({ filePath: "src/a.ts", success: true, noOp: true })
		expect(service.restoreFile).not.toHaveBeenCalled()
	})

	it("fails when the journal location is unavailable (no global storage)", async () => {
		// An unavailable journal is not "the task wrote nothing": a no-op
		// success would claim a restore that never happened.
		const task = {
			taskId: "task-rollback",
			providerRef: { deref: vi.fn().mockReturnValue(undefined) },
		} as unknown as Task

		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await restoreLatestFile(task, "src/a.ts")

		expect(outcome).toEqual({
			filePath: "src/a.ts",
			success: false,
			error: "Change journal is unavailable for this task",
		})
		expect(service.restoreFile).not.toHaveBeenCalled()
	})

	it("fails when the journal cannot be read (an I/O error is not an empty journal)", async () => {
		// A directory at the journal path makes readFile fail with EISDIR —
		// a stand-in for any permission or I/O failure (EACCES etc.).
		await fs.mkdir(journalPath(globalStorageDir, "task-rollback"), { recursive: true })
		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await restoreLatestFile(makeTask(), "src/a.ts")

		expect(outcome.success).toBe(false)
		expect(outcome.error).toContain("Change journal could not be read")
		expect(service.restoreFile).not.toHaveBeenCalled()
	})

	it("stringifies a non-Error journal read failure into the outcome", async () => {
		vi.spyOn(changeJournal, "loadChanges").mockRejectedValueOnce("raw journal failure")
		const service = serviceWith("base-0")
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await restoreLatestFile(makeTask(), "src/a.ts")

		expect(outcome.success).toBe(false)
		expect(outcome.error).toBe("Change journal could not be read: raw journal failure")
		expect(service.restoreFile).not.toHaveBeenCalled()
	})

	it("fails cleanly when checkpoints are not enabled", async () => {
		mockedGetCheckpointService.mockResolvedValue(undefined)

		const outcome = await restoreLatestFile(makeTask(), "src/a.ts")

		expect(outcome).toEqual({
			filePath: "src/a.ts",
			success: false,
			error: "Checkpoints are not enabled for this task",
		})
	})

	it("reports the service error without throwing", async () => {
		await seedJournal([{ path: "src/a.ts", operation: "create", checkpointId: "sha-1" }])
		const service = serviceWith("base-0")
		service.restoreFile.mockRejectedValue(new Error("index.lock held"))
		mockedGetCheckpointService.mockResolvedValue(service)

		const outcome = await restoreLatestFile(makeTask(), "src/a.ts")

		expect(outcome.success).toBe(false)
		expect(outcome.error).toContain("index.lock")
	})
})
