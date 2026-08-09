import { LLMock } from "@copilotkit/aimock"

/**
 * Shell resolution fixtures (PR #1125).
 *
 * Each task asks the model to write a marker file via execute_command.
 * Turn 1: The initial user message contains the marker tag; we return a
 *   write_to_file tool call so the extension writes the marker file.
 * Turn 2: The extension sends back the tool result; we match on the
 *   tool_call_id and marker tag, then return attempt_completion.
 *
 * Both turns use predicate-based matching (not JSON userMessage substring
 * matching) because the tool result content on Turn 2 includes the marker
 * tag, which would cause a JSON userMessage fixture to re-match and loop.
 */
// Matches when the marker tag appears in user message content that is NOT an
// <environment_details> block. The extension appends <environment_details>
// (which includes workspace directory listings) as a content part WITHIN the
// last user message — not as a separate message. If we concatenate all content
// parts and search the combined text, marker filenames from prior tests appear
// in the directory listing and cause cross-test fixture contamination — Test 2's
// request matches Test 1's fixture because the <environment_details> part lists
// shell-resolution-override-ok.txt.
//
// This function inspects EACH content part of a user message individually and
// skips any part whose text starts with "<environment_details>". Other parts
// (the task text) are searched normally. Tool-result messages (role "tool") are
// also searched because Turn 2's tool result contains the tag in the file path.
function requestContainsTag(req: Record<string, unknown>, tag: string): boolean {
	const messages = Array.isArray(req?.messages) ? (req.messages as unknown[]) : []
	for (const msg of messages) {
		if (typeof msg !== "object" || msg === null) continue
		const m = msg as Record<string, unknown>
		const role = m?.role
		// Search tool-result messages (Turn 2+). The tool result content
		// includes the file path which contains the tag.
		if (role === "tool") {
			if (JSON.stringify(m).includes(tag)) return true
			continue
		}
		// Search user messages, but skip <environment_details> content.
		//
		// The extension appends <environment_details> as a content part
		// WITHIN the last user message (not as a separate message). So a
		// single user message can contain:
		//   [{type:"text", text:"Write the text..."}, {type:"text", text:"<environment_details>..."}]
		//
		// We must check EACH content part individually and skip parts that
		// start with "<environment_details>". If we concatenate all parts
		// first, the combined text starts with the task text (not
		// "<environment_details>"), so the skip logic never triggers and
		// marker filenames from prior tests (appearing in the workspace
		// directory listing inside <environment_details>) cause the wrong
		// fixture to match.
		if (role === "user") {
			const content = m?.content
			if (typeof content === "string") {
				// String content: skip if it's an <environment_details> block
				if (!content.startsWith("<environment_details>") && content.includes(tag)) return true
			} else if (Array.isArray(content)) {
				// Array content: check each text part individually
				for (const part of content) {
					if (typeof part !== "object" || part === null) continue
					const p = part as Record<string, unknown>
					if (p?.type !== "text") continue
					const partText = typeof p.text === "string" ? p.text : ""
					// Skip <environment_details> content parts
					if (partText.startsWith("<environment_details>")) continue
					if (partText.includes(tag)) return true
				}
			}
		}
	}
	return false
}

// Guard: only match shell-resolution requests. Shell-resolution tests use the
// OpenRouter model "openai/gpt-4.1". DeepSeek V4 tests use "deepseek-v4-flash"
// or "deepseek-v4-pro" and carry a "deepseek-v4-e2e" probeTag. Without this
// guard, shell-resolution marker filenames appearing in the workspace directory
// listing (<environment_details>) cause DeepSeek requests to match
// shell-resolution fixtures, stealing the response and returning the wrong
// completion text.
function isShellResolutionRequest(req: Record<string, unknown>): boolean {
	const model = typeof req?.model === "string" ? req.model : ""
	if (!model.includes("gpt-4.1")) return false
	// Belt-and-suspenders: exclude any request carrying the DeepSeek probeTag.
	if (JSON.stringify(req).includes("deepseek-v4-e2e")) return false
	return true
}

// True when the request carries at least one tool-result message (Turn 2+).
function hasToolResultMessage(req: Record<string, unknown>): boolean {
	const messages = Array.isArray(req?.messages) ? req.messages : []
	return messages.some(
		(m: Record<string, unknown>) =>
			m?.role === "tool" || (m?.role === "user" && JSON.stringify(m).includes("tool_result")),
	)
}

export function addShellResolutionFixtures(mock: InstanceType<typeof LLMock>) {
	const markers = [
		{
			tag: "shell-resolution-override-ok",
			callId: "call_shell_resolution_override_001",
			doneId: "call_shell_resolution_override_002",
		},
		{
			tag: "shell-resolution-fallback-ok",
			callId: "call_shell_resolution_fallback_001",
			doneId: "call_shell_resolution_fallback_002",
		},
		{
			tag: "shell-resolution-disallowed-ok",
			callId: "call_shell_resolution_disallowed_001",
			doneId: "call_shell_resolution_disallowed_002",
		},
		{
			tag: "shell-resolution-legacy-ok",
			callId: "call_shell_resolution_legacy_001",
			doneId: "call_shell_resolution_legacy_002",
		},
		{
			tag: "shell-resolution-cleared-ok",
			callId: "call_shell_resolution_cleared_001",
			doneId: "call_shell_resolution_cleared_002",
		},
	]

	for (const { tag, callId, doneId } of markers) {
		// Turn 1: The request contains the marker tag AND there are no tool
		// results yet. Returns write_to_file to create the marker file.
		mock.addFixture({
			match: {
				predicate: (req: Record<string, unknown>) => {
					// Only match shell-resolution requests (OpenRouter gpt-4.1).
					// DeepSeek V4 requests must NOT match here.
					if (!isShellResolutionRequest(req)) return false

					// Only match when there are NO tool-result messages (i.e. Turn 1)
					if (hasToolResultMessage(req)) return false

					// Match the tag anywhere in the request so a trailing
					// <environment_details> user message cannot hide it.
					return requestContainsTag(req, tag)
				},
			},
			response: {
				toolCalls: [
					{
						name: "write_to_file",
						arguments: JSON.stringify({ path: `shell-resolution-e2e/${tag}.txt`, content: tag }),
						id: callId,
					},
				],
			},
			...({ repeat: true } as unknown as Record<string, boolean>),
		})

		// Turn 2: The request now carries a tool-result message (Turn 1's write_to_file
		// result). We match on: (a) the request has a tool-result message, AND (b) the
		// callId appears anywhere in the request (the extension may rewrite tool_call IDs
		// on resume, so we also accept the tag alone as a fallback). This is more robust
		// than toolResultContains which requires the exact tool_call_id on the last tool
		// message — Roo Code appends <environment_details> as a user message after tool
		// results, and the tool result content may not contain the tag verbatim.
		mock.addFixture({
			match: {
				predicate: (req: Record<string, unknown>) => {
					// Only match shell-resolution requests (OpenRouter gpt-4.1).
					// DeepSeek V4 requests must NOT match here.
					if (!isShellResolutionRequest(req)) return false

					if (!hasToolResultMessage(req)) return false
					// Preferred: the callId is present in the serialized request.
					if (requestContainsTag(req, callId)) return true
					// Fallback: the tag itself is present alongside a tool result.
					return requestContainsTag(req, tag)
				},
			},
			response: {
				toolCalls: [
					{
						name: "attempt_completion",
						arguments: JSON.stringify({ result: `Wrote marker ${tag}.txt` }),
						id: doneId,
					},
				],
			},
			...({ repeat: true } as unknown as Record<string, boolean>),
		})
	}

	// Scoped fallback fixture: guarantees Turn 2 completion for shell-resolution
	// marker tasks and prevents aimock 404 retry loops. It MUST be scoped to the
	// shell-resolution marker tags AND the OpenRouter model — without the model
	// guard, DeepSeek V4 tests (which use deepseek-v4-flash/pro) can match when
	// the workspace directory listing contains shell-resolution marker filenames,
	// causing the fallback to steal DeepSeek Turn-2 requests and return a generic
	// "Task completed via fallback fixture" instead of the expected marker.
	mock.addFixture({
		match: {
			predicate: (req: Record<string, unknown>) => {
				if (!hasToolResultMessage(req)) return false
				// Only handle OpenRouter requests (shell-resolution tests use openai/gpt-4.1).
				// DeepSeek tests use deepseek-v4-flash/pro and must NOT match this fallback.
				const model = typeof req?.model === "string" ? req.model : ""
				if (!model.includes("gpt-4.1")) return false
				// Only handle requests that belong to a shell-resolution marker task.
				return markers.some(({ tag }) => requestContainsTag(req, tag))
			},
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "Task completed via fallback fixture" }),
					id: "call_shell_resolution_wildcard_done",
				},
			],
		},
		...({ repeat: true } as unknown as Record<string, boolean>),
	})
}
