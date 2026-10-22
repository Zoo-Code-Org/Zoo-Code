import fs from "fs/promises"
import os from "os"
import path from "path"

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import type { Task } from "../../task/Task"
import { appendChange, loadChanges, pendingJournalPath, writePendingJournal } from "../changeJournal"
import { checkpointSave, type CheckpointWriteInfo } from "../index"

// Mock the VS Code API surface (index.ts imports vscode at module level).
vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		createTextEditorDecorationType: vi.fn(() => ({})),
	},
	Uri: {
		file: vi.fn((p: string) => ({ fsPath: p })),
		parse: vi.fn((_uri: string) => ({ with: vi.fn(() => ({})) })),
	},
	commands: {
		executeCommand: vi.fn(),
	},
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureCheckpointCreated: vi.fn(),
			captureCheckpointRestored: vi.fn(),
			captureCheckpointDiffed: vi.fn(),
		},
	},
}))

vi.mock("../../../utils/path", () => ({
	getWorkspacePath: vi.fn(() => "/test/workspace"),
}))

vi.mock("../../../utils/git", () => ({
	checkGitInstalled: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

vi.mock("p-wait-for", () => ({
	default: vi.fn(),
}))

// The real service would require a git repo; the checkpointSave under test
// only needs the pre-initialized service on the task.
vi.mock("../../../services/checkpoints")

const TASK_ID = "journal-test-task"
const COMMIT = "test-commit-hash"

interface ServiceLike {
	isInitialized: boolean
	saveCheckpoint: (...args: unknown[]) => Promise<unknown>
}

interface ProviderLike {
	context: { globalStorageUri: { fsPath: string } }
	log: (...args: unknown[]) => void
	postMessageToWebview: (...args: unknown[]) => void
}

interface TaskLike {
	taskId: string
	enableCheckpoints: boolean
	checkpointService: ServiceLike
	checkpointServiceInitializing: boolean
	providerRef: { deref: () => ProviderLike | undefined }
}

describe("checkpointSave change-journal wiring (B2)", () => {
	let tmpStorageDir: string
	let saveCheckpointSpy: Mock
	let mockProvider: ProviderLike
	let mockTask: TaskLike
	const write: CheckpointWriteInfo = {
		path: "src/foo.ts",
		operation: "create",
		diffStats: { additions: 3, deletions: 0 },
	}

	beforeEach(async () => {
		tmpStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), "b2-journal-wiring-"))
		saveCheckpointSpy = vi.fn().mockResolvedValue({ commit: COMMIT })
		mockProvider = {
			context: { globalStorageUri: { fsPath: tmpStorageDir } },
			log: vi.fn(),
			postMessageToWebview: vi.fn(),
		}
		// Structural test double for Task (the class is not instantiated at
		// this unit layer); the cast is safe because the fields checkpointSave
		// reads are exactly these.
		mockTask = {
			taskId: TASK_ID,
			enableCheckpoints: true,
			checkpointService: { isInitialized: true, saveCheckpoint: saveCheckpointSpy },
			checkpointServiceInitializing: false,
			providerRef: { deref: () => mockProvider },
		}
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(tmpStorageDir, { recursive: true, force: true })
	})

	it("appends exactly one journal line referencing the B1 checkpoint id for a per-write save", async () => {
		await checkpointSave(mockTask as Task, false, true, write)

		const entries = await loadChanges(tmpStorageDir, TASK_ID)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toEqual({
			path: "src/foo.ts",
			operation: "create",
			checkpointId: COMMIT,
			diffStats: { additions: 3, deletions: 0 },
		})

		// The raw file holds exactly one JSON line.
		const journalFile = path.join(tmpStorageDir, "tasks", TASK_ID, "checkpoints", "changes.jsonl")
		const raw = await fs.readFile(journalFile, "utf8")
		expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(1)
	})

	it("omits diffStats in the journal entry when not provided", async () => {
		await checkpointSave(mockTask as Task, false, true, { path: "src/bar.ts", operation: "update" })

		const entries = await loadChanges(tmpStorageDir, TASK_ID)
		expect(entries).toHaveLength(1)
		expect(entries[0].path).toBe("src/bar.ts")
		expect(entries[0].operation).toBe("update")
		expect(entries[0].checkpointId).toBe(COMMIT)
		expect(entries[0].diffStats).toBeUndefined()
	})

	it("does not write a journal entry for non-write checkpoint saves (task-start baseline)", async () => {
		await checkpointSave(mockTask as Task)

		const journalFile = path.join(tmpStorageDir, "tasks", TASK_ID, "checkpoints", "changes.jsonl")
		await expect(fs.stat(journalFile)).rejects.toThrow()
		expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
	})

	it("appends one entry per file change for a multi-file write (apply-patch shape)", async () => {
		await checkpointSave(mockTask as Task, false, true, [
			{ path: "src/a.ts", operation: "create" },
			{ path: "src/b.ts", operation: "update" },
			{ path: "src/c.ts", operation: "delete" },
		])

		const entries = await loadChanges(tmpStorageDir, TASK_ID)
		expect(entries).toHaveLength(3)
		// Every entry references the single checkpoint of the whole patch.
		expect(entries.map((entry) => entry.checkpointId)).toEqual([COMMIT, COMMIT, COMMIT])
		expect(entries.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"])
		expect(entries.map((entry) => entry.operation)).toEqual(["create", "update", "delete"])
	})

	it("keeps the existing error-swallowing behavior and skips the journal on save failure", async () => {
		saveCheckpointSpy.mockRejectedValueOnce(new Error("git exploded"))

		await expect(checkpointSave(mockTask as Task, false, true, write)).resolves.toBeUndefined()
		expect(mockTask.enableCheckpoints).toBe(false)
		expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
	})

	it("does not write a journal entry when the checkpoint save is a no-op (empty commit)", async () => {
		saveCheckpointSpy.mockResolvedValueOnce(undefined)

		await checkpointSave(mockTask as Task, false, true, write)

		expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
		expect(mockTask.enableCheckpoints).toBe(true)
	})

	it("does not crash when the provider has no globalStorageDir", async () => {
		mockTask.providerRef = { deref: () => undefined }

		await expect(checkpointSave(mockTask as Task, false, true, write)).resolves.toMatchObject({ commit: COMMIT })
		expect(mockTask.enableCheckpoints).toBe(true)
		expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
	})

	it("skips the checkpoint when the pending marker cannot be written durably", async () => {
		// Block the per-task checkpoint dir so the pending-marker mkdir/write fails.
		const taskDir = path.join(tmpStorageDir, "tasks", TASK_ID)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(path.join(taskDir, "checkpoints"), "blocker")

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

		// A committed checkpoint whose pending marker never landed could lose its journal
		// state, so the marker is a hard prerequisite: the save is skipped and no commit is
		// produced.
		await expect(checkpointSave(mockTask as Task, false, true, write)).resolves.toBeUndefined()
		expect(saveCheckpointSpy).not.toHaveBeenCalled()
		expect(mockTask.enableCheckpoints).toBe(true)
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("not running the checkpoint"),
			expect.anything(),
		)
	})
})

describe("loadChanges entry-shape validation (B2)", () => {
	let tmpStorageDir: string

	beforeEach(async () => {
		tmpStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), "b2-journal-shape-"))
	})

	afterEach(async () => {
		await fs.rm(tmpStorageDir, { recursive: true, force: true })
	})

	it("skips lines that are valid JSON but not entry-shaped", async () => {
		const dir = path.join(tmpStorageDir, "tasks", TASK_ID, "checkpoints")
		await fs.mkdir(dir, { recursive: true })
		const valid = JSON.stringify({ path: "src/a.ts", operation: "create", checkpointId: "c1" })
		await fs.writeFile(
			path.join(dir, "changes.jsonl"),
			[
				// A torn append can leave valid JSON that is not an entry.
				"1",
				"null",
				// Missing checkpointId.
				JSON.stringify({ path: "src/b.ts", operation: "update" }),
				// Unknown operation.
				JSON.stringify({ path: "src/c.ts", operation: "rename", checkpointId: "c2" }),
				// Non-string path.
				JSON.stringify({ path: 42, operation: "create", checkpointId: "c3" }),
				valid,
			].join("\n") + "\n",
		)

		const entries = await loadChanges(tmpStorageDir, TASK_ID)
		expect(entries).toEqual([{ path: "src/a.ts", operation: "create", checkpointId: "c1" }])
	})
})

describe("checkpoint/journal transaction recovery (B2)", () => {
	let tmpStorageDir: string

	beforeEach(async () => {
		tmpStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), "b2-journal-recovery-"))
	})

	afterEach(async () => {
		await fs.rm(tmpStorageDir, { recursive: true, force: true })
	})

	it("folds a durable ready marker into the journal on the next load", async () => {
		await writePendingJournal(tmpStorageDir, TASK_ID, {
			state: "ready",
			createdAt: Date.now(),
			entries: [{ path: "src/a.ts", operation: "create", checkpointId: "c1" }],
		})

		const entries = await loadChanges(tmpStorageDir, TASK_ID)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({ path: "src/a.ts", operation: "create", checkpointId: "c1" })
		// The marker is consumed once its entries are durable.
		await expect(fs.stat(pendingJournalPath(tmpStorageDir, TASK_ID))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("drops an awaiting-checkpoint marker without inventing entries", async () => {
		await writePendingJournal(tmpStorageDir, TASK_ID, { state: "awaiting-checkpoint", createdAt: Date.now() })

		expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
		await expect(fs.stat(pendingJournalPath(tmpStorageDir, TASK_ID))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("does not duplicate entries already appended before a crash", async () => {
		await appendChange(tmpStorageDir, TASK_ID, { path: "src/a.ts", operation: "create", checkpointId: "c1" })
		await writePendingJournal(tmpStorageDir, TASK_ID, {
			state: "ready",
			createdAt: Date.now(),
			entries: [
				{ path: "src/a.ts", operation: "create", checkpointId: "c1" },
				{ path: "src/b.ts", operation: "update", checkpointId: "c1" },
			],
		})

		const entries = await loadChanges(tmpStorageDir, TASK_ID)
		expect(entries.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"])
	})

	it.each(["not-json", JSON.stringify({ state: "unknown" }), JSON.stringify({ state: "ready" })] )(
		"discards an unreadable or unrecognized pending marker (%s)",
		async (rawMarker) => {
			const markerPath = pendingJournalPath(tmpStorageDir, TASK_ID)
			await fs.mkdir(path.dirname(markerPath), { recursive: true })
			await fs.writeFile(markerPath, rawMarker)

			expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
			// The unreadable marker is removed so it cannot shadow later writes.
			await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" })
		},
	)

	it("writes the pending marker with the exact state literals and no extra fields", async () => {
		const readyEntry = { path: "src/a.ts", operation: "create" as const, checkpointId: "c1" }
		await writePendingJournal(tmpStorageDir, TASK_ID, { state: "awaiting-checkpoint", createdAt: 1 })
		const awaiting = JSON.parse(await fs.readFile(pendingJournalPath(tmpStorageDir, TASK_ID), "utf8"))
		// Exact shape: a changed literal or an extra object property would leave the
		// recovery read unable to classify the marker.
		expect(awaiting).toEqual({ state: "awaiting-checkpoint", createdAt: 1 })

		await writePendingJournal(tmpStorageDir, TASK_ID, { state: "ready", createdAt: 2, entries: [readyEntry] })
		const ready = JSON.parse(await fs.readFile(pendingJournalPath(tmpStorageDir, TASK_ID), "utf8"))
		expect(ready).toEqual({ state: "ready", createdAt: 2, entries: [readyEntry] })
	})

	it("folds a marker left by an earlier crash before writing the new awaiting marker", async () => {
		// A earlier run committed a checkpoint but left its ready marker behind.
		await writePendingJournal(tmpStorageDir, TASK_ID, {
			state: "ready",
			createdAt: 1,
			entries: [{ path: "src/earlier.ts", operation: "update", checkpointId: "c0" }],
		})

		// The next save must fold that recovery record in, not overwrite it.
		const saveCheckpointSpy = vi.fn().mockResolvedValue({ commit: COMMIT })
		const provider = {
			context: { globalStorageUri: { fsPath: tmpStorageDir } },
			log: vi.fn(),
			postMessageToWebview: vi.fn(),
		}
		const task = {
			taskId: TASK_ID,
			enableCheckpoints: true,
			checkpointService: { isInitialized: true, saveCheckpoint: saveCheckpointSpy },
			checkpointServiceInitializing: false,
			providerRef: { deref: () => provider },
		}
		await checkpointSave(task as unknown as Task, false, true, {
			path: "src/foo.ts",
			operation: "create",
		})

		const entries = await loadChanges(tmpStorageDir, TASK_ID)
		expect(entries.map((entry) => entry.checkpointId)).toEqual(["c0", COMMIT])
		expect(entries.map((entry) => entry.path)).toEqual(["src/earlier.ts", "src/foo.ts"])
	})

})
