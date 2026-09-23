// pnpm --filter roo-cline test core/task-persistence/__tests__/TaskHistoryStore.guardCompromise.spec.ts

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import type { HistoryItem } from "@roo-code/types"

import { GlobalFileNames } from "../../../shared/globalFileNames"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => {
		return defaultPath
	}),
}))

// Mock safeWriteJson with plain fs writes so only the outer task guard
// behavior is under test.
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockImplementation(async (filePath: string, data: unknown) => {
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8")
	}),
}))

function makeHistoryItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: `task-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
		number: 1,
		ts: Date.now(),
		task: "Test task",
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.01,
		workspace: "/test/workspace",
		...overrides,
	}
}

async function seedTaskOnDisk(tmpDir: string, taskId: string): Promise<{ taskDir: string; historyFile: string }> {
	const taskDir = path.join(tmpDir, "tasks", taskId)
	const historyFile = path.join(taskDir, GlobalFileNames.historyItem)
	await fs.mkdir(taskDir, { recursive: true })
	await fs.writeFile(historyFile, JSON.stringify(makeHistoryItem({ id: taskId })))
	return { taskDir, historyFile }
}

describe("TaskHistoryStore task guard compromise", () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-guard-"))
	})

	afterEach(async () => {
		vi.doUnmock("proper-lockfile")
		vi.resetModules()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	/**
	 * Simulate proper-lockfile reporting the guard lock (never the history
	 * file lock) as compromised the moment it is acquired. Guards live at
	 * `tasks/.guards/<taskId>.guard`.
	 */
	function compromiseGuardsOnAcquire() {
		vi.doMock("proper-lockfile", () => ({
			lock: (file: string, options: { onCompromised: (error: Error) => void }) => {
				if (file.endsWith(".guard")) {
					options.onCompromised(new Error("Guard no longer available"))
				}
				return Promise.resolve(async () => {})
			},
		}))
	}

	async function importStoreClass(): Promise<typeof import("../TaskHistoryStore").TaskHistoryStore> {
		const module = await import("../TaskHistoryStore")
		return module.TaskHistoryStore
	}

	it("aborts a history write when the task guard is compromised", async () => {
		compromiseGuardsOnAcquire()
		const TaskHistoryStore = await importStoreClass()
		const store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		await expect(store.upsert(makeHistoryItem({ id: "guard-write" }))).rejects.toThrow("was compromised")

		// The write aborted before reaching the history file.
		const historyFile = path.join(tmpDir, "tasks", "guard-write", GlobalFileNames.historyItem)
		await expect(fs.access(historyFile)).rejects.toThrow()
		expect(store.get("guard-write")).toBeUndefined()

		store.dispose()
	})

	it("aborts a task deletion when the task guard is compromised before the unlink", async () => {
		const { taskDir, historyFile } = await seedTaskOnDisk(tmpDir, "guard-delete")

		compromiseGuardsOnAcquire()
		const TaskHistoryStore = await importStoreClass()
		const store = new TaskHistoryStore(tmpDir)
		await store.initialize()
		expect(store.get("guard-delete")).toBeDefined()

		await expect(store.delete("guard-delete")).rejects.toThrow("was compromised")

		// Neither the history file nor the task directory was removed.
		await expect(fs.access(historyFile)).resolves.toBeUndefined()
		await expect(fs.access(taskDir)).resolves.toBeUndefined()
		expect(store.get("guard-delete")).toBeDefined()

		store.dispose()
	})

	it("stops before removing the task directory when the guard is compromised mid-deletion", async () => {
		const { taskDir, historyFile } = await seedTaskOnDisk(tmpDir, "guard-mid-delete")

		// The history-file lock's release runs after the unlink and before
		// the directory removal, so it is the deterministic hook for losing
		// the guard between the two mutations. In-flight operations cannot
		// be cancelled; the store must re-check before each mutation.
		let compromiseGuard: (() => void) | undefined
		vi.doMock("proper-lockfile", () => ({
			lock: (file: string, options: { onCompromised: (error: Error) => void }) => {
				if (file.endsWith(".guard")) {
					compromiseGuard = () => options.onCompromised(new Error("Guard no longer available"))
					return Promise.resolve(async () => {})
				}
				return Promise.resolve(async () => {
					compromiseGuard?.()
				})
			},
		}))

		const TaskHistoryStore = await importStoreClass()
		const store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		await expect(store.delete("guard-mid-delete")).rejects.toThrow("was compromised")

		// The unlink already landed, but the guarded directory removal did not.
		await expect(fs.access(historyFile)).rejects.toThrow()
		await expect(fs.access(taskDir)).resolves.toBeUndefined()

		store.dispose()
	})
})
