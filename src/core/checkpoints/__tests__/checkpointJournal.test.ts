import fs from "fs/promises"
import os from "os"
import path from "path"

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import type { Task } from "../../task/Task"
import { loadChanges } from "../changeJournal"
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
		parse: vi.fn((uri: string) => ({ with: vi.fn(() => ({})) })),
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
	getState: () => Promise<Record<string, unknown>>
}

interface TaskLike {
	taskId: string
	enableCheckpoints: boolean
	checkpointService: ServiceLike
	checkpointServiceInitializing: boolean
	providerRef: { deref: () => ProviderLike | undefined }
	say: (...args: unknown[]) => Promise<void>
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
			// B3a: the card emission reads the live settings through getState.
			getState: vi.fn().mockResolvedValue({}),
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
			// B3a: the card emission calls task.say; a resolved double keeps the
			// test double complete instead of letting the emission take the
			// error path.
			say: vi.fn().mockResolvedValue(undefined),
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

	it("logs and continues when the journal cannot be written (checkpoints stay enabled)", async () => {
		// Block the per-task checkpoint dir so the journal mkdir/append fails.
		const taskDir = path.join(tmpStorageDir, "tasks", TASK_ID)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(path.join(taskDir, "checkpoints"), "blocker")

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

		// The journal failure is swallowed (logged, not rethrown), so the
		// checkpoint result still resolves exactly as without journaling.
		await expect(checkpointSave(mockTask as Task, false, true, write)).resolves.toMatchObject({ commit: COMMIT })

		expect(mockTask.enableCheckpoints).toBe(true)
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("failed to append change journal entry"),
			expect.anything(),
		)
	})
})
