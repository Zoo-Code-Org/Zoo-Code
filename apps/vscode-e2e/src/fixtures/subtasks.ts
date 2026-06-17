import { LLMock } from "@copilotkit/aimock"
import type { ChatCompletionRequest } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

const SUBTASK_PARENT_MARKER = "SUBTASK_PARENT_CANCELLATION_SMOKE"
const SUBTASK_CHILD_MARKER = "SUBTASK_CHILD_CALCULATOR_SMOKE"
const SUBTASK_FAST_PARENT_MARKER = "SUBTASK_PARENT_IMMEDIATE_COMPLETION"
const SUBTASK_FAST_CHILD_MARKER = "SUBTASK_CHILD_IMMEDIATE_COMPLETION"
const SUBTASK_XPROFILE_PARENT_MARKER = "SUBTASK_PARENT_CROSS_PROFILE"
const SUBTASK_XPROFILE_SAME_CHILD_MARKER = "SUBTASK_CHILD_SAME_PROFILE"
const SUBTASK_XPROFILE_DIFFERENT_CHILD_MARKER = "SUBTASK_CHILD_DIFFERENT_PROFILE"

const SUBTASK_CHILD_PROMPT = `${SUBTASK_CHILD_MARKER}: Ask the user exactly this follow-up question: What is the square root of 81? After the user answers, complete with only the answer.`
export const SUBTASK_PARENT_PROMPT = `${SUBTASK_PARENT_MARKER}: Use the new_task tool exactly once. Create an ask-mode subtask with this exact message: "${SUBTASK_CHILD_PROMPT}" Do not answer directly.`
export const SUBTASK_CHILD_FOLLOWUP_ANSWER = "9"
const SUBTASK_FAST_CHILD_PROMPT = `${SUBTASK_FAST_CHILD_MARKER}: Complete immediately with the exact result "Fast child completed".`
export const SUBTASK_FAST_PARENT_PROMPT = `${SUBTASK_FAST_PARENT_MARKER}: Use the new_task tool exactly once. Create an ask-mode subtask with this exact message: "${SUBTASK_FAST_CHILD_PROMPT}" Do not answer directly.`

const SUBTASK_XPROFILE_SAME_CHILD_PROMPT = `${SUBTASK_XPROFILE_SAME_CHILD_MARKER}: Complete immediately with the exact result "Same-profile child completed".`
const SUBTASK_XPROFILE_DIFFERENT_CHILD_PROMPT = `${SUBTASK_XPROFILE_DIFFERENT_CHILD_MARKER}: Complete immediately with the exact result "Different-profile child completed".`
export const SUBTASK_XPROFILE_PARENT_PROMPT = `${SUBTASK_XPROFILE_PARENT_MARKER}: First use new_task to create a code-mode subtask with this exact message: "${SUBTASK_XPROFILE_SAME_CHILD_PROMPT}" After it returns, create an ask-mode subtask with the next instructions you receive.`
export const SUBTASK_XPROFILE_SAME_CHILD_RESULT = "Same-profile child completed"
export const SUBTASK_XPROFILE_DIFFERENT_CHILD_RESULT = "Different-profile child completed"
export const SUBTASK_XPROFILE_PARENT_RESULT = "Sequential cross-profile parent resumed"

const requestContains = (req: ChatCompletionRequest, expected: string[]) => {
	const rawRequest = JSON.stringify(req)
	return expected.every((text) => rawRequest.includes(text))
}

const completionAfterAnswer = (followupId: string, completionId: string) => ({
	match: {
		predicate: (req: ChatCompletionRequest) =>
			// Preferred: structured tool-result message carries the followup answer.
			toolResultContains(req, followupId, [SUBTASK_CHILD_FOLLOWUP_ANSWER]) ||
			// Fallback 1: answer present alongside the tool-call ID but not in a role:tool message.
			requestContains(req, [followupId, SUBTASK_CHILD_FOLLOWUP_ANSWER]) ||
			// Fallback 2: answer arrives as a bare user message after task resume (no tool-call ID context).
			requestContains(req, [
				SUBTASK_CHILD_MARKER,
				`<user_message>\\n${SUBTASK_CHILD_FOLLOWUP_ANSWER}\\n</user_message>`,
			]),
	},
	response: {
		toolCalls: [
			{
				name: "attempt_completion",
				arguments: JSON.stringify({ result: "9" }),
				id: completionId,
			},
		],
	},
})

export function addSubtaskFixtures(mock: InstanceType<typeof LLMock>) {
	mock.addFixture({
		match: {
			userMessage: new RegExp(SUBTASK_FAST_PARENT_MARKER),
			sequenceIndex: 0,
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: "ask",
						message: SUBTASK_FAST_CHILD_PROMPT,
					}),
					id: "call_subtasks_fast_parent_new_task_001",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			userMessage: new RegExp(SUBTASK_FAST_CHILD_MARKER),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "Fast child completed" }),
					id: "call_subtasks_fast_child_completion_002",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			toolCallId: "call_subtasks_fast_parent_new_task_001",
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "Fast parent resumed" }),
					id: "call_subtasks_fast_parent_completion_003",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			userMessage: new RegExp(SUBTASK_PARENT_MARKER),
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: "ask",
						message: SUBTASK_CHILD_PROMPT,
					}),
					id: "call_subtasks_parent_new_task_001",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			userMessage: new RegExp(SUBTASK_CHILD_MARKER),
		},
		response: {
			toolCalls: [
				{
					name: "ask_followup_question",
					arguments: JSON.stringify({
						question: "What is the square root of 81?",
						follow_up: [{ text: SUBTASK_CHILD_FOLLOWUP_ANSWER }],
					}),
					id: "call_subtasks_child_followup_001",
				},
			],
		},
	})

	mock.addFixture(completionAfterAnswer("call_subtasks_child_followup_001", "call_subtasks_child_completion_002"))

	mock.addFixture({
		match: {
			toolCallId: "call_subtasks_parent_new_task_001",
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "Parent task resumed" }),
					id: "call_subtasks_parent_completion_003",
				},
			],
		},
	})

	// Issue #457 sequence: a same-profile child returns first, then the resumed
	// parent delegates to a child whose mode uses a different API profile.
	mock.addFixture({
		match: {
			userMessage: new RegExp(SUBTASK_XPROFILE_PARENT_MARKER),
			sequenceIndex: 0,
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: "code",
						message: SUBTASK_XPROFILE_SAME_CHILD_PROMPT,
					}),
					id: "call_subtasks_xprofile_parent_same_child_001",
				},
			],
		},
	})

	// Issue #561: parent prompt embeds SAME_CHILD_MARKER verbatim, so parent-resume turns
	// also match a bare substring check. Exclude the parent marker to let them fall through.
	mock.addFixture({
		match: {
			predicate: (req) =>
				requestContains(req, [SUBTASK_XPROFILE_SAME_CHILD_MARKER]) &&
				!requestContains(req, [SUBTASK_XPROFILE_PARENT_MARKER]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SUBTASK_XPROFILE_SAME_CHILD_RESULT }),
					id: "call_subtasks_xprofile_same_child_completion_002",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				requestContains(req, [SUBTASK_XPROFILE_PARENT_MARKER, SUBTASK_XPROFILE_SAME_CHILD_RESULT]) &&
				!requestContains(req, [SUBTASK_XPROFILE_DIFFERENT_CHILD_RESULT]),
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: "ask",
						message: SUBTASK_XPROFILE_DIFFERENT_CHILD_PROMPT,
					}),
					id: "call_subtasks_xprofile_parent_different_child_003",
				},
			],
		},
	})

	// Safe as bare regex: DIFFERENT_CHILD_MARKER is NOT embedded in SUBTASK_XPROFILE_PARENT_PROMPT,
	// so parent-resume turns never contain it. If that ever changes, add an exclusion predicate.
	mock.addFixture({
		match: {
			userMessage: new RegExp(SUBTASK_XPROFILE_DIFFERENT_CHILD_MARKER),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SUBTASK_XPROFILE_DIFFERENT_CHILD_RESULT }),
					id: "call_subtasks_xprofile_different_child_completion_004",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				requestContains(req, [
					SUBTASK_XPROFILE_PARENT_MARKER,
					SUBTASK_XPROFILE_SAME_CHILD_RESULT,
					SUBTASK_XPROFILE_DIFFERENT_CHILD_RESULT,
				]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SUBTASK_XPROFILE_PARENT_RESULT }),
					id: "call_subtasks_xprofile_parent_completion_005",
				},
			],
		},
	})
}
