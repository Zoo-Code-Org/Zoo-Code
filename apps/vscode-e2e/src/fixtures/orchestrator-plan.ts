export type OrchestratorFanOutMode = "ask" | "architect" | "code"

export type OrchestratorFanOutChildStep = {
	readonly mode: OrchestratorFanOutMode
	readonly marker: string
	readonly prompt: string
	readonly summary: string
	readonly newTaskToolCallId: string
	readonly completionToolCallId: string
}

export type OrchestratorRepeatedDelegationRole = "requirements" | "design" | "implementation"

export type OrchestratorRepeatedDelegationChildStep = OrchestratorFanOutChildStep & {
	readonly round: number
	readonly role: OrchestratorRepeatedDelegationRole
}

export type OrchestratorResumeExpectation = {
	readonly stepIndex: number
	readonly requiredSummaries: string[]
	readonly nextMode?: OrchestratorFanOutMode
}

export const ORCHESTRATOR_FAN_OUT_MARKER = "ORCHESTRATOR_SINGLE_ROUND_FAN_OUT"
export const ORCHESTRATOR_FAN_OUT_RESULT_INJECTION = "completed.\\n\\nResult:"
export const ORCHESTRATOR_REPEATED_DELEGATION_MARKER = "ORCHESTRATOR_REPEATED_DELEGATION_STRESS"

export const ORCHESTRATOR_FAN_OUT_CHILD_STEPS: readonly OrchestratorFanOutChildStep[] = [
	{
		mode: "ask",
		marker: "ORCHESTRATOR_SINGLE_ROUND_REQUIREMENTS_CHILD",
		prompt: 'ORCHESTRATOR_SINGLE_ROUND_REQUIREMENTS_CHILD: Complete immediately with the exact result "Requirement summary: gather requirements for the reporting workflow."',
		summary: "Requirement summary: gather requirements for the reporting workflow.",
		newTaskToolCallId: "call_orchestrator_fan_out_parent_new_task_001",
		completionToolCallId: "call_orchestrator_fan_out_requirements_completion_001",
	},
	{
		mode: "architect",
		marker: "ORCHESTRATOR_SINGLE_ROUND_DESIGN_CHILD",
		prompt: 'ORCHESTRATOR_SINGLE_ROUND_DESIGN_CHILD: Complete immediately with the exact result "Design summary: outline a minimal fan-in architecture."',
		summary: "Design summary: outline a minimal fan-in architecture.",
		newTaskToolCallId: "call_orchestrator_fan_out_parent_new_task_002",
		completionToolCallId: "call_orchestrator_fan_out_design_completion_001",
	},
	{
		mode: "code",
		marker: "ORCHESTRATOR_SINGLE_ROUND_IMPLEMENTATION_CHILD",
		prompt: 'ORCHESTRATOR_SINGLE_ROUND_IMPLEMENTATION_CHILD: Complete immediately with the exact result "Implementation summary: implement the delegated workflow skeleton."',
		summary: "Implementation summary: implement the delegated workflow skeleton.",
		newTaskToolCallId: "call_orchestrator_fan_out_parent_new_task_003",
		completionToolCallId: "call_orchestrator_fan_out_implementation_completion_001",
	},
]

export const ORCHESTRATOR_FAN_OUT_PARENT_PROMPT = `${ORCHESTRATOR_FAN_OUT_MARKER}: Delegate exactly three children in order. First create an ask-mode child with this exact message: "${ORCHESTRATOR_FAN_OUT_CHILD_STEPS[0]!.prompt}". After it returns, create an architect-mode child with this exact message: "${ORCHESTRATOR_FAN_OUT_CHILD_STEPS[1]!.prompt}". After it returns, create a code-mode child with this exact message: "${ORCHESTRATOR_FAN_OUT_CHILD_STEPS[2]!.prompt}". After all three return, complete with the final fan-in summary containing every child summary.`

export const ORCHESTRATOR_FAN_OUT_FINAL_RESULT = `Orchestrator fan-in complete:\n- ${ORCHESTRATOR_FAN_OUT_CHILD_STEPS[0]!.summary}\n- ${ORCHESTRATOR_FAN_OUT_CHILD_STEPS[1]!.summary}\n- ${ORCHESTRATOR_FAN_OUT_CHILD_STEPS[2]!.summary}`

const ORCHESTRATOR_REPEATED_DELEGATION_ROLES: ReadonlyArray<{
	readonly role: OrchestratorRepeatedDelegationRole
	readonly mode: OrchestratorFanOutMode
	readonly summaryByRound: readonly [string, string, string]
}> = [
	{
		role: "requirements",
		mode: "ask",
		summaryByRound: [
			"capture reporting workflow constraints.",
			"confirm dashboard stakeholder needs.",
			"verify rollout acceptance criteria.",
		],
	},
	{
		role: "design",
		mode: "architect",
		summaryByRound: [
			"outline fan-in checkpoints.",
			"refine retry-safe orchestration boundaries.",
			"document final aggregation shape.",
		],
	},
	{
		role: "implementation",
		mode: "code",
		summaryByRound: [
			"stub delegated workflow shell.",
			"wire summary collection fixtures.",
			"validate repeated delegation convergence.",
		],
	},
]

export const ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS: readonly OrchestratorRepeatedDelegationChildStep[] = (
	[1, 2, 3] as const
).flatMap((round, roundIndex) =>
	ORCHESTRATOR_REPEATED_DELEGATION_ROLES.map(({ role, mode, summaryByRound }, roleIndex) => {
		const summary = `Round ${round} ${role} summary: ${summaryByRound[roundIndex]!}`
		const marker = `ORCHESTRATOR_REPEATED_ROUND_${round}_${role.toUpperCase()}_CHILD`

		return {
			round,
			role,
			mode,
			marker,
			prompt: `${marker}: Complete immediately with the exact result "${summary}"`,
			summary,
			newTaskToolCallId: `call_orchestrator_repeated_parent_new_task_${String((round - 1) * 3 + roleIndex + 1).padStart(3, "0")}`,
			completionToolCallId: `call_orchestrator_repeated_${role}_round_${round}_completion_001`,
		}
	}),
)

export const ORCHESTRATOR_REPEATED_DELEGATION_PARENT_PROMPT = `${ORCHESTRATOR_REPEATED_DELEGATION_MARKER}: Run exactly three rounds. In each round, delegate exactly three children in order: ask-mode requirements, architect-mode design, then code-mode implementation. Use these exact child messages in order: ${ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS.map(({ prompt }) => `"${prompt}"`).join("; ")}. After each child returns, resume the parent before creating the next child. After all nine children return, complete with a final summary containing every round and child summary.`

export const ORCHESTRATOR_REPEATED_DELEGATION_FINAL_RESULT = `Orchestrator repeated delegation complete:\n${ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS.map(({ round, role, summary }) => `- Round ${round} ${role}: ${summary}`).join("\\n")}`

function buildResumeExpectations(steps: readonly OrchestratorFanOutChildStep[]): OrchestratorResumeExpectation[] {
	return steps.map((_step, index) => ({
		stepIndex: index + 1,
		requiredSummaries: steps.slice(0, index + 1).map(({ summary }) => summary),
		nextMode: steps[index + 1]?.mode,
	}))
}

export function buildOrchestratorResumeExpectations(): OrchestratorResumeExpectation[] {
	return buildResumeExpectations(ORCHESTRATOR_FAN_OUT_CHILD_STEPS)
}

export function buildOrchestratorRepeatedResumeExpectations(): OrchestratorResumeExpectation[] {
	return buildResumeExpectations(ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS)
}

export function shouldMatchOrchestratorChildRequest(rawRequest: string, childMarker: string): boolean {
	return (
		rawRequest.includes(childMarker) &&
		!rawRequest.includes(ORCHESTRATOR_FAN_OUT_MARKER) &&
		!rawRequest.includes(ORCHESTRATOR_REPEATED_DELEGATION_MARKER)
	)
}

export function shouldMatchOrchestratorResumeRequest(
	rawRequest: string,
	requiredSummaries: readonly string[],
): boolean {
	return (
		rawRequest.includes(ORCHESTRATOR_FAN_OUT_MARKER) &&
		rawRequest.includes(ORCHESTRATOR_FAN_OUT_RESULT_INJECTION) &&
		requiredSummaries.every((summary) => rawRequest.includes(`Result:\\n${summary}`))
	)
}

export function shouldMatchOrchestratorRepeatedResumeRequest(
	rawRequest: string,
	requiredSummaries: readonly string[],
): boolean {
	return (
		rawRequest.includes(ORCHESTRATOR_REPEATED_DELEGATION_MARKER) &&
		rawRequest.includes(ORCHESTRATOR_FAN_OUT_RESULT_INJECTION) &&
		requiredSummaries.every((summary) => rawRequest.includes(`Result:\\n${summary}`))
	)
}
