/** Parameters required to generate a commit message for selected Git changes. */
export interface GenerateMessageParams {
	/** Absolute workspace path used to resolve repository custom instructions. */
	workspacePath: string
	/** File paths included in the Git context used for generation. */
	selectedFiles: string[]
	/** Markdown Git context describing the changes to summarize. */
	gitContext: string
	/** Optional progress callback for UI updates during generation. */
	onProgress?: (progress: ProgressUpdate) => void
}

/** Prompt customization and regeneration context for commit-message prompts. */
export interface PromptOptions {
	/** User-defined support prompt templates keyed by prompt type. */
	customSupportPrompts?: Record<string, string>
	/** Previous Git context used to detect regeneration for the same changes. */
	previousContext?: string
	/** Previous generated message to avoid repeating during regeneration. */
	previousMessage?: string
}

/** Incremental status update emitted while generating a commit message. */
export interface ProgressUpdate {
	/** Human-readable status message for the current generation step. */
	message?: string
	/** Absolute progress percentage for the current generation step. */
	percentage?: number
	/** Relative progress increment for the current generation step. */
	increment?: number
}
