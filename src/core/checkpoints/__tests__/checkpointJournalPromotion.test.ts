import fs from "fs/promises"
import os from "os"
import path from "path"

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import type { Task } from "../../task/Task"
import { incompleteJournalPath, loadChanges } from "../changeJournal"
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

// Force only the durable ready promotion to fail: every other journal helper
// delegates to the real implementation so the recovery path stays real.
vi.mock("../changeJournal", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../changeJournal")>()
	return {
		...actual,
		writePendingJournal: vi.fn(async (dir: string, taskId: string, state: { state: string }) => {
			if (state.state === "ready") {
				throw new Error("ready marker write failed")
			}
			return actual.writePendingJournal(dir, taskId, state as never)
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

	it("records the entries in the incomplete marker and does not report success", async () => {
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
		vi.spyOn(console, "error").mockImplementation(() => undefined)

		await checkpointSave(mockTask as unknown as Task, false, true, write)

		const entries = await loadChanges(tmpStorageDir, TASK_ID)

		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({ path: "src/foo.ts", operation: "create", checkpointId: COMMIT })
		await expect(fs.stat(incompleteJournalPath(tmpStorageDir, TASK_ID))).rejects.toThrow()
	})
})
