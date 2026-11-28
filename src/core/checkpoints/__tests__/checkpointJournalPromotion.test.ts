import fs from "fs/promises"
import os from "os"
import path from "path"

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import type { Task } from "../../task/Task"
import { incompleteJournalPath, loadChanges, pendingJournalPath } from "../changeJournal"
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
	commands: { executeCommand: vi.fn() },
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

vi.mock("../../../utils/path", () => ({ getWorkspacePath: vi.fn(() => "/test/workspace") }))
vi.mock("../../../utils/git", () => ({ checkGitInstalled: vi.fn().mockResolvedValue(true) }))
vi.mock("../../../i18n", () => ({ t: vi.fn((key: string) => key) }))
vi.mock("p-wait-for", () => ({ default: vi.fn() }))
vi.mock("../../../services/checkpoints")

type JournalControls = {
	readyFailures: number
	incompleteFails: boolean
	reconcileCalls: number
	reconcileFailAfter: number
	awaitingFails: boolean
}
const controls = vi.hoisted<JournalControls>(() => ({
	readyFailures: 0,
	incompleteFails: false,
	reconcileCalls: 0,
	reconcileFailAfter: -1,
	awaitingFails: false,
}))

// The journal helpers are delegated to the real implementation; only the failure
// paths the tests drive are overridden, so recovery stays real.
vi.mock("../changeJournal", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../changeJournal")>()
	return {
		...actual,
		writePendingJournal: vi.fn(async (dir: string, taskId: string, state: { state: string }) => {
			if (state.state === "awaiting-checkpoint" && controls.awaitingFails) {
				throw new Error("awaiting marker write failed")
			}
			if (state.state === "ready" && controls.readyFailures > 0) {
				controls.readyFailures--
				throw new Error("ready marker write failed")
			}
			return actual.writePendingJournal(dir, taskId, state as never)
		}),
		writeIncompleteJournal: vi.fn(async (dir: string, taskId: string, entries: never) => {
			if (controls.incompleteFails) {
				throw new Error("incomplete marker write failed")
			}
			return actual.writeIncompleteJournal(dir, taskId, entries)
		}),
		reconcilePendingJournal: vi.fn(async (dir: string, taskId: string) => {
			controls.reconcileCalls++
			if (controls.reconcileFailAfter >= 0 && controls.reconcileCalls > controls.reconcileFailAfter) {
				throw new Error("reconcile failed")
			}
			return actual.reconcilePendingJournal(dir, taskId)
		}),
	}
})

const TASK_ID = "journal-promotion-task"
const COMMIT = "promotion-commit-hash"

describe("checkpointSave journal promotion failure (B2)", () => {
	let tmpStorageDir: string
	let saveCheckpointSpy: Mock
	let mockTask: {
		taskId: string
		enableCheckpoints: boolean
		checkpointService: { isInitialized: boolean; saveCheckpoint: (...args: unknown[]) => Promise<unknown> }
		checkpointServiceInitializing: boolean
		providerRef: { deref: () => unknown }
	}
	const write: CheckpointWriteInfo = { path: "src/foo.ts", operation: "create" }

	beforeEach(async () => {
		controls.readyFailures = 0
		controls.incompleteFails = false
		controls.reconcileCalls = 0
		controls.reconcileFailAfter = -1
		controls.awaitingFails = false
		tmpStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), "b2-journal-promotion-"))
		saveCheckpointSpy = vi.fn().mockResolvedValue({ commit: COMMIT })
		const mockProvider = {
			context: { globalStorageUri: { fsPath: tmpStorageDir } },
			log: vi.fn(),
			postMessageToWebview: vi.fn(),
		}
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

	it("retries the ready promotion once and journals the entries when the retry succeeds", async () => {
		controls.readyFailures = 1

		await expect(checkpointSave(mockTask as unknown as Task, false, true, write)).resolves.toEqual({
			commit: COMMIT,
		})

		const entries = await loadChanges(tmpStorageDir, TASK_ID)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({ path: "src/foo.ts", operation: "create", checkpointId: COMMIT })
		await expect(fs.stat(incompleteJournalPath(tmpStorageDir, TASK_ID))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("records the entries in the incomplete marker and does not report success", async () => {
		controls.readyFailures = 99
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

		// The ready promotion fails twice; the incomplete marker is the recovery record.
		await expect(checkpointSave(mockTask as unknown as Task, false, true, write)).resolves.toBeUndefined()

		expect(saveCheckpointSpy).toHaveBeenCalledOnce()
		expect(mockTask.enableCheckpoints).toBe(false)
		const marker = JSON.parse(await fs.readFile(incompleteJournalPath(tmpStorageDir, TASK_ID), "utf8"))
		expect(marker.entries).toEqual([{ path: "src/foo.ts", operation: "create", checkpointId: COMMIT }])
		expect(consoleErrorSpy).toHaveBeenCalled()
	})

	it("folds the incomplete marker into the journal on the next read", async () => {
		controls.readyFailures = 99
		vi.spyOn(console, "error").mockImplementation(() => undefined)

		await checkpointSave(mockTask as unknown as Task, false, true, write)

		const entries = await loadChanges(tmpStorageDir, TASK_ID)

		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({ path: "src/foo.ts", operation: "create", checkpointId: COMMIT })
		await expect(fs.stat(incompleteJournalPath(tmpStorageDir, TASK_ID))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("keeps the awaiting marker and disables checkpoints when neither marker can be written", async () => {
		controls.readyFailures = 99
		controls.incompleteFails = true
		vi.spyOn(console, "error").mockImplementation(() => undefined)

		await expect(checkpointSave(mockTask as unknown as Task, false, true, write)).resolves.toBeUndefined()

		expect(mockTask.enableCheckpoints).toBe(false)
		// The awaiting marker written before the commit stays as the on-disk state; it is
		// not claimed to recover entries (only a ready/incomplete marker carries them).
		const marker = JSON.parse(await fs.readFile(pendingJournalPath(tmpStorageDir, TASK_ID), "utf8"))
		expect(marker.state).toBe("awaiting-checkpoint")
	})

	it("reports the checkpoint result and logs when the reconciliation fails", async () => {
		// First reconcile runs before the awaiting marker, the second after promotion.
		controls.reconcileFailAfter = 1
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

		await expect(checkpointSave(mockTask as unknown as Task, false, true, write)).resolves.toEqual({
			commit: COMMIT,
		})

		expect(mockTask.enableCheckpoints).toBe(true)
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("failed to reconcile the pending change journal"),
			expect.anything(),
		)
	})

	it("discards the awaiting marker on the next read when the host exits before promotion", async () => {
		// The Git commit landed and then the extension host went away before the ready
		// promotion. The on-disk state of that scenario is an awaiting marker, which by
		// construction carries no entries, and this test pins what the next read really
		// does with it: reconcilePendingJournal accepts the awaiting state, skips the fold
		// (that block is gated on "ready"), and clears the marker - so a committed
		// checkpoint's writes never reach the journal. index.ts calls this record the
		// "recovery record for the next read"; if a later unit makes the pre-commit record
		// carry the entries plus a transaction identity, this is the assertion that has to
		// change, deliberately rather than by accident.
		controls.readyFailures = 99
		controls.incompleteFails = true
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

		await expect(checkpointSave(mockTask as unknown as Task, false, true, write)).resolves.toBeUndefined()

		expect(saveCheckpointSpy).toHaveBeenCalledOnce()
		const marker = JSON.parse(await fs.readFile(pendingJournalPath(tmpStorageDir, TASK_ID), "utf8"))
		expect(marker.state).toBe("awaiting-checkpoint")
		expect(marker.entries).toBeUndefined()

		expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
		await expect(fs.stat(pendingJournalPath(tmpStorageDir, TASK_ID))).rejects.toMatchObject({ code: "ENOENT" })
		consoleErrorSpy.mockRestore()
	})

	it("resolves undefined when the pre-commit marker cannot be written, so the save never runs", async () => {
		// The pending marker is a hard prerequisite: the save refuses to commit at all
		// and resolves undefined. Characterised rather than fixed here, because the
		// tool-side catch path reads that undefined as "the flush succeeded" and tells the
		// user only its own bookkeeping error; making a journal failure surface as a tool
		// failure at the five awaiting call sites is a product decision of its own, not a
		// bug fix, so it is recorded as behaviour rather than silently changed.
		controls.awaitingFails = true
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

		await expect(checkpointSave(mockTask as unknown as Task, false, true, write)).resolves.toBeUndefined()

		// No commit was attempted, so there is nothing to journal and no marker left.
		expect(saveCheckpointSpy).not.toHaveBeenCalled()
		expect(await loadChanges(tmpStorageDir, TASK_ID)).toEqual([])
		await expect(fs.stat(pendingJournalPath(tmpStorageDir, TASK_ID))).rejects.toMatchObject({ code: "ENOENT" })
		consoleErrorSpy.mockRestore()
	})
})
