import { isMcpTool } from "../../../utils/mcp-name"
import { hasAnyPromptTool, isPromptToolAvailable, type SystemPromptContext } from "../types"

const ARCHITECT_TODO_STEP = /3\. Once you've gained more context[\s\S]*?(?=\n\n4\. As you gather)/
const ARCHITECT_TODO_UPDATE_STEP =
	/4\. As you gather more information or discover new requirements, update the todo list to reflect the current understanding of what needs to be accomplished\./
const ARCHITECT_TODO_IMPORTANCE =
	/\*\*IMPORTANT: Focus on creating clear, actionable todo lists rather than lengthy markdown documents\. Use the todo list as your primary planning tool to track and organize the work that needs to be done\.\*\*/
const ARCHITECT_SWITCH_STEP =
	/\n\n7\. Use the switch_mode tool to request that the user switch to another mode to implement the solution\./
const ARCHITECT_PLAN_FILE =
	/\n\nUnless told otherwise, if you want to save a plan file, put it in the \.\/plans directory \(a directory named "plans" relative to the workspace root, not the absolute filesystem path \/plans\)/
const PLAN_FILE_TOOL_NAMES = ["write_to_file", "apply_patch"] as const

/** Adjusts only Zoo-owned built-in mode instructions; user-authored instructions bypass this function. */
export function getBuiltInModeInstructions(mode: string, instructions: string, context?: SystemPromptContext): string {
	if (!context) {
		return instructions
	}

	if (mode === "ask") {
		const hasMcpOperations =
			context.availableToolNames.has("access_mcp_resource") ||
			Array.from(context.availableToolNames).some(isMcpTool)
		return hasMcpOperations ? instructions : instructions.replace(", and access external resources", "")
	}

	if (mode !== "architect") {
		return instructions
	}

	let result = instructions
	let changed = false
	const hasPlanFileTool = hasAnyPromptTool(context, PLAN_FILE_TOOL_NAMES)

	if (!isPromptToolAvailable(context, "update_todo_list")) {
		const planDestination = hasPlanFileTool
			? "write the plan to a markdown file (e.g., `plan.md` or `todo.md`)"
			: "present the plan directly in your response"
		result = result.replace(
			ARCHITECT_TODO_STEP,
			`3. Once you've gained more context about the user's request, break down the task into clear, actionable steps and ${planDestination}. Each plan item should be:\n   - Specific and actionable\n   - Listed in logical execution order\n   - Focused on a single, well-defined outcome\n   - Clear enough that another mode could execute it independently`,
		)
		result = result.replace(
			ARCHITECT_TODO_UPDATE_STEP,
			"4. As you gather more information or discover new requirements, update the plan to reflect the current understanding of what needs to be accomplished.",
		)
		result = result.replace("refine the todo list", "refine the plan")
		result = result.replace(
			ARCHITECT_TODO_IMPORTANCE,
			"**IMPORTANT: Focus on creating a clear, actionable plan rather than a lengthy markdown document.**",
		)
		changed = true
	}

	if (!isPromptToolAvailable(context, "switch_mode")) {
		result = result.replace(ARCHITECT_SWITCH_STEP, "")
		changed = true
	}

	if (!hasPlanFileTool) {
		result = result.replace(ARCHITECT_PLAN_FILE, "")
		changed = true
	}

	if (changed) {
		let step = 0
		result = result.replace(/^\d+\. /gm, () => `${++step}. `)
	}

	return result
}
