import { LLMock } from "@copilotkit/aimock"
import type { ChatCompletionRequest } from "@copilotkit/aimock"

import {
	ORCHESTRATOR_FAN_OUT_CHILD_STEPS,
	ORCHESTRATOR_FAN_OUT_FINAL_RESULT,
	ORCHESTRATOR_FAN_OUT_MARKER,
	ORCHESTRATOR_FAN_OUT_PARENT_PROMPT,
	ORCHESTRATOR_FAN_OUT_RESULT_INJECTION,
	buildOrchestratorResumeExpectations,
	shouldMatchOrchestratorChildRequest,
	shouldMatchOrchestratorResumeRequest,
} from "./orchestrator-plan"

export {
	ORCHESTRATOR_FAN_OUT_CHILD_STEPS,
	ORCHESTRATOR_FAN_OUT_FINAL_RESULT,
	ORCHESTRATOR_FAN_OUT_MARKER,
	ORCHESTRATOR_FAN_OUT_PARENT_PROMPT,
	ORCHESTRATOR_FAN_OUT_RESULT_INJECTION,
	buildOrchestratorResumeExpectations,
	shouldMatchOrchestratorChildRequest,
	shouldMatchOrchestratorResumeRequest,
}

const requestText = (req: ChatCompletionRequest) => JSON.stringify(req)

export function addOrchestratorFixtures(mock: InstanceType<typeof LLMock>) {
	mock.addFixture({
		match: {
			userMessage: new RegExp(ORCHESTRATOR_FAN_OUT_MARKER),
			sequenceIndex: 0,
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: ORCHESTRATOR_FAN_OUT_CHILD_STEPS[0].mode,
						message: ORCHESTRATOR_FAN_OUT_CHILD_STEPS[0].prompt,
					}),
					id: ORCHESTRATOR_FAN_OUT_CHILD_STEPS[0].newTaskToolCallId,
				},
			],
		},
	})

	for (const step of ORCHESTRATOR_FAN_OUT_CHILD_STEPS) {
		mock.addFixture({
			match: {
				predicate: (req: ChatCompletionRequest) =>
					shouldMatchOrchestratorChildRequest(requestText(req), step.marker),
			},
			response: {
				toolCalls: [
					{
						name: "attempt_completion",
						arguments: JSON.stringify({ result: step.summary }),
						id: step.completionToolCallId,
					},
				],
			},
		})
	}

	for (const expectation of [...buildOrchestratorResumeExpectations()].reverse()) {
		const nextStep = ORCHESTRATOR_FAN_OUT_CHILD_STEPS[expectation.stepIndex]

		mock.addFixture({
			match: {
				predicate: (req: ChatCompletionRequest) =>
					shouldMatchOrchestratorResumeRequest(requestText(req), expectation.requiredSummaries),
			},
			response: {
				toolCalls: nextStep
					? [
							{
								name: "new_task",
								arguments: JSON.stringify({
									mode: nextStep.mode,
									message: nextStep.prompt,
								}),
								id: nextStep.newTaskToolCallId,
							},
						]
					: [
							{
								name: "attempt_completion",
								arguments: JSON.stringify({ result: ORCHESTRATOR_FAN_OUT_FINAL_RESULT }),
								id: "call_orchestrator_fan_out_parent_completion_004",
							},
						],
			},
		})
	}
}
