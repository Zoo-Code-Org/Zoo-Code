import type OpenAI from "openai"

const APPLY_DIFF_DESCRIPTION = `Apply precise, targeted modifications to an existing file using one or more search/replace blocks. This tool is for surgical edits only; the 'SEARCH' block must exactly match the existing content, including whitespace and indentation. To make multiple targeted changes, provide multiple SEARCH/REPLACE blocks in the 'diff' parameter. Use the 'read_file' tool first if you are not confident in the exact content to search for.`

const DIFF_PARAMETER_DESCRIPTION = `A string containing one or more search/replace blocks defining the changes. The ':start_line:' is strongly recommended and indicates the starting line number of the original content. You must not add a start line for the replacement content. Each block must follow this format:
<<<<<<< SEARCH
:start_line:[line_number]
-------
[exact content to find]
=======
[new content to replace with]
>>>>>>> REPLACE

CRITICAL:
- The ':start_line:[line_number]' header is strongly recommended for accurate matching. When provided, it must follow the exact syntax ':start_line:[integer]' (for example: ':start_line:220'). Do not write headers with shorthand forms like ':220' or variations like ':start_line=220'.
- Copy the exact lines from the source file for a 100% string match including all whitespace, indentation, and newlines.
- Ensure the separator '-------' is on its own line immediately following ':start_line:[line_number]' with a newline.`

export const apply_diff = {
	type: "function",
	function: {
		name: "apply_diff",
		description: APPLY_DIFF_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "The path of the file to modify, relative to the current workspace directory.",
				},
				diff: {
					type: "string",
					description: DIFF_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path", "diff"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
