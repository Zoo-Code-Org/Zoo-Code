import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import * as lockfile from "proper-lockfile"

import type { UsageEventV1 } from "@roo-code/types"
import { UsageEventV1 as UsageEventV1Schema } from "@roo-code/types"

import type { UsageStatsDatabase } from "./UsageStatsDatabase"

// ── Constants ──────────────────────────────────────────────────────────────

/** When a single segment file reaches this size, it rotates to the next segment. */
const SEGMENT_MAX_BYTES = 5 * 1024 * 1024 // 5 MiB

/** Hard cap for the total event files. When reached, new writes are suspended. */
const TOTAL_MAX_BYTES = 100 * 1024 * 1024 // 100 MiB

/** Segment file name prefix */
export const SEGMENT_PREFIX = "events-"

/** Segment file extension */
export const SEGMENT_EXT = ".ndjson"

/** Manifest file name */
const MANIFEST_FILENAME = "manifest.json"

/** Quarantine directory name */
const QUARANTINE_DIRNAME = "quarantine"

/** Quarantine report file name */
const QUARANTINE_REPORT_FILENAME = "corrupt-lines.jsonl"

// ── Error Codes ─────────────────────────────────────────────────────────────

/**
 * Storage error codes. Does not fail the LLM task.
 * Format: STATS_STORE/function/NNN
 */
export type StatsStoreErrorCode =
	| "STATS_STORE/append/001" // Directory creation failed
	| "STATS_STORE/append/002" // Lock acquisition failed
	| "STATS_STORE/append/003" // Hard cap reached
	| "STATS_STORE/append/004" // File write failed
	| "STATS_STORE/append/005" // Manifest update failed
	| "STATS_STORE/readAll/001" // Directory read failed
	| "STATS_STORE/readAll/002" // Segment file read failed
	| "STATS_STORE/clear/001" // Lock acquisition failed
	| "STATS_STORE/clear/002" // Manifest replacement failed
	| "STATS_STORE/scan/001" // Segment scan failed on restart

export class StatsStoreError extends Error {
	constructor(
		public readonly code: StatsStoreErrorCode,
		message: string,
		public override readonly cause?: unknown,
	) {
		super(`[${code}] ${message}`)
		this.name = "StatsStoreError"
	}
}

// ── Manifest ────────────────────────────────────────────────────────────────

/**
 * Storage manifest. Manages generation and the current segment number.
 * The cross-process lock is held on this file.
 */
export interface UsageStatsManifest {
	/** Manifest schema version */
	manifestVersion: 1
	/** Current generation. Incremented on clear. */
	generation: number
	/** Current active segment number (1-based) */
	currentSegment: number
	/** Last updated time (ISO 8601 UTC) */
	updatedAt: string
}

const DEFAULT_MANIFEST: UsageStatsManifest = {
	manifestVersion: 1,
	generation: 1,
	currentSegment: 1,
	updatedAt: new Date().toISOString(),
}

// ── Quarantine Report ───────────────────────────────────────────────────────

/**
 * Quarantine report entry for a corrupt line.
 * Records only the line number and hash, not the original content.
 */
export interface QuarantineReportEntry {
	/** Segment file name */
	segment: string
	/** 1-based line number */
	line: number
	/** 32-bit rolling hash of the corrupt line content as an 8-character hex string */
	hash: string
	/** Discovery time (ISO 8601 UTC) */
	at: string
}

// ── UsageEventStore ─────────────────────────────────────────────────────────

/**
 * NDJSON append-only file based usage event store.
 *
 * Design principles (architecture report section 5.12-5.14):
 * - Uses the `globalStorageUri.fsPath/usage-stats/` directory
 * - Manages generation/segment via manifest.json
 * - Serializes via in-process promise queue
 * - Cross-process uses advisory lock on manifest.json via proper-lockfile
 * - 5 MiB segment rotation, 100 MiB hard cap
 * - Idempotency: in-memory set + segment scan on restart
 * - Corrupt lines are recorded to quarantine and skipped
 * - Storage errors are classified with STATS_STORE_* codes, do not fail the LLM task
 *
 * Security: does not store prompt, response, API key, or workspace path.
 * (Structurally guaranteed because these fields are not included in the UsageEventV1 schema)
 */
export class UsageEventStore {
	private readonly statsDir: string
	private readonly manifestPath: string
	private readonly quarantineDir: string
	private readonly quarantineReportPath: string

	/** Optional SQLite database for indexed dashboard paths. */
	private database: UsageStatsDatabase | null = null

	/** In-process promise queue for serialization */
	private queue: Promise<void> = Promise.resolve()

	/** Idempotency: idempotencyKey set for the current segment */
	private idempotencyKeys: Set<string> = new Set()

	/** Whether initialization is complete */
	private initialized = false

	/** Whether the hard cap has been reached */
	private capped = false

	/** In-memory cached event snapshot. Null when cold. */
	private cachedEvents: UsageEventV1[] | null = null

	/** Generation that the cached snapshot corresponds to. */
	private cachedGeneration = -1

	/** Segment count that the cached snapshot corresponds to. */
	private cachedSegmentCount = -1

	/** Active segment file size that the cached snapshot corresponds to. */
	private cachedActiveSegmentSize = -1

	/** Active segment file mtime that the cached snapshot corresponds to. */
	private cachedActiveSegmentMtimeMs = -1

	/** Single-flight promise for concurrent cold loads. */
	private loadPromise: Promise<UsageEventV1[]> | null = null

	/**
	 * @param globalStoragePath VS Code globalStorageUri.fsPath
	 * @param database Optional SQLite database for indexed dashboard paths.
	 *   When provided, appends are also written to the database, and
	 *   readAll can use the database for indexed access.
	 */
	constructor(globalStoragePath: string, database?: UsageStatsDatabase) {
		this.statsDir = path.join(globalStoragePath, "usage-stats")
		this.manifestPath = path.join(this.statsDir, MANIFEST_FILENAME)
		this.quarantineDir = path.join(this.statsDir, QUARANTINE_DIRNAME)
		this.quarantineReportPath = path.join(this.quarantineDir, QUARANTINE_REPORT_FILENAME)
		this.database = database ?? null
	}

	// ── Public API ──────────────────────────────────────────────────────────

	/**
	 * Initializes the store.
	 * Creates directories, loads/creates the manifest, and restores the idempotency set.
	 * Must be called before the first append.
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return
		}

		try {
			await fs.mkdir(this.statsDir, { recursive: true })
			await fs.mkdir(this.quarantineDir, { recursive: true })
		} catch (err) {
			throw new StatsStoreError(
				"STATS_STORE/append/001",
				`Failed to create stats directory: ${this.statsDir}`,
				err,
			)
		}

		// Load or create manifest
		const manifest = await this.loadOrCreateManifest()

		// Restore idempotency set: scan all segments of the current generation
		try {
			await this.rebuildIdempotencySet(manifest)
		} catch (err) {
			// Scan failure is not fatal: dedupe just becomes looser
			console.warn(`[UsageEventStore] idempotency scan failed, continuing with empty set:`, err)
		}

		// Check hard cap
		this.capped = await this.checkTotalSize()

		this.initialized = true
	}

	/**
	 * Appends an event.
	 * Checks for duplicates within the lock, then appends.
	 * If the same idempotencyKey already exists, it is ignored (idempotent).
	 *
	 * @returns true if appended, false if deduplicated (already exists)
	 * @throws StatsStoreError Storage error (does not fail the LLM task - caller catches)
	 */
	async append(event: UsageEventV1): Promise<boolean> {
		// Serialize via in-process promise queue
		let resolveFn!: (value: boolean) => void
		let rejectFn!: (reason: unknown) => void
		const pending = new Promise<boolean>((resolve, reject) => {
			resolveFn = resolve
			rejectFn = reject
		})

		this.queue = this.queue.then(async () => {
			try {
				const result = await this.appendInternal(event)

				// Also append to the SQLite database if available.
				// Database writes are synchronous and idempotent.
				// Failures are logged but do not fail the NDJSON append.
				if (this.database && this.database._isInitialized()) {
					try {
						this.database.append(event)
					} catch (dbErr) {
						console.warn(`[UsageEventStore] database append failed for event ${event.eventId}:`, dbErr)
					}
				}

				// Incremental cache update: only after durable success.
				if (result && this.cachedEvents) {
					// If a segment rotation happened during the append, the cached
					// segment count no longer matches the disk files. Invalidate so the
					// next readAll rescans from disk instead of returning stale data.
					const currentSegmentFiles = await this.listSegmentFiles()
					const manifest = await this.loadOrCreateManifest()
					if (this.cachedSegmentCount !== currentSegmentFiles.length) {
						this.invalidateCache()
					} else {
						this.cachedEvents.push(event)
						const activeSegmentPath = this.getSegmentPath(manifest.currentSegment)
						const activeStat = await fs.stat(activeSegmentPath).catch(() => null)
						this.cachedActiveSegmentSize = activeStat?.size ?? -1
						this.cachedActiveSegmentMtimeMs = activeStat?.mtimeMs ?? -1
					}
				}
				resolveFn(result)
			} catch (err) {
				// If durable append failed, we may not know the storage state.
				// Invalidate the cache to force a fresh scan on the next read.
				if (err instanceof StatsStoreError) {
					this.invalidateCache()
				}
				rejectFn(err)
			}
		})

		return pending
	}

	/**
	 * Reads all valid events.
	 * Corrupt lines are recorded to quarantine and skipped.
	 * The last unterminated/truncated line is treated as a crash tail and ignored.
	 */
	async readAll(): Promise<UsageEventV1[]> {
		await this.ensureInitialized()

		const manifest = await this.loadOrCreateManifest()

		// Warm hit: cache matches current generation, the number of segment
		// files on disk, and the active segment file's size/mtime. Using the
		// on-disk file count (rather than manifest.currentSegment) catches
		// external writers that created new segments without updating the
		// manifest. The active segment stat catches same-segment appends from
		// other VS Code windows (multi-window scenario).
		const currentSegmentFiles = await this.listSegmentFiles()
		const activeSegmentPath = this.getSegmentPath(manifest.currentSegment)
		const activeStat = await fs.stat(activeSegmentPath).catch(() => null)
		const activeSize = activeStat?.size ?? -1
		const activeMtimeMs = activeStat?.mtimeMs ?? -1

		if (
			this.cachedEvents &&
			this.cachedGeneration === manifest.generation &&
			this.cachedSegmentCount === currentSegmentFiles.length &&
			this.cachedActiveSegmentSize === activeSize &&
			this.cachedActiveSegmentMtimeMs === activeMtimeMs
		) {
			return [...this.cachedEvents]
		}

		// Single-flight cold load: concurrent callers share one scan.
		if (this.loadPromise) {
			return this.loadPromise
		}

		this.loadPromise = this.scanAllSegments().then((events) => {
			this.cachedEvents = events
			this.cachedGeneration = manifest.generation
			this.cachedSegmentCount = currentSegmentFiles.length
			this.cachedActiveSegmentSize = activeSize
			this.cachedActiveSegmentMtimeMs = activeMtimeMs
			return [...events]
		})

		try {
			return await this.loadPromise
		} finally {
			this.loadPromise = null
		}
	}

	/**
	 * Deletes all statistics data.
	 * Replaces with a new empty generation.
	 * On failure, the existing manifest is preserved.
	 */
	async clear(): Promise<void> {
		// Invalidate the cache before mutating so no reader keeps the old
		// generation as authoritative.
		this.invalidateCache()

		await this.ensureInitialized()

		let releaseLock: () => Promise<void> = async () => {}

		try {
			releaseLock = await this.acquireManifestLock()
		} catch (err) {
			throw new StatsStoreError("STATS_STORE/clear/001", "Failed to acquire manifest lock for clear", err)
		}

		try {
			const manifest = await this.loadOrCreateManifest(true)

			// New generation number
			const newGeneration = manifest.generation + 1
			const newManifest: UsageStatsManifest = {
				...DEFAULT_MANIFEST,
				generation: newGeneration,
				currentSegment: 1,
				updatedAt: new Date().toISOString(),
			}

			// Move existing segment files to a new generation directory (backup)
			// Or simply replace with a new manifest and ignore existing files
			// Design: "Replace existing segments with a new empty generation"
			// Implementation: Move existing segment files under old-generation-{N}
			const oldGenDir = path.join(this.statsDir, `old-generation-${manifest.generation}`)
			await fs.mkdir(oldGenDir, { recursive: true })

			const allFiles = await fs.readdir(this.statsDir)
			const segmentFiles = allFiles.filter((f) => f.startsWith(SEGMENT_PREFIX) && f.endsWith(SEGMENT_EXT))

			for (const file of segmentFiles) {
				const oldPath = path.join(this.statsDir, file)
				const newPath = path.join(oldGenDir, file)
				try {
					await fs.rename(oldPath, newPath)
				} catch (err) {
					// Log move failures and continue
					console.warn(`[UsageEventStore] failed to move old segment ${file}:`, err)
				}
			}

			// Save new manifest (safeWriteJson pattern: temp → rename)
			await this.writeManifestAtomic(newManifest)

			// Clean up old-generation directory after successful manifest replacement
			try {
				await fs.rm(oldGenDir, { recursive: true, force: true })
			} catch (err) {
				console.warn(`[UsageEventStore] failed to clean up old generation dir ${oldGenDir}:`, err)
			}

			// Reset idempotency set
			this.idempotencyKeys.clear()
			this.capped = false
		} catch (err) {
			// On failure, preserve the existing manifest (already moved files are not restored - data loss risk)
			throw new StatsStoreError("STATS_STORE/clear/002", "Failed to replace manifest during clear", err)
		} finally {
			try {
				await releaseLock()
			} catch (err) {
				console.warn(`[UsageEventStore] failed to release manifest lock:`, err)
			}
		}
	}

	/**
	 * Returns whether the hard cap has been reached.
	 */
	isCapped(): boolean {
		return this.capped
	}

	/**
	 * Returns the current manifest.
	 */
	async getManifest(): Promise<UsageStatsManifest> {
		await this.ensureInitialized()
		return this.loadOrCreateManifest()
	}

	// ── Internal: Append ─────────────────────────────────────────────────────

	/**
	 * Actual append logic. Runs inside the promise queue.
	 */
	private invalidateCache(): void {
		this.cachedEvents = null
		this.cachedGeneration = -1
		this.cachedSegmentCount = -1
		this.cachedActiveSegmentSize = -1
		this.cachedActiveSegmentMtimeMs = -1
		this.loadPromise = null
	}

	/**
	 * Scans every segment on disk and returns a single validated event array.
	 * Corrupt lines are recorded to quarantine and skipped.
	 */
	private async scanAllSegments(): Promise<UsageEventV1[]> {
		const events: UsageEventV1[] = []
		const quarantineEntries: QuarantineReportEntry[] = []

		let segmentFiles: string[]
		try {
			const allFiles = await fs.readdir(this.statsDir)
			segmentFiles = allFiles.filter((f) => f.startsWith(SEGMENT_PREFIX) && f.endsWith(SEGMENT_EXT)).sort()
		} catch (err) {
			throw new StatsStoreError(
				"STATS_STORE/readAll/001",
				`Failed to read stats directory: ${this.statsDir}`,
				err,
			)
		}

		// If the number of segments on disk exceeds the current segment count
		// recorded in the manifest, an external writer (or a previous process that
		// rotated further) produced files we did not observe. Scan all of them and
		// let the next readAll re-evaluate cache validity against the freshly
		// loaded manifest.
		if (segmentFiles.length > this.getSegmentCount()) {
			console.warn(
				`[UsageEventStore] detected ${segmentFiles.length} segments on disk, manifest only tracks ${this.getSegmentCount()}. Scanning all segments.`,
			)
		}

		for (const segmentFile of segmentFiles) {
			const segmentPath = path.join(this.statsDir, segmentFile)

			let content: string
			try {
				content = await fs.readFile(segmentPath, "utf-8")
			} catch (err) {
				throw new StatsStoreError("STATS_STORE/readAll/002", `Failed to read segment file: ${segmentPath}`, err)
			}

			const endsWithNewline = content.endsWith("\n")
			const lines = content.split("\n")
			// Remove the last element if it's empty (trailing newline)
			if (lines.length > 0 && lines[lines.length - 1] === "") {
				lines.pop()
			}

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]
				const lineNum = i + 1
				const isLastLine = i === lines.length - 1
				const isCrashTail = isLastLine && !endsWithNewline

				// Skip empty lines
				if (!line.trim()) {
					continue
				}

				try {
					const parsed = JSON.parse(line)
					const result = UsageEventV1Schema.safeParse(parsed)
					if (result.success) {
						events.push(result.data)
					} else {
						// Schema validation failed
						// If it's an unterminated/truncated crash tail at EOF, ignore.
						// Otherwise (including corrupted lines ending with newline), quarantine.
						if (!isCrashTail) {
							quarantineEntries.push(this.makeQuarantineEntry(segmentFile, lineNum, line))
						}
					}
				} catch {
					// JSON parse failed
					// If it's an unterminated/truncated crash tail at EOF, ignore.
					// Otherwise (including corrupted lines ending with newline), quarantine.
					if (!isCrashTail) {
						quarantineEntries.push(this.makeQuarantineEntry(segmentFile, lineNum, line))
					}
				}
			}
		}

		// Write quarantine report
		if (quarantineEntries.length > 0) {
			await this.writeQuarantineReport(quarantineEntries)
		}

		return events
	}

	/**
	 * Returns the current segment count from the loaded manifest.
	 */
	private getSegmentCount(): number {
		return this.manifest?.currentSegment ?? 1
	}

	/**
	 * Lists segment files currently on disk, sorted by name.
	 */
	private async listSegmentFiles(): Promise<string[]> {
		try {
			const allFiles = await fs.readdir(this.statsDir)
			return allFiles.filter((f) => f.startsWith(SEGMENT_PREFIX) && f.endsWith(SEGMENT_EXT)).sort()
		} catch {
			return []
		}
	}

	private async appendInternal(event: UsageEventV1): Promise<boolean> {
		await this.ensureInitialized()

		// Check hard cap
		if (this.capped) {
			throw new StatsStoreError(
				"STATS_STORE/append/003",
				"Storage hard cap (100 MiB) reached, new events suspended",
			)
		}

		// Idempotency check
		if (this.idempotencyKeys.has(event.idempotencyKey)) {
			return false
		}

		let releaseLock: () => Promise<void> = async () => {}

		try {
			releaseLock = await this.acquireManifestLock()
		} catch (err) {
			throw new StatsStoreError("STATS_STORE/append/002", "Failed to acquire manifest lock for append", err)
		}

		try {
			const manifest = await this.loadOrCreateManifest(true)

			// Idempotency double-check under lock (rebuild idempotency set from disk)
			await this.rebuildIdempotencySet(manifest)
			if (this.idempotencyKeys.has(event.idempotencyKey)) {
				return false
			}

			// Prospective hard cap check under lock
			const line = JSON.stringify(event) + "\n"
			const serializedBytes = Buffer.byteLength(line, "utf-8")
			const currentTotalBytes = await this.getTotalSizeBytes()

			if (currentTotalBytes + serializedBytes >= TOTAL_MAX_BYTES) {
				this.capped = true
				throw new StatsStoreError(
					"STATS_STORE/append/003",
					"Storage hard cap (100 MiB) reached, new events suspended",
				)
			}

			const segmentPath = this.getSegmentPath(manifest.currentSegment)

			// Check if the segment file exists and its size
			let segmentSize = 0
			try {
				const stat = await fs.stat(segmentPath)
				segmentSize = stat.size
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					throw err
				}
				// If the file does not exist, create a new one
			}

			// Check segment rotation
			if (segmentSize >= SEGMENT_MAX_BYTES) {
				manifest.currentSegment += 1
				manifest.updatedAt = new Date().toISOString()
				await this.writeManifestAtomic(manifest)
			}

			// B3 fix: Recalculate segmentPath based on currentSegment after rotation.
			// Previously, the pre-rotation old segmentPath was used as-is, causing appends to
			// continue going to the old segment, invalidating the 5MiB rotation design and
			// allowing a single segment to grow indefinitely.
			const activeSegmentPath = this.getSegmentPath(manifest.currentSegment)

			try {
				// Open in append mode and write
				const handle = await fs.open(activeSegmentPath, "a")
				try {
					await handle.writeFile(line, "utf-8")
					// Return success after syncing the file handle
					await handle.sync()
				} finally {
					await handle.close()
				}
			} catch (err) {
				throw new StatsStoreError(
					"STATS_STORE/append/004",
					`Failed to write event to segment ${manifest.currentSegment}`,
					err,
				)
			}

			// Add to idempotency set
			this.idempotencyKeys.add(event.idempotencyKey)

			// Check total size and update cap
			this.capped = currentTotalBytes + serializedBytes >= TOTAL_MAX_BYTES

			return true
		} finally {
			try {
				await releaseLock()
			} catch (err) {
				console.warn(`[UsageEventStore] failed to release manifest lock:`, err)
			}
		}
	}

	// ── Internal: Manifest ──────────────────────────────────────────────────

	private manifest: UsageStatsManifest | null = null
	private manifestMtimeMs = -1

	/**
	 * Loads the manifest or creates it with default values.
	 * @param forceReload When true, bypasses the in-memory cached manifest and re-reads from disk.
	 */
	private async loadOrCreateManifest(forceReload = false): Promise<UsageStatsManifest> {
		if (!forceReload && this.manifest) {
			try {
				const stat = await fs.stat(this.manifestPath)
				if (stat.mtimeMs === this.manifestMtimeMs) {
					return this.manifest
				}
			} catch {
				// file stat failed, fall through to re-read or create
			}
		}

		try {
			const stat = await fs.stat(this.manifestPath).catch(() => null)
			const content = await fs.readFile(this.manifestPath, "utf-8")
			const parsed = JSON.parse(content)
			// Basic field validation
			if (
				typeof parsed.manifestVersion === "number" &&
				typeof parsed.generation === "number" &&
				typeof parsed.currentSegment === "number"
			) {
				this.manifest = parsed as UsageStatsManifest
				this.manifestMtimeMs = stat?.mtimeMs ?? -1
				return this.manifest
			}
			// On validation failure, overwrite with default values
			const defaultManifest = { ...DEFAULT_MANIFEST, updatedAt: new Date().toISOString() }
			await this.writeManifestAtomic(defaultManifest)
			return defaultManifest
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				// If manifest does not exist, create it
				const defaultManifest = { ...DEFAULT_MANIFEST, updatedAt: new Date().toISOString() }
				await this.writeManifestAtomic(defaultManifest)
				return defaultManifest
			}
			// Other errors return default values
			console.warn(`[UsageEventStore] failed to load manifest, using default:`, err)
			const defaultManifest = { ...DEFAULT_MANIFEST, updatedAt: new Date().toISOString() }
			this.manifest = defaultManifest
			this.manifestMtimeMs = -1
			return defaultManifest
		}
	}

	/**
	 * Stores the manifest atomically (temp → rename pattern).
	 */
	private async writeManifestAtomic(manifest: UsageStatsManifest): Promise<void> {
		this.manifest = manifest
		const tempPath = `${this.manifestPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
		const content = JSON.stringify(manifest, null, "\t")

		try {
			await fs.writeFile(tempPath, content, "utf-8")
			await fs.rename(tempPath, this.manifestPath)
		} catch (err) {
			// Clean up temp file
			try {
				await fs.unlink(tempPath)
			} catch {
				// ignore
			}
			throw new StatsStoreError("STATS_STORE/append/005", "Failed to write manifest atomically", err)
		}
	}

	// ── Internal: Lock ───────────────────────────────────────────────────────

	/**
	 * Acquires a cross-process advisory lock on manifest.json.
	 */
	private async acquireManifestLock(): Promise<() => Promise<void>> {
		// Create manifest file if it does not exist (lockfile.lock may require a file)
		try {
			await fs.access(this.manifestPath)
		} catch {
			await this.writeManifestAtomic({ ...DEFAULT_MANIFEST, updatedAt: new Date().toISOString() })
		}

		return lockfile.lock(this.manifestPath, {
			stale: 31000,
			update: 10000,
			realpath: false,
			retries: {
				retries: 5,
				factor: 2,
				minTimeout: 100,
				maxTimeout: 1000,
			},
			onCompromised: (err) => {
				console.error(`[UsageEventStore] manifest lock was compromised:`, err)
				throw err
			},
		})
	}

	// ── Internal: Idempotency ────────────────────────────────────────────────

	/**
	 * Scans idempotencyKeys from all segments of the current generation to restore the set.
	 */
	private async rebuildIdempotencySet(manifest: UsageStatsManifest): Promise<void> {
		this.idempotencyKeys.clear()

		for (let seg = 1; seg <= manifest.currentSegment; seg++) {
			const segmentPath = this.getSegmentPath(seg)

			let content: string
			try {
				content = await fs.readFile(segmentPath, "utf-8")
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					continue
				}
				throw new StatsStoreError(
					"STATS_STORE/scan/001",
					`Failed to scan segment ${seg} for idempotency rebuild`,
					err,
				)
			}

			const lines = content.split("\n")
			for (const line of lines) {
				if (!line.trim()) continue
				try {
					const parsed = JSON.parse(line)
					if (parsed && typeof parsed.idempotencyKey === "string") {
						this.idempotencyKeys.add(parsed.idempotencyKey)
					}
				} catch {
					// Skip corrupt lines during scan
				}
			}
		}
	}

	// ── Internal: Size Management ────────────────────────────────────────────

	/**
	 * Returns the total size in bytes of all segment files on disk.
	 */
	private async getTotalSizeBytes(): Promise<number> {
		try {
			const allFiles = await fs.readdir(this.statsDir)
			const segmentFiles = allFiles.filter((f) => f.startsWith(SEGMENT_PREFIX) && f.endsWith(SEGMENT_EXT))

			let totalSize = 0
			for (const file of segmentFiles) {
				try {
					const stat = await fs.stat(path.join(this.statsDir, file))
					totalSize += stat.size
				} catch {
					// skip
				}
			}

			return totalSize
		} catch {
			return 0
		}
	}

	/**
	 * Checks the total event file size and returns whether the hard cap has been reached.
	 */
	private async checkTotalSize(): Promise<boolean> {
		const totalBytes = await this.getTotalSizeBytes()
		return totalBytes >= TOTAL_MAX_BYTES
	}

	// ── Internal: Quarantine ────────────────────────────────────────────────

	/**
	 * Creates a quarantine entry for a corrupt line.
	 * Records only the line number and hash, not the original content.
	 */
	private makeQuarantineEntry(segment: string, line: number, content: string): QuarantineReportEntry {
		// Simple hash (without crypto, content-based)
		// In a production environment, crypto.createHash could be used,
		// but here a simple hash is used to minimize dependencies.
		let hash = 0
		for (let i = 0; i < content.length; i++) {
			const char = content.charCodeAt(i)
			hash = (hash << 5) - hash + char
			hash = hash & hash // Keep as 32-bit integer
		}
		const hashHex = (hash >>> 0).toString(16).padStart(8, "0")

		return {
			segment,
			line,
			hash: hashHex,
			at: new Date().toISOString(),
		}
	}

	/**
	 * Writes the quarantine report in append mode.
	 */
	private async writeQuarantineReport(entries: QuarantineReportEntry[]): Promise<void> {
		try {
			const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
			const handle = await fs.open(this.quarantineReportPath, "a")
			try {
				await handle.writeFile(lines, "utf-8")
			} finally {
				await handle.close()
			}
		} catch (err) {
			// Quarantine write failure is not fatal
			console.warn(`[UsageEventStore] failed to write quarantine report:`, err)
		}
	}

	// ── Internal: Utilities ──────────────────────────────────────────────────

	/**
	 * Generates a file path from a segment number.
	 */
	private getSegmentPath(segmentNumber: number): string {
		const padded = String(segmentNumber).padStart(6, "0")
		return path.join(this.statsDir, `${SEGMENT_PREFIX}${padded}${SEGMENT_EXT}`)
	}

	/**
	 * Checks whether initialization is complete; if not, initializes.
	 */
	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) {
			await this.initialize()
		}
	}

	/**
	 * For testing: returns the size of the idempotency set
	 */
	_getIdempotencyKeyCount(): number {
		return this.idempotencyKeys.size
	}

	/**
	 * For testing: returns the stats directory path
	 */
	_getStatsDir(): string {
		return this.statsDir
	}

	/**
	 * Returns the associated SQLite database, if one was provided.
	 * Used by UsageStatsService for indexed dashboard queries.
	 */
	getDatabase(): UsageStatsDatabase | null {
		return this.database
	}
}
