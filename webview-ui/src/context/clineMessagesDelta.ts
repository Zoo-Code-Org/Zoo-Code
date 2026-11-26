import type { ClineMessage, ClineMessagesDelta, ExtensionState } from "@roo-code/types"

/** Undefined means the baseline is missing or the patch is incomplete: request a snapshot. */
export function applyClineMessagesDelta(
	state: Pick<ExtensionState, "currentTaskId" | "clineMessagesSeq" | "clineMessages">,
	delta: ClineMessagesDelta,
): ClineMessage[] | undefined {
	if (
		state.currentTaskId !== delta.taskId ||
		state.clineMessagesSeq !== delta.baseSeq ||
		state.clineMessages.length !== delta.baseLength
	) {
		return undefined
	}
	if (!Number.isInteger(delta.length) || delta.length < delta.baseLength) return undefined
	const updates = new Map<number, ClineMessage>()
	for (const { index, message } of delta.updates) {
		if (!Number.isInteger(index) || index < 0 || index >= delta.length || updates.has(index)) return undefined
		updates.set(index, message)
	}
	for (let index = delta.baseLength; index < delta.length; index++) {
		if (!updates.has(index)) return undefined
	}
	if (updates.size === 0) return state.clineMessages
	const messages = state.clineMessages.slice()
	for (const [index, message] of updates) messages[index] = message
	return messages
}
