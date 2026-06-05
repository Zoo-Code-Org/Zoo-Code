import { LLMock } from "@copilotkit/aimock"

import {
	isToolResultExpectation,
	toolResultContains,
	toolResultsContain,
	type ToolResultExpectation,
} from "./tool-result"

type ReadFileResultFixture = {
	toolCallId: string
	expected: string[] | ToolResultExpectation[]
	result: string
	id: string
}

export function addReadFileResultFixtures(mock: InstanceType<typeof LLMock>) {
	const fixtures: ReadFileResultFixture[] = [
		{
			toolCallId: "call_read_file_simple_001",
			expected: ["File: simple-read-file-smoke.txt", "1 | Hello, World!"],
			result: 'The file [`simple-read-file-smoke.txt`](simple-read-file-smoke.txt) contains the text: "Hello, World!"',
			id: "call_read_file_simple_002",
		},
		{
			toolCallId: "call_read_file_multiline_001",
			expected: ["File: multiline-read-file.txt", "1 | Line 1", "5 | Line 5"],
			result: "The file [`multiline-read-file.txt`](multiline-read-file.txt) contains 5 lines: Line 1, Line 2, Line 3, Line 4, and Line 5.",
			id: "call_read_file_multiline_002",
		},
		{
			toolCallId: "call_read_file_slice_001",
			expected: ["File: multiline-read-file.txt", "2 | Line 2", "3 | Line 3", "4 | Line 4"],
			result: "The three lines read from [`multiline-read-file.txt`](multiline-read-file.txt) starting at offset 2 are:\n\n- Line 2\n- Line 3\n- Line 4",
			id: "call_read_file_slice_002",
		},
		{
			toolCallId: "call_read_file_missing_001",
			expected: ["non-existent-read-file.txt", "ENOENT", "no such file or directory"],
			result: "Attempting to read [`non-existent-read-file.txt`](non-existent-read-file.txt) resulted in an error: the file does not exist. This error was handled appropriately and no file contents were returned.",
			id: "call_read_file_missing_002",
		},
		{
			toolCallId: "call_read_file_xml_001",
			expected: ["File: xml-content-read-file.xml", "<child>Test content</child>", "<data>Some data</data>"],
			result: "The XML file [`xml-content-read-file.xml`](xml-content-read-file.xml) contains the following elements:\n- `<root>` (root element)\n- `<child>` (child of root)\n- `<data>` (child of root)\n\nThe structure is:\n```xml\n<root>\n  <child>Test content</child>\n  <data>Some data</data>\n</root>\n```",
			id: "call_read_file_xml_002",
		},
		{
			toolCallId: "call_read_file_multiple_multiline_001",
			expected: [
				{
					toolCallId: "call_read_file_multiple_simple_001",
					expected: ["File: simple-read-file-smoke.txt", "1 | Hello, World!"],
				},
				{
					toolCallId: "call_read_file_multiple_multiline_001",
					expected: ["File: multiline-read-file.txt", "1 | Line 1", "5 | Line 5"],
				},
			],
			result: "Contents of [`simple-read-file-smoke.txt`](simple-read-file-smoke.txt):\n\n```\nHello, World!\n```\n\nContents of [`multiline-read-file.txt`](multiline-read-file.txt):\n\n```\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\n```",
			id: "call_read_file_multiple_002",
		},
		{
			toolCallId: "call_read_file_large_001",
			expected: [
				"File: large-read-file.txt",
				"1 | Line 1: This is a test line with some content",
				"100 | Line 100: This is a test line with some content",
			],
			result: "The file [`large-read-file.txt`](large-read-file.txt) contains 100 lines, each following the pattern: `Line N: This is a test line with some content`, where `N` is the line number (from 1 to 100). The structure is consistent throughout the file, with only the line number changing on each line.",
			id: "call_read_file_large_002",
		},
	]

	for (const fixture of fixtures) {
		mock.addFixture({
			match: {
				toolCallId: fixture.toolCallId,
				predicate: (req) =>
					isToolResultExpectation(fixture.expected[0])
						? toolResultsContain(req, fixture.expected as ToolResultExpectation[])
						: toolResultContains(req, fixture.toolCallId, fixture.expected as string[]),
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
