export interface AutonomousValidationOptions {
	autonomous: boolean
	mode?: string
	requireApproval?: boolean
	print?: boolean
	stdinPromptStream?: boolean
	workspace?: string
	timeout?: number
	providerBaseUrl?: string
	provider?: string
}

export type ValidationError = {
	message: string
}

/**
 * Validates autonomous mode configuration flags.
 * Returns an array of validation errors, or an empty array if valid.
 */
export function validateAutonomousFlags(options: AutonomousValidationOptions): ValidationError[] {
	const errors: ValidationError[] = []

	if (!options.autonomous) {
		return errors
	}

	if (options.mode) {
		errors.push({ message: "--mode cannot be used with --autonomous; root mode is always orchestrator" })
	}

	if (options.requireApproval) {
		errors.push({ message: "--require-approval cannot be used with --autonomous" })
	}

	if (!options.print) {
		errors.push({ message: "--autonomous requires --print" })
	}

	if (options.stdinPromptStream) {
		errors.push({
			message: "--autonomous runs exactly one root task and cannot use --stdin-prompt-stream",
		})
	}

	if (!options.workspace) {
		errors.push({ message: "--autonomous requires an explicit --workspace" })
	}

	if (!Number.isFinite(options.timeout) || (options.timeout ?? 0) <= 0) {
		errors.push({ message: "--autonomous requires --timeout with a positive number of seconds" })
	}

	if (options.providerBaseUrl && options.provider !== "openrouter") {
		errors.push({ message: "--provider-base-url is currently supported only with --provider openrouter" })
	}

	return errors
}

/**
 * Validates that provider-base-url is only used with openrouter provider.
 */
export function validateProviderBaseUrl(
	providerBaseUrl: string | undefined,
	provider: string | undefined,
): ValidationError | null {
	if (providerBaseUrl && provider !== "openrouter") {
		return { message: "--provider-base-url is currently supported only with --provider openrouter" }
	}
	return null
}
