import fs from "fs/promises"
import os from "os"
import path from "path"
import * as vscode from "vscode"

import type { HistoryItem, PendingTaskAction } from "@roo-code/types"

import { ClineProvider } from "../ClineProvider"
import type { Task } from "../../task/Task"
import { TaskRegistry } from "../../task/TaskRegistry"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import * as taskMessages from "../../task-persistence/taskMessages"
import { GlobalFileNames } from "../../../shared/globalFileNames"

const historyItem = (workspace: string): HistoryItem => ({
	id: "task-1602",
	number: 1,
	ts: 1,
	task: "Continue in another worktree",
	tokensIn: 0,
	tokensOut: 0,
	cacheWrites: 0,
	cacheReads: 0,
	totalCost: 0,
	workspace,
})

const createProvider = (workspace: string) => {
	const provider = Object.create(ClineProvider.prototype) as ClineProvider
	Object.defineProperty(provider, "currentWorkspacePath", { value: workspace, writable: true })
	return provider
}

describe("ClineProvider historical workspace selection", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("keeps a history item unchanged when it already belongs to the current workspace", async () => {
		const provider = createProvider("/current/workspace")
		const prompt = vi.spyOn(vscode.window, "showWarningMessage")
		const item = historyItem("/current/workspace")

		await expect(provider.prepareHistoryItemForResume(item)).resolves.toBe(item)
		expect(prompt).not.toHaveBeenCalled()
	})

	it.each([
		{ current: "", original: "/old/worktree" },
		{ current: "/current/workspace", original: undefined },
	])("does not prompt when a workspace is absent ($current, $original)", async ({ current, original }) => {
		const provider = createProvider(current)
		const prompt = vi.spyOn(vscode.window, "showWarningMessage")
		const item = { ...historyItem("/old/worktree"), workspace: original }
		await expect(provider.prepareHistoryItemForResume(item)).resolves.toBe(item)
		expect(prompt).not.toHaveBeenCalled()
	})

	it("cancels restoration without mutating history when the mismatch prompt is dismissed", async () => {
		const provider = createProvider("/current/workspace")
		vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined)
		provider["resetTaskCheckpointsForWorkspaceChange"] = vi.fn()
		provider.updateTaskHistory = vi.fn()

		await expect(provider.prepareHistoryItemForResume(historyItem("/old/worktree"))).resolves.toBeUndefined()
		expect(provider["resetTaskCheckpointsForWorkspaceChange"]).not.toHaveBeenCalled()
		expect(provider.updateTaskHistory).not.toHaveBeenCalled()
	})

	it("opens the original workspace in a new window without restoring the task", async () => {
		const provider = createProvider("/current/workspace")
		const prompt = vi
			.spyOn(vscode.window, "showWarningMessage")
			.mockResolvedValue({ title: "Open Original Workspace" })
		const executeCommand = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)

		await expect(provider.prepareHistoryItemForResume(historyItem("/old/worktree"))).resolves.toBeUndefined()
		expect(prompt).toHaveBeenCalledWith(
			expect.any(String),
			{ modal: true },
			{ title: "Use Current Workspace" },
			{ title: "Open Original Workspace" },
		)
		expect(executeCommand).toHaveBeenCalledWith(
			"vscode.openFolder",
			expect.objectContaining({ fsPath: "/old/worktree" }),
			{ forceNewWindow: true },
		)
	})

	it("moves the task to the current workspace and resets workspace-specific checkpoints", async () => {
		const provider = createProvider("/current/workspace")
		vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue({ title: "Use Current Workspace" })
		provider["resetTaskCheckpointsForWorkspaceChange"] = vi.fn().mockResolvedValue(undefined)
		provider.updateTaskHistory = vi.fn().mockResolvedValue([])
		const item = historyItem("/old/worktree")

		await expect(provider.prepareHistoryItemForResume(item)).resolves.toEqual({
			...item,
			workspace: "/current/workspace",
		})
		expect(provider["resetTaskCheckpointsForWorkspaceChange"]).toHaveBeenCalledWith(item, {
			...item,
			workspace: "/current/workspace",
		})
	})

	it("restores history with the workspace selected by the mismatch prompt", async () => {
		const provider = createProvider("/current/workspace")
		const original = historyItem("/old/worktree")
		const prepared = { ...original, workspace: "/current/workspace" }
		provider.getCurrentTask = vi.fn().mockReturnValue(undefined)
		provider.getTaskWithId = vi.fn().mockResolvedValue({ historyItem: original })
		provider.prepareHistoryItemForResume = vi.fn().mockResolvedValue(prepared)
		provider.createTaskWithHistoryItem = vi.fn().mockResolvedValue({})
		provider.postMessageToWebview = vi.fn().mockResolvedValue(true)

		await provider.showTaskWithId(original.id)

		expect(provider.createTaskWithHistoryItem).toHaveBeenCalledWith(prepared)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "chatButtonClicked",
		})
	})

	it("does not restore or reveal a task when workspace selection is cancelled", async () => {
		const provider = createProvider("/current/workspace")
		const original = historyItem("/old/worktree")
		provider.getCurrentTask = vi.fn().mockReturnValue(undefined)
		provider.getTaskWithId = vi.fn().mockResolvedValue({ historyItem: original })
		provider.prepareHistoryItemForResume = vi.fn().mockResolvedValue(undefined)
		provider.createTaskWithHistoryItem = vi.fn()
		provider.postMessageToWebview = vi.fn()

		await provider.showTaskWithId(original.id)

		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	describe("with a persisted task history store", () => {
		let storagePath: string
		let taskDir: string
		let checkpointsDir: string
		let messagesPath: string
		let store: TaskHistoryStore

		const original = historyItem("/old/worktree")
		const updated = { ...original, workspace: "/current/workspace" }

		beforeEach(async () => {
			storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-history-workspace-"))
			taskDir = path.join(storagePath, "tasks", original.id)
			checkpointsDir = path.join(taskDir, "checkpoints")
			messagesPath = path.join(taskDir, "ui_messages.json")
			store = new TaskHistoryStore(storagePath)
			await store.initialize()
			store.dispose() // Keep watcher reconciliation out of these explicit write tests.
			await store.upsert(original)
		})

		afterEach(async () => {
			ClineProvider["activeInstances"].clear()
			await fs.rm(storagePath, { recursive: true, force: true })
		})

		const originalMessages = [
			{ type: "say", say: "task", ts: 1, text: "Continue" },
			{ type: "say", say: "checkpoint_saved", ts: 2, text: "old-hash" },
		]

		const createStoredProvider = () => {
			const provider = createProvider("/current/workspace")
			Object.defineProperty(provider, "contextProxy", { value: { globalStorageUri: { fsPath: storagePath } } })
			Object.defineProperty(provider, "taskHistoryStore", { value: store })
			provider["log"] = vi.fn()
			return provider
		}

		const writeCheckpointState = async () => {
			await fs.mkdir(checkpointsDir, { recursive: true })
			await fs.writeFile(path.join(checkpointsDir, "HEAD"), "old checkpoint")
			await fs.writeFile(messagesPath, JSON.stringify(originalMessages))
		}

		const readPersistedHistory = async () =>
			JSON.parse(await fs.readFile(path.join(taskDir, GlobalFileNames.historyItem), "utf8")) as HistoryItem

		it.each([true, false])(
			"resets checkpoint rows with an existing checkpoint directory: %s",
			async (hasDirectory) => {
				if (hasDirectory) {
					await fs.mkdir(checkpointsDir)
					await fs.writeFile(path.join(checkpointsDir, "HEAD"), "old checkpoint")
				}
				await fs.writeFile(
					messagesPath,
					JSON.stringify([
						{ type: "say", say: "task", ts: 1, text: "Continue" },
						{ type: "say", say: "checkpoint_saved", ts: 2, text: "old-hash" },
						{ type: "say", say: "text", ts: 3, text: "Still useful" },
					]),
				)
				const provider = createStoredProvider()

				await expect(provider["resetTaskCheckpointsForWorkspaceChange"](original, updated)).resolves.toEqual(
					updated,
				)

				await expect(fs.stat(checkpointsDir)).rejects.toMatchObject({ code: "ENOENT" })
				expect(JSON.parse(await fs.readFile(messagesPath, "utf8"))).toMatchObject([
					{ type: "say", say: "task", text: "Continue" },
					{ type: "say", say: "text", text: "Still useful" },
				])
				expect(store.get(original.id)?.workspace).toBe("/current/workspace")
				expect((await readPersistedHistory()).workspace).toBe("/current/workspace")
			},
		)

		it.each([false, true])(
			"keeps history fields written while the prompt was open (rollback: %s)",
			async (rollback) => {
				await writeCheckpointState()
				const pendingAction: PendingTaskAction = {
					kind: "create_subtask",
					actionId: "action-1",
					approvalText: "Create a subtask",
					mode: "code",
					message: "Do the work",
					todos: [],
				}
				// An explicit stale status is what a full-item write would put back over the newer one.
				const snapshot: HistoryItem = { ...original, status: "active" }
				await store.upsert(snapshot)
				const fresh = { status: "delegated", awaitingChildId: "child-1", pendingAction } as const
				const provider = createStoredProvider()
				// The stale snapshot is the record read before the modal; another writer updates it meanwhile.
				vi.spyOn(vscode.window, "showWarningMessage").mockImplementation(async () => {
					await store.atomicReadAndUpdate(original.id, (current) => ({ ...current, ...fresh }))
					return { title: "Use Current Workspace" }
				})
				const historyBroadcastFailure = new Error("history broadcast failed")
				provider.isViewLaunched = rollback
				provider.postMessageToWebview = vi.fn().mockRejectedValueOnce(historyBroadcastFailure)

				const prepared = provider.prepareHistoryItemForResume(snapshot)

				const expected = { ...snapshot, ...fresh, workspace: rollback ? original.workspace : updated.workspace }
				if (rollback) await expect(prepared).rejects.toBe(historyBroadcastFailure)
				else await expect(prepared).resolves.toEqual(expected)
				expect(store.get(original.id)).toEqual(expected)
				expect(await readPersistedHistory()).toEqual(expected)
			},
		)

		it.each([false, true])("preserves intervening message writes (rollback: %s)", async (rollback) => {
			await fs.mkdir(checkpointsDir, { recursive: true })
			const options = { taskId: original.id, globalStoragePath: storagePath }
			await taskMessages.saveTaskMessages({
				...options,
				messages: [
					{ ts: 1, type: "say", say: "text", text: "before" },
					{ ts: 2, type: "say", say: "checkpoint_saved", text: "old-hash" },
				],
			})
			const provider = createStoredProvider()
			const rename = fs.rename
			vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
				await rename(source, destination)
				if (source === checkpointsDir) {
					// A live task saves after reset starts, before the locked removal.
					await taskMessages.saveTaskMessages({
						...options,
						merge: true,
						messages: [{ ts: 3, type: "say", say: "text", text: "during reset" }],
					})
				}
			})
			const realAtomicUpdate = store.atomicReadAndUpdate.bind(store)
			vi.spyOn(store, "atomicReadAndUpdate").mockImplementationOnce(async (...args) => {
				await taskMessages.saveTaskMessages({
					...options,
					merge: true,
					messages: [{ ts: 1, type: "say", say: "text", text: "updated during history write" }],
				})
				if (rollback) throw new Error("history write failed")
				return realAtomicUpdate(...args)
			})

			const reset = provider["resetTaskCheckpointsForWorkspaceChange"](original, updated)
			if (rollback) await expect(reset).rejects.toThrow("history write failed")
			else await reset

			const messages = await taskMessages.readTaskMessages(options)
			expect(messages.map(({ ts, text }) => ({ ts, text }))).toEqual([
				{ ts: 1, text: "updated during history write" },
				...(rollback ? [{ ts: 2, text: "old-hash" }] : []),
				{ ts: 3, text: "during reset" },
			])
		})

		it("restores checkpoint files and messages when workspace persistence fails", async () => {
			await writeCheckpointState()
			const provider = createStoredProvider()
			vi.spyOn(store, "atomicReadAndUpdate").mockRejectedValueOnce(new Error("history write failed"))

			await expect(provider["resetTaskCheckpointsForWorkspaceChange"](original, updated)).rejects.toThrow(
				"history write failed",
			)

			await expect(fs.readFile(path.join(checkpointsDir, "HEAD"), "utf8")).resolves.toBe("old checkpoint")
			expect(JSON.parse(await fs.readFile(messagesPath, "utf8"))).toMatchObject(originalMessages)
			expect(store.get(original.id)?.workspace).toBe("/old/worktree")
		})

		it.each([
			{ failures: ["messages"] },
			{ failures: ["checkpoints"] },
			{ failures: ["history"] },
			{ failures: ["messages", "checkpoints", "history"] },
		])(
			"attempts every rollback and preserves the original error when $failures restoration fails",
			async ({ failures }) => {
				await writeCheckpointState()
				const provider = createStoredProvider()
				// History is already committed when broadcasting the update fails.
				const originalError = new Error("history broadcast failed")
				provider.isViewLaunched = true
				provider.postMessageToWebview = vi.fn().mockRejectedValueOnce(originalError).mockResolvedValue(true)
				const realAtomicUpdate = store.atomicReadAndUpdate.bind(store)
				const atomicUpdate = vi.spyOn(store, "atomicReadAndUpdate")
				if (failures.includes("history")) {
					atomicUpdate
						.mockImplementationOnce(realAtomicUpdate)
						.mockRejectedValueOnce(new Error("history restore failed"))
				}
				const save = vi.spyOn(taskMessages, "saveTaskMessages")
				if (failures.includes("messages")) {
					save.mockRejectedValueOnce(new Error("messages restore failed"))
				}
				const rename = fs.rename
				const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
					if (destination === checkpointsDir && failures.includes("checkpoints")) {
						throw new Error("checkpoints restore failed")
					}
					await rename(source, destination)
				})

				await expect(provider["resetTaskCheckpointsForWorkspaceChange"](original, updated)).rejects.toBe(
					originalError,
				)

				expect(save).toHaveBeenCalledOnce()
				expect(save.mock.calls[0][0]).toMatchObject({
					messages: [originalMessages[1]],
					taskId: original.id,
					globalStoragePath: storagePath,
					merge: true,
				})
				expect(renameSpy).toHaveBeenCalledWith(
					expect.stringContaining("checkpoints.workspace-change-"),
					checkpointsDir,
				)
				expect(atomicUpdate).toHaveBeenCalledTimes(2)
				expect(store.get(original.id)?.workspace).toBe(
					failures.includes("history") ? "/current/workspace" : "/old/worktree",
				)
				expect(provider["log"]).toHaveBeenCalledTimes(failures.length)
				for (const failure of failures) {
					expect(provider["log"]).toHaveBeenCalledWith(expect.stringContaining(`${failure} restore failed`))
				}
				if (!failures.includes("messages")) {
					expect(JSON.parse(await fs.readFile(messagesPath, "utf8"))).toMatchObject(originalMessages)
				}
				if (!failures.includes("checkpoints")) {
					await expect(fs.readFile(path.join(checkpointsDir, "HEAD"), "utf8")).resolves.toBe("old checkpoint")
				}
			},
		)

		it("does not roll back a workspace that a newer write already moved", async () => {
			await writeCheckpointState()
			const provider = createStoredProvider()
			const broadcastFailure = new Error("history broadcast failed")
			provider.isViewLaunched = true
			provider.postMessageToWebview = vi.fn().mockImplementationOnce(async () => {
				await store.atomicReadAndUpdate(original.id, (current) => ({
					...current,
					workspace: "/newer/workspace",
				}))
				throw broadcastFailure
			})

			await expect(provider["resetTaskCheckpointsForWorkspaceChange"](original, updated)).rejects.toBe(
				broadcastFailure,
			)

			expect(store.get(original.id)?.workspace).toBe("/newer/workspace")
		})

		it("retries checkpoint backup cleanup without rolling back committed history", async () => {
			await writeCheckpointState()
			const provider = createStoredProvider()
			vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("backup cleanup failed"))

			try {
				await expect(provider["resetTaskCheckpointsForWorkspaceChange"](original, updated)).resolves.toEqual(
					updated,
				)

				expect(store.get(original.id)?.workspace).toBe("/current/workspace")
				expect(provider["log"]).toHaveBeenCalledWith(expect.stringContaining("backup cleanup failed"))
				expect(vi.mocked(fs.rm)).toHaveBeenCalledTimes(2)
				expect(
					(await fs.readdir(taskDir)).filter((name) => name.startsWith("checkpoints.workspace-change-")),
				).toEqual([])
				await expect(fs.stat(checkpointsDir)).rejects.toMatchObject({ code: "ENOENT" })
				expect(JSON.parse(await fs.readFile(messagesPath, "utf8"))).toMatchObject([
					{ type: "say", say: "task", text: "Continue" },
				])
			} finally {
				vi.mocked(fs.rm).mockRestore()
			}
		})

		it("leaves a task owned by a live Task untouched without prompting", async () => {
			await writeCheckpointState()
			const provider = createStoredProvider()
			const registry = new TaskRegistry()
			// TaskRegistry reads only taskId; a full Task would start unrelated services.
			registry.push({ taskId: original.id } as Task)
			Object.defineProperty(provider, "taskRegistry", { value: registry })
			ClineProvider["activeInstances"].add(provider)
			const prompt = vi.spyOn(vscode.window, "showWarningMessage")

			await expect(provider.prepareHistoryItemForResume(original)).resolves.toBe(original)

			expect(prompt).not.toHaveBeenCalled()
			expect(store.get(original.id)?.workspace).toBe("/old/worktree")
			await expect(fs.readFile(path.join(checkpointsDir, "HEAD"), "utf8")).resolves.toBe("old checkpoint")
		})

		it("cancels without resetting when the task becomes live while the prompt is open", async () => {
			await writeCheckpointState()
			const provider = createStoredProvider()
			const registry = new TaskRegistry()
			Object.defineProperty(provider, "taskRegistry", { value: registry })
			ClineProvider["activeInstances"].add(provider)
			vi.spyOn(vscode.window, "showWarningMessage").mockImplementation(async () => {
				// TaskRegistry reads only taskId; a full Task would start unrelated services.
				registry.push({ taskId: original.id } as Task)
				return { title: "Use Current Workspace" }
			})

			await expect(provider.prepareHistoryItemForResume(original)).resolves.toBeUndefined()

			expect(store.get(original.id)?.workspace).toBe("/old/worktree")
			await expect(fs.readFile(path.join(checkpointsDir, "HEAD"), "utf8")).resolves.toBe("old checkpoint")
			expect(JSON.parse(await fs.readFile(messagesPath, "utf8"))).toMatchObject(originalMessages)
		})
	})
})
