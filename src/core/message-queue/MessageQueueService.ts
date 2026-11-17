import { EventEmitter } from "events"

import { v4 as uuidv4 } from "uuid"

import type { MentionSegment, QueuedMessage } from "@roo-code/types"

import { normalizeSegments } from "../../shared/mentionSegments"

export interface QueueEvents {
	stateChanged: [messages: QueuedMessage[]]
	/** A blocked drain found a message. The consumer sends it. */
	drained: [message: QueuedMessage]
}

export class MessageQueueService extends EventEmitter<QueueEvents> {
	private _messages: QueuedMessage[]
	private claimedMessageIds = new Set<string>()
	private editTokens = new Map<string, number>()
	private editSeq = 0
	// Each blocked drain keeps the ids that edits held. See docs/architecture/tla/QueueDrainRetry.tla.
	private blockedDrains: string[][] = []

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

	public addMessage(text: string, images?: string[], segments?: MentionSegment[]): QueuedMessage | undefined {
		if (!text && !images?.length) {
			return undefined
		}

		const message: QueuedMessage = {
			timestamp: Date.now(),
			id: uuidv4(),
			text,
			images,
			segments,
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
		this.editTokens.delete(id)
		this.emit("stateChanged", this._messages)
		this.serveBlockedDrains()
		return true
	}

	/**
	 * An edit holds the message, so a drain skips it until the edit commits. A newer edit replaces an older
	 * one, and only the newest commits. Returns no token if the message is gone or a consumer holds it.
	 * See docs/architecture/tla/QueueEditRace.tla.
	 */
	public beginEdit(id: string): number | undefined {
		const { message } = this.findMessage(id)

		if (!message || (this.claimedMessageIds.has(id) && !this.editTokens.has(id))) {
			return undefined
		}

		this.claimedMessageIds.add(id)
		const token = ++this.editSeq
		this.editTokens.set(id, token)
		return token
	}

	/** Sets text, segments and images together for the newest edit, then lets the message go. */
	public commitEdit(id: string, token: number, text: string, images?: string[], segments?: unknown): boolean {
		const { message } = this.findMessage(id)

		if (!message || this.editTokens.get(id) !== token) {
			return false
		}

		// The editor tags each input event. A diff of the saved text would tag generated text user.
		message.segments = normalizeSegments(text, segments)
		message.timestamp = Date.now()
		message.text = text
		message.images = images
		this.editTokens.delete(id)
		this.claimedMessageIds.delete(id)
		this.emit("stateChanged", this._messages)
		this.serveBlockedDrains()
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

	/**
	 * One drain call. It returns the next message. If edits hold every message, the call waits.
	 * The "drained" event then sends one of the held messages when its edit ends.
	 */
	public drain(): QueuedMessage | undefined {
		const message = this.dequeueMessage()
		if (!message && this.editTokens.size > 0) {
			this.blockedDrains.push([...this.editTokens.keys()])
		}
		return message
	}

	// A blocked drain sends one message of its own ids. It ends when all of them are gone.
	private serveBlockedDrains(): void {
		const pending = this.blockedDrains
		this.blockedDrains = []
		for (const ids of pending) {
			const live = this._messages.filter((message) => ids.includes(message.id))
			if (live.length === 0) {
				continue
			}
			const next = live.find((message) => !this.claimedMessageIds.has(message.id))
			if (!next) {
				this.blockedDrains.push(ids)
				continue
			}
			this._messages.splice(this._messages.indexOf(next), 1)
			this.emit("stateChanged", this._messages)
			this.emit("drained", next)
		}
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
		const released = this.claimedMessageIds.delete(messageId)
		if (released) {
			this.serveBlockedDrains()
		}
		return released
	}

	public get messages(): QueuedMessage[] {
		return this._messages
	}

	public isEmpty(): boolean {
		return this._messages.length === 0
	}

	/**
	 * Whether at least one queued message is still available to be claimed.
	 *
	 * `isEmpty()` measures the queue's length and is blind to claims, so a
	 * message some consumer is holding (claim is not a removal) still makes it
	 * report a non-empty queue. Consumers that are about to take a message need
	 * this instead: it answers "is there anything I may take", which is false
	 * when every remaining message is already spoken for.
	 */
	public hasUnclaimed(): boolean {
		return this._messages.some((message) => !this.claimedMessageIds.has(message.id))
	}

	public dispose(): void {
		this._messages = []
		this.claimedMessageIds.clear()
		this.editTokens.clear()
		this.blockedDrains = []
		this.removeAllListeners()
	}
}
