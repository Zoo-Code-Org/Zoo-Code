import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

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
		// Turn 1: Initial user message contains the marker tag AND there are
		// no tool results yet. Returns write_to_file to create the marker file.
		mock.addFixture({
			match: {
				predicate: (req: Record<string, unknown>) => {
					const messages = Array.isArray(req?.messages) ? req.messages : []
					// Only match when there are NO tool-result messages (i.e. Turn 1)
					const hasToolResult = messages.some(
						(m: Record<string, unknown>) =>
							m?.role === "tool" ||
							(m?.role === "user" && JSON.stringify(m).includes("tool_result")),
					)
					if (hasToolResult) return false

					// Check if the last user message contains the marker tag
					const lastUserMsg = messages.filter((m: Record<string, unknown>) => m?.role === "user").pop()
					if (!lastUserMsg) return false
					const content = JSON.stringify(lastUserMsg)
					return content.includes(tag)
				},
			},
			response: {
				toolCalls: [
					{
						name: "write_to_file",
						arguments: JSON.stringify({ path: `${tag}.txt`, content: tag }),
						id: callId,
					},
				],
			},
			...({ repeat: true } as unknown as Record<string, boolean>),
		})

		// Turn 2: Tool result contains the callId and marker tag. Returns
		// attempt_completion to end the task.
		mock.addFixture({
			match: {
				predicate: (req: Parameters<typeof toolResultContains>[0]) => toolResultContains(req, callId, [tag]),
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

	// Wildcard fallback fixture to guarantee Turn 2 completion and prevent aimock 404 retries
	mock.addFixture({
		match: {
			predicate: (req: Record<string, unknown>) => {
				const messages = Array.isArray(req?.messages) ? req.messages : []
				return messages.some(
					(m: Record<string, unknown>) =>
						m?.role === "tool" || (m?.role === "user" && JSON.stringify(m).includes("tool_result")),
				)
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
