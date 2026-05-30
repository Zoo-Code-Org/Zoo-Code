export enum ErrorCategory {
	FILE_NOT_FOUND = "FILE_NOT_FOUND",
	DIRECTORY_CONFUSION = "DIRECTORY_CONFUSION",
	TOOL_NOT_FOUND = "TOOL_NOT_FOUND",
	PERMISSION_DENIED = "PERMISSION_DENIED",
	RATE_LIMITED = "RATE_LIMITED",
	AUTH_FAILED = "AUTH_FAILED",
	NETWORK_ERROR = "NETWORK_ERROR",
	TIMEOUT = "TIMEOUT",
	INVALID_PARAMS = "INVALID_PARAMS",
	MODEL_THOUGHT_FAILURE = "MODEL_THOUGHT_FAILURE",
	EMPTY_RESPONSE = "EMPTY_RESPONSE",
	CASCADE_FAILURE = "CASCADE_FAILURE",
	UNKNOWN = "UNKNOWN",
}

export interface ClassifiedError {
	category: ErrorCategory
	severity: 1 | 2 | 3 | 4 | 5
	toolName?: string
	paramName?: string
	suggestion: string
	isRecoverable: boolean
	recoveryAction?: string
}

export class ErrorClassifier {
	classify(errorMessage: string, toolName?: string): ClassifiedError {
		// Directory confusion — trying to read a directory as file (Situations C, E)
		if (errorMessage.includes("is a directory") || errorMessage.includes("Cannot read")) {
			return {
				category: ErrorCategory.DIRECTORY_CONFUSION,
				severity: 3,
				toolName,
				suggestion: "Use list_files tool instead of read_file for directories",
				isRecoverable: true,
				recoveryAction: "switch_to_list_files",
			}
		}

		// ripgrep / rg ENOENT (Situation B)
		if (
			errorMessage.includes("ripgrep") ||
			errorMessage.includes("rg ENOENT") ||
			(errorMessage.includes("ENOENT") && errorMessage.includes("rg"))
		) {
			return {
				category: ErrorCategory.TOOL_NOT_FOUND,
				severity: 4,
				toolName,
				suggestion:
					"ripgrep is not available. Use 'find' or 'ls' commands via execute_command instead of list_files",
				isRecoverable: true,
				recoveryAction: "use_find_instead_of_list_files",
			}
		}

		// Model thought process failure (Situation A)
		if (
			errorMessage.includes("Zoo is having trouble") ||
			errorMessage.includes("failure in the model's thought process")
		) {
			return {
				category: ErrorCategory.MODEL_THOUGHT_FAILURE,
				severity: 4,
				toolName,
				suggestion:
					"[Context Recovery] The previous attempt failed. Break down the task into smaller steps. Try using a simpler approach or different tool. Relevant code context will be injected automatically.",
				isRecoverable: true,
				recoveryAction: "break_down_task",
			}
		}

		// Empty response — tool returned nothing (Situation D)
		if (
			errorMessage === "" ||
			errorMessage === "Running" ||
			!errorMessage ||
			errorMessage.trim().length === 0
		) {
			return {
				category: ErrorCategory.EMPTY_RESPONSE,
				severity: 3,
				toolName,
				suggestion:
					"The tool returned no output. Verify the command parameters and try again with explicit flags.",
				isRecoverable: true,
				recoveryAction: "retry_with_explicit_params",
			}
		}

		// File not found
		if (
			errorMessage.includes("no such file") ||
			errorMessage.includes("ENOENT") ||
			errorMessage.includes("not found")
		) {
			return {
				category: ErrorCategory.FILE_NOT_FOUND,
				severity: 3,
				toolName,
				paramName: this.extractPath(errorMessage),
				suggestion:
					"Verify the file path exists before reading. Use list_files to check the directory contents first.",
				isRecoverable: true,
				recoveryAction: "verify_path_first",
			}
		}

		// Permission denied
		if (errorMessage.includes("Permission denied") || errorMessage.includes("EACCES")) {
			return {
				category: ErrorCategory.PERMISSION_DENIED,
				severity: 4,
				toolName,
				suggestion: "The operation requires elevated permissions. Try using sudo or a different path.",
				isRecoverable: false,
			}
		}

		// Rate limited
		if (
			errorMessage.includes("rate limit") ||
			errorMessage.includes("too many requests") ||
			errorMessage.includes("429")
		) {
			return {
				category: ErrorCategory.RATE_LIMITED,
				severity: 3,
				toolName,
				suggestion: "Rate limit exceeded. Wait before retrying or reduce request frequency.",
				isRecoverable: true,
				recoveryAction: "backoff_and_retry",
			}
		}

		// Auth failure
		if (
			errorMessage.includes("auth") ||
			errorMessage.includes("unauthorized") ||
			errorMessage.includes("401") ||
			errorMessage.includes("403")
		) {
			return {
				category: ErrorCategory.AUTH_FAILED,
				severity: 5,
				toolName,
				suggestion: "Authentication failed. Check credentials and try again.",
				isRecoverable: false,
			}
		}

		// Network error
		if (
			errorMessage.includes("network") ||
			errorMessage.includes("ECONNREFUSED") ||
			errorMessage.includes("ECONNRESET") ||
			errorMessage.includes("ETIMEDOUT") ||
			errorMessage.includes("ENOTFOUND")
		) {
			return {
				category: ErrorCategory.NETWORK_ERROR,
				severity: 4,
				toolName,
				suggestion: "Network error occurred. Check connectivity and try again.",
				isRecoverable: true,
				recoveryAction: "retry_after_connectivity_check",
			}
		}

		// Timeout
		if (errorMessage.includes("timeout") || errorMessage.includes("timed out")) {
			return {
				category: ErrorCategory.TIMEOUT,
				severity: 3,
				toolName,
				suggestion: "The operation timed out. Try with a longer timeout or smaller scope.",
				isRecoverable: true,
				recoveryAction: "retry_with_longer_timeout",
			}
		}

		// Invalid params
		if (
			errorMessage.includes("parameter") ||
			errorMessage.includes("missing") ||
			errorMessage.includes("required")
		) {
			return {
				category: ErrorCategory.INVALID_PARAMS,
				severity: 3,
				toolName,
				paramName: this.extractParamName(errorMessage),
				suggestion: "Check the tool parameters. A required parameter may be missing or invalid.",
				isRecoverable: true,
				recoveryAction: "fix_parameters",
			}
		}

		return {
			category: ErrorCategory.UNKNOWN,
			severity: 3,
			toolName,
			suggestion: "An unexpected error occurred. Check the error details and try a different approach.",
			isRecoverable: false,
		}
	}

	private extractPath(errorMessage: string): string | undefined {
		const match = errorMessage.match(/'([^']+)'|"([^"]+)"/)
		return match?.[1] || match?.[2] || undefined
	}

	private extractParamName(errorMessage: string): string | undefined {
		const match = errorMessage.match(/parameter\s+'([^']+)'/i)
		return match?.[1] || undefined
	}
}
