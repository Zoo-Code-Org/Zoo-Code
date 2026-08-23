import type OpenAI from "openai"

/**
 * DTE series 3/5: native tool schema for model-driven per-turn thinking effort.
 *
 * The tool is only exposed when the dynamicThinkingEffort experiment is on and
 * the current model supports per-request reasoning effort (see
 * filter-tools-for-mode.ts). The gate is evaluated at task start only so the
 * tool list stays stable within a task (prompt-cache safety).
 */
const SET_THINKING_EFFORT_DESCRIPTION = `Adjust your own thinking (reasoning) effort for the remainder of this task. Use it when the task complexity changes mid-task — for example, when a simple lookup turns into a deep multi-file refactor, or when a straightforward step follows a hard one. The change takes effect from the next model request and applies to the current task only; it is never written to persisted settings and requires no user approval.

Parameters:
- effort: (required) The new thinking effort level. Must be one of the levels supported by the current model.
- reason: (required) A one-sentence explanation of why the effort is changing. It is shown to the user alongside the new level.

Example: Escalating after a complex bug
{ "effort": "high", "reason": "The refactor spans 6 files with cross-cutting type changes; deeper reasoning is needed." }

Example: De-escalating after a hard phase
{ "effort": "low", "reason": "Remaining work is mechanical test updates for already-verified behavior." }`

const EFFORT_PARAMETER_DESCRIPTION = `The new thinking effort level (one of the levels supported by the current model)`

const REASON_PARAMETER_DESCRIPTION = `A one-sentence explanation of why the effort is changing; shown to the user`

export default {
	type: "function",
	function: {
		name: "set_thinking_effort",
		description: SET_THINKING_EFFORT_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				effort: {
					type: "string",
					description: EFFORT_PARAMETER_DESCRIPTION,
				},
				reason: {
					type: "string",
					description: REASON_PARAMETER_DESCRIPTION,
				},
			},
			required: ["effort", "reason"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
