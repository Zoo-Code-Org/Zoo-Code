import { Anthropic } from "@anthropic-ai/sdk"

import type { ApiMessage } from "../task-persistence"

type Role = ApiMessage["role"]

/**
 * Custom error class for duplicate `tool_result` blocks that are dropped while shaping an
 * API request. Used for structured error tracking via PostHog so the root cause (the same
 * pending tool result being appended to history more than once) can be hunted down.
 */
export class DuplicateToolResultIdError extends Error {
	constructor(
		message: string,
		public readonly droppedToolUseIds: string[],
	) {
		super(message)
		this.name = "DuplicateToolResultIdError"
	}
}

export interface MergeConsecutiveApiMessagesResult {
	messages: ApiMessage[]
	/**
	 * One entry per dropped `tool_result` block, so the same `tool_use_id` appears once per
	 * duplicate that was removed (its length is the drop count). Empty when nothing was dropped.
	 */
	droppedDuplicateToolUseIds: string[]
}

function normalizeContentToBlocks(content: ApiMessage["content"]): Anthropic.Messages.ContentBlockParam[] {
	if (Array.isArray(content)) {
		return content as Anthropic.Messages.ContentBlockParam[]
	}
	if (content === undefined || content === null) {
		return []
	}
	return [{ type: "text", text: String(content) }]
}

/**
 * Removes `tool_result` blocks whose `tool_use_id` already appeared earlier in the same
 * content array. First occurrence wins, matching `validateAndFixToolResultIds()`.
 *
 * Providers reject a single user message that carries the same tool result id twice
 * (Bedrock: "The toolResult blocks at messages.N.content contain duplicate Ids: <id>"),
 * and merging consecutive user messages is where separately-legal messages first become
 * an illegal one. Non-`tool_result` blocks are never deduped.
 */
function dedupeToolResultBlocks(content: Anthropic.Messages.ContentBlockParam[]): {
	content: Anthropic.Messages.ContentBlockParam[]
	droppedToolUseIds: string[]
} {
	const seenToolUseIds = new Set<string>()
	const droppedToolUseIds: string[] = []

	const deduped = content.filter((block) => {
		if (block.type !== "tool_result") {
			return true
		}
		if (seenToolUseIds.has(block.tool_use_id)) {
			droppedToolUseIds.push(block.tool_use_id)
			return false
		}
		seenToolUseIds.add(block.tool_use_id)
		return true
	})

	return droppedToolUseIds.length > 0 ? { content: deduped, droppedToolUseIds } : { content, droppedToolUseIds }
}

/**
 * Non-destructively merges consecutive messages with the same role.
 *
 * Used for *API request shaping only* (do not use for storage), so rewind/edit operations
 * can still reference the original individual messages.
 *
 * Duplicate `tool_result` ids are dropped from merged content only; messages that are not
 * merged keep their content untouched.
 */
export function mergeConsecutiveApiMessages(
	messages: ApiMessage[],
	options?: { roles?: Role[] },
): MergeConsecutiveApiMessagesResult {
	if (messages.length <= 1) {
		return { messages, droppedDuplicateToolUseIds: [] }
	}

	const mergeRoles = new Set<Role>(options?.roles ?? ["user"]) // default: user only
	const out: ApiMessage[] = []
	const droppedDuplicateToolUseIds: string[] = []

	for (const msg of messages) {
		const prev = out[out.length - 1]
		const canMerge =
			prev &&
			prev.role === msg.role &&
			mergeRoles.has(msg.role) &&
			// Allow merging regular messages into a summary (API-only shaping),
			// but never merge a summary into something else.
			!msg.isSummary &&
			!prev.isTruncationMarker &&
			!msg.isTruncationMarker

		if (!canMerge) {
			out.push(msg)
			continue
		}

		const { content: mergedContent, droppedToolUseIds } = dedupeToolResultBlocks([
			...normalizeContentToBlocks(prev.content),
			...normalizeContentToBlocks(msg.content),
		])

		droppedDuplicateToolUseIds.push(...droppedToolUseIds)

		// Preserve the newest ts to keep chronological ordering for downstream logic.
		out[out.length - 1] = {
			...prev,
			content: mergedContent,
			ts: Math.max(prev.ts ?? 0, msg.ts ?? 0) || prev.ts || msg.ts,
		}
	}

	return { messages: out, droppedDuplicateToolUseIds }
}
