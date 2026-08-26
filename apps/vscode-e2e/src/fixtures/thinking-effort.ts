import { LLMock } from "@copilotkit/aimock"
import type { ChatCompletionRequest } from "@copilotkit/aimock"

// DTE e2e fixtures for the thinking-effort-tool and thinking-effort-switching
// suites. Replaces the former JSON fixtures (fixtures/thinking-effort-*.json):
// post-tool requests end with a role:user message (fresh <environment_details>
// is appended after the tool result), so aimock's toolCallId matcher — which
// requires the LAST message to be role:tool — can never bind those continuation
// turns, and JSON fixtures cannot carry predicates. Each turn is instead scoped
// by a predicate that searches the whole request for its own flow identifiers:
// the unique prompt marker for the baseline turn and the previous turn's unique
// tool call id for the continuations (same pattern as deepseek-v4.ts). No other
// suite can serve these responses and these suites cannot match unrelated turns.

const SWITCH_MODEL = "openai/gpt-5.1"
const APPLY_MODEL = "openai/gpt-5"
const SWITCH_MARKER = "DTE_E2E_SWITCH"
const APPLY_MARKER = "DTE_E2E_EFFORT_APPLY"
const SWITCH_DONE = "DTE_E2E_SWITCH_DONE"

// Post-tool requests carry the tool result of the PREVIOUS turn and nothing
// appends another tool result before the next API call, so the LAST role:tool
// message is exactly the call whose result this request follows.
const lastToolCallId = (req: ChatCompletionRequest): string | undefined => {
	const messages = Array.isArray(req?.messages) ? req.messages : []
	return messages.filter((message) => message?.role === "tool").at(-1)?.tool_call_id
}

// aimock's userMessage matcher only inspects the LAST user message and joins
// only the type:"text" content parts (getTextContent in aimock's router) — the
// predicate replicates that semantics for the baseline turns.
const lastUserMessageContains = (req: ChatCompletionRequest, text: string): boolean => {
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

export function addThinkingEffortFixtures(mock: InstanceType<typeof LLMock>) {
	// --- thinking-effort-switching suite (openai/gpt-5.1) ---
	// Baseline turn: bound to this suite's unique prompt marker.
	mock.addFixture({
		match: {
			model: SWITCH_MODEL,
			predicate: (req: ChatCompletionRequest) => lastUserMessageContains(req, SWITCH_MARKER),
		},
		response: {
			toolCalls: [
				{
					name: "set_thinking_effort",
					arguments: JSON.stringify({ effort: "medium", reason: "start at medium" }),
					id: "call_dte_sw_001",
				},
			],
		},
	})

	// Continuations: each turn binds to the previous turn's unique tool call id,
	// so a future flow on the same model cannot serve these responses.
	const switchingContinuations: Array<{
		afterCallId: string
		effort: string
		reason: string
		responseCallId: string
	}> = [
		{
			afterCallId: "call_dte_sw_001",
			effort: "medium",
			reason: "confirm current level",
			responseCallId: "call_dte_sw_002",
		},
		{ afterCallId: "call_dte_sw_002", effort: "high", reason: "raise to high", responseCallId: "call_dte_sw_003" },
		{
			afterCallId: "call_dte_sw_003",
			effort: "medium",
			reason: "try returning to medium",
			responseCallId: "call_dte_sw_004",
		},
	]
	for (const continuation of switchingContinuations) {
		mock.addFixture({
			match: {
				model: SWITCH_MODEL,
				predicate: (req: ChatCompletionRequest) => lastToolCallId(req) === continuation.afterCallId,
			},
			response: {
				toolCalls: [
					{
						name: "set_thinking_effort",
						arguments: JSON.stringify({
							effort: continuation.effort,
							reason: continuation.reason,
						}),
						id: continuation.responseCallId,
					},
				],
			},
		})
	}

	// Final turn: after the refused oscillation call, the task completes.
	mock.addFixture({
		match: {
			model: SWITCH_MODEL,
			predicate: (req: ChatCompletionRequest) => lastToolCallId(req) === "call_dte_sw_004",
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: SWITCH_DONE }),
					id: "call_dte_sw_005",
				},
			],
		},
	})

	// --- thinking-effort-tool suite (openai/gpt-5) ---
	// Baseline turn: bound to this suite's unique prompt marker.
	mock.addFixture({
		match: {
			model: APPLY_MODEL,
			predicate: (req: ChatCompletionRequest) => lastUserMessageContains(req, APPLY_MARKER),
		},
		response: {
			toolCalls: [
				{
					name: "set_thinking_effort",
					arguments: JSON.stringify({ effort: "high", reason: "multi-step math" }),
					id: "call_dte_e2e_001",
				},
			],
		},
	})

	// Continuation: binds to the set_thinking_effort call's unique tool call id.
	mock.addFixture({
		match: {
			model: APPLY_MODEL,
			predicate: (req: ChatCompletionRequest) => lastToolCallId(req) === "call_dte_e2e_001",
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "42" }),
					id: "call_dte_e2e_002",
				},
			],
		},
	})
}
