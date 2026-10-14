import type { Task } from "../../task/Task"

import { ReadFileCancelledError } from "./ReadFileCancelledError"

/** Observe existing task cancellation flags; never change lifecycle state. */
export class ReadFileCancellation {
	constructor(private readonly task: Pick<Task, "abort" | "abandoned">) {}

	isCancelled(): boolean {
		return this.task.abort || this.task.abandoned
	}

	throwIfCancelled(): void {
		if (this.isCancelled()) throw new ReadFileCancelledError()
	}

	/** Guard value-producing operations; resource acquisition needs its own cleanup scope. */
	async run<T>(operation: () => Promise<T>): Promise<T> {
		this.throwIfCancelled()

		let result: T
		try {
			result = await operation()
		} catch (error) {
			if (error instanceof ReadFileCancelledError) throw error
			this.throwIfCancelled()
			throw error
		}

		this.throwIfCancelled()
		return result
	}
}
