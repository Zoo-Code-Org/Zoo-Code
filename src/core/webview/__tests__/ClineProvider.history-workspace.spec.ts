import fs from "fs/promises"
import os from "os"
import path from "path"
import * as vscode from "vscode"

import type { HistoryItem } from "@roo-code/types"

import { ClineProvider } from "../ClineProvider"

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

	it("removes the old checkpoint repository and checkpoint-only chat rows", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-history-workspace-"))
		const taskDir = path.join(storagePath, "tasks", "task-1602")
		const checkpointsDir = path.join(taskDir, "checkpoints")
		await fs.mkdir(checkpointsDir, { recursive: true })
		await fs.writeFile(path.join(checkpointsDir, "HEAD"), "old checkpoint")
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

	it("keeps committed history when checkpoint backup cleanup fails", async () => {
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
