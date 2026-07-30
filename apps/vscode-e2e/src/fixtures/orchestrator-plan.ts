export type OrchestratorFanOutMode = "ask" | "architect" | "code"

export type OrchestratorFanOutChildStep = {
	readonly mode: OrchestratorFanOutMode
	readonly marker: string
	readonly prompt: string
	readonly summary: string
	readonly newTaskToolCallId: string
	readonly completionToolCallId: string
}

export type OrchestratorResumeExpectation = {
	readonly stepIndex: number
	readonly requiredSummaries: string[]
	readonly nextMode?: OrchestratorFanOutMode
}

export const ORCHESTRATOR_FAN_OUT_MARKER = "ORCHESTRATOR_SINGLE_ROUND_FAN_OUT"
export const ORCHESTRATOR_FAN_OUT_RESULT_INJECTION = "completed.\\n\\nResult:"

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

export const ORCHESTRATOR_FAN_OUT_PARENT_PROMPT = `${ORCHESTRATOR_FAN_OUT_MARKER}: Delegate exactly three children in order. First create an ask-mode child with this exact message: "${ORCHESTRATOR_FAN_OUT_CHILD_STEPS[0].prompt}". After it returns, create an architect-mode child with this exact message: "${ORCHESTRATOR_FAN_OUT_CHILD_STEPS[1].prompt}". After it returns, create a code-mode child with this exact message: "${ORCHESTRATOR_FAN_OUT_CHILD_STEPS[2].prompt}". After all three return, complete with the final fan-in summary containing every child summary.`

export const ORCHESTRATOR_FAN_OUT_FINAL_RESULT = `Orchestrator fan-in complete:\n- ${ORCHESTRATOR_FAN_OUT_CHILD_STEPS[0].summary}\n- ${ORCHESTRATOR_FAN_OUT_CHILD_STEPS[1].summary}\n- ${ORCHESTRATOR_FAN_OUT_CHILD_STEPS[2].summary}`

export function buildOrchestratorResumeExpectations(): OrchestratorResumeExpectation[] {
	return ORCHESTRATOR_FAN_OUT_CHILD_STEPS.map((_step, index) => ({
		stepIndex: index + 1,
		requiredSummaries: ORCHESTRATOR_FAN_OUT_CHILD_STEPS.slice(0, index + 1).map(({ summary }) => summary),
		nextMode: ORCHESTRATOR_FAN_OUT_CHILD_STEPS[index + 1]?.mode,
	}))
}

export function shouldMatchOrchestratorChildRequest(rawRequest: string, childMarker: string): boolean {
	return rawRequest.includes(childMarker) && !rawRequest.includes(ORCHESTRATOR_FAN_OUT_MARKER)
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
