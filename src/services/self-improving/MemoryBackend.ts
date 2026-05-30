import type { MemoryEntry } from "@roo-code/types"

/**
 * MemoryBackend — abstract interface for memory storage backends.
 *
 * Both the built-in MemoryStore and the optional agentmemory adapter
 * implement this interface, allowing the SelfImprovingManager to
 * switch between backends transparently.
 */
export interface MemoryBackend {
	/** Initialize the backend */
	initialize(): Promise<void>

	/** Store a memory entry */
	store(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry | null>

	/** Search memory entries by query */
	search(query: string, maxResults?: number): Promise<MemoryEntry[]>

	/** Recall recent memory entries */
	recall(maxResults?: number): Promise<MemoryEntry[]>

	/** Remove a memory entry by ID */
	forget(id: string): Promise<boolean>

	/** Remove entries matching a substring */
	forgetByContent(substring: string): Promise<number>

	/** Get backend statistics */
	getStats(): Promise<{ entryCount: number; backend: string }>

	/** Clear all entries */
	clear(): Promise<void>

	/** Dispose the backend */
	dispose(): Promise<void>
}

/**
 * MemoryBackendType — supported backend implementations
 */
export type MemoryBackendType = "builtin" | "agentmemory"
