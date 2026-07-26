export type AutonomousTerminalState =
	| "completed"
	| "needs_input"
	| "provider_failed"
	| "tool_failed"
	| "cancelled"
	| "timed_out"
	| "configuration_error"
	| "crashed"

export const AUTONOMOUS_EXIT_CODES: Record<AutonomousTerminalState, number> = {
	completed: 0,
	needs_input: 2,
	provider_failed: 4,
	tool_failed: 5,
	cancelled: 6,
	timed_out: 124,
	configuration_error: 78,
	crashed: 70,
}

export class AutonomousRunError extends Error {
	constructor(
		public readonly state: Exclude<AutonomousTerminalState, "completed">,
		message: string,
	) {
		super(message)
		this.name = "AutonomousRunError"
	}
}

export interface TaskRunResult {
	rootTaskId: string
	result?: string
}
