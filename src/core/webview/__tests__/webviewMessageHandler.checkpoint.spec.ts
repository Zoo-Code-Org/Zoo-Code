import { describe, it, expect, vi, beforeEach } from "vitest"
import pWaitFor from "p-wait-for"
import { webviewMessageHandler } from "../webviewMessageHandler"
import { saveTaskMessages } from "../../task-persistence"
import { handleCheckpointRestoreOperation } from "../checkpointRestoreHandler"
import { MessageManager } from "../../message-manager"

// Mock dependencies
vi.mock("../../task-persistence", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../task-persistence")>()),
	saveTaskMessages: vi.fn(),
}))
vi.mock("../checkpointRestoreHandler")
vi.mock("p-wait-for", () => ({
	default: vi.fn(async (condition: () => boolean) => {
		if (!condition()) {
			throw new Error("condition not met")
		}
	}),
}))
vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: undefined,
	},
}))

describe("webviewMessageHandler - checkpoint operations", () => {
	let mockProvider: any
	let mockCline: any

	beforeEach(() => {
		vi.clearAllMocks()

		// Setup mock Cline instance
		mockCline = {
			taskId: "test-task-123",
			isInitialized: true,
			clineMessages: [
				{ ts: 1, type: "user", say: "user", text: "First message" },
				{ ts: 2, type: "assistant", say: "checkpoint_saved", text: "abc123" },
				{ ts: 3, type: "user", say: "user", text: "Message to delete" },
				{ ts: 4, type: "assistant", say: "assistant", text: "After message" },
			],
			apiConversationHistory: [
				{ ts: 1, role: "user", content: [{ type: "text", text: "First message" }] },
				{ ts: 3, role: "user", content: [{ type: "text", text: "Message to delete" }] },
				{ ts: 4, role: "assistant", content: [{ type: "text", text: "After message" }] },
			],
			checkpointDiff: vi.fn(),
			checkpointRestore: vi.fn(),
			overwriteClineMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
		}
		mockCline.messageManager = new MessageManager(mockCline)

		// Setup mock provider
		mockProvider = {
			getCurrentTask: vi.fn(() => mockCline),
			postMessageToWebview: vi.fn(),
			getTaskWithId: vi.fn(() => ({
				historyItem: { id: "test-task-123", messages: mockCline.clineMessages },
			})),
			createTaskWithHistoryItem: vi.fn(),
			setPendingEditOperation: vi.fn(),
			cancelTask: vi.fn(),
			contextProxy: {
				globalStorageUri: { fsPath: "/test/storage" },
			},
			getState: vi.fn().mockResolvedValue({
				maxImageFileSize: 5,
				maxTotalImageSize: 20,
			}),
		}
	})

	describe("delete operations with checkpoint restoration", () => {
		it("should call handleCheckpointRestoreOperation for checkpoint deletes", async () => {
			// Mock handleCheckpointRestoreOperation
			;(handleCheckpointRestoreOperation as any).mockResolvedValue(undefined)

			// Call the handler with delete confirmation
			await webviewMessageHandler(mockProvider, {
				type: "deleteMessageConfirm",
				messageTs: 1,
				restoreCheckpoint: true,
			})

			// Verify handleCheckpointRestoreOperation was called with correct parameters
			expect(handleCheckpointRestoreOperation).toHaveBeenCalledWith({
				provider: mockProvider,
				currentCline: mockCline,
				messageTs: 1,
				messageIndex: 0,
				checkpoint: { hash: "abc123" },
				operation: "delete",
			})
		})

		it("should save messages for non-checkpoint deletes", async () => {
			// Call the handler with delete confirmation (no checkpoint restoration)
			await webviewMessageHandler(mockProvider, {
				type: "deleteMessageConfirm",
				messageTs: 2,
				restoreCheckpoint: false,
			})

			// Verify saveTaskMessages was called
			expect(saveTaskMessages).toHaveBeenCalledWith({
				messages: expect.any(Array),
				taskId: "test-task-123",
				globalStoragePath: "/test/storage",
			})

			// Verify checkpoint restore was NOT called
			expect(mockCline.checkpointRestore).not.toHaveBeenCalled()
		})
	})

	describe("edit operations with checkpoint restoration", () => {
		it("should call handleCheckpointRestoreOperation for checkpoint edits", async () => {
			// Mock handleCheckpointRestoreOperation
			;(handleCheckpointRestoreOperation as any).mockResolvedValue(undefined)

			// Call the handler with edit confirmation
			await webviewMessageHandler(mockProvider, {
				type: "editMessageConfirm",
				messageTs: 1,
				text: "Edited checkpoint message",
				restoreCheckpoint: true,
			})

			// Verify handleCheckpointRestoreOperation was called with correct parameters
			expect(handleCheckpointRestoreOperation).toHaveBeenCalledWith({
				provider: mockProvider,
				currentCline: mockCline,
				messageTs: 1,
				messageIndex: 0,
				checkpoint: { hash: "abc123" },
				operation: "edit",
				editData: {
					editedContent: "Edited checkpoint message",
					images: [],
					apiConversationHistoryIndex: 0,
				},
			})
		})
	})

	describe("completion checkpoint actions", () => {
		beforeEach(() => {
			mockCline.clineMessages = [
				{ ts: 1, type: "say", say: "text", text: "Initial task" },
				{ ts: 2, type: "say", say: "checkpoint_saved", text: "initial-checkpoint" },
				{ ts: 3, type: "say", say: "user_feedback", text: "Latest prompt" },
				{ ts: 4, type: "say", say: "checkpoint_saved", text: "latest-prompt-checkpoint" },
				{ ts: 5, type: "say", say: "completion_result", text: "Task complete" },
				{ ts: 6, type: "ask", ask: "completion_result", text: "", partial: false },
			]
		})

		it("diffs changes from the checkpoint created after the latest prompt", async () => {
			await webviewMessageHandler(mockProvider, { type: "completionCheckpointDiff" })

			expect(mockCline.checkpointDiff).toHaveBeenCalledWith({
				ts: 4,
				commitHash: "latest-prompt-checkpoint",
				mode: "to-current",
			})
		})

		it("restores files and task state to the checkpoint created after the latest prompt", async () => {
			const callOrder: string[] = []
			mockProvider.cancelTask.mockImplementation(async () => callOrder.push("cancelTask"))
			mockCline.checkpointRestore.mockImplementation(async () => callOrder.push("checkpointRestore"))

			await webviewMessageHandler(mockProvider, { type: "completionCheckpointRestore" })

			expect(mockProvider.cancelTask).toHaveBeenCalled()
			expect(mockCline.checkpointRestore).toHaveBeenCalledWith({
				ts: 4,
				commitHash: "latest-prompt-checkpoint",
				mode: "restore",
			})
			expect(callOrder).toEqual(["cancelTask", "checkpointRestore"])
		})

		it("does not diff or restore when no latest-prompt checkpoint exists", async () => {
			mockCline.clineMessages = [
				{ ts: 1, type: "say", say: "text", text: "Initial task" },
				{ ts: 2, type: "say", say: "user_feedback", text: "Latest prompt" },
				{ ts: 3, type: "ask", ask: "completion_result", text: "", partial: false },
			]

			await webviewMessageHandler(mockProvider, { type: "completionCheckpointDiff" })
			await webviewMessageHandler(mockProvider, { type: "completionCheckpointRestore" })

			expect(mockCline.checkpointDiff).not.toHaveBeenCalled()
			expect(mockCline.checkpointRestore).not.toHaveBeenCalled()
			expect(mockProvider.cancelTask).not.toHaveBeenCalled()
		})

		it("resolves the latest completion checkpoint in the extension host", async () => {
			await webviewMessageHandler(mockProvider, { type: "completionCheckpointDiff" })

			expect(mockCline.checkpointDiff).toHaveBeenCalledWith({
				ts: 4,
				commitHash: "latest-prompt-checkpoint",
				mode: "to-current",
			})
		})

		it("does not restore when task re-initialization times out", async () => {
			;(pWaitFor as any).mockRejectedValueOnce(new Error("timed out"))

			await webviewMessageHandler(mockProvider, { type: "completionCheckpointRestore" })

			expect(mockProvider.cancelTask).toHaveBeenCalled()
			expect(mockCline.checkpointRestore).not.toHaveBeenCalled()
			const vscode = await import("vscode")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.checkpoint_timeout")
		})

		it("shows an error when completion checkpoint restore fails", async () => {
			const restoreError = new Error("restore failed")
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			mockCline.checkpointRestore.mockRejectedValueOnce(restoreError)

			await webviewMessageHandler(mockProvider, { type: "completionCheckpointRestore" })

			const vscode = await import("vscode")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[completionCheckpointRestore] checkpointRestore failed:",
				restoreError,
			)
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.checkpoint_failed")
			consoleErrorSpy.mockRestore()
		})

		it("does not restore when task identity changes during cancellation", async () => {
			mockProvider.getCurrentTask.mockReturnValueOnce(mockCline).mockReturnValue({
				...mockCline,
				taskId: "different-task-id",
			})

			await webviewMessageHandler(mockProvider, { type: "completionCheckpointRestore" })

			expect(mockProvider.cancelTask).toHaveBeenCalled()
			expect(mockCline.checkpointRestore).not.toHaveBeenCalled()
			const vscode = await import("vscode")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.checkpoint_failed")
		})
	})
})
