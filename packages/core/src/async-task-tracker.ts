export class AsyncTaskTracker {
	private readonly tasks = new Set<Promise<unknown>>()
	private active = true

	get isActive(): boolean {
		return this.active
	}

	track<T>(task: Promise<T>): Promise<T> {
		this.tasks.add(task)
		void task.then(
			() => this.tasks.delete(task),
			() => this.tasks.delete(task),
		)
		return task
	}

	runIfActive<T, Result>(callback: (value: T) => Promise<Result>, value: T): Promise<Result | undefined> {
		return this.active ? callback(value) : Promise.resolve(undefined)
	}

	async drain(): Promise<void> {
		while (this.tasks.size) await Promise.allSettled(this.tasks)
	}

	async closeAndDrain(): Promise<void> {
		this.active = false
		await this.drain()
	}
}
