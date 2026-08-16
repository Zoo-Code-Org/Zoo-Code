// Auto-flatten e2e fixtures (#12): a three-level new_task chain where the depth-2 task's
// own new_task call exceeds maxNestingDepth (default 2) and is flattened inline instead of
// opening a fourth tab. Unique FLATTEN_E2E_ markers avoid collisions with other suites.
import { LLMock } from "@copilotkit/aimock"
import type { ChatCompletionRequest } from "@copilotkit/aimock"

export const FLATTEN_ROOT_MARKER = "FLATTEN_E2E_ROOT_CHAIN"
export const FLATTEN_CHILD_MARKER = "FLATTEN_E2E_CHILD_CHAIN"
export const FLATTEN_DEPTH2_MARKER = "FLATTEN_E2E_DEPTH2_CHAIN"

// The depth-2 task's completion result — emitted by the same (flattened) task, proving the
// inline phase ran in-conversation rather than delegating to a new tab.
export const FLATTEN_DEPTH2_RESULT = "Flattened inline completed"
export const FLATTEN_CHILD_RESUME_RESULT = "Child resumed after flatten"
export const FLATTEN_ROOT_RESULT = "Root resumed after chain"

// Prompt chains. Each task's initial request wraps its own prompt in <user_message>...</user_message>,
// so anchoring on `<user_message>` + the marker uniquely identifies that task's FIRST turn even
// though downstream markers are embedded verbatim upstream (the anchor never appears inside a
// nested quoted message).
export const FLATTEN_DEPTH2_PROMPT = `${FLATTEN_DEPTH2_MARKER}: Complete immediately with the exact result "${FLATTEN_DEPTH2_RESULT}".`
export const FLATTEN_CHILD_PROMPT = `${FLATTEN_CHILD_MARKER}: Use the new_task tool exactly once. Create an ask-mode subtask with this exact message: "${FLATTEN_DEPTH2_PROMPT}" Do not answer directly.`
export const FLATTEN_ROOT_PROMPT = `${FLATTEN_ROOT_MARKER}: Use the new_task tool exactly once. Create an ask-mode subtask with this exact message: "${FLATTEN_CHILD_PROMPT}" Do not answer directly.`

// The directive NewTaskTool pushes when it flattens (inlineSubtask.ts buildInlineDirective).
// It appears only in the depth-2 task's own requests — no other conversation ever sees it.
const FLATTEN_DIRECTIVE = "auto-flattened"

// reopenParentFromDelegation injects `Subtask <childId> completed.\n\nResult:\n<summary>` into the
// resumed parent's history. In raw JSON bodies newlines are escaped, so match the serialized form.
const INJECTION_PREFIX_RAW = "completed.\\n\\nResult:"

const requestContains = (req: ChatCompletionRequest, expected: string[]) => {
	const rawRequest = JSON.stringify(req)
	return expected.every((text) => rawRequest.includes(text))
}

// aimock's `userMessage` matcher only inspects the LAST user message and joins only the
// `type: "text"` content parts. Replicate that scoping inside predicates so resume turns — whose
// last user message is a fresh environment block with no markers at all — never match initial-turn
// fixtures.
const lastUserMessageContains = (req: ChatCompletionRequest, text: string) => {
	const userMessages = req.messages?.filter((message) => message.role === "user") ?? []
	const last = userMessages.at(-1)
	if (!last) return false
	const content =
		typeof last.content === "string"
			? last.content
			: (last.content ?? [])
					.filter((part): part is { type: string; text: string } => part?.type === "text")
					.map((part) => part.text)
					.join("")
	return content.includes(text)
}

export function addInlineFlattenFixtures(mock: InstanceType<typeof LLMock>) {
	// Root (depth 0), first turn only: delegate to the child.
	mock.addFixture({
		match: {
			predicate: (req) => lastUserMessageContains(req, `<user_message>\n${FLATTEN_ROOT_MARKER}`),
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({ mode: "ask", message: FLATTEN_CHILD_PROMPT }),
					id: "call_flatten_root_newtask_001",
				},
			],
		},
	})

	// Child (depth 1), first turn only: delegate to the depth-2 task.
	mock.addFixture({
		match: {
			predicate: (req) => lastUserMessageContains(req, `<user_message>\n${FLATTEN_CHILD_MARKER}`),
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({ mode: "ask", message: FLATTEN_DEPTH2_PROMPT }),
					id: "call_flatten_child_newtask_002",
				},
			],
		},
	})

	// Depth-2 task (depth 2), first turn only: its new_task call would exceed maxNestingDepth,
	// so the tool flattens it inline and pushes a directive containing FLATTEN_DIRECTIVE.
	mock.addFixture({
		match: {
			predicate: (req) => lastUserMessageContains(req, `<user_message>\n${FLATTEN_DEPTH2_MARKER}`),
		},
		response: {
			toolCalls: [
				{
					name: "new_task",
					arguments: JSON.stringify({
						mode: "ask",
						message: `Complete immediately with the exact result "${FLATTEN_DEPTH2_RESULT}".`,
					}),
					id: "call_flatten_depth2_newtask_003",
				},
			],
		},
	})

	// Depth-2 task after the flatten directive is in its history (and on the follow-up turn):
	// complete with the inline result. While the inline phase is active this ends the phase
	// without completing the task; once the phase has ended the same response completes it and
	// delegates back to the child — no new tab was ever opened.
	mock.addFixture({
		match: {
			predicate: (req) => requestContains(req, [FLATTEN_DIRECTIVE]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: FLATTEN_DEPTH2_RESULT }),
					id: "call_flatten_depth2_inline_004",
				},
			],
		},
	})

	// Child resumes after its (flattened) subtask returns: the injected result carries the
	// depth-2 completion summary. Complete so the root can resume.
	mock.addFixture({
		match: {
			predicate: (req) => requestContains(req, [`${INJECTION_PREFIX_RAW}\\n${FLATTEN_DEPTH2_RESULT}`]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: FLATTEN_CHILD_RESUME_RESULT }),
					id: "call_flatten_child_resume_005",
				},
			],
		},
	})

	// Root resumes last: the injected result carries the child's completion summary.
	mock.addFixture({
		match: {
			predicate: (req) => requestContains(req, [`${INJECTION_PREFIX_RAW}\\n${FLATTEN_CHILD_RESUME_RESULT}`]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: FLATTEN_ROOT_RESULT }),
					id: "call_flatten_root_resume_006",
				},
			],
		},
	})
}
