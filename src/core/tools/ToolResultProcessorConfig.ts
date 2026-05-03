/**
 * Configuration for the ToolResultProcessor.
 * Controls thresholds for when compression kicks in.
 */
export interface ToolResultProcessorConfig {
	/** Master switch — false disables all LLM compression */
	enabled: boolean

	/** Whether the user is a subscriber (LLM compression requires subscription) */
	isSubscriber: boolean

	/** Character thresholds per tool type. Results below these are not compressed. */
	thresholds: {
		/** Compress read_file results above this many characters (default: 1500) */
		readFileCharsAbove: number
		/** Compress search_files results above this many matches (default: 20) */
		searchMatchesAbove: number
		/** Compress list_files results above this many paths (default: 100) */
		listFilesCountAbove: number
		/** Compress execute_command results above this many characters (default: 1500) */
		executeCommandCharsAbove: number
	}
}

export const DEFAULT_PROCESSOR_CONFIG: ToolResultProcessorConfig = {
	enabled: true,
	isSubscriber: false,
	thresholds: {
		readFileCharsAbove: 1500,
		searchMatchesAbove: 20,
		listFilesCountAbove: 100,
		executeCommandCharsAbove: 1500,
	},
}
