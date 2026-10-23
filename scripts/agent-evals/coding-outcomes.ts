import type { AgentExecutionCode } from "./trace.ts"
import type { GraderVerdict } from "./coding-grader.ts"

export type CodingRunOutcome = "correct" | "incorrect" | "timed-out" | "grading-failure" | "infrastructure-failure"

export interface OutcomeInput {
	hasTrace: boolean
	executionCode?: AgentExecutionCode
	finalWorkspaceAvailable: boolean
	grading?: Pick<GraderVerdict, "kind"> & { reason?: string }
}

export interface ClassifiedOutcome {
	outcome: CodingRunOutcome
	reason: string
}

const INFRASTRUCTURE_CODES: readonly AgentExecutionCode[] = [
	"SETUP_FAILED",
	"ACTIVATION_FAILED",
	"TASK_START_FAILED",
	"SESSION_LOST",
]

// Outcome rules, in order:
// - A missing trace is infrastructure failure. Nothing about the task ran.
// - Setup, activation, start, and session-loss codes are infrastructure
//   failure. VS Code, IPC, or the provider failed; the agent did not.
// - A run-window expiry is timed out. The agent hit an execution limit.
// - COMPLETED and STOPPED runs are graded. The hidden tests decide:
//   passed is correct, failed is incorrect, including when the agent
//   reported completion.
// - A grader that hung, crashed, or hit its limits is grading failure and is
//   never counted as incorrect.
export function classifyRunOutcome(input: OutcomeInput): ClassifiedOutcome {
	if (!input.hasTrace) return { outcome: "infrastructure-failure", reason: "runTraceMissing" }
	const code = input.executionCode
	if (code && INFRASTRUCTURE_CODES.includes(code))
		return { outcome: "infrastructure-failure", reason: `execution-${code}` }
	if (code === "TASK_RUN_TIMEOUT") return { outcome: "timed-out", reason: "agentHitRunLimit" }
	if (code !== "COMPLETED" && code !== "STOPPED")
		return { outcome: "infrastructure-failure", reason: `execution-${code ?? "unknown"}` }
	if (!input.finalWorkspaceAvailable)
		return { outcome: "infrastructure-failure", reason: "finalWorkspaceUnavailable" }
	if (!input.grading) return { outcome: "infrastructure-failure", reason: "graderNotRun" }
	switch (input.grading.kind) {
		case "passed":
			return { outcome: "correct", reason: "hiddenTestsPassed" }
		case "failed":
			return { outcome: "incorrect", reason: "hiddenTestsFailed" }
		case "grading-failure":
			return { outcome: "grading-failure", reason: input.grading.reason ?? "gradingFailure" }
	}
}
