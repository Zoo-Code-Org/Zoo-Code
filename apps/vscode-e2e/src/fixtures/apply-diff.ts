import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

type ApplyDiffFixture = {
	toolCallId: string
	expected: string[]
	result: string
	id: string
}

export function addApplyDiffResultFixtures(mock: InstanceType<typeof LLMock>) {
	const fixtures: ApplyDiffFixture[] = [
		{
			toolCallId: "call_apply_diff_simple_001",
			expected: ['"path":"apply-diff-tool-fixture/simple-modify.txt"', '"operation":"modified"'],
			result: "Updated `apply-diff-tool-fixture/simple-modify.txt` to say `Hello Universe`.",
			id: "call_apply_diff_simple_002",
		},
		{
			toolCallId: "call_apply_diff_multi_replace_001",
			expected: ['"path":"apply-diff-tool-fixture/multiple-replace.js"', '"operation":"modified"'],
			result: "Updated `apply-diff-tool-fixture/multiple-replace.js` with the renamed function, parameters, and return fields.",
			id: "call_apply_diff_multi_replace_002",
		},
		{
			toolCallId: "call_apply_diff_line_hints_001",
			expected: ['"path":"apply-diff-tool-fixture/line-hints.js"', '"operation":"modified"'],
			result: "Updated `apply-diff-tool-fixture/line-hints.js` so `oldFunction` became `newFunction` with the new log message.",
			id: "call_apply_diff_line_hints_002",
		},
		{
			toolCallId: "call_apply_diff_error_001",
			expected: ["No sufficiently similar match found at line: 1", "This content does not exist"],
			result: "The apply_diff operation on `apply-diff-tool-fixture/error-handling.txt` was rejected - the search content did not match any content in the file, so it was not modified.",
			id: "call_apply_diff_error_002",
		},
		{
			toolCallId: "call_apply_diff_multi_block_001",
			expected: ['"path":"apply-diff-tool-fixture/multi-search-replace.js"', '"operation":"modified"'],
			result: "Applied both search/replace blocks in `apply-diff-tool-fixture/multi-search-replace.js` to rename the two target functions.",
			id: "call_apply_diff_multi_block_002",
		},
	]

	for (const fixture of fixtures) {
		mock.addFixture({
			match: {
				toolCallId: fixture.toolCallId,
				predicate: (req) => toolResultContains(req, fixture.toolCallId, fixture.expected),
			},
			response: {
				toolCalls: [
					{
						name: "attempt_completion",
						arguments: JSON.stringify({ result: fixture.result }),
						id: fixture.id,
					},
				],
			},
		})
	}
}
