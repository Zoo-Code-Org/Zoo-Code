import type OpenAI from "openai"

const EDIT_FILE_DESCRIPTION = `Use this tool to replace text in an existing file, or create a new file.

This tool performs literal string replacement with support for multiple occurrences.

To be resilient to minor formatting drift, the tool normalizes line endings (CRLF/LF) for matching and may fall back to deterministic matching strategies when an exact literal match fails (exact → whitespace-tolerant match → token-based match). The original file's line endings are preserved when writing.

USAGE PATTERNS:

1. MODIFY EXISTING FILE (default):
   - Provide file_path, old_string (text to find), and new_string (replacement)
   - By default, expects exactly 1 occurrence of old_string
   - Use expected_replacements to replace multiple occurrences

2. CREATE NEW FILE:
   - Set old_string to empty string ""
   - new_string becomes the entire file content
   - File must not already exist

CRITICAL REQUIREMENTS:

1. EXACT MATCHING (BEST): The old_string should match the file contents EXACTLY, including:
    - All whitespace (spaces, tabs, newlines)
    - All indentation
    - All punctuation and special characters

2. CONTEXT FOR UNIQUENESS: For single replacements (default), include at least 3 lines of context BEFORE and AFTER the target text to ensure uniqueness.

3. MULTIPLE REPLACEMENTS: If you need to replace multiple identical occurrences:
   - Set expected_replacements to the exact count you expect to replace
   - ALL occurrences will be replaced

4. NO ESCAPING: Provide the literal text - do not escape special characters.`

const edit_file = {
	type: "function",
	function: {
		name: "edit_file",
		description: EDIT_FILE_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description:
						"The path to the file to modify or create. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is.",
				},
				old_string: {
					type: "string",
					description:
						"The exact literal text to replace (must match the file contents exactly, including all whitespace and indentation). For single replacements (default), include at least 3 lines of context BEFORE and AFTER the target text. Use empty string to create a new file.",
				},
				new_string: {
					type: "string",
					description:
						"The exact literal text to replace old_string with. When creating a new file (old_string is empty), this becomes the file content.",
				},
				expected_replacements: {
					type: "number",
					description:
						"Number of replacements expected. Defaults to 1 if not specified. Use when you want to replace multiple occurrences of the same text.",
					minimum: 1,
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
			required: ["file_path", "old_string", "new_string"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool

export default edit_file
