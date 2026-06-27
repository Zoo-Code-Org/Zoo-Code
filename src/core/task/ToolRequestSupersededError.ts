/**
 * Abort reason given to tool-owned controllers when a failed stream is retried.
 * The retry resets the turn state, so a tool from the failed attempt must not
 * publish anything: tools check `signal.reason` for this class and return
 * without a result, an error bubble or a failure flag.
 *
 * Kept in its own module so tools can import it without a runtime dependency
 * on `Task.ts` (which imports the tools through the presenter).
 */
export class ToolRequestSupersededError extends Error {
	constructor() {
		super("Tool request superseded by a stream retry")
		this.name = "ToolRequestSupersededError"
	}
}
