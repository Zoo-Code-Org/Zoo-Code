import type OpenAI from "openai"

const PARALLEL_SUBTASKS_DESCRIPTION = `Spawn up to 6 read-only investigation tasks that run in parallel in the background and report their findings back to you.

Contract:
- Each child can ONLY read and report. It cannot write files, run commands, switch modes, spawn its own subtasks, or ask you anything.
- Each child reports its findings through attempt_completion. The host saves each report to a .md file and returns a summary plus the report paths to you, so you can act on the findings in a later step.
- label must be unique among the tasks of one call. It names the child's report file and its UI row, so keep it short and descriptive (for example "api-surface").
- mode is the mode slug the child runs in (e.g., code, debug, architect). Different modes may use different models, so pick the mode that fits each investigation.

Use this tool when several independent investigations can run at once. Do NOT use it for work that must be sequential, and do NOT use it for anything that changes files because children have no write access.

Parameters:
- tasks: (required) The investigations to run in parallel. At most 6 children per call; excess requests are dropped. A call that lists more than 50 tasks is rejected instead of run.
- tasks[].label: (optional) Sibling-unique short label used for the report filename and the UI row. When omitted or blank it defaults to child-N (the task's 1-based position); duplicate labels gain a numeric suffix to stay sibling-unique.
- tasks[].mode: (required) Mode slug the child runs in.
- tasks[].message: (required) The investigation prompt for the child.

Example: Two independent investigations
{ "tasks": [{ "label": "api-surface", "mode": "code", "message": "Map the public API of src/core/task." }, { "label": "test-gaps", "mode": "debug", "message": "Find untested branches in the task scheduler." }] }`

const TASKS_PARAMETER_DESCRIPTION = `Read-only investigations to run in parallel; at most 6 per call, excess requests are dropped (a call listing more than 50 tasks is rejected)`

const LABEL_PARAMETER_DESCRIPTION = `Sibling-unique short label used for the report filename and the UI row; optional, defaults to child-N (1-based position) when omitted or blank, duplicates get a numeric suffix`

const MODE_PARAMETER_DESCRIPTION = `Mode slug the child runs in (e.g., code, debug, architect)`

const MESSAGE_PARAMETER_DESCRIPTION = `Investigation prompt for the child; the child reports findings back through attempt_completion`

export default {
	type: "function",
	function: {
		name: "parallel_subtasks",
		description: PARALLEL_SUBTASKS_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				tasks: {
					type: "array",
					description: TASKS_PARAMETER_DESCRIPTION,
					items: {
						type: "object",
						properties: {
							label: {
								type: ["string", "null"],
								description: LABEL_PARAMETER_DESCRIPTION,
							},
							mode: {
								type: "string",
								description: MODE_PARAMETER_DESCRIPTION,
							},
							message: {
								type: "string",
								description: MESSAGE_PARAMETER_DESCRIPTION,
							},
						},
						// Strict schemas must list every declared property as
						// required; an unused label arrives as null.
						required: ["label", "mode", "message"],
						additionalProperties: false,
					},
				},
			},
			required: ["tasks"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
