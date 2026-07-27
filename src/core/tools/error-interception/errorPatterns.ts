import type { ErrorPattern, InterceptionSignal, RecoveryDisposition } from "./types.ts"

// Sanitization helpers --------------------------------------------------------

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0

const hasMetadata = (signal: InterceptionSignal, key: string): boolean => signal.metadata[key] !== undefined

const metadataIs = (signal: InterceptionSignal, key: string, value: unknown): boolean => signal.metadata[key] === value

const resultStatusIs = (signal: InterceptionSignal, status: string): boolean => {
	if (typeof signal.result !== "object" || signal.result === null) return false
	return signal.result.status === status
}

const resultTypeIs = (signal: InterceptionSignal, type: string): boolean => {
	if (typeof signal.result !== "object" || signal.result === null) return false
	return signal.result.type === type
}

const errorCodeIs = (signal: InterceptionSignal, code: string): boolean => {
	if (signal.error === null || typeof signal.error !== "object") return false
	return (signal.error as { code?: unknown }).code === code
}

const errorCodeIsNumber = (signal: InterceptionSignal, code: number): boolean => {
	if (signal.error === null || typeof signal.error !== "object") return false
	return (signal.error as { code?: unknown }).code === code
}

const errorNameIs = (signal: InterceptionSignal, name: string): boolean => {
	if (signal.error === null || typeof signal.error !== "object") return false
	return (signal.error as { name?: unknown }).name === name
}

const errorMessageIncludes = (signal: InterceptionSignal, phrase: string): boolean => {
	if (signal.error === null || typeof signal.error !== "object") return false
	const message = (signal.error as { message?: unknown }).message
	return typeof message === "string" && message.toLowerCase().includes(phrase.toLowerCase())
}

const resultTextIncludes = (signal: InterceptionSignal, phrase: string): boolean => {
	if (typeof signal.result !== "object" || signal.result === null) return false
	const text = (signal.result as { text?: unknown }).text
	return typeof text === "string" && text.toLowerCase().includes(phrase.toLowerCase())
}

// The pattern DB is ordered by descending priority. Keep this ordering strict;
// classifier iterates in the declared order.

export const ERROR_PATTERNS: readonly ErrorPattern[] = [
	// -------------------------------------------------------------------------
	// 100 DUPLICATE_CALL
	// -------------------------------------------------------------------------
	{
		id: "EI/DUPLICATE_CALL/001",
		category: "DUPLICATE_CALL",
		priority: 100,
		severity: "error",
		retryPolicy: "do-not-retry",
		requiresToolContext: true,
		matches: (signal) => signal.source === "repetition" && metadataIs(signal, "blocked", true),
		template: {
			what: "The same tool invocation was blocked because it was repeated with identical inputs.",
			why: "Running the same call again would not produce a different result and only increases loop count.",
			next: [
				"Do not execute the same invocation again.",
				"Read the previous tool result already in the conversation history.",
				"Switch to a different tool, input, or strategy if the result is insufficient.",
			],
		},
		occurrenceTemplates: {
			first: {
				what: "The same tool invocation was blocked because it was repeated with identical inputs.",
				why: "A duplicate call was detected; the previous result is still available in the conversation.",
				next: [
					"Continue from the retained result already in the conversation history.",
					"Do not resend the duplicate invocation.",
				],
			},
			repeated: {
				what: "The same duplicate invocation was emitted again.",
				why: "Retrying the same fingerprint cannot add new information.",
				next: [
					"Emit no duplicate call now; continue from the retained result.",
					"Choose a different tool or input if the retained result is insufficient.",
				],
			},
			stuck: {
				what: "The same duplicate invocation keeps being emitted.",
				why: "The loop has not advanced despite prior guidance.",
				next: [
					"Change strategy before the next tool call; do not repeat the same fingerprint.",
					"Continue the task from retained results or pick a different action.",
				],
			},
		},
		recoveryDispositions: {
			first: "discard_duplicate",
			repeated: "discard_duplicate",
			stuck: "change_strategy",
		},
	},

	// -------------------------------------------------------------------------
	// 95 TOOL_NOT_FOUND — exact metadata flag from presentAssistantMessage.ts
	// -------------------------------------------------------------------------
	{
		id: "EI/TOOL_NOT_FOUND/001",
		category: "TOOL_NOT_FOUND",
		priority: 95,
		severity: "error",
		retryPolicy: "do-not-retry",
		requiresToolContext: true,
		matches: (signal) =>
			signal.source === "validation" && signal.stage === "preflight" && metadataIs(signal, "unknownTool", true),
		template: {
			what: "The tool name is not recognized or is not registered in this session.",
			why: "The model emitted a tool name that does not match any available core tool or MCP tool definition.",
			next: [
				"Review the list of available tools in the system prompt.",
				"Use only tool names that are explicitly defined in the current tool registry.",
				"Do not invent or guess tool names.",
			],
		},
	},

	// -------------------------------------------------------------------------
	// 94 MODE_RESTRICTION — exact metadata flag from presentAssistantMessage.ts
	// -------------------------------------------------------------------------
	{
		id: "EI/MODE_RESTRICTION/001",
		category: "MODE_RESTRICTION",
		priority: 94,
		severity: "error",
		retryPolicy: "do-not-retry",
		requiresToolContext: true,
		matches: (signal) =>
			signal.source === "validation" &&
			signal.stage === "preflight" &&
			metadataIs(signal, "modeRestriction", true),
		template: {
			what: "The tool is not allowed in the current mode.",
			why: "The active mode restricts which tools can be used. This tool was rejected by mode-level validation.",
			next: [
				"Check which tools are permitted in the current mode.",
				"Switch to a mode that allows this tool, or use an alternative tool that is permitted.",
				"Do not retry the same tool call in the same mode.",
			],
		},
	},

	// -------------------------------------------------------------------------
	// 93 FILE_RESTRICTION — exact metadata flag from presentAssistantMessage.ts
	// -------------------------------------------------------------------------
	{
		id: "EI/FILE_RESTRICTION/001",
		category: "FILE_RESTRICTION",
		priority: 93,
		severity: "error",
		retryPolicy: "do-not-retry",
		requiresToolContext: true,
		matches: (signal) =>
			signal.source === "validation" &&
			signal.stage === "preflight" &&
			metadataIs(signal, "fileRestriction", true),
		template: {
			what: "The tool was blocked by a file access restriction.",
			why: "A file-level restriction policy prevented this tool from operating on the requested path.",
			next: [
				"Verify the target path is within the allowed workspace scope.",
				"Use an alternative tool or request access through the appropriate permission flow.",
				"Do not retry the same path if the restriction is expected.",
			],
		},
	},

	// -------------------------------------------------------------------------
	// 92 PARSER_FAILURE_JSON_SYNTAX — exact metadata flag from parser
	// -------------------------------------------------------------------------
	{
		id: "EI/PARSER_FAILURE_JSON_SYNTAX/001",
		category: "PARSER_FAILURE_JSON_SYNTAX",
		priority: 92,
		severity: "error",
		retryPolicy: "correct-and-retry",
		requiresToolContext: true,
		matches: (signal) =>
			signal.source === "parser" &&
			signal.stage === "parse" &&
			metadataIs(signal, "parseFailureKind", "json_syntax"),
		template: {
			what: "The tool call arguments could not be parsed as valid JSON.",
			why: "The arguments string contained a JSON syntax error such as an unbalanced brace, trailing comma, or malformed value.",
			next: [
				"Re-emit the tool call with a single valid JSON object as arguments.",
				"Check for unbalanced braces, trailing commas, or unescaped characters.",
				"Do not concatenate multiple JSON objects into one arguments string.",
			],
		},
		occurrenceTemplates: {
			first: {
				what: "The tool call arguments could not be parsed as valid JSON.",
				why: "The arguments string contained a JSON syntax error. Only a parser-proven syntax class is reported here.",
				next: [
					"Re-emit one tool call with a single valid JSON object matching the tool schema, then continue the task.",
					"Check for unbalanced braces, trailing commas, or unescaped characters.",
				],
			},
			repeated: {
				what: "The same JSON syntax error was emitted again.",
				why: "Retrying the same malformed arguments cannot produce a valid parse.",
				next: [
					"Emit one corrected call with a single valid JSON object; do not repeat the prior arguments.",
					"Continue the task after the corrected call succeeds.",
				],
			},
			stuck: {
				what: "The same JSON syntax error keeps being emitted.",
				why: "The loop has not advanced despite prior guidance.",
				next: [
					"Change strategy before the next tool call; do not repeat the same malformed arguments.",
					"Continue the task from retained results or pick a different action.",
				],
			},
		},
		recoveryDispositions: {
			first: "correct_once",
			repeated: "correct_once",
			stuck: "change_strategy",
		},
	},

	// -------------------------------------------------------------------------
	// 91 PARSER_FAILURE_MISSING_ARGS — exact metadata flag from parser
	// -------------------------------------------------------------------------
	{
		id: "EI/PARSER_FAILURE_MISSING_ARGS/001",
		category: "PARSER_FAILURE_MISSING_ARGS",
		priority: 91,
		severity: "error",
		retryPolicy: "correct-and-retry",
		requiresToolContext: true,
		matches: (signal) =>
			signal.source === "parser" &&
			signal.stage === "parse" &&
			metadataIs(signal, "parseFailureKind", "missing_required_arguments"),
		template: {
			what: "The tool call is missing one or more required arguments.",
			why: "The JSON was syntactically valid but required fields were absent. The parser detected empty arguments or known missing parameter names.",
			next: [
				"Review the tool schema to identify all required parameters.",
				"Provide values for every required field in a single corrected tool call.",
				"Retry only once with the complete parameter set.",
			],
		},
		occurrenceTemplates: {
			first: {
				what: "The tool call is missing one or more required arguments.",
				why: "The JSON was syntactically valid but required fields were absent.",
				next: [
					"Provide values for every required field in a single corrected tool call, then continue the task.",
					"Review the tool schema if any required field name is unclear.",
				],
			},
			repeated: {
				what: "The same missing-required-arguments shape was emitted again.",
				why: "Retrying the same empty or incomplete arguments cannot satisfy the schema.",
				next: [
					"Emit one corrected call with all required fields; do not repeat the prior arguments.",
					"Continue the task after the corrected call succeeds.",
				],
			},
			stuck: {
				what: "The same missing-required-arguments shape keeps being emitted.",
				why: "The loop has not advanced despite prior guidance.",
				next: [
					"Change strategy before the next tool call; do not repeat the same incomplete arguments.",
					"Continue the task from retained results or pick a different action.",
				],
			},
		},
		recoveryDispositions: {
			first: "correct_once",
			repeated: "correct_once",
			stuck: "change_strategy",
		},
	},

	// -------------------------------------------------------------------------
	// 90 PARSER_FAILURE_INVALID_SHAPE — exact metadata flag from parser
	// -------------------------------------------------------------------------
	{
		id: "EI/PARSER_FAILURE_INVALID_SHAPE/001",
		category: "PARSER_FAILURE_INVALID_SHAPE",
		priority: 90,
		severity: "error",
		retryPolicy: "correct-and-retry",
		requiresToolContext: true,
		matches: (signal) =>
			signal.source === "parser" &&
			signal.stage === "parse" &&
			metadataIs(signal, "parseFailureKind", "invalid_argument_shape"),
		template: {
			what: "The tool call arguments had an invalid structural shape.",
			why: "The JSON was syntactically valid and required fields were present, but the value types or structure did not match the tool schema.",
			next: [
				"Re-read the tool schema for the expected field types.",
				"Ensure each argument matches the declared type (string, number, object, array).",
				"Submit one corrected native tool call; do not repeat blindly.",
			],
		},
		occurrenceTemplates: {
			first: {
				what: "The tool call arguments had an invalid structural shape.",
				why: "The JSON was syntactically valid but the value types or structure did not match the tool schema.",
				next: [
					"Re-emit one corrected call matching the declared field types, then continue the task.",
					"Re-read the tool schema for the expected field types.",
				],
			},
			repeated: {
				what: "The same invalid argument shape was emitted again.",
				why: "Retrying the same shape cannot satisfy the schema.",
				next: [
					"Emit one corrected call with the right types; do not repeat the prior arguments.",
					"Continue the task after the corrected call succeeds.",
				],
			},
			stuck: {
				what: "The same invalid argument shape keeps being emitted.",
				why: "The loop has not advanced despite prior guidance.",
				next: [
					"Change strategy before the next tool call; do not repeat the same shape.",
					"Continue the task from retained results or pick a different action.",
				],
			},
		},
		recoveryDispositions: {
			first: "correct_once",
			repeated: "correct_once",
			stuck: "change_strategy",
		},
	},

	// -------------------------------------------------------------------------
	// 90 PARAM_MISSING
	// -------------------------------------------------------------------------
	{
		id: "EI/PARAM_MISSING/001",
		category: "PARAM_MISSING",
		priority: 90,
		severity: "error",
		retryPolicy: "correct-and-retry",
		requiresToolContext: true,
		matches: (signal) =>
			(signal.source === "parser" && signal.stage === "parse" && metadataIs(signal, "missingNativeArgs", true)) ||
			(signal.source === "validation" &&
				signal.stage === "preflight" &&
				metadataIs(signal, "missingParameter", true)) ||
			metadataIs(signal, "pathEmpty", true) ||
			resultStatusIs(signal, "missing-parameter"),
		template: {
			what: "A required parameter for the tool is missing.",
			why: "The tool cannot determine which resource to operate on without the complete parameter set.",
			next: [
				"Identify the required parameter name from the tool schema.",
				"Provide a valid value of the expected type in a single corrected native tool call.",
				"Retry only once with the complete parameter set.",
			],
		},
	},

	// -------------------------------------------------------------------------
	// 87 PARAM_TYPE_MISMATCH variant: CWD_OBJECT_MISUSE
	// -------------------------------------------------------------------------
	{
		id: "EI/PARAM_TYPE_MISMATCH/002",
		category: "PARAM_TYPE_MISMATCH",
		priority: 87,
		severity: "error",
		retryPolicy: "correct-and-retry",
		requiresToolContext: true,
		matches: (signal) =>
			(signal.source === "validation" &&
				signal.stage === "preflight" &&
				metadataIs(signal, "variant", "CWD_OBJECT_MISUSE")) ||
			(signal.source === "validation" &&
				signal.stage === "preflight" &&
				errorMessageIncludes(signal, "cwd must be a string")),
		template: {
			what: "A parallel tool call corrupted the cwd parameter by embedding another call's object into it.",
			why: "When generating multiple tool calls simultaneously, parameters from one call bleed into another's cwd field. This is a parallel generation artifact, not an intentional parameter.",
			next: [
				"Generate tool calls ONE AT A TIME, never in parallel.",
				"Each tool call must have only its own parameters at the top level.",
				"Set 'cwd' to a simple workspace path string or omit it entirely.",
			],
		},
	},

	// -------------------------------------------------------------------------
	// 86 PARAM_TYPE_MISMATCH variant: NESTED_PARAM_OVERFLOW
	// -------------------------------------------------------------------------
	{
		id: "EI/PARAM_TYPE_MISMATCH/003",
		category: "PARAM_TYPE_MISMATCH",
		priority: 86,
		severity: "error",
		retryPolicy: "correct-and-retry",
		requiresToolContext: true,
		matches: (signal) =>
			(signal.source === "validation" &&
				signal.stage === "preflight" &&
				metadataIs(signal, "variant", "NESTED_PARAM_OVERFLOW")) ||
			(signal.source === "validation" &&
				signal.stage === "preflight" &&
				errorMessageIncludes(signal, "nested tool input object")),
		template: {
			what: "A parallel tool call embedded another call's parameters as a nested object.",
			why: "When generating multiple tool calls simultaneously, parameters from one call bleed into another. Each tool call must be completely independent with only its own parameters.",
			next: [
				"Generate tool calls ONE AT A TIME, never in parallel.",
				"Each tool call must contain only its own declared parameters.",
				"Never embed one tool call's structure inside another tool's parameter values.",
			],
		},
	},

	// -------------------------------------------------------------------------
	// 85 PARAM_TYPE_MISMATCH
	// -------------------------------------------------------------------------
	{
		id: "EI/PARAM_TYPE_MISMATCH/001",
		category: "PARAM_TYPE_MISMATCH",
		priority: 85,
		severity: "error",
		retryPolicy: "correct-and-retry",
		requiresToolContext: true,
		matches: (signal) =>
			(signal.source === "validation" &&
				signal.stage === "preflight" &&
				metadataIs(signal, "typeMismatch", true)) ||
			(signal.source === "tool_result" && resultStatusIs(signal, "invalid-argument")) ||
			(signal.source === "tool_result" && resultTypeIs(signal, "invalid_argument")) ||
			(errorCodeIs(signal, "-32602") && signal.source === "tool_result") ||
			(errorCodeIsNumber(signal, -32602) && signal.source === "tool_result"),
		template: {
			what: "A parameter value does not match the tool schema type.",
			why: "Runtime validation rejected the request before execution because a field had the wrong type or shape.",
			next: [
				"Re-read the tool schema for the flagged parameter.",
				"Correct only the reported field type and keep the rest unchanged.",
				"Submit one corrected native tool call; do not repeat blindly.",
			],
		},
	},

	// -------------------------------------------------------------------------
	// 80 FILE_NOT_FOUND
	// -------------------------------------------------------------------------
	{
		id: "EI/FILE_NOT_FOUND/001",
		category: "FILE_NOT_FOUND",
		priority: 80,
		severity: "error",
		retryPolicy: "alternate-tool",
		requiresToolContext: true,
		matches: (signal) =>
			(signal.source === "tool_result" && resultStatusIs(signal, "file-not-found")) ||
			(signal.source === "tool_result" && resultTypeIs(signal, "file_not_found")) ||
			(signal.source === "handler_exception" &&
				(errorCodeIs(signal, "ENOENT") ||
					(metadataIs(signal, "fileNotFound", true) && !metadataIs(signal, "pathEmpty", true)))),
		fallback: (signal) =>
			signal.source === "tool_result" &&
			isNonEmptyString(signal.result?.text) &&
			/^File does not exist|^cannot find path|^Path not found/i.test(signal.result.text.trim()),
		template: {
			what: "The requested path was not found in the workspace.",
			why: "The path may be misspelled, absolute, or relative to a different workspace root.",
			next: [
				"Use list_files or search_files to discover the actual relative path.",
				"Do not edit or write to a path until it has been verified to exist.",
				"Retry only with a confirmed workspace-relative path.",
			],
		},
	},

	// -------------------------------------------------------------------------
	// 75 SHELL_INTEGRATION
	// -------------------------------------------------------------------------
	{
		id: "EI/SHELL_INTEGRATION/001",
		category: "SHELL_INTEGRATION",
		priority: 75,
		severity: "error",
		retryPolicy: "alternate-tool",
		requiresToolContext: true,
		matches: (signal) =>
			(signal.source === "handler_exception" &&
				(errorNameIs(signal, "ShellIntegrationError") ||
					errorCodeIs(signal, "ShellIntegrationError") ||
					metadataIs(signal, "shellIntegrationError", true))) ||
			(signal.source === "tool_result" && resultTypeIs(signal, "shell_integration_error")),
		fallback: (signal) =>
			signal.source === "handler_exception" &&
			errorMessageIncludes(signal, "shell integration") &&
			!metadataIs(signal, "commandSubmitted", true),
		template: {
			what: "The terminal execution channel is unavailable due to a shell integration failure.",
			why: "The failure is in VS Code shell integration or terminal initialization, not the command itself.",
			next: [
				"Stop repeating the same shell command loop.",
				"Continue any work that does not require a shell using non-shell tools.",
				"If a shell is required, ask the user to restore the terminal environment.",
			],
		},
	},

	// -------------------------------------------------------------------------
	// 72 DIFF_MATCH_FAILED
	// -------------------------------------------------------------------------
	{
		id: "EI/DIFF_MATCH_FAILED/001",
		category: "DIFF_MATCH_FAILED",
		priority: 72,
		severity: "error",
		retryPolicy: "correct-and-retry",
		requiresToolContext: true,
		matches: (signal) =>
			signal.source === "tool_result" &&
			signal.stage === "result" &&
			signal.toolName === "apply_diff" &&
			isNonEmptyString(signal.result?.text) &&
			(resultTextIncludes(signal, "no sufficiently similar match found") ||
				(resultTextIncludes(signal, "similar") && resultTextIncludes(signal, "needs 100%"))),
		template: {
			what: "The diff could not be applied because the SEARCH text does not exactly match the current file content.",
			why: "The target file changed or the SEARCH block differs from the current content, so applying the replacement would be unsafe.",
			next: [
				"Use read_file to read the latest content around the failed line.",
				"Rebuild the SEARCH block from the exact current text, preserving spelling, whitespace, and indentation.",
				"Submit one corrected apply_diff call; do not repeat the unchanged diff.",
			],
		},
	},

	// -------------------------------------------------------------------------
	// 70 MCP_TOOL_MISSING
	// -------------------------------------------------------------------------
	{
		id: "EI/MCP_TOOL_MISSING/001",
		category: "MCP_TOOL_MISSING",
		priority: 70,
		severity: "error",
		retryPolicy: "alternate-tool",
		requiresToolContext: true,
		matches: (signal) =>
			(signal.source === "tool_result" && resultTypeIs(signal, "unknown_mcp_tool")) ||
			(signal.source === "tool_result" && resultStatusIs(signal, "unknown-tool")) ||
			(signal.source === "tool_result" && resultTypeIs(signal, "unknown_mcp_server")),
		template: {
			what: "The requested MCP tool or server is not registered or is unavailable.",
			why: "The tool name may belong to a different MCP namespace, or the server/tool is disabled.",
			next: [
				"Check the available MCP tools by examining the tool definitions provided in the system prompt or by using the list_mcp_tools command.",
				"Select a tool from the available server/tool list; do not guess names or invent namespaces.",
				"If no replacement exists, inform the user and stop retrying.",
			],
		},
	},

	// -------------------------------------------------------------------------
	// 66 INVALID_TOOL_PROTOCOL variant: XML_NATIVE_DUAL_PROTOCOL
	// -------------------------------------------------------------------------
	{
		id: "EI/INVALID_TOOL_PROTOCOL/002",
		category: "INVALID_TOOL_PROTOCOL",
		priority: 66,
		severity: "error",
		retryPolicy: "do-not-retry",
		requiresToolContext: false,
		matches: (signal) =>
			signal.source === "parser" &&
			signal.stage === "parse" &&
			(metadataIs(signal, "xmlNativeDualProtocol", true) || metadataIs(signal, "xmlMarkupInTextBlock", true)),
		template: {
			what: "XML tool markup was detected in a text block alongside a native tool call.",
			why: "The assistant turn contained both executable XML tool markup and a native tool_use block; only the native call was executed and the XML markup was stripped from the visible text.",
			next: [
				"Use native tool_use blocks only; do not emit XML or free-form tool markup.",
				"Remove all <tool_call>, <invoke>, <function=...>, and <parameter=...> tags from text output.",
				"If a tool call is needed, express it exclusively as a native tool_use block.",
			],
		},
	},

	// -------------------------------------------------------------------------
	// 65 INVALID_TOOL_PROTOCOL
	// -------------------------------------------------------------------------
	{
		id: "EI/INVALID_TOOL_PROTOCOL/001",
		category: "INVALID_TOOL_PROTOCOL",
		priority: 65,
		severity: "error",
		retryPolicy: "do-not-retry",
		requiresToolContext: false,
		matches: (signal) =>
			(signal.source === "parser" && signal.stage === "parse" && metadataIs(signal, "xmlToolCall", true)) ||
			(signal.source === "validation" &&
				signal.stage === "preflight" &&
				metadataIs(signal, "invalidProtocol", true)) ||
			(signal.source === "parser" && signal.stage === "parse" && metadataIs(signal, "missingToolCallId", true)),
		template: {
			what: "A native tool protocol violation was detected in the model output.",
			why: "Text markup or XML tool calls cannot be mapped to an executable tool call ID and typed arguments.",
			next: [
				"Do not emit XML or free-form tool markup in the response.",
				"Use the provider-native tool call format only.",
			],
		},
	},

	// -------------------------------------------------------------------------
	// 63 INVALID_JSON_ARGUMENTS
	// -------------------------------------------------------------------------
	{
		id: "EI/INVALID_JSON_ARGUMENTS/001",
		category: "INVALID_JSON_ARGUMENTS",
		priority: 63,
		severity: "error",
		retryPolicy: "correct-and-retry",
		requiresToolContext: true,
		matches: (signal) =>
			signal.source === "parser" && signal.stage === "parse" && metadataIs(signal, "invalidJsonArguments", true),
		template: {
			what: "Tool call arguments could not be parsed as JSON.",
			why: "The arguments string was not valid JSON. Only a parser-proven syntax class is reported; concatenation is not asserted unless the parser proves it.",
			next: [
				"Re-emit one tool call with a single valid JSON object as arguments.",
				"Check for unbalanced braces, trailing commas, or unescaped characters.",
			],
		},
		occurrenceTemplates: {
			first: {
				what: "Tool call arguments could not be parsed as JSON.",
				why: "The arguments string was not valid JSON. Only a parser-proven syntax class is reported.",
				next: [
					"Re-emit one tool call with a single valid JSON object matching the tool schema, then continue the task.",
					"Check for unbalanced braces, trailing commas, or unescaped characters.",
				],
			},
			repeated: {
				what: "The same invalid JSON arguments were emitted again.",
				why: "Retrying the same malformed arguments cannot produce a valid parse.",
				next: [
					"Emit one corrected call with a single valid JSON object; do not repeat the prior arguments.",
					"Continue the task after the corrected call succeeds.",
				],
			},
			stuck: {
				what: "The same invalid JSON arguments keep being emitted.",
				why: "The loop has not advanced despite prior guidance.",
				next: [
					"Change strategy before the next tool call; do not repeat the same malformed arguments.",
					"Continue the task from retained results or pick a different action.",
				],
			},
		},
		recoveryDispositions: {
			first: "correct_once",
			repeated: "correct_once",
			stuck: "change_strategy",
		},
	},

	// -------------------------------------------------------------------------
	// 60 CONTEXT_OVERFLOW
	// -------------------------------------------------------------------------
	{
		id: "EI/CONTEXT_OVERFLOW/001",
		category: "CONTEXT_OVERFLOW",
		priority: 60,
		severity: "error",
		retryPolicy: "auto-recover",
		requiresToolContext: false,
		matches: (signal) =>
			signal.source === "api_request" &&
			signal.stage === "api" &&
			(metadataIs(signal, "contextWindowExceeded", true) ||
				metadataIs(signal, "contextLengthExceeded", true) ||
				metadataIs(signal, "contextOverflow", true)),
		template: {
			what: "The provider rejected the request because the context exceeded its input capacity.",
			why: "Conversation history and tool schemas accumulated beyond the model's context window.",
			next: [
				"Continue from the automatic summary that will be provided.",
				"Do not repeat the request that failed.",
				"Break large outputs into smaller chunks and read them incrementally.",
			],
		},
	},

	// -------------------------------------------------------------------------
	// 0 UNCLASSIFIED
	// -------------------------------------------------------------------------
	{
		id: "EI/UNCLASSIFIED/001",
		category: "UNCLASSIFIED",
		priority: 0,
		severity: "error",
		retryPolicy: "do-not-retry",
		requiresToolContext: false,
		matches: () => true,
		template: {
			what: "The tool or request failed with an unrecognized error.",
			why: "The failure signature does not match any known recoverable pattern.",
			next: ["Check the raw error details shown in the UI.", "If retrying, change the input or tool first."],
		},
	},
]

/** Maximum length of a single NEXT suggestion in characters. */
export const NEXT_ITEM_CHAR_LIMIT = 160

/** Maximum number of NEXT suggestions in a guidance payload. */
export const NEXT_ITEM_COUNT_LIMIT = 3

/** Hard UTF-8 byte limit for the encoded model-facing JSON payload. */
export const MODEL_PAYLOAD_BYTE_LIMIT = 1024

/** Stable payload version. */
export const GUIDANCE_VERSION = 1
