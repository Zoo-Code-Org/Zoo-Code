import { Semaphore } from "async-mutex"

/**
 * A thin wrapper around `async-mutex`'s `Semaphore` that adds observable
 * queue-depth (`waiting`) and safe bulk-cancellation (`cancel()`).
 *
 * **Why not use `Semaphore` directly?**
 * `Semaphore` has no way to inspect how many callers are blocked waiting for a
 * permit. `TaskSemaphore` tracks that count so callers can make scheduling
 * decisions (e.g. "don't enqueue more work when the queue is already deep").
 *
 * **`_waiting`** is incremented before `sem.acquire()` is awaited (only when
 * the semaphore is already locked, i.e. the caller will actually block) and
 * decremented once the permit is granted or the acquire is rejected.
 *
 * **`_generation`** is a monotonically-increasing counter bumped on every
 * `cancel()` call. Each in-flight `acquire()` captures the generation at
 * enqueue time; when the acquire settles it only adjusts `_waiting` if the
 * generation hasn't changed, preventing stale decrements after a cancel has
 * already reset the counter to 0.
 */
export class TaskSemaphore {
	private sem: Semaphore
	private _waiting = 0
	private _generation = 0

	constructor(permits: number) {
		this.sem = new Semaphore(permits)
	}

	get available(): number {
		return this.sem.getValue()
	}

	get waiting(): number {
		return this._waiting
	}

	async acquire(): Promise<() => void> {
		// Only count as waiting if the permit won't be granted immediately.
		const willQueue = this.sem.isLocked()
		const gen = this._generation
		if (willQueue) this._waiting++
		try {
			const [, release] = await this.sem.acquire()
			if (willQueue && gen === this._generation) this._waiting--
			return release
		} catch (e) {
			if (willQueue && gen === this._generation) this._waiting--
			throw e
		}
	}

	/**
	 * Rejects all queued waiters and resets the waiting count to 0.
	 * Does NOT release or alter any held permits — callers that already
	 * received a release function must still call it.
	 * The semaphore remains usable after cancellation.
	 */
	cancel(): void {
		this._waiting = 0
		this._generation++
		this.sem.cancel()
	}
}
