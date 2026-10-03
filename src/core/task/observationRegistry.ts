/**
 * Per-task file observation registry (upstream epic #1375, phase A2).
 *
 * Each Task owns its own instance so parent and subtask observations are
 * independent. The S4 guarded-write will compare these versions against the
 * token recomputed pre-write to detect stale reads or file replacement.
 *
 * Pure in-memory — zero I/O, no dependencies. No behavior change in this PR:
 * observations are recorded but not consulted.
 */

export interface FileObservation {
	/** Version token derived from on-disk fs.stat (bigint mode). */
	version: string
	/** Millisecond timestamp when the observation was recorded. */
	observedAt: number
	/**
	 * Whether the read that produced this observation returned the complete
	 * file. A slice, line-range, truncated, or indentation-block read returns
	 * only a view of the file; such an observation authorizes targeted edits
	 * on the view the model saw, but never a full-file replacement.
	 */
	complete: boolean
}

export class ObservationRegistry {
	private readonly entries = new Map<string, FileObservation>()

	/**
	 * Record an observation for a file at its absolute path.
	 *
	 * Re-observing replaces the entry with a fresh observedAt timestamp, the
	 * new version token, and the read's completeness. `complete` defaults to
	 * true for callers that read the whole file themselves (spec doubles,
	 * WriteToFileTool). A caller whose read is internal to a targeted edit must
	 * carry the model's prior completeness instead, so the tool's own read cannot
	 * upgrade a partial read into authority for a full-file replacement.
	 */
	observe(absolutePath: string, version: string, complete: boolean = true): void {
		this.entries.set(absolutePath, { version, observedAt: Date.now(), complete })
	}

	get(absolutePath: string): FileObservation | undefined {
		return this.entries.get(absolutePath)
	}

	has(absolutePath: string): boolean {
		return this.entries.has(absolutePath)
	}

	clear(): void {
		this.entries.clear()
	}

	get size(): number {
		return this.entries.size
	}
}
