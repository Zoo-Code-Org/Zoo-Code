import { createHash } from "node:crypto"
import type { ClineMessagesDelta, ExtensionMessage, ExtensionState } from "@roo-code/types"
import { omitOriginalContent } from "./stripOriginalContent"

/** Retains compact fingerprints instead of a duplicate transcript. */
export class ClineMessageDelivery {
	private previous?: { taskId: string; seq: number; fingerprints: string[] }
	private lastSeq = -1

	prepare(
		state: Pick<ExtensionState, "clineMessages"> & Partial<ExtensionState>,
		forceFull = false,
	): ExtensionMessage | undefined {
		const { clineMessages, currentTaskId, clineMessagesSeq } = state
		if (clineMessagesSeq !== undefined) {
			if (clineMessagesSeq <= this.lastSeq) return undefined
			this.lastSeq = clineMessagesSeq
		}
		if (!clineMessages) {
			this.previous = undefined
			return { type: "state", state }
		}
		// Fingerprint exactly what the renderer will receive. File-edit messages
		// retain whole pre-edit files on disk, but those bodies are never needed in
		// the transcript and can dominate both hashing work and wire payloads.
		const displayMessages = clineMessages.map(omitOriginalContent)
		if (!currentTaskId || clineMessagesSeq === undefined) {
			this.previous = undefined
			return { type: "state", state: { ...state, clineMessages: displayMessages } }
		}
		// Task messages are mutated in place, including nested metadata. Hashing
		// each message detects those edits without retaining their potentially large text.
		const fingerprints = displayMessages.map((message) =>
			createHash("sha256").update(JSON.stringify(message)).digest("hex"),
		)
		const previous = this.previous
		this.previous = { taskId: currentTaskId, seq: clineMessagesSeq, fingerprints }
		if (
			forceFull ||
			!previous ||
			previous.taskId !== currentTaskId ||
			clineMessages.length < previous.fingerprints.length
		) {
			return { type: "state", state: { ...state, clineMessages: displayMessages } }
		}
		const delta: ClineMessagesDelta = {
			taskId: currentTaskId,
			baseSeq: previous.seq,
			baseLength: previous.fingerprints.length,
			length: clineMessages.length,
			updates: [],
		}
		for (let index = 0; index < fingerprints.length; index++) {
			if (fingerprints[index] !== previous.fingerprints[index]) {
				delta.updates.push({ index, message: displayMessages[index] })
			}
		}
		const { clineMessages: _messages, ...rest } = state
		return { type: "state", state: rest, clineMessagesDelta: delta }
	}
}
