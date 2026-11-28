import type { IconName } from "../../Icon.js"
import type { ToolCategory } from "../types.js"
import { getToolCategory } from "../types.js"
import { getToolDisplayName, getToolIconName } from "../utils.js"

describe("parallel subtasks display mapping", () => {
	it.each(["parallelSubtasks", "parallel_subtasks"])("returns a friendly display name for %s", (toolName) => {
		expect(getToolDisplayName(toolName)).toBe("Parallel Subtasks")
	})

	it.each(["parallelSubtasks", "parallel_subtasks"])("returns the delegation icon for %s", (toolName) => {
		expect(getToolIconName(toolName)).toBe("switch")
	})

	it.each(["parallelSubtasks", "parallel_subtasks"])("routes %s to the generic renderer", (toolName) => {
		// ModeTool renders only an icon for tools whose name lacks "switch", so the
		// label would disappear if this row were routed to the mode category.
		expect(getToolCategory(toolName)).toBe("other")
	})
})

describe("existing tool display mapping", () => {
	const cases: Array<{ tool: string; displayName: string; icon: IconName; category: ToolCategory }> = [
		{ tool: "newTask", displayName: "New Task", icon: "switch", category: "mode" },
		{ tool: "new_task", displayName: "New Task", icon: "switch", category: "mode" },
		{ tool: "finishTask", displayName: "Finish Task", icon: "check", category: "mode" },
		{ tool: "switchMode", displayName: "Switch Mode", icon: "switch", category: "mode" },
		{ tool: "switch_mode", displayName: "Switch Mode", icon: "switch", category: "mode" },
		{ tool: "attempt_completion", displayName: "Task Complete", icon: "check", category: "completion" },
	]

	it.each(cases)("keeps the $tool mapping intact", ({ tool, displayName, icon, category }) => {
		expect(getToolDisplayName(tool)).toBe(displayName)
		expect(getToolIconName(tool)).toBe(icon)
		expect(getToolCategory(tool)).toBe(category)
	})
})
