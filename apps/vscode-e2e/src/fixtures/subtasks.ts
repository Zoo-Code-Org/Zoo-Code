import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

export const SUBTASK_PARENT_PROMPT = "SUBTASK_PARENT_CANCELLATION_SMOKE"
export const SUBTASK_CHILD_PROMPT = "SUBTASK_CHILD_CALCULATOR_SMOKE"
export const SUBTASK_CHILD_FOLLOWUP_ANSWER = "9"
const INTERRUPTED_TOOL_RESULT = "Task was interrupted before this tool call could be completed."

export function addSubtaskFixtures(mock: InstanceType<typeof LLMock>) {
	mock.addFixture({
		match: {
			userMessage: new RegExp(SUBTASK_PARENT_PROMPT),
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
			userMessage: new RegExp(SUBTASK_CHILD_PROMPT),
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

	mock.addFixture({
		match: {
			toolCallId: "call_subtasks_child_followup_001",
			predicate: (req) => toolResultContains(req, "call_subtasks_child_followup_001", [INTERRUPTED_TOOL_RESULT]),
		},
		response: {
			toolCalls: [
				{
					name: "ask_followup_question",
					arguments: JSON.stringify({
						question: "What is the square root of 81?",
						follow_up: [{ text: SUBTASK_CHILD_FOLLOWUP_ANSWER }],
					}),
					id: "call_subtasks_child_followup_resume_002",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			toolCallId: "call_subtasks_child_followup_001",
			predicate: (req) =>
				toolResultContains(req, "call_subtasks_child_followup_001", [SUBTASK_CHILD_FOLLOWUP_ANSWER]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "9" }),
					id: "call_subtasks_child_completion_002",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			toolCallId: "call_subtasks_child_followup_resume_002",
			predicate: (req) =>
				toolResultContains(req, "call_subtasks_child_followup_resume_002", [SUBTASK_CHILD_FOLLOWUP_ANSWER]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "9" }),
					id: "call_subtasks_child_completion_resume_003",
				},
			],
		},
	})

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
}
