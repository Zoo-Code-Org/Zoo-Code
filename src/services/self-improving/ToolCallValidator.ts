import { ErrorClassifier, ErrorCategory } from "./ErrorClassifier"

export interface ValidationResult {
	valid: boolean
	warnings: string[]
	suggestions: string[]
}

export class ToolCallValidator {
	private errorClassifier: ErrorClassifier

	constructor() {
		this.errorClassifier = new ErrorClassifier()
	}

	validate(toolName: string, params: Record<string, unknown>): ValidationResult {
		const warnings: string[] = []
		const suggestions: string[] = []

		switch (toolName) {
			case "read_file": {
				const path = params.path as string | undefined
				if (path && !path.includes(".")) {
					warnings.push("Path has no file extension — may be a directory")
					suggestions.push("Use list_files instead of read_file for directories")
				}
				if (path && path.endsWith("/")) {
					warnings.push("Path ends with '/' — this is likely a directory")
					suggestions.push("Use list_files tool to list directory contents")
				}
				break
			}

			case "list_files": {
				const recursive = params.recursive
				if (recursive === true) {
					warnings.push("Recursive listing may fail if ripgrep is unavailable")
					suggestions.push(
						"If list_files fails, use 'find PATH -type f' via execute_command",
					)
				}
				break
			}

			case "search_files": {
				if (!params.regex) {
					warnings.push("Missing required 'regex' parameter")
					suggestions.push("Provide a valid regex pattern for the search")
				}
				if (!params.path) {
					warnings.push("Missing 'path' parameter — searching entire workspace may be slow")
					suggestions.push("Specify a directory path to limit the search scope")
				}
				break
			}

			case "execute_command": {
				const command = params.command as string | undefined
				if (command && command.length > 1000) {
					warnings.push("Command is very long — may exceed shell limits")
					suggestions.push("Break the command into smaller parts")
				}
				if (command && command.includes("rm -rf")) {
					warnings.push("Command contains 'rm -rf' — destructive operation")
					suggestions.push("Verify the target path before executing destructive commands")
				}
				break
			}

			case "write_to_file": {
				const content = params.content as string | undefined
				if (content && content.length > 50_000) {
					warnings.push("File content is very large (>50KB)")
					suggestions.push("Consider splitting the file into smaller modules")
				}
				break
			}

			case "apply_diff": {
				if (!params.diff) {
					warnings.push("Missing required 'diff' parameter")
					suggestions.push("Provide the diff content to apply")
				}
				if (!params.path) {
					warnings.push("Missing required 'path' parameter")
					suggestions.push("Specify the file path to edit")
				}
				break
			}

			case "attempt_completion": {
				if (!params.result) {
					warnings.push("Missing required 'result' parameter")
					suggestions.push("Provide the completion result message")
				}
				break
			}

			case "ask_followup_question": {
				if (!params.question) {
					warnings.push("Missing required 'question' parameter")
					suggestions.push("Provide the question to ask the user")
				}
				break
			}

			case "new_task": {
				if (!params.mode) {
					warnings.push("Missing required 'mode' parameter")
					suggestions.push("Specify the mode for the new task")
				}
				if (!params.message) {
					warnings.push("Missing required 'message' parameter")
					suggestions.push("Provide the task message")
				}
				break
			}
		}

		return {
			valid: warnings.length === 0,
			warnings,
			suggestions,
		}
	}

	getPreventionHints(
		toolName: string,
		recentErrors: Array<{ toolName: string; category: ErrorCategory }>,
	): string[] {
		const hints: string[] = []

		// Check if this tool has failed recently
		const recentFailures = recentErrors.filter((e) => e.toolName === toolName)
		if (recentFailures.length >= 2) {
			const categories = [...new Set(recentFailures.map((e) => e.category))]
			for (const cat of categories) {
				const classified = this.errorClassifier.classify(cat, toolName)
				hints.push(`⚠️ Previous ${toolName} calls failed: ${classified.suggestion}`)
			}
		}

		return hints
	}
}
