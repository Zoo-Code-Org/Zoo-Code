import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

/**
 * Shell resolution fixtures (PR #1125).
 *
 * Each task asks the model to write a marker file via execute_command. The
 * initial fixture (loaded from fixtures/shell-resolution.json) issues a
 * write_to_file tool call; once the tool result lands (path + created), we
 * complete the task. The write_to_file path is used so the marker file is
 * produced deterministically regardless of which shell resolved.
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
