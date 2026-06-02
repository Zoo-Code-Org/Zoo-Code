import type OpenAI from "openai"

const APPLY_DIFF_DESCRIPTION = `Apply precise, targeted modifications to an existing file using one or more search/replace blocks. This tool is for surgical edits only; the 'SEARCH' block must exactly match the existing content, including whitespace and indentation. To make multiple targeted changes, provide multiple SEARCH/REPLACE blocks in the 'diff' parameter. Use the 'read_file' tool first if you are not confident in the exact content to search for.`

const DIFF_PARAMETER_DESCRIPTION = `A string containing one or more search/replace blocks defining the changes. The ':start_line:' is required and indicates the starting line number of the original content. You must not add a start line for the replacement content. Each block must follow this format:
<<<<<<< SEARCH
:start_line:[line_number]
-------
[exact content to find]
=======
[new content to replace with]
>>>>>>> REPLACE`

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
				ref: {
					type: ["object", "null"],
					properties: {
						source: { type: "string", enum: ["chat", "file", "terminal", "tool"] },
						ref: { type: "string" },
						startAnchor: { type: ["string", "null"] },
						endAnchor: { type: ["string", "null"] },
						selector: { type: ["string", "null"] },
						contextType: {
							type: ["string", "null"],
							enum: ["code", "command", "prose", "markdown", "diff"],
						},
					},
					required: ["source", "ref", "startAnchor", "endAnchor", "selector", "contextType"],
					additionalProperties: false,
				},
				multi_ref: {
					type: ["array", "null"],
					items: { type: "object" },
				},
				transform: {
					type: ["object", "null"],
					properties: {
						append: { type: ["string", "null"] },
						prepend: { type: ["string", "null"] },
						replace: {
							type: ["object", "null"],
							properties: {
								from: { type: "string" },
								to: { type: "string" },
							},
							required: ["from", "to"],
							additionalProperties: false,
						},
						wrap_with: { type: ["string", "null"] },
						join_with: { type: ["string", "null"] },
					},
					required: ["append", "prepend", "replace", "wrap_with", "join_with"],
					additionalProperties: false,
				},
			},
			required: ["path", "diff", "ref", "multi_ref", "transform"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
