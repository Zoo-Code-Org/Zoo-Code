import * as fs from "fs/promises"
import * as path from "path"
import crypto from "crypto"

import { safeWriteJson } from "../../utils/safeWriteJson"
import type { MemoryContext, MemoryEntry } from "@roo-code/types"
import type { MemoryBackend, MemoryBackendType } from "./MemoryBackend"
import type { Logger } from "./types"

/**
 * Store type for memory categorization.
 * Mirrors Hermes' MEMORY.md (environment) vs USER.md (user profile) split.
 */
export type MemoryStoreType = "environment" | "userProfile"

const MEMORY_SOURCES: ReadonlySet<MemoryEntry["source"]> = new Set(["learning", "user", "system", "review"])

/**
 * MemoryStore - real bounded memory subsystem.
 *
 * Implements Hermes' dual-store approach:
 * - environment: durable operational facts, project knowledge, learned patterns
 * - userProfile: user preferences, corrections, style feedback
 *
 * Key design:
 * - Frozen snapshot at session start (prompt stability)
 * - Live writes go to disk but NOT to active snapshot
 * - Exact-duplicate rejection on load
 * - Substring-based replace and remove
 * - Bounded retention per store
 */
export class MemoryStore implements MemoryBackend {
	private readonly baseDir: string
	private readonly logger: Logger
	private environment: MemoryEntry[] = []
	private userProfile: MemoryEntry[] = []
	private environmentSnapshot: MemoryEntry[] = []
	private userProfileSnapshot: MemoryEntry[] = []
	private revision = 0
	private initialized = false

	private static readonly MAX_ENVIRONMENT_ENTRIES = 50
	private static readonly MAX_USER_PROFILE_ENTRIES = 20
	private static readonly MAX_ENTRY_LENGTH = 2000
	private static readonly MAX_SNAPSHOT_ENVIRONMENT_ENTRIES = 5
	private static readonly MAX_SNAPSHOT_USER_PROFILE_ENTRIES = 5

	constructor(baseDir: string, logger: Logger) {
		this.baseDir = path.join(baseDir, "self-improving", "memory")
		this.logger = logger
	}

	get backendType(): MemoryBackendType {
		return "builtin"
	}

	/**
	 * Initialize the memory store - load persisted entries from disk.
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return
		}

		try {
			await fs.mkdir(this.baseDir, { recursive: true })
			await this.loadFromDisk()
			this.logger.appendLine(
				`[MemoryStore] Initialized: ${this.environment.length} environment, ${this.userProfile.length} user profile entries`,
			)
		} catch (error) {
			this.logger.appendLine(
				`[MemoryStore] Initialization error: ${error instanceof Error ? error.message : String(error)}`,
			)
		} finally {
			this.initialized = true
		}
	}

	async store(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry | null> {
		return this.addEnvironmentEntry(entry.content, {
			source: entry.source,
			tags: entry.tags,
			expiresAt: entry.expiresAt,
		})
	}

	async search(query: string, maxResults: number = 10): Promise<MemoryEntry[]> {
		await this.ensureInitialized()

		const lowerQuery = query.toLowerCase()
		const allEntries = [...this.environment, ...this.userProfile]
		return allEntries
			.filter((entry) => entry.content.toLowerCase().includes(lowerQuery))
			.slice(0, maxResults)
			.map((entry) => this.cloneEntry(entry))
	}

	async recall(maxResults: number = 20): Promise<MemoryEntry[]> {
		await this.ensureInitialized()

		return [...this.environment, ...this.userProfile]
			.sort((left, right) => {
				const leftTimestamp = left.updatedAt ?? left.createdAt
				const rightTimestamp = right.updatedAt ?? right.createdAt
				return rightTimestamp - leftTimestamp
			})
			.slice(0, maxResults)
			.map((entry) => this.cloneEntry(entry))
	}

	async forget(id: string): Promise<boolean> {
		await this.ensureInitialized()

		const envIdx = this.environment.findIndex((entry) => entry.id === id)
		if (envIdx >= 0) {
			this.environment.splice(envIdx, 1)
			await this.persistStore("environment")
			return true
		}

		const userIdx = this.userProfile.findIndex((entry) => entry.id === id)
		if (userIdx >= 0) {
			this.userProfile.splice(userIdx, 1)
			await this.persistStore("userProfile")
			return true
		}

		return false
	}

	async forgetByContent(substring: string): Promise<number> {
		await this.ensureInitialized()

		const lowerSubstring = substring.trim().toLowerCase()
		if (!lowerSubstring) {
			return 0
		}

		let removed = 0

		const envBefore = this.environment.length
		this.environment = this.environment.filter((entry) => !entry.content.toLowerCase().includes(lowerSubstring))
		removed += envBefore - this.environment.length

		const userBefore = this.userProfile.length
		this.userProfile = this.userProfile.filter((entry) => !entry.content.toLowerCase().includes(lowerSubstring))
		removed += userBefore - this.userProfile.length

		if (removed > 0) {
			await this.persistStore("environment")
			await this.persistStore("userProfile")
		}

		return removed
	}

	/**
	 * Load entries from disk with duplicate rejection.
	 */
	private async loadFromDisk(): Promise<void> {
		this.environment = await this.loadStoreFile("environment")
		this.userProfile = await this.loadStoreFile("userProfile")
		this.takeSnapshot()
	}

	/**
	 * Load a single store file with validation and dedup.
	 */
	private async loadStoreFile(type: MemoryStoreType): Promise<MemoryEntry[]> {
		try {
			const raw = await fs.readFile(this.getFilePath(type), "utf-8")
			const parsed = JSON.parse(raw)

			if (!Array.isArray(parsed)) {
				return []
			}

			const seen = new Set<string>()
			const deduped: MemoryEntry[] = []

			for (const candidate of parsed) {
				const entry = this.sanitizePersistedEntry(candidate)
				if (!entry) {
					continue
				}

				const contentKey = this.normalizeContent(entry.content)
				if (seen.has(contentKey)) {
					continue
				}

				seen.add(contentKey)
				deduped.push(entry)
			}

			return this.enforceBounds(type, deduped)
		} catch (error: unknown) {
			const errorCode = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
			if (errorCode !== "ENOENT") {
				this.logger.appendLine(
					`[MemoryStore] Load error for ${this.getFilePath(type)}: ${error instanceof Error ? error.message : String(error)}`,
				)
			}

			return []
		}
	}

	/**
	 * Take a frozen snapshot of current memory for prompt injection.
	 * Live writes update the working store but NOT the snapshot.
	 */
	takeSnapshot(): void {
		this.environmentSnapshot = this.environment.map((entry) => this.cloneEntry(entry))
		this.userProfileSnapshot = this.userProfile.map((entry) => this.cloneEntry(entry))
		this.revision += 1
	}

	/**
	 * Get the frozen snapshot context for prompt injection.
	 */
	getSnapshotContext(): MemoryContext {
		return {
			entries: this.buildSnapshotEntries(),
			revision: this.revision,
			generatedAt: Date.now(),
		}
	}

	/**
	 * Get snapshot as formatted string for prompt injection.
	 */
	getSnapshotString(): string {
		const context = this.getSnapshotContext()
		if (context.entries.length === 0) return ""

		const lines = context.entries.map((entry) => {
			// Sanitize: single line, strip control characters, no markdown headings
			const sanitized = entry.content
				.split("")
				.filter((c) => {
					const code = c.charCodeAt(0)
					return code >= 32 || code === 9 || code === 10 || code === 13
				})
				.join("")
				.replace(/\n/g, " ")
				.replace(/^#+\s*/gm, "")
				.trim()
			const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : ""
			return `- ${sanitized}${tags}`
		})

		return `\n## Learned Context\n${lines.join("\n")}\n`
	}

	// ──── Environment store operations ────

	/**
	 * Add an entry to the environment store.
	 * Rejects exact duplicates. Persists to disk but does NOT update the snapshot.
	 */
	async addEnvironmentEntry(
		content: string,
		options?: {
			source?: MemoryEntry["source"]
			tags?: string[]
			expiresAt?: number
		},
	): Promise<MemoryEntry | null> {
		return this.addEntry("environment", content, options)
	}

	/**
	 * Replace entries in the environment store that contain a substring.
	 * If no match is found, adds as new entry.
	 */
	async replaceEnvironmentEntry(
		substring: string,
		newContent: string,
		options?: {
			source?: MemoryEntry["source"]
			tags?: string[]
		},
	): Promise<MemoryEntry> {
		return this.replaceEntry("environment", substring, newContent, options)
	}

	/**
	 * Remove entries from the environment store that contain a substring.
	 */
	async removeEnvironmentEntry(substring: string): Promise<boolean> {
		return this.removeEntry("environment", substring)
	}

	// ──── User profile store operations ────

	/**
	 * Add an entry to the user profile store.
	 */
	async addUserProfileEntry(
		content: string,
		options?: {
			source?: MemoryEntry["source"]
			tags?: string[]
			expiresAt?: number
		},
	): Promise<MemoryEntry | null> {
		return this.addEntry("userProfile", content, options)
	}

	/**
	 * Replace entries in the user profile store that contain a substring.
	 */
	async replaceUserProfileEntry(
		substring: string,
		newContent: string,
		options?: {
			source?: MemoryEntry["source"]
			tags?: string[]
		},
	): Promise<MemoryEntry> {
		return this.replaceEntry("userProfile", substring, newContent, options)
	}

	/**
	 * Remove entries from the user profile store that contain a substring.
	 */
	async removeUserProfileEntry(substring: string): Promise<boolean> {
		return this.removeEntry("userProfile", substring)
	}

	// ──── Generic store operations ────

	private getStore(type: MemoryStoreType): MemoryEntry[] {
		return type === "environment" ? this.environment : this.userProfile
	}

	private setStore(type: MemoryStoreType, entries: MemoryEntry[]): void {
		if (type === "environment") {
			this.environment = entries
			return
		}

		this.userProfile = entries
	}

	private getMaxEntries(type: MemoryStoreType): number {
		return type === "environment" ? MemoryStore.MAX_ENVIRONMENT_ENTRIES : MemoryStore.MAX_USER_PROFILE_ENTRIES
	}

	private getFilePath(type: MemoryStoreType): string {
		return path.join(this.baseDir, type === "environment" ? "environment.json" : "user-profile.json")
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) {
			await this.initialize()
		}
	}

	private async addEntry(
		type: MemoryStoreType,
		content: string,
		options?: {
			source?: MemoryEntry["source"]
			tags?: string[]
			expiresAt?: number
		},
	): Promise<MemoryEntry | null> {
		await this.ensureInitialized()

		const trimmed = content.trim()
		if (!trimmed || trimmed.length > MemoryStore.MAX_ENTRY_LENGTH) {
			return null
		}

		const normalized = this.normalizeContent(trimmed)
		const store = this.getStore(type)
		if (store.some((entry) => this.normalizeContent(entry.content) === normalized)) {
			return null
		}

		const now = Date.now()
		const entry: MemoryEntry = {
			id: crypto.randomUUID(),
			content: trimmed,
			source: this.normalizeSource(options?.source),
			createdAt: now,
			updatedAt: now,
			relevanceScore: 1,
			tags: this.normalizeTags(options?.tags),
			expiresAt: typeof options?.expiresAt === "number" ? options.expiresAt : undefined,
		}

		this.setStore(type, this.enforceBounds(type, [...store, entry]))
		await this.persistStore(type)

		return this.cloneEntry(entry)
	}

	private async replaceEntry(
		type: MemoryStoreType,
		substring: string,
		newContent: string,
		options?: {
			source?: MemoryEntry["source"]
			tags?: string[]
		},
	): Promise<MemoryEntry> {
		await this.ensureInitialized()

		const trimmedContent = newContent.trim()
		if (!trimmedContent || trimmedContent.length > MemoryStore.MAX_ENTRY_LENGTH) {
			throw new Error("Replacement memory content must be non-empty and within bounds")
		}

		const normalizedSubstring = substring.trim().toLowerCase()
		const store = this.getStore(type)
		const remaining =
			normalizedSubstring.length > 0
				? store.filter((entry) => !entry.content.toLowerCase().includes(normalizedSubstring))
				: [...store]

		const duplicate = remaining.find(
			(entry) => this.normalizeContent(entry.content) === this.normalizeContent(trimmedContent),
		)

		if (duplicate) {
			this.setStore(type, this.enforceBounds(type, remaining))
			if (remaining.length !== store.length) {
				await this.persistStore(type)
			}

			return this.cloneEntry(duplicate)
		}

		const now = Date.now()
		const entry: MemoryEntry = {
			id: crypto.randomUUID(),
			content: trimmedContent,
			source: this.normalizeSource(options?.source),
			createdAt: now,
			updatedAt: now,
			relevanceScore: 1,
			tags: this.normalizeTags(options?.tags),
		}

		this.setStore(type, this.enforceBounds(type, [...remaining, entry]))
		await this.persistStore(type)

		return this.cloneEntry(entry)
	}

	private async removeEntry(type: MemoryStoreType, substring: string): Promise<boolean> {
		await this.ensureInitialized()

		const normalizedSubstring = substring.trim().toLowerCase()
		if (!normalizedSubstring) {
			return false
		}

		const store = this.getStore(type)
		const remaining = store.filter((entry) => !entry.content.toLowerCase().includes(normalizedSubstring))
		const removed = remaining.length !== store.length

		if (!removed) {
			return false
		}

		this.setStore(type, remaining)
		await this.persistStore(type)

		return true
	}

	private async persistStore(type: MemoryStoreType): Promise<void> {
		try {
			await safeWriteJson(this.getFilePath(type), this.getStore(type), { prettyPrint: true })
		} catch (error) {
			this.logger.appendLine(
				`[MemoryStore] Persist error for ${type}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private sanitizePersistedEntry(value: unknown): MemoryEntry | null {
		if (!value || typeof value !== "object") {
			return null
		}

		const candidate = value as Partial<MemoryEntry>
		const trimmedContent = typeof candidate.content === "string" ? candidate.content.trim() : ""
		if (!trimmedContent) {
			return null
		}

		const now = Date.now()
		const createdAt = typeof candidate.createdAt === "number" ? candidate.createdAt : now
		const updatedAt = typeof candidate.updatedAt === "number" ? candidate.updatedAt : createdAt

		return {
			id: typeof candidate.id === "string" && candidate.id.trim().length > 0 ? candidate.id : crypto.randomUUID(),
			content: trimmedContent.slice(0, MemoryStore.MAX_ENTRY_LENGTH),
			source: this.normalizeSource(candidate.source),
			createdAt,
			updatedAt,
			relevanceScore:
				typeof candidate.relevanceScore === "number"
					? Math.min(1, Math.max(0, candidate.relevanceScore))
					: undefined,
			tags: this.normalizeTags(candidate.tags),
			expiresAt: typeof candidate.expiresAt === "number" ? candidate.expiresAt : undefined,
		}
	}

	private buildSnapshotEntries(): MemoryEntry[] {
		const environmentEntries = this.environmentSnapshot
			.slice(-MemoryStore.MAX_SNAPSHOT_ENVIRONMENT_ENTRIES)
			.map((entry) => this.cloneEntry(entry))
		const userProfileEntries = this.userProfileSnapshot
			.slice(-MemoryStore.MAX_SNAPSHOT_USER_PROFILE_ENTRIES)
			.map((entry) => this.cloneEntry(entry))

		return [...environmentEntries, ...userProfileEntries]
	}

	private enforceBounds(type: MemoryStoreType, entries: MemoryEntry[]): MemoryEntry[] {
		const maxEntries = this.getMaxEntries(type)
		if (entries.length <= maxEntries) {
			return entries
		}

		return [...entries].sort((left, right) => left.createdAt - right.createdAt).slice(-maxEntries)
	}

	private normalizeContent(content: string): string {
		return content.trim().toLowerCase()
	}

	private normalizeSource(source: MemoryEntry["source"] | undefined): MemoryEntry["source"] {
		return source && MEMORY_SOURCES.has(source) ? source : "learning"
	}

	private normalizeTags(tags: string[] | undefined): string[] | undefined {
		if (!Array.isArray(tags)) {
			return undefined
		}

		const normalized = Array.from(new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)))

		return normalized.length > 0 ? normalized : undefined
	}

	private cloneEntry(entry: MemoryEntry): MemoryEntry {
		return {
			...entry,
			tags: entry.tags ? [...entry.tags] : undefined,
		}
	}

	/**
	 * Get count of entries per store.
	 */
	async getStats(): Promise<{ entryCount: number; backend: string }> {
		await this.ensureInitialized()

		return {
			entryCount: this.environment.length + this.userProfile.length,
			backend: "builtin",
		}
	}

	async clear(): Promise<void> {
		await this.reset()
	}

	/**
	 * Reset all memory stores.
	 */
	async reset(): Promise<void> {
		await this.ensureInitialized()

		this.environment = []
		this.userProfile = []
		this.environmentSnapshot = []
		this.userProfileSnapshot = []
		this.revision = 0

		try {
			await Promise.all([
				safeWriteJson(this.getFilePath("environment"), [], { prettyPrint: true }),
				safeWriteJson(this.getFilePath("userProfile"), [], { prettyPrint: true }),
			])
		} catch (error) {
			this.logger.appendLine(
				`[MemoryStore] Reset error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	async dispose(): Promise<void> {
		this.initialized = false
	}
}
