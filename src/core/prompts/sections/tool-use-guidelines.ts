import type { EffectiveToolPolicy } from "../tools/effective-tool-policy"

/**
 * Builds the TOOL USE GUIDELINES section of the system prompt.
 *
 * Guideline 2's example names `list_files` over `ls`; that example is only kept
 * when `list_files` is in the request's effective tool policy.
 *
 * @param policy The request's effective tool policy.
 */
export function getToolUseGuidelinesSection(policy: EffectiveToolPolicy): string {
	const listExample = policy.tools.has("list_files")
		? " For example using the list_files tool is more effective than running a command like `ls` in the terminal."
		: ""

	return `# Tool Use Guidelines

1. Assess what information you already have and what information you need to proceed with the task.
2. Choose the most appropriate tool based on the task and the tool descriptions provided. Assess if you need additional information to proceed, and which of the available tools would be most effective for gathering this information.${listExample} It's critical that you think about each available tool and use the one that best fits the current step in the task.
3. If multiple actions are needed, you may use multiple tools in a single message when appropriate, or use tools iteratively across messages. Each tool use should be informed by the results of previous tool uses. Do not assume the outcome of any tool use. Each step must be informed by the previous step's result.

By carefully considering the user's response after tool executions, you can react accordingly and make informed decisions about how to proceed with the task. This iterative process helps ensure the overall success and accuracy of your work.`
}
