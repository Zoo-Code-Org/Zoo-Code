import fs from "fs/promises"
import os from "os"
import path from "path"
import * as vscode from "vscode"

import type { ClineMessage, HistoryItem } from "@roo-code/types"

import { ClineProvider } from "../ClineProvider"
import * as taskMessages from "../../task-persistence/taskMessages"

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

	it.each([true, false])("resets checkpoint rows with an existing checkpoint directory: %s", async (hasDirectory) => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-history-workspace-"))
		const taskDir = path.join(storagePath, "tasks", "task-1602")
		const checkpointsDir = path.join(taskDir, "checkpoints")
		await fs.mkdir(taskDir, { recursive: true })
		if (hasDirectory) {
			await fs.mkdir(checkpointsDir)
			await fs.writeFile(path.join(checkpointsDir, "HEAD"), "old checkpoint")
		}
		await fs.writeFile(
			path.join(taskDir, "ui_messages.json"),
			JSON.stringify([
				{ type: "say", say: "task", ts: 1, text: "Continue" },
				{ type: "say", say: "checkpoint_saved", ts: 2, text: "old-hash" },
				{ type: "say", say: "text", ts: 3, text: "Still useful" },
			]),
		)

		const provider = createProvider("/current/workspace")
		Object.defineProperty(provider, "contextProxy", {
			value: { globalStorageUri: { fsPath: storagePath } },
		})
		const original = historyItem("/old/worktree")
		const updated = { ...original, workspace: "/current/workspace" }
		provider.updateTaskHistory = vi.fn().mockResolvedValue([])
		Object.defineProperty(provider, "taskHistoryStore", { value: { get: vi.fn().mockReturnValue(original) } })

		try {
			await provider["resetTaskCheckpointsForWorkspaceChange"](original, updated)

			await expect(fs.stat(checkpointsDir)).rejects.toMatchObject({ code: "ENOENT" })
			const messages = JSON.parse(await fs.readFile(path.join(taskDir, "ui_messages.json"), "utf8"))
			expect(messages).toMatchObject([
				{ type: "say", say: "task", text: "Continue" },
				{ type: "say", say: "text", text: "Still useful" },
			])
			expect(provider.updateTaskHistory).toHaveBeenCalledWith(updated)
		} finally {
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it.each([false, true])("preserves intervening message writes (rollback: %s)", async (rollback) => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-history-concurrent-"))
		const taskDir = path.join(storagePath, "tasks", "task-1602")
		const checkpointsDir = path.join(taskDir, "checkpoints")
		await fs.mkdir(checkpointsDir, { recursive: true })
		const original = historyItem("/old/worktree")
		const updated = { ...original, workspace: "/current/workspace" }
		const options = { taskId: original.id, globalStoragePath: storagePath }
		const checkpoint: ClineMessage = { ts: 2, type: "say", say: "checkpoint_saved", text: "old-hash" }
		await taskMessages.saveTaskMessages({
			...options,
			messages: [{ ts: 1, type: "say", say: "text", text: "before" }, checkpoint],
		})
		const provider = createProvider(updated.workspace)
		Object.defineProperty(provider, "contextProxy", { value: { globalStorageUri: { fsPath: storagePath } } })
		Object.defineProperty(provider, "taskHistoryStore", { value: { get: () => original } })
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
		provider.updateTaskHistory = vi.fn().mockImplementation(async () => {
			await taskMessages.saveTaskMessages({
				...options,
				merge: true,
				messages: [{ ts: 1, type: "say", say: "text", text: "updated during history write" }],
			})
			if (rollback) throw new Error("history write failed")
			return [updated]
		})
		try {
			const reset = provider["resetTaskCheckpointsForWorkspaceChange"](original, updated)
			if (rollback) await expect(reset).rejects.toThrow("history write failed")
			else await reset
			const messages = await taskMessages.readTaskMessages(options)
			expect(messages.map(({ ts, text }) => ({ ts, text }))).toEqual([
				{ ts: 1, text: "updated during history write" },
				...(rollback ? [{ ts: 2, text: "old-hash" }] : []),
				{ ts: 3, text: "during reset" },
			])
		} finally {
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("restores checkpoint files and messages when workspace persistence fails", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-history-workspace-rollback-"))
		const taskDir = path.join(storagePath, "tasks", "task-1602")
		const checkpointsDir = path.join(taskDir, "checkpoints")
		const messagesPath = path.join(taskDir, "ui_messages.json")
		const originalMessages = [
			{ type: "say", say: "task", ts: 1, text: "Continue" },
			{ type: "say", say: "checkpoint_saved", ts: 2, text: "old-hash" },
		]
		await fs.mkdir(checkpointsDir, { recursive: true })
		await fs.writeFile(path.join(checkpointsDir, "HEAD"), "old checkpoint")
		await fs.writeFile(messagesPath, JSON.stringify(originalMessages))

		const provider = createProvider("/current/workspace")
		const original = historyItem("/old/worktree")
		const updated = { ...original, workspace: "/current/workspace" }
		Object.defineProperty(provider, "contextProxy", {
			value: { globalStorageUri: { fsPath: storagePath } },
		})
		Object.defineProperty(provider, "taskHistoryStore", { value: { get: vi.fn().mockReturnValue(original) } })
		provider.updateTaskHistory = vi.fn().mockRejectedValue(new Error("history write failed"))

		try {
			await expect(provider["resetTaskCheckpointsForWorkspaceChange"](original, updated)).rejects.toThrow(
				"history write failed",
			)
			await expect(fs.readFile(path.join(checkpointsDir, "HEAD"), "utf8")).resolves.toBe("old checkpoint")
			expect(JSON.parse(await fs.readFile(messagesPath, "utf8"))).toMatchObject(originalMessages)
		} finally {
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it.each([
		{ failures: ["messages"] },
		{ failures: ["checkpoints"] },
		{ failures: ["history"] },
		{ failures: ["messages", "checkpoints", "history"] },
	])(
		"attempts every rollback and preserves the original error when $failures restoration fails",
		async ({ failures }) => {
			const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-history-workspace-rollback-failure-"))
			const taskDir = path.join(storagePath, "tasks", "task-1602")
			const checkpointsDir = path.join(taskDir, "checkpoints")
			const messagesPath = path.join(taskDir, "ui_messages.json")
			const originalMessages = [
				{ type: "say", say: "task", ts: 1, text: "Continue" },
				{ type: "say", say: "checkpoint_saved", ts: 2, text: "old-hash" },
			]
			await fs.mkdir(checkpointsDir, { recursive: true })
			await fs.writeFile(path.join(checkpointsDir, "HEAD"), "old checkpoint")
			await fs.writeFile(messagesPath, JSON.stringify(originalMessages))

			const provider = createProvider("/current/workspace")
			const original = historyItem("/old/worktree")
			const updated = { ...original, workspace: "/current/workspace" }
			Object.defineProperty(provider, "contextProxy", {
				value: { globalStorageUri: { fsPath: storagePath } },
			})
			// History can already be committed when broadcasting the update fails.
			Object.defineProperty(provider, "taskHistoryStore", { value: { get: vi.fn().mockReturnValue(updated) } })
			const originalError = new Error("history broadcast failed")
			const updateHistory = vi.fn<ClineProvider["updateTaskHistory"]>().mockRejectedValueOnce(originalError)
			if (failures.includes("history")) {
				updateHistory.mockRejectedValueOnce(new Error("history restore failed"))
			} else {
				updateHistory.mockResolvedValueOnce([original])
			}
			provider.updateTaskHistory = updateHistory
			provider["log"] = vi.fn()
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

			try {
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
				expect(updateHistory).toHaveBeenCalledTimes(2)
				expect(updateHistory).toHaveBeenLastCalledWith(original)
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
			} finally {
				await fs.rm(storagePath, { recursive: true, force: true })
			}
		},
	)

	it("retries checkpoint backup cleanup without rolling back committed history", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-history-workspace-cleanup-"))
		const taskDir = path.join(storagePath, "tasks", "task-1602")
		const checkpointsDir = path.join(taskDir, "checkpoints")
		const messagesPath = path.join(taskDir, "ui_messages.json")
		await fs.mkdir(checkpointsDir, { recursive: true })
		await fs.writeFile(path.join(checkpointsDir, "HEAD"), "old checkpoint")
		await fs.writeFile(
			messagesPath,
			JSON.stringify([
				{ type: "say", say: "task", ts: 1, text: "Continue" },
				{ type: "say", say: "checkpoint_saved", ts: 2, text: "old-hash" },
			]),
		)

		const provider = createProvider("/current/workspace")
		const original = historyItem("/old/worktree")
		const updated = { ...original, workspace: "/current/workspace" }
		Object.defineProperty(provider, "contextProxy", {
			value: { globalStorageUri: { fsPath: storagePath } },
		})
		Object.defineProperty(provider, "taskHistoryStore", { value: { get: vi.fn().mockReturnValue(updated) } })
		provider.updateTaskHistory = vi.fn().mockResolvedValue([])
		provider["log"] = vi.fn()
		vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("backup cleanup failed"))

		try {
			await expect(provider["resetTaskCheckpointsForWorkspaceChange"](original, updated)).resolves.toBeUndefined()

			expect(provider.updateTaskHistory).toHaveBeenCalledOnce()
			expect(provider.updateTaskHistory).toHaveBeenCalledWith(updated)
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
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})
})
