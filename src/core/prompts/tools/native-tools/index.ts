import type OpenAI from "openai"
import accessMcpResource from "./access_mcp_resource"
import { apply_diff } from "./apply_diff"
import applyPatch from "./apply_patch"
import askFollowupQuestion from "./ask_followup_question"
import attemptCompletion from "./attempt_completion"
import codebaseSearch from "./codebase_search"
import editTool from "./edit"
import { createExecuteCommandTool } from "./execute_command"
import generateImage from "./generate_image"
import listFiles from "./list_files"
import newTask from "./new_task"
import readCommandOutput from "./read_command_output"
import { createReadFileTool, type ReadFileToolOptions } from "./read_file"
import runSlashCommand from "./run_slash_command"
import skill from "./skill"
import searchReplace from "./search_replace"
import edit_file from "./edit_file"
import searchFiles from "./search_files"
import switchMode from "./switch_mode"
import updateTodoList from "./update_todo_list"
import writeToFile from "./write_to_file"
import type { ResolvedCommandEnvironment } from "../../../../integrations/terminal/shell/types"

export { getMcpServerTools } from "./mcp_server"
export { convertOpenAIToolToAnthropic, convertOpenAIToolsToAnthropic } from "./converters"
export type { ReadFileToolOptions } from "./read_file"
export { createExecuteCommandTool } from "./execute_command"

/**
 * Options for customizing the native tools array.
 */
export interface NativeToolsOptions {
	/** Whether the model supports image processing (default: false) */
	supportsImages?: boolean
	/** Resolved command environment for shell-aware tool descriptions. */
	resolvedEnv?: ResolvedCommandEnvironment
}

/**
 * Get native tools array, optionally customizing based on settings.
 *
 * When `resolvedEnv` is provided, the execute_command tool description is
 * generated from the resolved environment — stating the exact shell family,
 * correct chaining operator, and shell-specific guidance.
 *
 * @param options - Configuration options for the tools
 * @returns Array of native tool definitions
 */
export function getNativeTools(options: NativeToolsOptions = {}): OpenAI.Chat.ChatCompletionTool[] {
	const { supportsImages = false, resolvedEnv } = options

	const readFileOptions: ReadFileToolOptions = {
		supportsImages,
	}

	return [
		accessMcpResource,
		apply_diff,
		applyPatch,
		askFollowupQuestion,
		attemptCompletion,
		codebaseSearch,
		// Use the factory to create a shell-aware execute_command tool when
		// a resolved environment is available. Otherwise, use the default.
		createExecuteCommandTool(resolvedEnv),
		generateImage,
		listFiles,
		newTask,
		readCommandOutput,
		createReadFileTool(readFileOptions),
		runSlashCommand,
		skill,
		searchReplace,
		edit_file,
		editTool,
		searchFiles,
		switchMode,
		updateTodoList,
		writeToFile,
	] satisfies OpenAI.Chat.ChatCompletionTool[]
}

// Backward compatibility: export default tools with line ranges enabled
export const nativeTools = getNativeTools()
