// Shared context policy; the file-reading feature owns batch allocation.
import { TOKEN_BUFFER_PERCENTAGE } from "../../context-management"

export const MAX_READ_FILES_RESULT_BYTES = 64 * 1024
export const BATCH_ENTRY_ENVELOPE_BYTES = 1024
const BATCH_HEADER_ENVELOPE_BYTES = 256

export function getReadFileBatchEnvelopeBytes(entryCount: number): number {
	return entryCount * BATCH_ENTRY_ENVELOPE_BYTES + BATCH_HEADER_ENVELOPE_BYTES
}

/** UTF-8 bytes are a conservative text-token upper bound, not a chars/4 guess. */
export function getReadFileBatchBudget({
	contextWindow,
	contextTokens,
	reservedOutputTokens,
	pendingBytes = 0,
}: {
	contextWindow: number
	contextTokens: number
	reservedOutputTokens: number
	pendingBytes?: number
}): number {
	const available =
		Math.floor(contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE)) - contextTokens - reservedOutputTokens - pendingBytes
	return Math.max(0, Math.min(MAX_READ_FILES_RESULT_BYTES, Number.isFinite(available) ? available : 0))
}
