import type OpenAI from "openai"

const EXECUTE_COMMAND_DESCRIPTION = `Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task. You must tailor your command to the user's system and provide a clear explanation of what the command does. For command chaining, use the appropriate chaining syntax for the user's shell. Prefer to execute complex CLI commands over creating executable scripts, as they are more flexible and easier to run. Prefer relative commands and paths that avoid location sensitivity for terminal consistency.

Parameters:
- command: (required) The CLI command to execute. This should be valid for the current operating system. Ensure the command is properly formatted and does not contain any harmful instructions.
- cwd: (optional) The working directory to execute the command in
- timeout: (optional) Timeout in seconds. When exceeded, the command keeps running in the background and you receive the output so far. Set this for commands that may run indefinitely, such as dev servers or file watchers, so you can proceed without waiting for them to exit.

Example: Executing npm run dev
{ "command": "npm run dev", "cwd": null, "timeout": null }

Example: Executing ls in a specific directory if directed
{ "command": "ls -la", "cwd": "/home/user/projects", "timeout": null }

Example: Using relative paths
{ "command": "touch ./testdata/example.file", "cwd": null, "timeout": null }

Example: Running a build with a timeout
{ "command": "npm run build", "cwd": null, "timeout": 30 }`

const COMMAND_PARAMETER_DESCRIPTION = `Shell command to execute`

const CWD_PARAMETER_DESCRIPTION = `Optional working directory for the command, relative or absolute`

const TIMEOUT_PARAMETER_DESCRIPTION = `Timeout in seconds. When exceeded, the command continues running in the background and output collected so far is returned. Use this for long-running processes like dev servers, file watchers, or any command that may not exit on its own`

export default {
	type: "function",
	function: {
		name: "execute_command",
		description: EXECUTE_COMMAND_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: COMMAND_PARAMETER_DESCRIPTION,
				},
				cwd: {
					type: ["string", "null"],
					description: CWD_PARAMETER_DESCRIPTION,
				},
				timeout: {
					type: ["number", "null"],
					description: TIMEOUT_PARAMETER_DESCRIPTION,
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
			required: ["command", "cwd", "timeout", "ref", "multi_ref", "transform"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
