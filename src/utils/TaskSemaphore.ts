import { Semaphore } from "async-mutex"

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

	cancel(): void {
		this._waiting = 0
		this._generation++
		this.sem.cancel()
	}
}
