import type OpenAI from "openai"

import type { ResolvedCommandEnvironment } from "../../../../integrations/terminal/shell/types"

/**
 * Builds the execute_command tool description from the resolved command
 * environment. The description states:
 * - the exact effective shell family,
 * - the correct chaining operator,
 * - PowerShell cmdlet guidance only when the family is PowerShell,
 * - POSIX guidance only for bash/WSL/POSIX families,
 * - that inline execution is non-interactive,
 * - that the fallback, when available, preserves shell syntax.
 *
 * When no environment is provided, falls back to a generic description.
 */
function buildExecuteCommandDescription(env?: ResolvedCommandEnvironment): string {
	const baseDesc = `Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task. You must tailor your command to the user's system and provide a clear explanation of what the command does. For command chaining, use the appropriate chaining syntax for the user's shell. Prefer to execute complex CLI commands over creating executable scripts, as they are more flexible and easier to run. Prefer relative commands and paths that avoid location sensitivity for terminal consistency.`

	if (!env) {
		return baseDesc
	}

	const d = env.promptDescriptor
	const family = env.primaryPlan.family
	const chainOp = env.chainOperator

	const lines: string[] = [baseDesc, ""]

	// Shell family and chaining information
	lines.push(`Command execution shell: ${d.shellFamilyLabel} (${d.shellExecutableName}).`)
	lines.push(`Command chaining operator: \`${chainOp}\`.`)

	if (d.isNonInteractive) {
		lines.push("Inline execution is non-interactive: commands run without loading interactive profile scripts.")
	}

	// Shell-specific guidance
	if (family === "powershell") {
		lines.push(
			"PowerShell guidance: Use PowerShell cmdlets instead of Unix utilities. Use `Select-String` for grep, `Get-Content` for cat, `Remove-Item` for rm, `Copy-Item` for cp, `Move-Item` for mv, and PowerShell's `-replace` operator or `[regex]` for sed.",
		)
	} else if (family === "cmd") {
		lines.push(
			"Command Prompt guidance: Use built-in commands like `type` for cat, `del` for rm, `copy` for cp, `move` for mv, `find`/`findstr` for grep.",
		)
	} else if (family === "posix" || family === "wsl" || family === "fish") {
		lines.push("POSIX guidance: Standard Unix utilities (sed, grep, awk, cat, rm, cp, mv) are available.")
	}

	// Fallback behavior
	if (env.fallbackPlan && env.fallbackPlan.family === env.primaryPlan.family) {
		lines.push(
			`If shell integration fails before command submission, the command is retried using the same shell family (${d.shellFamilyLabel}). Shell syntax is preserved across fallback.`,
		)
	}

	return lines.join("\n")
}

const COMMAND_PARAMETER_DESCRIPTION = `Shell command to execute`

const CWD_PARAMETER_DESCRIPTION = `Optional working directory for the command, relative or absolute`

const TIMEOUT_PARAMETER_DESCRIPTION = `Timeout in seconds. When exceeded, the command continues running in the background and output collected so far is returned. Use this for long-running processes like dev servers, file watchers, or any command that may not exit on its own`

/**
 * Factory that creates the execute_command tool definition from the resolved
 * command environment. The tool description includes the exact shell family,
 * correct chaining operator, and shell-specific guidance.
 *
 * When no environment is provided, falls back to a generic description.
 *
 * @param env Optional resolved command environment snapshot.
 * @returns The execute_command tool definition.
 */
export function createExecuteCommandTool(env?: ResolvedCommandEnvironment): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: {
			name: "execute_command",
			description: buildExecuteCommandDescription(env),
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
				},
				required: ["command", "cwd", "timeout"],
				additionalProperties: false,
			},
		},
	} satisfies OpenAI.Chat.ChatCompletionTool
}

/**
 * Default execute_command tool with a generic description.
 * Used when no resolved environment is available (legacy callers).
 */
const executeCommandDefault = createExecuteCommandTool()

export default executeCommandDefault
