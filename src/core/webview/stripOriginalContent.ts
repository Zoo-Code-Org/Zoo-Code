import type { ClineMessage, ExtensionMessage } from "@roo-code/types"

// Keyed by message object; only the transformed text is cached (valid while the source text is unchanged), so
// metadata such as `isAnswered` and `partial` is always taken from the current message.
const cache = new WeakMap<ClineMessage, { source: string; strippedText: string | undefined }>()

const FILE_EDIT_TOOLS = new Set<unknown>(["editedExistingFile", "appliedDiff", "newFileCreated"])

function isToolMessage(message: ClineMessage): boolean {
	return (message.type === "ask" && message.ask === "tool") || (message.type === "say" && message.say === "tool")
}

/** Replaces a file-edit tool message's `originalContent` (the whole pre-edit file) with its length. */
export function omitOriginalContent(message: ClineMessage): ClineMessage {
	const text = message.text

	if (typeof text !== "string" || !isToolMessage(message) || !text.includes('"originalContent"')) {
		return message
	}

	let entry = cache.get(message)

	if (!entry || entry.source !== text) {
		entry = { source: text, strippedText: stripOriginalContentFromText(text) }
		cache.set(message, entry)
	}

	return entry.strippedText === undefined ? message : { ...message, text: entry.strippedText }
}

function stripOriginalContentFromText(text: string): string | undefined {
	try {
		const { originalContent, ...rest } = JSON.parse(text) as Record<string, unknown>

		// An empty original (new file) is free and still means "has an original" to the webview, so it stays.
		if (typeof originalContent === "string" && originalContent.length > 0) {
			return JSON.stringify({ ...rest, originalContentLength: originalContent.length })
		}
	} catch {
		// Not valid JSON (e.g. a truncated partial message): leave it untouched.
	}

	return undefined
}

/**
 * The `originalContent` of an approved file-edit tool message, or null when there is none. A pending, denied or
 * partial approval never discloses it, since the file has not been authorized for the webview yet. `ts` is not unique (two messages can be
 * created in the same millisecond), so `messageId` is preferred; `ts` only serves messages persisted without one.
 */
export function findOriginalContent(
	messages: ClineMessage[] | undefined,
	id: { messageId?: string; ts: number },
): string | null {
	const message = messages?.find(
		(m) => isToolMessage(m) && (id.messageId !== undefined ? m.messageId === id.messageId : m.ts === id.ts),
	)

	if (!message?.text || message.partial || (message.type === "ask" && message.isAnswered !== true)) {
		return null
	}

	try {
		const { tool, originalContent } = JSON.parse(message.text) as { tool?: unknown; originalContent?: unknown }
		return FILE_EDIT_TOOLS.has(tool) && typeof originalContent === "string" ? originalContent : null
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
