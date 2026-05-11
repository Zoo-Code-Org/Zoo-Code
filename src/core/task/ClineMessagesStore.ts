import type { ClineMessage, HistoryItem, TokenUsage, ToolUsage } from "@roo-code/types"
import { TelemetryEventName } from "@roo-code/types"
import { CloudService } from "@roo-code/cloud"

import type { ClineProvider } from "../webview/ClineProvider"
import { readTaskMessages, saveTaskMessages, taskMetadata } from "../task-persistence"
import { defaultModeSlug } from "../../shared/modes"

export type ClineMessagesStoreOptions = {
	taskId: string
	rootTaskId?: string
	parentTaskId?: string
	taskNumber: number
	globalStoragePath: string
	workspace: string
	initialStatus?: "active" | "delegated" | "completed"
	getProvider: () => ClineProvider | undefined
	getTaskMode: () => string | undefined
	getTaskApiConfigName: () => string | undefined
	waitForTaskApiConfig: () => Promise<void>
	getToolUsage: () => ToolUsage
	emitMessage: (payload: { action: "created" | "updated"; message: ClineMessage }) => void
	emitTokenUsage: (tokenUsage: TokenUsage, toolUsage: ToolUsage) => void
	afterOverwrite: () => void
}

export class ClineMessagesStore {
	messages: ClineMessage[] = []
	lastMessageTs?: number

	private readonly cloudSyncedMessageTimestamps: Set<number> = new Set()

	constructor(private readonly options: ClineMessagesStoreOptions) {}

	async getSaved(): Promise<ClineMessage[]> {
		return readTaskMessages({
			taskId: this.options.taskId,
			globalStoragePath: this.options.globalStoragePath,
		})
	}

	async add(message: ClineMessage) {
		this.messages.push(message)
		const provider = this.options.getProvider()
		// Avoid resending large, mostly-static fields (notably taskHistory) on every chat message update.
		// taskHistory is maintained in-memory in the webview and updated via taskHistoryItemUpdated.
		await provider?.postStateToWebviewWithoutTaskHistory()
		this.options.emitMessage({ action: "created", message })
		await this.save()

		this.captureMessageIfNeeded(message)
	}

	async overwrite(newMessages: ClineMessage[]) {
		this.messages = newMessages
		this.options.afterOverwrite()
		await this.save()

		// When overwriting messages (e.g., during task resume), repopulate the cloud sync tracking Set
		// with timestamps from all non-partial messages to prevent re-syncing previously synced messages.
		this.cloudSyncedMessageTimestamps.clear()
		for (const msg of newMessages) {
			if (msg.partial !== true) {
				this.cloudSyncedMessageTimestamps.add(msg.ts)
			}
		}
	}

	async update(message: ClineMessage) {
		const provider = this.options.getProvider()
		await provider?.postMessageToWebview({ type: "messageUpdated", clineMessage: message })
		this.options.emitMessage({ action: "updated", message })
		this.captureMessageIfNeeded(message)
	}

	async save(): Promise<boolean> {
		try {
			await saveTaskMessages({
				messages: structuredClone(this.messages),
				taskId: this.options.taskId,
				globalStoragePath: this.options.globalStoragePath,
			})

			if (this.options.getTaskApiConfigName() === undefined) {
				await this.options.waitForTaskApiConfig()
			}

			const { historyItem, tokenUsage } = await this.getMetadata()

			this.options.emitTokenUsage(tokenUsage, this.options.getToolUsage())
			await this.options.getProvider()?.updateTaskHistory(historyItem)
			return true
		} catch (error) {
			console.error("Failed to save Roo messages:", error)
			return false
		}
	}

	findByTimestamp(ts: number): ClineMessage | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			if (this.messages[i].ts === ts) {
				return this.messages[i]
			}
		}

		return undefined
	}

	private async getMetadata(): Promise<{ historyItem: HistoryItem; tokenUsage: TokenUsage }> {
		return taskMetadata({
			taskId: this.options.taskId,
			rootTaskId: this.options.rootTaskId,
			parentTaskId: this.options.parentTaskId,
			taskNumber: this.options.taskNumber,
			messages: this.messages,
			globalStoragePath: this.options.globalStoragePath,
			workspace: this.options.workspace,
			mode: this.options.getTaskMode() || defaultModeSlug,
			apiConfigName: this.options.getTaskApiConfigName(),
			initialStatus: this.options.initialStatus,
		})
	}

	private captureMessageIfNeeded(message: ClineMessage) {
		const shouldCaptureMessage = message.partial !== true && CloudService.isEnabled()
		const hasNotBeenSynced = !this.cloudSyncedMessageTimestamps.has(message.ts)

		if (shouldCaptureMessage && hasNotBeenSynced) {
			CloudService.instance.captureEvent({
				event: TelemetryEventName.TASK_MESSAGE,
				properties: { taskId: this.options.taskId, message },
			})
			this.cloudSyncedMessageTimestamps.add(message.ts)
		}
	}
}
