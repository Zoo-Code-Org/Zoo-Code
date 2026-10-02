import type { ClineMessage, ExtensionMessage } from "@roo-code/types"

// Keyed by message object; only valid while the text is unchanged (partial messages are updated in place).
const cache = new WeakMap<ClineMessage, { source: string; result: ClineMessage }>()

function isToolMessage(message: ClineMessage): boolean {
	return (message.type === "ask" && message.ask === "tool") || (message.type === "say" && message.say === "tool")
}

/** Replaces a file-edit tool message's `originalContent` (the whole pre-edit file) with its length. */
export function omitOriginalContent(message: ClineMessage): ClineMessage {
	const text = message.text

	if (typeof text !== "string" || !isToolMessage(message) || !text.includes('"originalContent"')) {
		return message
	}

	const cached = cache.get(message)

	if (cached && cached.source === text) {
		return cached.result
	}

	let result = message

	try {
		const { originalContent, ...rest } = JSON.parse(text) as Record<string, unknown>

		// An empty original (new file) is free and still means "has an original" to the webview, so it stays.
		if (typeof originalContent === "string" && originalContent.length > 0) {
			result = { ...message, text: JSON.stringify({ ...rest, originalContentLength: originalContent.length }) }
		}
	} catch {
		// Not valid JSON (e.g. a truncated partial message): leave it untouched.
	}

	cache.set(message, { source: text, result })
	return result
}

/** The `originalContent` of the tool message with this `ts`, or null when there is none. */
export function findOriginalContent(messages: ClineMessage[] | undefined, ts: number): string | null {
	const message = messages?.find((m) => m.ts === ts && isToolMessage(m))

	if (!message?.text) {
		return null
	}

	try {
		const { originalContent } = JSON.parse(message.text) as { originalContent?: unknown }
		return typeof originalContent === "string" ? originalContent : null
	} catch {
		return null
	}
}

/** The webview gets `originalContent` on demand (`readOriginalContent`) instead of inside every chat message. */
export function omitOriginalContentFromExtensionMessage(message: ExtensionMessage): ExtensionMessage {
	if (message.type === "state" && message.state?.clineMessages?.length) {
		return {
			...message,
			state: { ...message.state, clineMessages: message.state.clineMessages.map(omitOriginalContent) },
		}
	}

	if (message.type === "messageUpdated" && message.clineMessage) {
		return { ...message, clineMessage: omitOriginalContent(message.clineMessage) }
	}

	return message
}
