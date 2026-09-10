interface BatchableMessage {
	type?: string
	say?: string
	text?: string
}

/**
 * Messages that can be safely skipped over when batching tool asks.
 * These are low-information or invisible messages that don't affect semantics.
 */
export const isIgnorableBetweenTargets = (msg: BatchableMessage): boolean => {
	if (msg.type !== "say") return false
	return msg.say === "api_req_started" || (msg.say === "text" && !msg.text?.trim()) || msg.say === "reasoning"
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
		msg.say === "codebase_search_result"
	)
}
