import type { MemoryEntry } from "@roo-code/types"

import type { MemoryBackend, MemoryBackendType } from "./MemoryBackend"
import type { Logger } from "./types"

/**
 * Default agentmemory server URL
 */
const DEFAULT_AGENTMEMORY_URL = "http://localhost:3111"

/**
 * Raw shape from agentmemory search API response.
 * Search returns { results: [{ observation: { id, narrative, ... }, score }] }
 * NOT the same shape as the remember/write endpoints.
 */
type AgentMemorySearchObservation = {
	id: string
	narrative?: string
	content?: string
	title?: string
	timestamp?: string
	confidence?: number
	concepts?: string[]
	metadata?: Record<string, unknown>
}

/**
 * AgentMemoryAdapter — implements MemoryBackend via agentmemory REST API.
 *
 * agentmemory (https://github.com/rohitg00/agentmemory) is a service-first
 * memory system. This adapter connects to its REST API when the server is
 * running, and gracefully degrades to no-op when it's not.
 *
 * Key REST endpoints used:
 *   POST /agentmemory/observe   — store an observation
 *   POST /agentmemory/search    — semantic search
 *   POST /agentmemory/remember  — recall recent memories
 *   POST /agentmemory/forget    — remove a memory
 *   GET  /agentmemory/livez     — health check
 */
export class AgentMemoryAdapter implements MemoryBackend {
	private readonly baseUrl: string
	private readonly logger: Logger
	private available = false
	private healthCheckInterval: ReturnType<typeof setInterval> | null = null
	private initialized = false

	constructor(logger: Logger, baseUrl?: string) {
		this.baseUrl = baseUrl || DEFAULT_AGENTMEMORY_URL
		this.logger = logger
	}

	get backendType(): MemoryBackendType {
		return "agentmemory"
	}

	/**
	 * Initialize the adapter — check if agentmemory server is available.
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return

		this.available = await this.checkHealth()

		if (this.available) {
			this.logger.appendLine(`[AgentMemoryAdapter] Connected to agentmemory at ${this.baseUrl}`)
		} else {
			this.logger.appendLine(
				`[AgentMemoryAdapter] agentmemory server not available at ${this.baseUrl} — will degrade gracefully`,
			)
		}

		this.healthCheckInterval = setInterval(async () => {
			this.available = await this.checkHealth()
		}, 30000)

		this.initialized = true
	}

	/**
	 * Check if agentmemory server is healthy.
	 */
	private async checkHealth(): Promise<boolean> {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), 2000)

		try {
			const response = await fetch(`${this.baseUrl}/agentmemory/livez`, {
				signal: controller.signal,
			})

			return response.ok
		} catch {
			return false
		} finally {
			clearTimeout(timeout)
		}
	}

	/**
	 * Make a POST request to agentmemory API.
	 */
	private async post<T>(path: string, body: unknown): Promise<T | null> {
		if (!this.available) return null

		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), 5000)

		try {
			const response = await fetch(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: controller.signal,
			})

			if (!response.ok) {
				this.logger.appendLine(`[AgentMemoryAdapter] POST ${path} failed: ${response.status}`)
				return null
			}

			return (await response.json()) as T
		} catch (error) {
			this.logger.appendLine(
				`[AgentMemoryAdapter] POST ${path} error: ${error instanceof Error ? error.message : String(error)}`,
			)
			this.available = false
			return null
		} finally {
			clearTimeout(timeout)
		}
	}

	/**
	 * Store a memory entry via agentmemory observe endpoint.
	 * agentmemory v3 requires: hookType, sessionId, project, cwd, timestamp, narrative.
	 */
	async store(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry | null> {
		const sessionId = `zoo-code-${Date.now().toString(36)}`
		const result = await this.post<{ observationId: string }>("/agentmemory/observe", {
			hookType: "conversation",
			sessionId,
			project: "zoo-code",
			cwd: typeof process !== "undefined" && process.cwd ? process.cwd() : "/",
			timestamp: new Date().toISOString(),
			narrative: entry.content,
			title: (entry.content ?? "").slice(0, 120),
			metadata: {
				source: entry.source,
				tags: entry.tags,
				relevanceScore: entry.relevanceScore,
				expiresAt: entry.expiresAt,
			} as Record<string, unknown>,
		})

		if (!result) return null

		return {
			id: result.observationId,
			content: entry.content,
			source: entry.source,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			relevanceScore: entry.relevanceScore,
			tags: entry.tags,
			expiresAt: entry.expiresAt,
		}
	}

	/**
	 * Search memory entries via agentmemory search endpoint.
	 * Search API returns: { results: [{ observation: { id, narrative, ... }, score }] }
	 */
	async search(query: string, maxResults: number = 10): Promise<MemoryEntry[]> {
		const result = await this.post<{
			results: Array<{ observation: AgentMemorySearchObservation }>
		}>("/agentmemory/search", {
			query,
			limit: maxResults,
		})

		if (!result?.results) return []

		return result.results
			.map((entry) => this.mapSearchObservationToMemoryEntry(entry.observation))
			.filter((entry): entry is MemoryEntry => entry !== undefined)
	}

	/**
	 * Recall recent memory entries via agentmemory search with broad query.
	 * Uses a generic query to retrieve recent entries instead of the
	 * /remember endpoint which requires a specific content string.
	 */
	async recall(maxResults: number = 20): Promise<MemoryEntry[]> {
		const result = await this.post<{
			results: Array<{ observation: AgentMemorySearchObservation }>
		}>("/agentmemory/search", {
			query: "recent activity task user system",
			limit: maxResults,
		})

		if (!result?.results) return []

		return result.results
			.map((entry) => this.mapSearchObservationToMemoryEntry(entry.observation))
			.filter((entry): entry is MemoryEntry => entry !== undefined)
	}

	/**
	 * Remove a memory entry by ID via agentmemory forget endpoint.
	 */
	async forget(id: string): Promise<boolean> {
		const result = await this.post<{ success: boolean }>("/agentmemory/forget", { id })
		return result?.success === true
	}

	/**
	 * Remove entries matching content substring.
	 * Uses agentmemory search + forget pattern.
	 */
	async forgetByContent(substring: string): Promise<number> {
		const normalized = substring.trim().toLowerCase()
		if (!normalized) {
			return 0
		}

		const entries = await this.search(substring.trim(), 50)
		let removed = 0

		for (const entry of entries) {
			if (entry.content.toLowerCase().includes(normalized)) {
				const ok = await this.forget(entry.id)
				if (ok) removed += 1
			}
		}

		return removed
	}

	/**
	 * Get backend statistics.
	 */
	async getStats(): Promise<{ entryCount: number; backend: string }> {
		if (!this.available) {
			return { entryCount: 0, backend: "agentmemory (unavailable)" }
		}

		const memories = await this.recall(1000)
		return {
			entryCount: memories.length,
			backend: "agentmemory",
		}
	}

	/**
	 * Clear all entries via agentmemory governance delete.
	 */
	async clear(): Promise<void> {
		await this.post("/agentmemory/governance/bulk-delete", { all: true })
	}

	/**
	 * Dispose the adapter — stop health check interval.
	 */
	async dispose(): Promise<void> {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval)
			this.healthCheckInterval = null
		}

		this.available = false
		this.initialized = false
	}

	private mapSearchObservationToMemoryEntry(obs: AgentMemorySearchObservation): MemoryEntry | undefined {
		if (!obs || typeof obs.id !== "string") return undefined

		return {
			id: obs.id,
			content: obs.narrative ?? obs.content ?? "",
			source: (obs.metadata?.source as MemoryEntry["source"]) || "learning",
			createdAt: obs.timestamp ? new Date(obs.timestamp).getTime() : Date.now(),
			updatedAt: obs.timestamp ? new Date(obs.timestamp).getTime() : Date.now(),
			relevanceScore: (obs.confidence as number) ?? (obs.metadata?.relevanceScore as number | undefined),
			tags: obs.concepts ?? (obs.metadata?.tags as string[] | undefined) ?? [],
			expiresAt: obs.metadata?.expiresAt as number | undefined,
		}
	}
}
