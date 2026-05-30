import * as fs from "fs/promises"
import * as path from "path"

import { safeWriteJson } from "../../utils/safeWriteJson"
import type { Logger } from "./types"

/**
 * Skill provenance - who created the skill
 */
export type SkillProvenance = "agent" | "user" | "bundled" | "hub" | "unknown"

/**
 * Skill lifecycle state
 */
export type SkillLifecycleState = "active" | "stale" | "archived"

/**
 * Skill telemetry record
 */
export interface SkillTelemetryRecord {
	/** Unique skill identifier */
	skillId: string
	/** Skill name */
	skillName: string
	/** Who created this skill */
	createdBy: SkillProvenance
	/** Current lifecycle state */
	state: SkillLifecycleState
	/** Whether the skill is pinned (protected from auto-mutation) */
	pinned: boolean
	/** Number of times the skill has been loaded/viewed */
	viewCount: number
	/** Number of times the skill has been used in a task */
	useCount: number
	/** Number of times the skill has been patched/updated */
	patchCount: number
	/** Timestamp of first creation */
	createdAt: number
	/** Timestamp of last activity */
	lastActivityAt: number
	/** Timestamp of archival (if archived) */
	archivedAt?: number
	/** Tags for categorization */
	tags?: string[]
	/** Name of umbrella skill this was absorbed into (set by curator merge) */
	absorbedInto?: string
}

const SKILL_PROVENANCE_VALUES: ReadonlySet<SkillProvenance> = new Set(["agent", "user", "bundled", "hub", "unknown"])
const SKILL_LIFECYCLE_VALUES: ReadonlySet<SkillLifecycleState> = new Set(["active", "stale", "archived"])

/**
 * SkillUsageStore - telemetry sidecar for skill usage tracking.
 *
 * Mirrors Hermes' skill_usage.py pattern with:
 * - Use/view/patch counters
 * - Provenance tracking (agent-created vs user-authored vs bundled)
 * - Pinning support (protected from autonomous mutation)
 * - Lifecycle state management
 * - Atomic file persistence
 */
export class SkillUsageStore {
	private readonly filePath: string
	private readonly logger: Logger
	private records: Map<string, SkillTelemetryRecord> = new Map()
	private initialized = false

	constructor(baseDir: string, logger: Logger) {
		this.filePath = path.join(baseDir, "self-improving", "skill-usage.json")
		this.logger = logger
	}

	/**
	 * Initialize the store - load persisted telemetry from disk.
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return
		}

		try {
			await fs.mkdir(path.dirname(this.filePath), { recursive: true })
			await this.loadFromDisk()
			this.logger.appendLine(`[SkillUsageStore] Initialized: ${this.records.size} skill records`)
		} catch (error) {
			this.logger.appendLine(
				`[SkillUsageStore] Initialization error: ${error instanceof Error ? error.message : String(error)}`,
			)
		} finally {
			this.initialized = true
		}
	}

	/**
	 * Load telemetry from disk.
	 */
	private async loadFromDisk(): Promise<void> {
		try {
			const raw = await fs.readFile(this.filePath, "utf-8")
			const parsed = JSON.parse(raw)

			if (!Array.isArray(parsed)) {
				return
			}

			for (const candidate of parsed) {
				const record = this.sanitizeRecord(candidate)
				if (record) {
					this.records.set(record.skillId, record)
				}
			}
		} catch (error: unknown) {
			const errorCode = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
			if (errorCode !== "ENOENT") {
				this.logger.appendLine(
					`[SkillUsageStore] Load error: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}

	/**
	 * Persist telemetry to disk atomically with file-locking for concurrent write protection.
	 */
	private async persist(): Promise<void> {
		try {
			await safeWriteJson(this.filePath, Array.from(this.records.values()), { prettyPrint: true })
		} catch (error) {
			this.logger.appendLine(
				`[SkillUsageStore] Persist error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private queuePersist(): void {
		void this.persist()
	}

	private getRecord(skillId: string): SkillTelemetryRecord | undefined {
		return this.records.get(skillId)
	}

	private cloneRecord(record: SkillTelemetryRecord): SkillTelemetryRecord {
		return {
			...record,
			tags: record.tags ? [...record.tags] : undefined,
		}
	}

	private sanitizeRecord(value: unknown): SkillTelemetryRecord | null {
		if (!value || typeof value !== "object") {
			return null
		}

		const candidate = value as Partial<SkillTelemetryRecord>
		if (typeof candidate.skillId !== "string" || candidate.skillId.trim().length === 0) {
			return null
		}

		const now = Date.now()
		const createdAt = typeof candidate.createdAt === "number" ? candidate.createdAt : now
		const lastActivityAt = typeof candidate.lastActivityAt === "number" ? candidate.lastActivityAt : createdAt

		return {
			skillId: candidate.skillId,
			skillName:
				typeof candidate.skillName === "string" && candidate.skillName.trim().length > 0
					? candidate.skillName
					: candidate.skillId,
			createdBy: this.normalizeProvenance(candidate.createdBy),
			state: this.normalizeState(candidate.state),
			pinned: candidate.pinned === true,
			viewCount: this.normalizeCounter(candidate.viewCount),
			useCount: this.normalizeCounter(candidate.useCount),
			patchCount: this.normalizeCounter(candidate.patchCount),
			createdAt,
			lastActivityAt,
			archivedAt: typeof candidate.archivedAt === "number" ? candidate.archivedAt : undefined,
			tags: this.normalizeTags(candidate.tags),
			absorbedInto:
				typeof candidate.absorbedInto === "string" && candidate.absorbedInto.trim().length > 0
					? candidate.absorbedInto
					: undefined,
		}
	}

	private normalizeCounter(value: number | undefined): number {
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
	}

	private normalizeProvenance(value: SkillProvenance | undefined): SkillProvenance {
		return value && SKILL_PROVENANCE_VALUES.has(value) ? value : "unknown"
	}

	private normalizeState(value: SkillLifecycleState | undefined): SkillLifecycleState {
		return value && SKILL_LIFECYCLE_VALUES.has(value) ? value : "active"
	}

	private normalizeTags(tags: string[] | undefined): string[] | undefined {
		if (!Array.isArray(tags)) {
			return undefined
		}

		const normalized = Array.from(new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)))

		return normalized.length > 0 ? normalized : undefined
	}

	// ──── Record management ────

	/**
	 * Get or create a telemetry record for a skill.
	 */
	getOrCreate(skillId: string, skillName: string, createdBy: SkillProvenance = "unknown"): SkillTelemetryRecord {
		const existing = this.getRecord(skillId)
		if (existing) {
			return this.cloneRecord(existing)
		}

		const now = Date.now()
		const record: SkillTelemetryRecord = {
			skillId,
			skillName,
			createdBy,
			state: "active",
			pinned: false,
			viewCount: 0,
			useCount: 0,
			patchCount: 0,
			createdAt: now,
			lastActivityAt: now,
		}

		this.records.set(skillId, record)
		this.queuePersist()

		return this.cloneRecord(record)
	}

	/**
	 * Get a telemetry record by skill ID.
	 */
	get(skillId: string): SkillTelemetryRecord | undefined {
		const record = this.getRecord(skillId)
		return record ? this.cloneRecord(record) : undefined
	}

	/**
	 * Get all telemetry records.
	 */
	getAll(): SkillTelemetryRecord[] {
		return Array.from(this.records.values(), (record) => this.cloneRecord(record))
	}

	/**
	 * Get records filtered by provenance.
	 */
	getByProvenance(provenance: SkillProvenance): SkillTelemetryRecord[] {
		return this.getAll().filter((record) => record.createdBy === provenance)
	}

	/**
	 * Get records filtered by lifecycle state.
	 */
	getByState(state: SkillLifecycleState): SkillTelemetryRecord[] {
		return this.getAll().filter((record) => record.state === state)
	}

	// ──── Telemetry bumps ────

	/**
	 * Record that a skill was viewed/loaded.
	 */
	async bumpView(skillId: string): Promise<void> {
		const record = this.getRecord(skillId)
		if (!record) {
			return
		}

		record.viewCount += 1
		record.lastActivityAt = Date.now()
		await this.persist()
	}

	/**
	 * Record that a skill was used in a task.
	 */
	async bumpUse(skillId: string): Promise<void> {
		const record = this.getRecord(skillId)
		if (!record) {
			return
		}

		record.useCount += 1
		record.lastActivityAt = Date.now()
		await this.persist()
	}

	/**
	 * Record that a skill was patched/updated.
	 */
	async bumpPatch(skillId: string): Promise<void> {
		const record = this.getRecord(skillId)
		if (!record) {
			return
		}

		record.patchCount += 1
		record.lastActivityAt = Date.now()
		await this.persist()
	}

	// ──── Lifecycle management ────

	/**
	 * Pin a skill (protect from autonomous mutation).
	 */
	async pin(skillId: string): Promise<void> {
		const record = this.getRecord(skillId)
		if (!record) {
			return
		}

		record.pinned = true
		record.lastActivityAt = Date.now()
		await this.persist()
	}

	/**
	 * Unpin a skill.
	 */
	async unpin(skillId: string): Promise<void> {
		const record = this.getRecord(skillId)
		if (!record) {
			return
		}

		record.pinned = false
		record.lastActivityAt = Date.now()
		await this.persist()
	}

	/**
	 * Check if a skill is pinned.
	 */
	isPinned(skillId: string): boolean {
		return this.getRecord(skillId)?.pinned ?? false
	}

	/**
	 * Transition a skill to a new lifecycle state.
	 */
	async transitionState(skillId: string, newState: SkillLifecycleState): Promise<void> {
		const record = this.getRecord(skillId)
		if (!record || record.pinned) {
			return
		}

		record.state = newState
		record.lastActivityAt = Date.now()

		if (newState === "archived") {
			record.archivedAt = Date.now()
		} else {
			delete record.archivedAt
		}

		await this.persist()
	}

	/**
	 * Get skills eligible for stale transition.
	 * Skills with no activity for staleAfterDays.
	 */
	getStaleCandidates(staleAfterDays: number): SkillTelemetryRecord[] {
		const threshold = Date.now() - staleAfterDays * 24 * 60 * 60 * 1000
		return this.getAll().filter(
			(record) => record.state === "active" && !record.pinned && record.lastActivityAt < threshold,
		)
	}

	/**
	 * Get skills eligible for archive transition.
	 */
	getArchiveCandidates(archiveAfterDays: number): SkillTelemetryRecord[] {
		const threshold = Date.now() - archiveAfterDays * 24 * 60 * 60 * 1000
		return this.getAll().filter(
			(record) => record.state === "stale" && !record.pinned && record.lastActivityAt < threshold,
		)
	}

	/**
	 * Remove a skill record entirely.
	 */
	async remove(skillId: string): Promise<void> {
		if (!this.records.delete(skillId)) {
			return
		}

		await this.persist()
	}

	/**
	 * Get aggregate statistics.
	 */
	getStats(): {
		total: number
		active: number
		stale: number
		archived: number
		pinned: number
		agentCreated: number
		pinnedAgentCreated: number
	} {
		const records = Array.from(this.records.values())
		return {
			total: records.length,
			active: records.filter((record) => record.state === "active").length,
			stale: records.filter((record) => record.state === "stale").length,
			archived: records.filter((record) => record.state === "archived").length,
			pinned: records.filter((record) => record.pinned).length,
			agentCreated: records.filter((record) => record.createdBy === "agent").length,
			pinnedAgentCreated: records.filter((record) => record.createdBy === "agent" && record.pinned).length,
		}
	}
	/**
	 * Get agent-created skills for curator review (excludes pinned and non-agent).
	 */
	getAgentCreatedForReview(): SkillTelemetryRecord[] {
		return this.getAll().filter((record) => record.createdBy === "agent" && !record.pinned)
	}

	/**
	 * Get agent-created pinned skills.
	 */
	getAgentCreatedPinned(): SkillTelemetryRecord[] {
		return this.getAll().filter((record) => record.createdBy === "agent" && record.pinned)
	}

	/**
	 * Move a skill record to archived state.
	 * Sets archivedAt timestamp and transitions state.
	 */
	async archive(skillId: string): Promise<void> {
		const record = this.getRecord(skillId)
		if (!record) {
			return
		}

		record.state = "archived"
		record.archivedAt = Date.now()
		record.lastActivityAt = Date.now()
		await this.persist()
	}

	/**
	 * Restore an archived skill back to active.
	 */
	async restore(skillId: string): Promise<void> {
		const record = this.getRecord(skillId)
		if (!record) {
			return
		}

		record.state = "active"
		record.archivedAt = undefined
		record.lastActivityAt = Date.now()
		await this.persist()
	}

	/**
	 * Set the absorbedInto field on a skill record.
	 * Used by curator merge actions to mark skills as absorbed into an umbrella.
	 */
	async setAbsorbedInto(skillId: string, umbrellaName: string): Promise<void> {
		const record = this.getRecord(skillId)
		if (!record) {
			return
		}

		record.absorbedInto = umbrellaName
		await this.persist()
	}

	/**
	 * Reset all telemetry.
	 */
	async reset(): Promise<void> {
		this.records.clear()
		await this.persist()
	}
}
