import { EventEmitter } from "events"

import { v4 as uuidv4 } from "uuid"

import { QueuedMessage, QueuedMessageDeliveryMode } from "@roo-code/types"

export interface MessageQueueState {
	messages: QueuedMessage[]
	isProcessing: boolean
	isPaused: boolean
}

export interface QueueEvents {
	stateChanged: [messages: QueuedMessage[]]
}

export class MessageQueueService extends EventEmitter<QueueEvents> {
	private readonly lanes: Record<QueuedMessageDeliveryMode, QueuedMessage[]>

	constructor() {
		super()

		this.lanes = {
			queue: [],
			steer: [],
		}
	}

	private normalizeMessage(
		message: Pick<QueuedMessage, "id" | "text"> & Partial<Omit<QueuedMessage, "id" | "text">>,
	): QueuedMessage {
		const createdAt = message.createdAt ?? message.timestamp ?? Date.now()
		const updatedAt = message.updatedAt ?? message.timestamp ?? createdAt

		return {
			timestamp: message.timestamp ?? updatedAt,
			createdAt,
			updatedAt,
			id: message.id,
			text: message.text,
			images: message.images ? [...message.images] : undefined,
			deliveryMode: message.deliveryMode ?? "queue",
		}
	}

	private emitStateChanged(): void {
		this.emit("stateChanged", this.messages)
	}

	private getLane(deliveryMode: QueuedMessageDeliveryMode): QueuedMessage[] {
		return this.lanes[deliveryMode]
	}

	private findMessage(id: string) {
		for (const deliveryMode of ["steer", "queue"] as const) {
			const lane = this.getLane(deliveryMode)
			const index = lane.findIndex((message) => message.id === id)

			if (index !== -1) {
				return {
					deliveryMode,
					index,
					message: lane[index],
				}
			}
		}

		return {
			deliveryMode: undefined,
			index: -1,
			message: undefined,
		}
	}

	public addMessage(
		text: string,
		images?: string[],
		deliveryMode: QueuedMessageDeliveryMode = "queue",
	): QueuedMessage | undefined {
		if (!text && !images?.length) {
			return undefined
		}

		const now = Date.now()
		const message: QueuedMessage = {
			timestamp: now,
			createdAt: now,
			updatedAt: now,
			id: uuidv4(),
			text,
			images,
			deliveryMode,
		}

		this.getLane(deliveryMode).push(message)
		this.emitStateChanged()

		return message
	}

	public removeMessage(id: string): boolean {
		const { deliveryMode, index, message } = this.findMessage(id)

		if (!message || !deliveryMode) {
			return false
		}

		this.getLane(deliveryMode).splice(index, 1)
		this.emitStateChanged()
		return true
	}

	public updateMessage(
		id: string,
		text: string,
		images?: string[],
		deliveryMode?: QueuedMessageDeliveryMode,
	): boolean {
		const now = Date.now()
		const { message } = this.findMessage(id)

		if (!message) {
			return false
		}

		const nextDeliveryMode = deliveryMode ?? message.deliveryMode

		if (nextDeliveryMode !== message.deliveryMode) {
			return this.setDeliveryMode(id, nextDeliveryMode, { text, images, updatedAt: now })
		}

		message.timestamp = now
		message.updatedAt = now
		message.text = text
		message.images = images
		this.emitStateChanged()
		return true
	}

	public dequeueMessage(): QueuedMessage | undefined {
		return this.dequeueNextMessage(["steer", "queue"])
	}

	public dequeueMessageByMode(deliveryMode: QueuedMessageDeliveryMode): QueuedMessage | undefined {
		const message = this.getLane(deliveryMode).shift()

		if (message) {
			this.emitStateChanged()
		}

		return message
	}

	public dequeueNextMessage(priority: QueuedMessageDeliveryMode[] = ["steer", "queue"]): QueuedMessage | undefined {
		for (const deliveryMode of priority) {
			const message = this.dequeueMessageByMode(deliveryMode)

			if (message) {
				return message
			}
		}

		return undefined
	}

	public setDeliveryMode(
		id: string,
		deliveryMode: QueuedMessageDeliveryMode,
		overrides?: { text?: string; images?: string[]; updatedAt?: number },
	): boolean {
		const { deliveryMode: currentDeliveryMode, index, message } = this.findMessage(id)

		if (!message || !currentDeliveryMode) {
			return false
		}

		const now = overrides?.updatedAt ?? Date.now()
		const nextMessage: QueuedMessage = {
			...message,
			timestamp: now,
			updatedAt: now,
			text: overrides?.text ?? message.text,
			images: overrides?.images ?? message.images,
			deliveryMode,
		}

		if (currentDeliveryMode === deliveryMode) {
			this.getLane(currentDeliveryMode)[index] = nextMessage
			this.emitStateChanged()
			return true
		}

		this.getLane(currentDeliveryMode).splice(index, 1)
		this.getLane(deliveryMode).push(nextMessage)
		this.emitStateChanged()
		return true
	}

	public restoreMessages(messages: QueuedMessage[]): void {
		this.lanes.queue = []
		this.lanes.steer = []

		for (const message of messages) {
			const normalized = this.normalizeMessage(message)
			this.getLane(normalized.deliveryMode).push(normalized)
		}

		this.emitStateChanged()
	}

	public get messages(): QueuedMessage[] {
		return [...this.lanes.steer, ...this.lanes.queue]
	}

	public getMessagesByMode(deliveryMode: QueuedMessageDeliveryMode): QueuedMessage[] {
		return [...this.getLane(deliveryMode)]
	}

	public hasMessages(deliveryMode?: QueuedMessageDeliveryMode): boolean {
		if (deliveryMode) {
			return this.getLane(deliveryMode).length > 0
		}

		return this.messages.length > 0
	}

	public isEmpty(deliveryMode?: QueuedMessageDeliveryMode): boolean {
		return !this.hasMessages(deliveryMode)
	}

	public dispose(): void {
		this.lanes.queue = []
		this.lanes.steer = []
		this.removeAllListeners()
	}
}
