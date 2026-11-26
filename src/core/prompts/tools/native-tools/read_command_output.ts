import type OpenAI from "openai"

/**
 * Native tool definition for read_command_output.
 *
 * Retrieve paged task artifacts, including truncated command output and
 * oversized tool results or completed tool-call arguments.
 */

const READ_COMMAND_OUTPUT_DESCRIPTION = `Retrieve persisted task output in small pages. Use this tool when:
1. The execute_command result shows "[OUTPUT TRUNCATED - Full output saved to artifact: output-1]"
2. A tool result or completed tool-call argument says its full content was retained as an artifact
3. You need to search or inspect more than the preview

Use artifact_id="list" to discover recent available outputs if a reference is missing. Use "latest" only when you want the most recent output. References such as output-1 are stable within this task; legacy cmd-*.txt filenames also work.

The tool supports two modes:
- **Read mode**: Read output starting from a byte offset with optional limit
- **Search mode**: Filter lines matching a regex or literal pattern (like grep)

Parameters:
- artifact_id: (required) The output reference from the truncated output message (e.g., "output-1")
- search: (optional) Pattern to filter lines. Supports regex or literal strings. Case-insensitive. **Omit this parameter entirely if you don't need to filter - do not pass null or empty string.**
- offset: (optional) Byte offset to start reading from. Default: 0. Use for pagination.
- limit: (optional) Maximum bytes requested. Zoo caps each response to 5% of the model's available input budget.

Example: Reading truncated command output
{ "artifact_id": "output-1" }

Example: Reading with pagination
{ "artifact_id": "output-1", "offset": 4000, "limit": 4000 }

Example: Searching for errors in build output
{ "artifact_id": "output-1", "search": "error|failed|Error" }

Example: Finding specific test failures
{ "artifact_id": "output-1", "search": "FAIL" }`

const ARTIFACT_ID_DESCRIPTION = `The output reference from a retained tool or command output (e.g., "output-1")`

const SEARCH_DESCRIPTION = `Optional regex or literal pattern to filter lines (case-insensitive, like grep). Omit this parameter if not searching - do not pass null or empty string.`

const OFFSET_DESCRIPTION = `Byte offset to start reading from (default: 0, for pagination)`

const LIMIT_DESCRIPTION = `Maximum bytes requested; Zoo also caps this to a small share of the model input budget`

export default {
	type: "function",
	function: {
		name: "read_command_output",
		description: READ_COMMAND_OUTPUT_DESCRIPTION,
		// Note: strict mode is intentionally disabled for this tool.
		// With strict: true, OpenAI requires ALL properties to be in the 'required' array,
		// which forces the LLM to always provide explicit values (even null) for optional params.
		// This creates verbose tool calls and poor UX. By disabling strict mode, the LLM can
		// omit optional parameters entirely, making the tool easier to use.
		parameters: {
			type: "object",
			properties: {
				artifact_id: {
					type: "string",
					description: ARTIFACT_ID_DESCRIPTION,
				},
				search: {
					type: "string",
					description: SEARCH_DESCRIPTION,
				},
				offset: {
					type: "number",
					description: OFFSET_DESCRIPTION,
				},
				limit: {
					type: "number",
					description: LIMIT_DESCRIPTION,
				},
			},
			required: ["artifact_id"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
