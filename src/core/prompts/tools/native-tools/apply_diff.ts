import type OpenAI from "openai"

const APPLY_DIFF_DESCRIPTION = `Apply precise, targeted modifications to an existing file using one or more search/replace blocks. This tool is for surgical edits only; the 'SEARCH' block must exactly match the existing content, including whitespace and indentation. To make multiple targeted changes, provide multiple SEARCH/REPLACE blocks in the 'diff' parameter. Use the 'read_file' tool first if you are not confident in the exact content to search for.
CRITICAL WARNING: The 'read_file' tool outputs line numbers (e.g. '1: ', '2: ') for your convenience, but these line numbers DO NOT exist in the actual file! You MUST STRIP all line numbers from the 'SEARCH' block. Your 'SEARCH' block must match the RAW file content exactly.`

const DIFF_PARAMETER_DESCRIPTION = `A string containing one or more search/replace blocks defining the changes. The ':start_line:' is required and indicates the starting line number of the original content. You must not add a start line for the replacement content. Each block must follow this format:
<<<<<<< SEARCH
:start_line:[line_number]
-------
[exact content to find WITHOUT line numbers]
=======
[new content to replace with]
>>>>>>> REPLACE

CRITICAL: DO NOT include line numbers (like '137: ') in the [exact content to find] section! It must match the actual file content, which does not have line numbers.`

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
