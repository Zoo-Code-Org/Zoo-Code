/**
 * Settings passed to system prompt generation functions
 */
export interface SystemPromptSettings {
	todoListEnabled: boolean
	useAgentRules: boolean
	/** When true, recursively discover and load .roo/rules from subdirectories */
	enableSubfolderRules?: boolean
	newTaskRequireTodos: boolean
	/** When true, model should hide vendor/company identity in responses */
	isStealthModel?: boolean
}

/** Request-scoped inputs used to keep system-owned guidance aligned with available tools. */
export interface SystemPromptContext {
	availableToolNames: ReadonlySet<string>
	editFileRestriction?: {
		fileRegex: string
		description?: string
	}
}

export const FILE_EDIT_TOOL_NAMES = [
	"write_to_file",
	"apply_diff",
	"edit",
	"search_replace",
	"edit_file",
	"apply_patch",
] as const

/** Legacy section callers omit context and retain the existing all-tools wording. */
export function isPromptToolAvailable(context: SystemPromptContext | undefined, toolName: string): boolean {
	return context?.availableToolNames.has(toolName) ?? true
}

export function hasAnyPromptTool(context: SystemPromptContext | undefined, toolNames: readonly string[]): boolean {
	return toolNames.some((toolName) => isPromptToolAvailable(context, toolName))
}
