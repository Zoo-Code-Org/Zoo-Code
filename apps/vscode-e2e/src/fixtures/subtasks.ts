import { LLMock } from "@copilotkit/aimock"
import type { ChatCompletionRequest } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

const SUBTASK_PARENT_MARKER = "SUBTASK_PARENT_CANCELLATION_SMOKE"
const SUBTASK_CHILD_MARKER = "SUBTASK_CHILD_CALCULATOR_SMOKE"
const SUBTASK_INTERRUPT_PARENT_MARKER = "SUBTASK_PARENT_INTERRUPT_RESUME"
const SUBTASK_INTERRUPT_CHILD_MARKER = "SUBTASK_CHILD_INTERRUPT_RESUME"
export const SUBTASK_API_HANG_PARENT_MARKER = "SUBTASK_PARENT_API_HANG_INTERRUPT_RESUME"
export const SUBTASK_API_HANG_CHILD_MARKER = "SUBTASK_CHILD_API_HANG_INTERRUPT_RESUME"
const SUBTASK_FAST_PARENT_MARKER = "SUBTASK_PARENT_IMMEDIATE_COMPLETION"
const SUBTASK_FAST_CHILD_MARKER = "SUBTASK_CHILD_IMMEDIATE_COMPLETION"
const SUBTASK_XPROFILE_PARENT_MARKER = "SUBTASK_PARENT_CROSS_PROFILE"
const SUBTASK_XPROFILE_SAME_CHILD_MARKER = "SUBTASK_CHILD_SAME_PROFILE"
const SUBTASK_XPROFILE_DIFFERENT_CHILD_MARKER = "SUBTASK_CHILD_DIFFERENT_PROFILE"
const SUBTASK_FANOUT_PARENT_MARKER = "SUBTASK_PARENT_FANOUT_CONCURRENT"
const SUBTASK_FANOUT_CHILD_MARKER = "SUBTASK_CHILD_FANOUT_CONCURRENT"
const SUBTASK_FANOUT_XPROFILE_PARENT_MARKER = "SUBTASK_PARENT_FANOUT_CROSS_PROFILE"
const SUBTASK_FANOUT_XPROFILE_CHILD_MARKER = "SUBTASK_CHILD_FANOUT_CROSS_PROFILE"

const SUBTASK_CHILD_PROMPT = `${SUBTASK_CHILD_MARKER}: Ask the user exactly this follow-up question: What is the square root of 81? After the user answers, complete with only the answer.`
export const SUBTASK_PARENT_PROMPT = `${SUBTASK_PARENT_MARKER}: Use the new_task tool exactly once. Create an ask-mode subtask with this exact message: "${SUBTASK_CHILD_PROMPT}" Do not answer directly.`
export const SUBTASK_CHILD_FOLLOWUP_ANSWER = "9"
export const SUBTASK_FAST_CHILD_RESULT = "Fast child completed"
const SUBTASK_FAST_CHILD_PROMPT = `${SUBTASK_FAST_CHILD_MARKER}: Complete immediately with the exact result "${SUBTASK_FAST_CHILD_RESULT}".`
export const SUBTASK_FAST_PARENT_PROMPT = `${SUBTASK_FAST_PARENT_MARKER}: Use the new_task tool exactly once. Create an ask-mode subtask with this exact message: "${SUBTASK_FAST_CHILD_PROMPT}" Do not answer directly.`
export const SUBTASK_FANOUT_PARENT_FOLLOWUP = "Parent fan-out is still active?"
export const SUBTASK_FANOUT_CHILD_RESULT = "Fan-out child completed"
const SUBTASK_FANOUT_CHILD_PROMPT = `${SUBTASK_FANOUT_CHILD_MARKER}: Complete with the exact result "${SUBTASK_FANOUT_CHILD_RESULT}".`
export const SUBTASK_FANOUT_PARENT_PROMPT = `${SUBTASK_FANOUT_PARENT_MARKER}: Use the new_task tool exactly once. Create an ask-mode subtask with this exact message: "${SUBTASK_FANOUT_CHILD_PROMPT}" After delegation, ask the user exactly this follow-up question: ${SUBTASK_FANOUT_PARENT_FOLLOWUP}`
export const SUBTASK_FANOUT_XPROFILE_PARENT_MODEL = "openai/gpt-4.1"
export const SUBTASK_FANOUT_XPROFILE_CHILD_MODEL = "openai/gpt-4.1-mini"
export const SUBTASK_FANOUT_XPROFILE_PARENT_FOLLOWUP = "Parent cross-profile fan-out is still isolated?"
export const SUBTASK_FANOUT_XPROFILE_CHILD_RESULT = "Fan-out cross-profile child completed"
const SUBTASK_FANOUT_XPROFILE_CHILD_PROMPT = `${SUBTASK_FANOUT_XPROFILE_CHILD_MARKER}: Complete with the exact result "${SUBTASK_FANOUT_XPROFILE_CHILD_RESULT}".`
export const SUBTASK_FANOUT_XPROFILE_PARENT_PROMPT = `${SUBTASK_FANOUT_XPROFILE_PARENT_MARKER}: Use the new_task tool exactly once. Create an ask-mode subtask with this exact message: "${SUBTASK_FANOUT_XPROFILE_CHILD_PROMPT}" After delegation, ask the user exactly this follow-up question: ${SUBTASK_FANOUT_XPROFILE_PARENT_FOLLOWUP}`

const SUBTASK_INTERRUPT_CHILD_PROMPT = `${SUBTASK_INTERRUPT_CHILD_MARKER}: Ask the user exactly this follow-up question: What is the square root of 81? After the user answers, complete with only the answer.`
export const SUBTASK_INTERRUPT_PARENT_PROMPT = `${SUBTASK_INTERRUPT_PARENT_MARKER}: Use the new_task tool exactly once. Create an ask-mode subtask with this exact message: "${SUBTASK_INTERRUPT_CHILD_PROMPT}" Do not answer directly. When the subtask returns, complete with the exact result "Interrupted parent resumed".`
export const SUBTASK_INTERRUPT_CHILD_FOLLOWUP_ANSWER = "9"
export const SUBTASK_INTERRUPT_PARENT_RESULT = "Interrupted parent resumed"

const SUBTASK_API_HANG_CHILD_PROMPT = `${SUBTASK_API_HANG_CHILD_MARKER}: Complete with the exact result "Hung child completed".`
export const SUBTASK_API_HANG_PARENT_PROMPT = `${SUBTASK_API_HANG_PARENT_MARKER}: Use the new_task tool exactly once. Create an ask-mode subtask with this exact message: "${SUBTASK_API_HANG_CHILD_PROMPT}" Do not answer directly. When the subtask returns, complete with the exact result "API hang parent resumed".`
export const SUBTASK_API_HANG_RESUME_MESSAGE = "Continue after provider hang."
export const SUBTASK_API_HANG_CHILD_RESULT = "Hung child completed"
export const SUBTASK_API_HANG_PARENT_RESULT = "API hang parent resumed"

// How long the API-hang child's first mocked response stays pending before its first SSE
// chunk. Shared with the subtask suite so its post-test drain waits exactly one window.
// Correctness depends on no flat `latency` (fixture or LLMock default) being set on that
// fixture — a flat latency would apply to every chunk after the first, not just the ttft.
export const SUBTASK_API_HANG_RESPONSE_LATENCY_MS = 15_000
export const SUBTASK_FANOUT_CHILD_DELAY_MS = 15_000

// Abandon-subtask scenario (#559) — separate markers to avoid sequenceIndex collisions with the
// interrupted-child-resumes tests above, which exhaust the sequence count for INTERRUPT markers.
const SUBTASK_ABANDON_PARENT_MARKER = "SUBTASK_PARENT_ABANDON_SEVER"
const SUBTASK_ABANDON_CHILD_MARKER = "SUBTASK_CHILD_ABANDON_SEVER"
const SUBTASK_ABANDON_CHILD_PROMPT = `${SUBTASK_ABANDON_CHILD_MARKER}: Ask the user exactly this follow-up question: What is the square root of 81? After the user answers, complete with only the answer.`
export const SUBTASK_ABANDON_PARENT_PROMPT = `${SUBTASK_ABANDON_PARENT_MARKER}: Use the new_task tool exactly once. Create an ask-mode subtask with this exact message: "${SUBTASK_ABANDON_CHILD_PROMPT}" Do not answer directly.`
export const SUBTASK_ABANDON_CHILD_FOLLOWUP_ANSWER = "9"

const SUBTASK_XPROFILE_SAME_CHILD_PROMPT = `${SUBTASK_XPROFILE_SAME_CHILD_MARKER}: Complete immediately with the exact result "Same-profile child completed".`
const SUBTASK_XPROFILE_DIFFERENT_CHILD_PROMPT = `${SUBTASK_XPROFILE_DIFFERENT_CHILD_MARKER}: Complete immediately with the exact result "Different-profile child completed".`
export const SUBTASK_XPROFILE_PARENT_PROMPT = `${SUBTASK_XPROFILE_PARENT_MARKER}: First use new_task to create a code-mode subtask with this exact message: "${SUBTASK_XPROFILE_SAME_CHILD_PROMPT}" After it returns, create an ask-mode subtask with the next instructions you receive.`
export const SUBTASK_XPROFILE_SAME_CHILD_RESULT = "Same-profile child completed"
export const SUBTASK_XPROFILE_DIFFERENT_CHILD_RESULT = "Different-profile child completed"
export const SUBTASK_XPROFILE_PARENT_RESULT = "Sequential cross-profile parent resumed"

// Scheduler regression tests — exercises TaskScheduler + run() dispatch post-CodeRabbit fix.
// Separate markers to avoid collisions with the other subtask fixtures.
const SCHED_STANDALONE_MARKER = "SCHED_STANDALONE_INTERRUPT_RESUME"
const SCHED_COMPLETED_MARKER = "SCHED_COMPLETED_REOPEN"
export const SCHED_STANDALONE_PROMPT = `${SCHED_STANDALONE_MARKER}: Ask the user exactly this follow-up question: What is the square root of 64? After the user answers, complete with only the answer.`
export const SCHED_STANDALONE_FOLLOWUP_ANSWER = "8"
export const SCHED_COMPLETED_PROMPT = `${SCHED_COMPLETED_MARKER}: Complete immediately with the exact result "Scheduler completed task".`
export const SCHED_COMPLETED_RESULT = "Scheduler completed task"

const apiHangChildMatch = new RegExp(SUBTASK_API_HANG_CHILD_MARKER)

const requestContains = (req: ChatCompletionRequest, expected: string[]) => {
	const rawRequest = JSON.stringify(req)
	return expected.every((text) => rawRequest.includes(text))
}

// aimock's `userMessage` matcher only inspects the LAST user message and joins only the
// `type: "text"` content parts (see getTextContent in aimock's router). Fixtures that need
// whole-request exclusions must replicate that scoping inside a predicate so they keep the
// same matching semantics as the bare-regex fixtures they replace.
const lastUserMessageContains = (req: ChatCompletionRequest, text: string) => {
	const userMessages = req.messages?.filter((message) => message.role === "user") ?? []
	const last = userMessages.at(-1)
	if (!last) return false
	const content =
		typeof last.content === "string"
			? last.content
			: (last.content ?? [])
					.filter((part): part is { type: "text"; text: string } => part?.type === "text")
					.map((part) => part.text)
					.join("")
	return content.includes(text)
}

// reopenParentFromDelegation injects the child result into the resumed parent's history as
// `Subtask <childId> completed.\n\nResult:\n<summary>`. Matching on this injected prefix (in
// its JSON-serialized form) keeps parent-resume fixtures robust when
// validateAndFixToolResultIds rewrites tool-use ids on resume — matching on the new_task
// tool-call id directly proved flaky (the id can be rewritten, the fixture then misses, and
// a looser child fixture wins and serves the child's response to the parent).
const SUBTASK_RESULT_INJECTION = "completed.\\n\\nResult:"
const completionAfterAnswer = (followupId: string, completionId: string) => ({
	match: {
		predicate: (req: ChatCompletionRequest) =>
			!requestContains(req, [SUBTASK_INTERRUPT_CHILD_MARKER]) &&
			!requestContains(req, [SUBTASK_INTERRUPT_PARENT_MARKER]) &&
			// Preferred: structured tool-result message carries the followup answer.
			(toolResultContains(req, followupId, [SUBTASK_CHILD_FOLLOWUP_ANSWER]) ||
				// Fallback 1: answer present alongside the tool-call ID but not in a role:tool message.
				requestContains(req, [followupId, SUBTASK_CHILD_FOLLOWUP_ANSWER]) ||
				// Fallback 2: answer arrives as a bare user message after task resume (no tool-call ID context).
				requestContains(req, [
					SUBTASK_CHILD_MARKER,
					`<user_message>\\n${SUBTASK_CHILD_FOLLOWUP_ANSWER}\\n</user_message>`,
				])),
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
			userMessage: new RegExp(SUBTASK_FANOUT_PARENT_MARKER),
			sequenceIndex: 0,
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: "ask",
						message: SUBTASK_FANOUT_CHILD_PROMPT,
					}),
					id: "call_subtasks_fanout_parent_new_task_001",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				lastUserMessageContains(req, SUBTASK_FANOUT_CHILD_MARKER) &&
				!requestContains(req, [SUBTASK_FANOUT_PARENT_MARKER]),
		},
		streamingProfile: { ttft: SUBTASK_FANOUT_CHILD_DELAY_MS },
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SUBTASK_FANOUT_CHILD_RESULT }),
					id: "call_subtasks_fanout_child_completion_002",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				requestContains(req, [SUBTASK_FANOUT_PARENT_MARKER, "Delegated to child task"]) &&
				!requestContains(req, [SUBTASK_RESULT_INJECTION]),
		},
		response: {
			toolCalls: [
				{
					name: "ask_followup_question",
					arguments: JSON.stringify({
						question: SUBTASK_FANOUT_PARENT_FOLLOWUP,
						follow_up: [{ text: "continue" }],
					}),
					id: "call_subtasks_fanout_parent_followup_003",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			userMessage: new RegExp(SUBTASK_FANOUT_XPROFILE_PARENT_MARKER),
			sequenceIndex: 0,
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: "ask",
						message: SUBTASK_FANOUT_XPROFILE_CHILD_PROMPT,
					}),
					id: "call_subtasks_fanout_xprofile_parent_new_task_001",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				lastUserMessageContains(req, SUBTASK_FANOUT_XPROFILE_CHILD_MARKER) &&
				!requestContains(req, [SUBTASK_FANOUT_XPROFILE_PARENT_MARKER]),
		},
		streamingProfile: { ttft: SUBTASK_FANOUT_CHILD_DELAY_MS },
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SUBTASK_FANOUT_XPROFILE_CHILD_RESULT }),
					id: "call_subtasks_fanout_xprofile_child_completion_002",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				requestContains(req, [SUBTASK_FANOUT_XPROFILE_PARENT_MARKER, "Delegated to child task"]) &&
				!requestContains(req, [SUBTASK_RESULT_INJECTION]),
		},
		response: {
			toolCalls: [
				{
					name: "ask_followup_question",
					arguments: JSON.stringify({
						question: SUBTASK_FANOUT_XPROFILE_PARENT_FOLLOWUP,
						follow_up: [{ text: "continue" }],
					}),
					id: "call_subtasks_fanout_xprofile_parent_followup_003",
				},
			],
		},
	})

	// The parent prompt embeds SUBTASK_FAST_CHILD_MARKER verbatim, so parent-resume turns
	// can also match a bare substring check (same collision class as #561). Exclude the
	// parent marker so those turns fall through to the parent-resume fixture below.
	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				lastUserMessageContains(req, SUBTASK_FAST_CHILD_MARKER) &&
				!requestContains(req, [SUBTASK_FAST_PARENT_MARKER]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SUBTASK_FAST_CHILD_RESULT }),
					id: "call_subtasks_fast_child_completion_002",
				},
			],
		},
	})

	// Guard on SUBTASK_RESULT_INJECTION (not the child result text): the child result is
	// embedded verbatim in SUBTASK_FAST_PARENT_PROMPT, so it cannot distinguish the parent's
	// initial request from its resume turn.
	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				requestContains(req, [SUBTASK_FAST_PARENT_MARKER, SUBTASK_RESULT_INJECTION]),
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

	// This fixture is shared by several tests, so sequenceIndex cannot guard it. Exclude
	// resume turns via the injected tool_result prefix instead: when the tool_result is
	// serialized as role:"tool", the original parent prompt is the last user message again
	// and would otherwise re-serve new_task on the parent's resume turn.
	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				lastUserMessageContains(req, SUBTASK_PARENT_MARKER) &&
				!requestContains(req, [SUBTASK_RESULT_INJECTION]),
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

	// Same collision guard as the fast-child fixture above: SUBTASK_PARENT_PROMPT embeds
	// SUBTASK_CHILD_MARKER verbatim, so parent-resume turns must not match this fixture.
	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				lastUserMessageContains(req, SUBTASK_CHILD_MARKER) && !requestContains(req, [SUBTASK_PARENT_MARKER]),
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
			predicate: (req: ChatCompletionRequest) =>
				requestContains(req, [SUBTASK_PARENT_MARKER, SUBTASK_RESULT_INJECTION]),
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

	mock.addFixture({
		match: {
			userMessage: new RegExp(SUBTASK_API_HANG_PARENT_MARKER),
			sequenceIndex: 0,
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: "ask",
						message: SUBTASK_API_HANG_CHILD_PROMPT,
					}),
					id: "call_api_hang_parent_new_task_001",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			userMessage: apiHangChildMatch,
			sequenceIndex: 0,
		},
		// Keep the first child response pending long enough for the e2e test to cancel an in-flight
		// API request. Delay only the first chunk (ttft) rather than using flat `latency`: aimock
		// applies `latency` to EVERY chunk and never observes client disconnects, so after the test
		// cancels, a flat-latency stream would stay pending server-side for chunks × latency before
		// flushing to the dead socket. With ttft the pending window is exactly
		// SUBTASK_API_HANG_RESPONSE_LATENCY_MS (see its doc comment for the no-flat-latency
		// invariant this relies on), which is what the suite's post-test drain waits out.
		streamingProfile: { ttft: SUBTASK_API_HANG_RESPONSE_LATENCY_MS },
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SUBTASK_API_HANG_CHILD_RESULT }),
					id: "call_api_hang_child_completion_002",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			userMessage: apiHangChildMatch,
			sequenceIndex: 1,
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SUBTASK_API_HANG_CHILD_RESULT }),
					id: "call_api_hang_child_completion_003",
				},
			],
		},
	})

	// Same as the fast parent-resume fixture: the child result is embedded verbatim in
	// SUBTASK_API_HANG_PARENT_PROMPT, so guard on the injected tool_result prefix instead.
	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				requestContains(req, [SUBTASK_API_HANG_PARENT_MARKER, SUBTASK_RESULT_INJECTION]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SUBTASK_API_HANG_PARENT_RESULT }),
					id: "call_api_hang_parent_completion_004",
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

	// Scheduler regression fixtures: standalone interrupted task resume and completed task reopen.
	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				requestContains(req, [SCHED_STANDALONE_MARKER]) &&
				!requestContains(req, ["call_sched_standalone_followup_001"]) &&
				!requestContains(req, [`<user_message>\\n${SCHED_STANDALONE_FOLLOWUP_ANSWER}\\n</user_message>`]),
		},
		response: {
			toolCalls: [
				{
					name: "ask_followup_question",
					arguments: JSON.stringify({
						question: "What is the square root of 64?",
						follow_up: [{ text: SCHED_STANDALONE_FOLLOWUP_ANSWER }],
					}),
					id: "call_sched_standalone_followup_001",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				toolResultContains(req, "call_sched_standalone_followup_001", [SCHED_STANDALONE_FOLLOWUP_ANSWER]) ||
				requestContains(req, ["call_sched_standalone_followup_001", SCHED_STANDALONE_FOLLOWUP_ANSWER]) ||
				requestContains(req, [
					SCHED_STANDALONE_MARKER,
					`<user_message>\\n${SCHED_STANDALONE_FOLLOWUP_ANSWER}\\n</user_message>`,
				]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SCHED_STANDALONE_FOLLOWUP_ANSWER }),
					id: "call_sched_standalone_completion_002",
				},
			],
		},
	})

	mock.addFixture({
		match: { userMessage: new RegExp(SCHED_COMPLETED_MARKER) },
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SCHED_COMPLETED_RESULT }),
					id: "call_sched_completed_completion_001",
				},
			],
		},
	})

	// Interrupted-child-resumes-and-reports-back scenario (#560)
	mock.addFixture({
		match: {
			userMessage: new RegExp(SUBTASK_INTERRUPT_PARENT_MARKER),
			sequenceIndex: 0,
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: "ask",
						message: SUBTASK_INTERRUPT_CHILD_PROMPT,
					}),
					id: "call_interrupt_parent_new_task_001",
				},
			],
		},
	})

	// The parent prompt embeds SUBTASK_INTERRUPT_CHILD_MARKER verbatim, so parent-resume turns
	// also match a bare substring check. Exclude the parent marker so they fall through.
	// The answer exclusion must use the <user_message> wrapping: the bare answer is a single
	// digit that can appear anywhere in the serialized request (timestamps in environment
	// details, token counts), which would make this fixture unmatchable.
	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				requestContains(req, [SUBTASK_INTERRUPT_CHILD_MARKER]) &&
				!requestContains(req, [SUBTASK_INTERRUPT_PARENT_MARKER]) &&
				!requestContains(req, ["call_interrupt_child_followup_001"]) &&
				!requestContains(req, [
					`<user_message>\\n${SUBTASK_INTERRUPT_CHILD_FOLLOWUP_ANSWER}\\n</user_message>`,
				]),
		},
		response: {
			toolCalls: [
				{
					name: "ask_followup_question",
					arguments: JSON.stringify({
						question: "What is the square root of 81?",
						follow_up: [{ text: SUBTASK_INTERRUPT_CHILD_FOLLOWUP_ANSWER }],
					}),
					id: "call_interrupt_child_followup_001",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				// Preferred: structured tool-result message carries the followup answer.
				toolResultContains(req, "call_interrupt_child_followup_001", [
					SUBTASK_INTERRUPT_CHILD_FOLLOWUP_ANSWER,
				]) ||
				// Fallback 1: answer present alongside the tool-call ID.
				requestContains(req, ["call_interrupt_child_followup_001", SUBTASK_INTERRUPT_CHILD_FOLLOWUP_ANSWER]) ||
				// Fallback 2: answer arrives as a bare user message after task resume.
				requestContains(req, [
					SUBTASK_INTERRUPT_CHILD_MARKER,
					`<user_message>\\n${SUBTASK_INTERRUPT_CHILD_FOLLOWUP_ANSWER}\\n</user_message>`,
				]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SUBTASK_INTERRUPT_CHILD_FOLLOWUP_ANSWER }),
					id: "call_interrupt_child_completion_002",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				requestContains(req, [SUBTASK_INTERRUPT_PARENT_MARKER, SUBTASK_RESULT_INJECTION]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SUBTASK_INTERRUPT_PARENT_RESULT }),
					id: "call_interrupt_parent_completion_003",
				},
			],
		},
	})

	// Abandon-subtask scenario (#559)
	mock.addFixture({
		match: {
			userMessage: new RegExp(SUBTASK_ABANDON_PARENT_MARKER),
			sequenceIndex: 0,
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: "ask",
						message: SUBTASK_ABANDON_CHILD_PROMPT,
					}),
					id: "call_abandon_parent_new_task_001",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				requestContains(req, [SUBTASK_ABANDON_CHILD_MARKER]) &&
				!requestContains(req, [SUBTASK_ABANDON_PARENT_MARKER]) &&
				!requestContains(req, ["call_abandon_child_followup_001"]) &&
				!requestContains(req, [`<user_message>\\n${SUBTASK_ABANDON_CHILD_FOLLOWUP_ANSWER}\\n</user_message>`]),
		},
		response: {
			toolCalls: [
				{
					name: "ask_followup_question",
					arguments: JSON.stringify({
						question: "What is the square root of 81?",
						follow_up: [{ text: SUBTASK_ABANDON_CHILD_FOLLOWUP_ANSWER }],
					}),
					id: "call_abandon_child_followup_001",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) =>
				toolResultContains(req, "call_abandon_child_followup_001", [SUBTASK_ABANDON_CHILD_FOLLOWUP_ANSWER]) ||
				requestContains(req, ["call_abandon_child_followup_001", SUBTASK_ABANDON_CHILD_FOLLOWUP_ANSWER]) ||
				requestContains(req, [
					SUBTASK_ABANDON_CHILD_MARKER,
					`<user_message>\\n${SUBTASK_ABANDON_CHILD_FOLLOWUP_ANSWER}\\n</user_message>`,
				]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SUBTASK_ABANDON_CHILD_FOLLOWUP_ANSWER }),
					id: "call_abandon_child_completion_002",
				},
			],
		},
	})
}
