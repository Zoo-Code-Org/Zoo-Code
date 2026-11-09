import { Task } from "../task/Task"
import { checkpointRestoreFailureMessage, ConversationRewindError } from "../checkpoints/ConversationRewindError"
import { ClineProvider } from "./ClineProvider"
import { saveTaskMessages } from "../task-persistence"
import * as vscode from "vscode"
import pWaitFor from "p-wait-for"

import { t } from "../../i18n"

export interface CheckpointRestoreConfig {
	provider: ClineProvider
	currentCline: Task
	messageTs: number
	messageIndex: number
	checkpoint: { hash: string }
	operation: "delete" | "edit"
	editData?: {
		editedContent: string
		images?: string[]
		apiConversationHistoryIndex: number
	}
}

/**
 * Handles checkpoint restoration for both delete and edit operations.
 * This consolidates the common logic while handling operation-specific behavior.
 */
export async function handleCheckpointRestoreOperation(config: CheckpointRestoreConfig): Promise<void> {
	const { provider, currentCline, messageTs, checkpoint, operation, editData } = config

	let checkpointRestored = false
	let pendingEditOwner: object | undefined

	try {
		// For delete operations, ensure the task is properly aborted to handle any pending ask operations
		// This prevents "Current ask promise was ignored" errors
		// For edit operations, we don't abort because the checkpoint restore will handle it
		if (operation === "delete" && currentCline && !currentCline.abort) {
			await currentCline.abortTask()
			// Wait a bit for the abort to complete
			await pWaitFor(() => currentCline.abort === true, {
				timeout: 1000,
				interval: 50,
			}).catch(() => {
				// Continue even if timeout - the abort flag should be set
			})
		}

		// For edit operations, set up pending edit data before restoration
		if (operation === "edit" && editData) {
			const operationId = `task-${currentCline.taskId}`
			pendingEditOwner = provider.setPendingEditOperation(operationId, {
				messageTs,
				editedContent: editData.editedContent,
				images: editData.images,
				messageIndex: config.messageIndex,
				apiConversationHistoryIndex: editData.apiConversationHistoryIndex,
			})
		}

		// Perform the checkpoint restoration
		await currentCline.checkpointRestore({
			ts: messageTs,
			commitHash: checkpoint.hash,
			mode: "restore",
			operation,
		})

		checkpointRestored = true

		// For delete operations, we need to save messages and reinitialize
		// For edit operations, the reinitialization happens automatically
		// and processes the pending edit
		if (operation === "delete") {
			// Save the updated messages to disk after checkpoint restoration
			await saveTaskMessages({
				messages: currentCline.clineMessages,
				taskId: currentCline.taskId,
				globalStoragePath: provider.contextProxy.globalStorageUri.fsPath,
			})

			// Get the updated history item and reinitialize
			const { historyItem } = await provider.getTaskWithId(currentCline.taskId)
			await provider.createTaskWithHistoryItem(historyItem)
		}
		// For edit operations, the task cancellation in checkpointRestore
		// will trigger reinitialization, which will process pendingEditAfterRestore
	} catch (error) {
		// The files were restored and the task is started again (see `ConversationRewindError`): the starting task
		// takes the pending edit, and hands it back to the user if it cannot apply it, and there is nothing to restart.
		const taskRestarted = error instanceof ConversationRewindError && error.restarted
		if (operation === "edit" && !checkpointRestored && pendingEditOwner && !taskRestarted) {
			provider.clearPendingEditOperation(`task-${currentCline.taskId}`, pendingEditOwner)
			// The rewind failed and the task could not be started again either: nothing will apply the edit, so it is
			// put back in the chat box, as the provider does when it cannot apply it.
			if (error instanceof ConversationRewindError && editData) {
				try {
					await provider.postMessageToWebview({
						type: "invoke",
						invoke: "setChatBoxMessage",
						text: editData.editedContent,
						images: editData.images,
					})
				} catch {
					// The failure is reported below; the edit cannot be shown if the webview is gone.
				}
			}
		}
		console.error(`Error in checkpoint restore (${operation}):`, error)
		void vscode.window.showErrorMessage(checkpointRestoreFailureMessage(error))
		if (operation === "delete" && !checkpointRestored && !taskRestarted && currentCline.abort) {
			try {
				const restart = t("common:checkpoints.restart")
				const response = await vscode.window.showWarningMessage(
					t("common:checkpoints.restart_after_restore_failure"),
					restart,
				)
				if (response === restart) {
					await provider.restartTaskIfCurrent(currentCline)
				}
			} catch (restartError) {
				console.error("Failed to restart task after checkpoint restore failure:", restartError)
			}
		}
		throw error
	}
}
