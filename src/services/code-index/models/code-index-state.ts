import type { IndexingState } from "../state-manager"

/**
 * Complete code-index state exposed to interface adapters.
 */
export interface CodeIndexState {
	systemStatus: IndexingState
	message: string
	processedItems: number
	totalItems: number
	currentItemUnit: string
	workspacePath: string
	workspaceEnabled: boolean
	autoEnableDefault: boolean
}
