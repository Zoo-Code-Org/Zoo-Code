/**
 * Per-task file observation registry (upstream epic #1375, phase A2).
 *
 * Each Task owns its own instance so parent and subtask observations are
 * independent. The S4 guarded-write will compare these versions against the
 * token recomputed pre-write to detect stale reads or file replacement.
 *
 * Pure in-memory — zero I/O, no dependencies. The observations ARE consulted:
 * guardedWrite reads this registry before publishing (src/core/tools/guardedWrite.ts)
 * and compares the recorded version token against the token recomputed from disk, so a
 * stale read or an out-of-band replacement that the check detects is rejected instead of
 * published over. Detection is best effort against a non-cooperating process: the token is
 * recomputed before the publish, so a replacement that lands after that check and before
 * the rename is not observable from here and can still win. Closing that last window needs
 * a cross-process lock or an atomic create, not a token comparison.
 */

export interface FileObservation {
	/** Version token derived from on-disk fs.stat (bigint mode). */
	version: string
	/** Millisecond timestamp when the observation was recorded. */
	observedAt: number
}

export class ObservationRegistry {
	private readonly entries = new Map<string, FileObservation>()

	/** Set by close(): after disposal the registry refuses further observations. */
	private closed = false

	/**
	 * Record an observation for a file at its absolute path, unless the registry is closed.
	 *
	 * Re-observing replaces the entry with a fresh observedAt timestamp and
	 * the new version token. A read that was already in flight can finish after
	 * Task.disposeOnce() dropped the observations; recording then would hand a version token
	 * to a task that no longer serves any request, and a later guarded write could consult
	 * it. close() therefore makes this a no-op, so disposal is terminal at this layer.
	 */
	observe(absolutePath: string, version: string): void {
		if (this.closed) {
			return
		}
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

	/**
	 * Drop every observation and refuse any later one. Task.disposeOnce() calls this so a
	 * disposed task's registry cannot be repopulated by a read that finishes late.
	 */
	close(): void {
		this.closed = true
		this.entries.clear()
	}

	get isClosed(): boolean {
		return this.closed
	}

	get size(): number {
		return this.entries.size
	}
}
