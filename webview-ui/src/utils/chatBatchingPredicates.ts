interface BatchableMessage {
	type?: string
	say?: string
	text?: string
}

const isToolRecord = (value: unknown): value is { tool: string } =>
	typeof value === "object" && value !== null && typeof (value as { tool?: unknown }).tool === "string"

/**
 * Tool name carried by a say-tool row's JSON text. Partial or non-JSON payloads
 * carry no tool field, so they never match.
 */
const parseToolName = (text?: string): string | undefined => {
	if (!text) {
		return undefined
	}
	try {
		const parsed: unknown = JSON.parse(text)
		return isToolRecord(parsed) ? parsed.tool : undefined
	} catch {
		return undefined
	}
}

/**
 * Messages that can be safely skipped over when batching tool asks.
 * These are low-information or invisible messages that don't affect semantics.
 */
export const isIgnorableBetweenTargets = (msg: BatchableMessage, batchContext?: BatchableMessage): boolean => {
	if (msg.type !== "say") return false
	return (
		msg.say === "api_req_started" ||
		(msg.say === "text" &&
			(!msg.text?.trim() ||
				(batchContext?.type === "say" &&
					batchContext.say === "text" &&
					!!batchContext.text?.trim() &&
					msg.text === batchContext.text))) ||
		msg.say === "reasoning"
	)
}

/**
 * Semantic boundaries that stop batching. When batching hits one of these,
 * the current batch is finalized and the boundary message is preserved as-is.
 */
export const isBoundary = (msg: BatchableMessage): boolean => {
	if (msg.type !== "say") return false
	return (
		msg.say === "user_feedback" ||
		msg.say === "user_feedback_diff" ||
		(msg.say === "text" && !!msg.text?.trim()) ||
		msg.say === "completion_result" ||
		msg.say === "checkpoint_saved" ||
		msg.say === "error" ||
		msg.say === "condense_context" ||
		msg.say === "codebase_search_result" ||
		// The parallel-subtasks panel (design D9) is a say "tool" row whose
		// JSON text carries { tool: "parallelSubtasks" }. It renders live child
		// state, so merging it into an adjacent tool-ask batch would freeze the
		// panel; treat it as a semantic boundary. The parsed tool field is the
		// identity test, so unrelated rows that merely contain the literal do not
		// match (F-12).
		(msg.say === "tool" && parseToolName(msg.text) === "parallelSubtasks")
	)
}
