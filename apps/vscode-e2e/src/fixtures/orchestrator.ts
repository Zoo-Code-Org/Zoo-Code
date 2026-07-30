import { LLMock } from "@copilotkit/aimock"
import type { ChatCompletionRequest } from "@copilotkit/aimock"

export * from "./orchestrator-plan"

import {
	ORCHESTRATOR_CANCELLATION_RECOVERY_CHILD_STEP,
	ORCHESTRATOR_CANCELLATION_RECOVERY_FINAL_RESULT,
	ORCHESTRATOR_CANCELLATION_RECOVERY_FOLLOWUP_TOOL_CALL_ID,
	ORCHESTRATOR_CANCELLATION_RECOVERY_MARKER,
	ORCHESTRATOR_FAN_OUT_CHILD_STEPS,
	ORCHESTRATOR_FAN_OUT_FINAL_RESULT,
	ORCHESTRATOR_FAN_OUT_MARKER,
	ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT,
	ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP,
	ORCHESTRATOR_NESTED_DELEGATION_FINAL_RESULT,
	ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS,
	ORCHESTRATOR_NESTED_DELEGATION_MARKER,
	ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS,
	ORCHESTRATOR_REPEATED_DELEGATION_FINAL_RESULT,
	ORCHESTRATOR_REPEATED_DELEGATION_MARKER,
	buildOrchestratorCancellationRecoveryResumeExpectations,
	buildOrchestratorNestedChildResumeExpectations,
	buildOrchestratorNestedParentResumeExpectations,
	buildOrchestratorRepeatedResumeExpectations,
	buildOrchestratorResumeExpectations,
	shouldMatchOrchestratorCancellationChildCompletionRequest,
	shouldMatchOrchestratorCancellationChildRequest,
	shouldMatchOrchestratorCancellationRecoveryResumeRequest,
	shouldMatchOrchestratorChildRequest,
	shouldMatchOrchestratorNestedChildResumeRequest,
	shouldMatchOrchestratorNestedParentResumeRequest,
	shouldMatchOrchestratorRepeatedResumeRequest,
	shouldMatchOrchestratorResumeRequest,
} from "./orchestrator-plan"

const requestText = (req: ChatCompletionRequest) => JSON.stringify(req)

function addChildCompletionFixtures(
	mock: InstanceType<typeof LLMock>,
	steps: readonly { marker: string; summary: string; completionToolCallId: string }[],
) {
	for (const step of steps) {
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
}

function addResumeFixtures(
	mock: InstanceType<typeof LLMock>,
	config: {
		expectations: readonly { stepIndex: number; requiredSummaries: readonly string[] }[]
		steps: readonly { mode: string; prompt: string; newTaskToolCallId: string }[]
		matches: (rawRequest: string, requiredSummaries: readonly string[]) => boolean
		finalResult: string
		finalToolCallId: string
	},
) {
	// Register most-cumulative expectations first so less-specific predicates cannot shadow later rounds.
	for (const expectation of [...config.expectations].reverse()) {
		const nextStep = config.steps[expectation.stepIndex]

		mock.addFixture({
			match: {
				predicate: (req: ChatCompletionRequest) =>
					config.matches(requestText(req), expectation.requiredSummaries),
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
								arguments: JSON.stringify({ result: config.finalResult }),
								id: config.finalToolCallId,
							},
						],
			},
		})
	}
}

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

	addChildCompletionFixtures(mock, ORCHESTRATOR_FAN_OUT_CHILD_STEPS)
	addResumeFixtures(mock, {
		expectations: buildOrchestratorResumeExpectations(),
		steps: ORCHESTRATOR_FAN_OUT_CHILD_STEPS,
		matches: shouldMatchOrchestratorResumeRequest,
		finalResult: ORCHESTRATOR_FAN_OUT_FINAL_RESULT,
		finalToolCallId: "call_orchestrator_fan_out_parent_completion_004",
	})
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

	addChildCompletionFixtures(mock, ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS)
	addResumeFixtures(mock, {
		expectations: buildOrchestratorRepeatedResumeExpectations(),
		steps: ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS,
		matches: shouldMatchOrchestratorRepeatedResumeRequest,
		finalResult: ORCHESTRATOR_REPEATED_DELEGATION_FINAL_RESULT,
		finalToolCallId: "call_orchestrator_repeated_parent_completion_010",
	})

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

	addChildCompletionFixtures(mock, ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS)
	addResumeFixtures(mock, {
		expectations: buildOrchestratorNestedChildResumeExpectations(),
		steps: ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS,
		matches: shouldMatchOrchestratorNestedChildResumeRequest,
		finalResult: ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT,
		finalToolCallId: ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP.completionToolCallId,
	})
	addResumeFixtures(mock, {
		expectations: buildOrchestratorNestedParentResumeExpectations(),
		steps: [],
		matches: shouldMatchOrchestratorNestedParentResumeRequest,
		finalResult: ORCHESTRATOR_NESTED_DELEGATION_FINAL_RESULT,
		finalToolCallId: "call_orchestrator_nested_parent_completion_002",
	})

	mock.addFixture({
		match: {
			userMessage: new RegExp(ORCHESTRATOR_CANCELLATION_RECOVERY_MARKER),
			sequenceIndex: 0,
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: ORCHESTRATOR_CANCELLATION_RECOVERY_CHILD_STEP.mode,
						message: ORCHESTRATOR_CANCELLATION_RECOVERY_CHILD_STEP.prompt,
					}),
					id: ORCHESTRATOR_CANCELLATION_RECOVERY_CHILD_STEP.newTaskToolCallId,
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				shouldMatchOrchestratorCancellationChildRequest(requestText(req)),
		},
		response: {
			toolCalls: [
				{
					name: "ask_followup_question",
					arguments: JSON.stringify({
						question: `Type "${ORCHESTRATOR_CANCELLATION_RECOVERY_CHILD_STEP.followupAnswer}" to recover the cancelled child.`,
						follow_up: [{ text: ORCHESTRATOR_CANCELLATION_RECOVERY_CHILD_STEP.followupAnswer }],
					}),
					id: ORCHESTRATOR_CANCELLATION_RECOVERY_FOLLOWUP_TOOL_CALL_ID,
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				shouldMatchOrchestratorCancellationChildCompletionRequest(requestText(req)),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: ORCHESTRATOR_CANCELLATION_RECOVERY_CHILD_STEP.summary }),
					id: ORCHESTRATOR_CANCELLATION_RECOVERY_CHILD_STEP.completionToolCallId,
				},
			],
		},
	})

	addResumeFixtures(mock, {
		expectations: buildOrchestratorCancellationRecoveryResumeExpectations(),
		steps: [],
		matches: shouldMatchOrchestratorCancellationRecoveryResumeRequest,
		finalResult: ORCHESTRATOR_CANCELLATION_RECOVERY_FINAL_RESULT,
		finalToolCallId: "call_orchestrator_cancellation_parent_completion_002",
	})
}
