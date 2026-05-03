import type { ToolName } from "@roo-code/types"

/**
 * Tools that only READ data and do not modify the workspace.
 * These are safe to execute in parallel when called together.
 */
export const READ_ONLY_TOOLS: ReadonlySet<ToolName> = new Set([
	"read_file",
	"list_files",
	"search_files",
	"codebase_search",
])

/**
 * Check if a tool is read-only and safe for parallel execution.
 */
export function isReadOnlyTool(toolName: string): boolean {
	return READ_ONLY_TOOLS.has(toolName as ToolName)
}

/**
 * Given a list of tool blocks, partition them into groups that can
 * be executed in parallel. Consecutive read-only tools form a parallel batch.
 * Any non-read-only tool breaks the batch and forms its own sequential group.
 *
 * Example: [read_file, read_file, write_to_file, read_file]
 * → [[read_file, read_file], [write_to_file], [read_file]]
 * The first two run in parallel, then write_to_file runs alone, then the last read_file.
 */
export function partitionToolsForExecution<T extends { name: string }>(
	tools: T[],
): { batch: T[]; parallel: boolean }[] {
	if (tools.length === 0) {
		return []
	}

	const groups: { batch: T[]; parallel: boolean }[] = []
	let currentBatch: T[] = []

	for (const tool of tools) {
		if (isReadOnlyTool(tool.name)) {
			// Accumulate consecutive read-only tools into a parallel batch
			currentBatch.push(tool)
		} else {
			// Flush any accumulated read-only batch first
			if (currentBatch.length > 0) {
				groups.push({ batch: currentBatch, parallel: currentBatch.length > 1 })
				currentBatch = []
			}
			// Non-read-only tools always form their own sequential group
			groups.push({ batch: [tool], parallel: false })
		}
	}

	// Flush any remaining read-only tools
	if (currentBatch.length > 0) {
		groups.push({ batch: currentBatch, parallel: currentBatch.length > 1 })
	}

	return groups
}
