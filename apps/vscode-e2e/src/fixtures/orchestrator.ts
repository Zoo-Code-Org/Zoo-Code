import { LLMock } from "@copilotkit/aimock"
import type { ChatCompletionRequest } from "@copilotkit/aimock"

import {
	ORCHESTRATOR_FAN_OUT_CHILD_STEPS,
	ORCHESTRATOR_FAN_OUT_FINAL_RESULT,
	ORCHESTRATOR_FAN_OUT_MARKER,
	ORCHESTRATOR_FAN_OUT_PARENT_PROMPT,
	ORCHESTRATOR_FAN_OUT_RESULT_INJECTION,
	ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT,
	ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP,
	ORCHESTRATOR_NESTED_DELEGATION_FINAL_RESULT,
	ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS,
	ORCHESTRATOR_NESTED_DELEGATION_MARKER,
	ORCHESTRATOR_NESTED_DELEGATION_PARENT_PROMPT,
	ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS,
	ORCHESTRATOR_REPEATED_DELEGATION_FINAL_RESULT,
	ORCHESTRATOR_REPEATED_DELEGATION_MARKER,
	ORCHESTRATOR_REPEATED_DELEGATION_PARENT_PROMPT,
	buildOrchestratorNestedChildResumeExpectations,
	buildOrchestratorNestedParentResumeExpectations,
	buildOrchestratorRepeatedResumeExpectations,
	buildOrchestratorResumeExpectations,
	shouldMatchOrchestratorChildRequest,
	shouldMatchOrchestratorNestedChildResumeRequest,
	shouldMatchOrchestratorNestedParentResumeRequest,
	shouldMatchOrchestratorRepeatedResumeRequest,
	shouldMatchOrchestratorResumeRequest,
} from "./orchestrator-plan"

export {
	ORCHESTRATOR_FAN_OUT_CHILD_STEPS,
	ORCHESTRATOR_FAN_OUT_FINAL_RESULT,
	ORCHESTRATOR_FAN_OUT_MARKER,
	ORCHESTRATOR_FAN_OUT_PARENT_PROMPT,
	ORCHESTRATOR_FAN_OUT_RESULT_INJECTION,
	ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT,
	ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP,
	ORCHESTRATOR_NESTED_DELEGATION_FINAL_RESULT,
	ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS,
	ORCHESTRATOR_NESTED_DELEGATION_MARKER,
	ORCHESTRATOR_NESTED_DELEGATION_PARENT_PROMPT,
	ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS,
	ORCHESTRATOR_REPEATED_DELEGATION_FINAL_RESULT,
	ORCHESTRATOR_REPEATED_DELEGATION_MARKER,
	ORCHESTRATOR_REPEATED_DELEGATION_PARENT_PROMPT,
	buildOrchestratorNestedChildResumeExpectations,
	buildOrchestratorNestedParentResumeExpectations,
	buildOrchestratorRepeatedResumeExpectations,
	buildOrchestratorResumeExpectations,
	shouldMatchOrchestratorChildRequest,
	shouldMatchOrchestratorNestedChildResumeRequest,
	shouldMatchOrchestratorNestedParentResumeRequest,
	shouldMatchOrchestratorRepeatedResumeRequest,
	shouldMatchOrchestratorResumeRequest,
}

const requestText = (req: ChatCompletionRequest) => JSON.stringify(req)

export function addOrchestratorFixtures(mock: InstanceType<typeof LLMock>) {
	const firstFanOutStep = ORCHESTRATOR_FAN_OUT_CHILD_STEPS[0]!
	const firstRepeatedStep = ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS[0]!
	const firstNestedGrandchildStep = ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS[0]!

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
						mode: firstFanOutStep.mode,
						message: firstFanOutStep.prompt,
					}),
					id: firstFanOutStep.newTaskToolCallId,
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
	mock.addFixture({
		match: {
			userMessage: new RegExp(ORCHESTRATOR_REPEATED_DELEGATION_MARKER),
			sequenceIndex: 0,
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: firstRepeatedStep.mode,
						message: firstRepeatedStep.prompt,
					}),
					id: firstRepeatedStep.newTaskToolCallId,
				},
			],
		},
	})

	for (const step of ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS) {
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

	for (const expectation of [...buildOrchestratorRepeatedResumeExpectations()].reverse()) {
		const nextStep = ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS[expectation.stepIndex]

		mock.addFixture({
			match: {
				predicate: (req: ChatCompletionRequest) =>
					shouldMatchOrchestratorRepeatedResumeRequest(requestText(req), expectation.requiredSummaries),
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
								arguments: JSON.stringify({ result: ORCHESTRATOR_REPEATED_DELEGATION_FINAL_RESULT }),
								id: "call_orchestrator_repeated_parent_completion_010",
							},
						],
			},
		})
	}

	mock.addFixture({
		match: {
			userMessage: new RegExp(ORCHESTRATOR_NESTED_DELEGATION_MARKER),
			sequenceIndex: 0,
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP.mode,
						message: ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP.prompt,
					}),
					id: ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP.newTaskToolCallId,
				},
			],
		},
	})

	mock.addFixture({
		match: {
			userMessage: new RegExp(ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP.marker),
			sequenceIndex: 0,
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: firstNestedGrandchildStep.mode,
						message: firstNestedGrandchildStep.prompt,
					}),
					id: firstNestedGrandchildStep.newTaskToolCallId,
				},
			],
		},
	})

	for (const step of ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS) {
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

	for (const expectation of [...buildOrchestratorNestedChildResumeExpectations()].reverse()) {
		const nextStep = ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS[expectation.stepIndex]

		mock.addFixture({
			match: {
				predicate: (req: ChatCompletionRequest) =>
					shouldMatchOrchestratorNestedChildResumeRequest(requestText(req), expectation.requiredSummaries),
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
								arguments: JSON.stringify({
									result: ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT,
								}),
								id: ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP.completionToolCallId,
							},
						],
			},
		})
	}

	for (const expectation of [...buildOrchestratorNestedParentResumeExpectations()].reverse()) {
		mock.addFixture({
			match: {
				predicate: (req: ChatCompletionRequest) =>
					shouldMatchOrchestratorNestedParentResumeRequest(requestText(req), expectation.requiredSummaries),
			},
			response: {
				toolCalls: [
					{
						name: "attempt_completion",
						arguments: JSON.stringify({ result: ORCHESTRATOR_NESTED_DELEGATION_FINAL_RESULT }),
						id: "call_orchestrator_nested_parent_completion_002",
					},
				],
			},
		})
	}
}
