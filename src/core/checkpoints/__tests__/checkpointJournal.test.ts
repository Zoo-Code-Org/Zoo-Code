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
	isPathIgnored: (filePath: string) => Promise<boolean>
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
			checkpointService: {
				isInitialized: true,
				saveCheckpoint: saveCheckpointSpy,
				// Default: nothing is excluded from the shadow repo, so journaling
				// behavior is unchanged unless a test overrides this.
				isPathIgnored: vi.fn().mockResolvedValue(false),
			},
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

	it("keeps shadow-repo-excluded paths out of the journal and the card", async () => {
		// Excluded paths are absent from the shadow commit by design; journaling
		// them would route a later rollback into restoreFile's delete branch and
		// remove the user's live file. They must not appear in the journal, must
		// not be advertised by the card, and a step whose writes are ALL excluded
		// must produce neither a journal update nor a card.
		mockTask.checkpointService.isPathIgnored = vi
			.fn()
			.mockImplementation(async (p: string) => p.startsWith("node_modules/"))

		await checkpointSave(mockTask as Task, false, true, [
			{ path: "src/kept.ts", operation: "create", diffStats: { additions: 1, deletions: 0 } },
			{ path: "node_modules/pkg/index.js", operation: "create", diffStats: { additions: 1, deletions: 0 } },
		])

		let entries = await loadChanges(tmpStorageDir, TASK_ID)
		expect(entries.map((e) => e.path)).toEqual(["src/kept.ts"])
		const sayMock = mockTask.say as Mock
		expect(sayMock).toHaveBeenCalledTimes(1)
		expect(String(sayMock.mock.calls[0][1])).not.toContain("node_modules")

		// A step whose every write is excluded journals nothing and emits no card.
		await checkpointSave(mockTask as Task, false, true, {
			path: "node_modules/pkg/other.js",
			operation: "create",
			diffStats: { additions: 1, deletions: 0 },
		})
		entries = await loadChanges(tmpStorageDir, TASK_ID)
		expect(entries.map((e) => e.path)).toEqual(["src/kept.ts"])
		expect(sayMock).toHaveBeenCalledTimes(1)
	})

	it("resolves an all-excluded write when the checkpoint produces no commit", async () => {
		// An excluded path is never staged, so an all-excluded step has nothing
		// to commit: the save must resolve (the write succeeded and no rollback
		// metadata is expected) instead of failing on the no-commit rejection,
		// whose outcome would otherwise depend on unrelated workspace changes.
		saveCheckpointSpy.mockResolvedValueOnce(undefined)
		mockTask.checkpointService.isPathIgnored = vi.fn().mockResolvedValue(true)

		await expect(
			checkpointSave(mockTask as Task, false, true, {
				path: "node_modules/pkg/index.js",
				operation: "create",
				diffStats: { additions: 1, deletions: 0 },
			}),
		).resolves.toBeUndefined()

		expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
		expect(mockTask.say as Mock).not.toHaveBeenCalled()
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

	it("keeps the existing error-swallowing behavior for non-write saves on failure", async () => {
		// The legacy swallow (log + disable + resolve undefined) is reserved
		// for checkpoint calls without write metadata, e.g. the task-start
		// baseline: no file write has happened, so there is no orphaned write
		// to report.
		saveCheckpointSpy.mockRejectedValueOnce(new Error("git exploded"))

		await expect(checkpointSave(mockTask as Task)).resolves.toBeUndefined()
		expect(mockTask.enableCheckpoints).toBe(false)
		expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
	})

	it("propagates a saveCheckpoint rejection for a write-metadata save", async () => {
		// The file write already happened: swallowing the commit failure
		// would report a tool success whose rollback metadata does not exist.
		saveCheckpointSpy.mockRejectedValueOnce(new Error("git exploded"))
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

		await expect(checkpointSave(mockTask as Task, false, true, write)).rejects.toThrow(/no rollback metadata/)

		// Checkpoints are still disabled on failure, and neither the journal
		// nor the change card is written for a commit that never happened.
		expect(mockTask.enableCheckpoints).toBe(false)
		expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
		const cardCalls = vi.mocked(mockTask.say).mock.calls.filter((call) => call[0] === "change_card")
		expect(cardCalls).toHaveLength(0)
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("caught unexpected error"),
			expect.anything(),
		)
		consoleErrorSpy.mockRestore()
	})

	it("resolves a write-metadata save when the user disabled checkpoints", async () => {
		// Documented contract: user-disabled checkpoints means the absence of
		// rollback metadata is the user's choice, so the save must not fail the
		// write tool (no journal entry, no change card, no throw). Genuine
		// init-failure coverage lives in checkpointSave.spec.ts. The
		// persisted setting agrees the user disabled checkpoints (an unset
		// setting would mean an earlier failure flipped the task flag).
		mockTask.enableCheckpoints = false
		mockProvider.getState = vi.fn().mockResolvedValue({ enableCheckpoints: false })

		await expect(checkpointSave(mockTask as Task, false, true, write)).resolves.toBeUndefined()
		expect(saveCheckpointSpy).not.toHaveBeenCalled()
		expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
	})

	it("keeps non-write saves a no-op when the checkpoint service is unavailable", async () => {
		// The task-start baseline tolerates an unavailable service: no write
		// metadata, no rollback expectation, historical behavior preserved.
		mockTask.enableCheckpoints = false

		await expect(checkpointSave(mockTask as Task)).resolves.toBeUndefined()
		expect(saveCheckpointSpy).not.toHaveBeenCalled()
	})

	it("keeps non-write saves succeeding when the checkpoint produces no commit", async () => {
		// The task-start baseline tolerates an empty shadow repository: no
		// write metadata means no rollback expectation.
		saveCheckpointSpy.mockResolvedValueOnce(undefined)

		await expect(checkpointSave(mockTask as Task)).resolves.toBeUndefined()
	})

	it("fails a write-metadata save on an empty checkpoint without disabling checkpoints", async () => {
		// A no-op checkpoint resolves without a commit: with write metadata
		// there is no rollback point, so the save fails explicitly - but an
		// empty checkpoint is not a service failure, so checkpoints stay
		// enabled for later writes.
		saveCheckpointSpy.mockResolvedValueOnce(undefined)

		await expect(checkpointSave(mockTask as Task, false, true, write)).rejects.toThrow(/did not produce a commit/)

		expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
		expect(mockTask.enableCheckpoints).toBe(true)
	})

	it("fails a write-metadata save before committing when the provider has no globalStorageDir", async () => {
		// A commit whose journal update would be silently skipped is worse
		// than no commit: rollback metadata would be incomplete with no error
		// surfaced, so the save must fail before the Git commit runs.
		mockTask.providerRef = { deref: () => undefined }

		await expect(checkpointSave(mockTask as Task, false, true, write)).rejects.toThrow(/stable journal location/)
		expect(saveCheckpointSpy).not.toHaveBeenCalled()
		expect(mockTask.enableCheckpoints).toBe(true)
		expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
	})

	it("persists the journal through the captured location when the provider disappears during the commit", async () => {
		// The weak provider reference dies while the Git save is awaited:
		// the journal location captured before the commit must still be used,
		// so a successful commit never silently loses its rollback metadata.
		saveCheckpointSpy.mockImplementation(async () => {
			mockTask.providerRef = { deref: () => undefined }
			return { commit: COMMIT }
		})

		await expect(checkpointSave(mockTask as Task, false, true, write)).resolves.toMatchObject({ commit: COMMIT })

		const entries = await loadChanges(tmpStorageDir, TASK_ID)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({ path: "src/foo.ts", checkpointId: COMMIT })
		expect(mockTask.enableCheckpoints).toBe(true)
	})

	it("still runs non-write checkpoint saves when the provider is gone (task-start baseline)", async () => {
		// The pre-commit journal-location guard applies only to saves that
		// carry write metadata; the baseline save has none and keeps the
		// historical behavior.
		mockTask.providerRef = { deref: () => undefined }

		await expect(checkpointSave(mockTask as Task)).resolves.toMatchObject({ commit: COMMIT })
		expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
	})

	it("propagates a journal persistence failure after the commit and emits no change card", async () => {
		// Block the per-task checkpoint dir so the journal mkdir/read fails.
		const taskDir = path.join(tmpStorageDir, "tasks", TASK_ID)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(path.join(taskDir, "checkpoints"), "blocker")

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

		// The checkpoint committed but the journal update did not persist: the
		// save must not report a fully durable checkpoint, and the change card
		// (which advertises the journaled files) must not be emitted.
		await expect(checkpointSave(mockTask as Task, false, true, write)).rejects.toMatchObject({
			name: "CheckpointPartialPersistenceError",
			checkpointId: COMMIT,
			writes: [{ path: "src/foo.ts", operation: "create", diffStats: { additions: 3, deletions: 0 } }],
		})

		// Propagation is not a checkpoint error: checkpoints stay enabled.
		expect(mockTask.enableCheckpoints).toBe(true)
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("failed to persist change journal entries"),
			expect.anything(),
		)
		const cardCalls = vi.mocked(mockTask.say).mock.calls.filter((call) => call[0] === "change_card")
		expect(cardCalls).toHaveLength(0)
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
