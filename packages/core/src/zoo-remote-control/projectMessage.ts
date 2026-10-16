import type { ClineMessage } from "@roo-code/types"

/** Cap remote tool payloads so dashboard mirror stays usable without huge transfers. */
export const REMOTE_MESSAGE_TEXT_MAX_CHARS = 48_000
export const REMOTE_MESSAGE_IMAGE_MAX_COUNT = 2
export const REMOTE_MESSAGE_IMAGE_MAX_CHARS = 8_000
export const REMOTE_SNAPSHOT_MAX_MESSAGES = 80
/** Cap nested arrays (e.g. batchDiffs) so snapshots stay bounded. */
export const REMOTE_MESSAGE_ARRAY_MAX_ITEMS = 20
/** Aggregate serialized-character budget for a single tool JSON payload. */
export const REMOTE_MESSAGE_JSON_MAX_CHARS = 96_000

function truncateString(value: string, max: number): string {
	if (max <= 0) {
		return ""
	}
	if (value.length <= max) {
		return value
	}
	// Keep the returned length within `max` (marker fits inside the budget).
	const marker = `\n…[truncated ${value.length - max} chars]`
	const head = Math.max(0, max - marker.length)
	return `${value.slice(0, head)}${marker}`
}

/** Bound nested JSON while preserving keys/array slots; `stringCap` limits each string. */
function boundJsonValue(value: unknown, stringCap: number): unknown {
	if (typeof value === "string") {
		return truncateString(value, stringCap)
	}

	if (Array.isArray(value)) {
		return value.slice(0, REMOTE_MESSAGE_ARRAY_MAX_ITEMS).map((entry) => boundJsonValue(entry, stringCap))
	}

	if (value && typeof value === "object") {
		const record: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			record[key] = boundJsonValue(child, stringCap)
		}
		return record
	}

	return value
}

function shapeToolText(text: string): string {
	try {
		const parsed: unknown = JSON.parse(text)
		if (parsed === null || typeof parsed !== "object") {
			return truncateString(text, REMOTE_MESSAGE_TEXT_MAX_CHARS)
		}

		let stringCap = REMOTE_MESSAGE_TEXT_MAX_CHARS
		let bounded = boundJsonValue(parsed, stringCap)
		let serialized = JSON.stringify(bounded)

		// If the payload is still too large, shrink every string together so structure
		// (keys, array slots, small metadata) stays intact under the aggregate budget.
		while (serialized.length > REMOTE_MESSAGE_JSON_MAX_CHARS && stringCap > 512) {
			stringCap = Math.floor(stringCap * 0.5)
			bounded = boundJsonValue(parsed, stringCap)
			serialized = JSON.stringify(bounded)
		}

		if (serialized.length > REMOTE_MESSAGE_JSON_MAX_CHARS) {
			return truncateString(serialized, REMOTE_MESSAGE_JSON_MAX_CHARS)
		}

		return serialized
	} catch {
		return truncateString(text, REMOTE_MESSAGE_TEXT_MAX_CHARS)
	}
}

/** Shape a ClineMessage for remote publish (size-safe, still useful for asks/diffs). */
export function projectClineMessageForRemote(message: ClineMessage): ClineMessage {
	const next: ClineMessage = { ...message }

	if (typeof next.text === "string") {
		const isToolish =
			next.ask === "tool" || next.say === "tool" || next.ask === "command" || next.ask === "use_mcp_server"

		next.text = isToolish ? shapeToolText(next.text) : truncateString(next.text, REMOTE_MESSAGE_TEXT_MAX_CHARS)
	}

	if (typeof next.reasoning === "string") {
		next.reasoning = truncateString(next.reasoning, REMOTE_MESSAGE_TEXT_MAX_CHARS)
	}

	if (Array.isArray(next.images) && next.images.length > 0) {
		next.images = next.images
			.slice(0, REMOTE_MESSAGE_IMAGE_MAX_COUNT)
			.map((image) => truncateString(image, REMOTE_MESSAGE_IMAGE_MAX_CHARS))
	}

	return next
}

export function projectClineMessagesForSnapshot(messages: ClineMessage[]): ClineMessage[] {
	const window = messages.slice(-REMOTE_SNAPSHOT_MAX_MESSAGES)
	return window.map(projectClineMessageForRemote)
}
