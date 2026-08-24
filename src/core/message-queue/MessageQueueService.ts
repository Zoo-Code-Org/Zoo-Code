import { EventEmitter } from "events"

import { v4 as uuidv4 } from "uuid"

import { QueuedMessage } from "@roo-code/types"

export interface MessageQueueState {
	messages: QueuedMessage[]
	isProcessing: boolean
	isPaused: boolean
}

export interface QueueEvents {
	stateChanged: [messages: QueuedMessage[]]
}

export class MessageQueueService extends EventEmitter<QueueEvents> {
	private _messages: QueuedMessage[]
	private claimedMessageIds = new Set<string>()

	constructor() {
		super()

		this._messages = []
	}

	private findMessage(id: string) {
		const index = this._messages.findIndex((msg) => msg.id === id)

		if (index === -1) {
			return { index, message: undefined }
		}

		return { index, message: this._messages[index] }
	}

	public addMessage(text: string, images?: string[]): QueuedMessage | undefined {
		if (!text && !images?.length) {
			return undefined
		}

		const message: QueuedMessage = {
			timestamp: Date.now(),
			id: uuidv4(),
			text,
			images,
		}

		this._messages.push(message)
		this.emit("stateChanged", this._messages)

		return message
	}

	public removeMessage(id: string): boolean {
		const { index, message } = this.findMessage(id)

		if (!message) {
			return false
		}

		this._messages.splice(index, 1)
		this.claimedMessageIds.delete(id)
		this.emit("stateChanged", this._messages)
		return true
	}

	public updateMessage(id: string, text: string, images?: string[]): boolean {
		const { message } = this.findMessage(id)

		if (!message) {
			return false
		}

		message.timestamp = Date.now()
		message.text = text
		message.images = images
		this.emit("stateChanged", this._messages)
		return true
	}

	public dequeueMessage(): QueuedMessage | undefined {
		const index = this._messages.findIndex((message) => !this.claimedMessageIds.has(message.id))
		if (index === -1) {
			return undefined
		}
		const [message] = this._messages.splice(index, 1)
		this.emit("stateChanged", this._messages)
		return message
	}

	public claimNextMessage(): QueuedMessage | undefined {
		const message = this._messages.find((candidate) => !this.claimedMessageIds.has(candidate.id))
		if (message) {
			this.claimedMessageIds.add(message.id)
		}
		return message
	}

	/**
	 * Makes a claimed message available to a later consumer without removing it.
	 * Durable consumers must use removeMessage() only after their persistence write succeeds.
	 */
	public releaseMessage(messageId: string): boolean {
		return this.claimedMessageIds.delete(messageId)
	}

	public get messages(): QueuedMessage[] {
		return this._messages
	}

	public isEmpty(): boolean {
		return this._messages.length === 0
	}

	public dispose(): void {
		this._messages = []
		this.claimedMessageIds.clear()
		this.removeAllListeners()
	}
}
