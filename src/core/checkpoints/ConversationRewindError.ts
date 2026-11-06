/**
 * The files were put back to the checkpoint, but the conversation could not be rewound to it (the messages could not be
 * saved, and were left as they were). The task is started again from what is saved, so the workspace and the task are
 * not left apart with the task stopped; the caller still has to tell the user, and may keep an edit for it.
 */
export class ConversationRewindError extends Error {
	constructor(override readonly cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause))
		this.name = "ConversationRewindError"
	}
}
