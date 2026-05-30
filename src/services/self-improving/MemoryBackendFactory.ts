import { AgentMemoryAdapter } from "./AgentMemoryAdapter"
import type { MemoryBackend, MemoryBackendType } from "./MemoryBackend"
import { MemoryStore } from "./MemoryStore"
import type { Logger } from "./types"

/**
 * MemoryBackendFactory — creates the appropriate memory backend
 * based on configuration.
 *
 * Supports:
 * - "builtin" (default): Zoo-Code's own MemoryStore
 * - "agentmemory": agentmemory REST API adapter
 */
export class MemoryBackendFactory {
	/**
	 * Create a memory backend.
	 *
	 * @param type - Backend type ("builtin" | "agentmemory")
	 * @param baseDir - Base directory for built-in storage
	 * @param logger - Logger instance
	 * @param agentMemoryUrl - Optional agentmemory server URL
	 */
	static create(type: MemoryBackendType, baseDir: string, logger: Logger, agentMemoryUrl?: string): MemoryBackend {
		switch (type) {
			case "agentmemory":
				return new AgentMemoryAdapter(logger, agentMemoryUrl)
			case "builtin":
			default:
				return new MemoryStore(baseDir, logger)
		}
	}
}
