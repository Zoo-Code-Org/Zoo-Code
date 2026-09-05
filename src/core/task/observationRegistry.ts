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
}

export class ObservationRegistry {
	private readonly entries = new Map<string, FileObservation>()

	/**
	 * Record an observation for a file at its absolute path.
	 *
	 * Re-observing replaces the entry with a fresh observedAt timestamp and
	 * the new version token.
	 */
	observe(absolutePath: string, version: string): void {
		this.entries.set(absolutePath, { version, observedAt: Date.now() })
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
