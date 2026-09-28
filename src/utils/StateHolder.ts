export interface StateSubscription {
	unsubscribe(): void
}

/** A replaying, read-only view of state. Subscriptions are synchronous. */
export interface StateStream<T> {
	readonly value: T
	subscribe(listener: (value: T) => void): StateSubscription
	waitFor(predicate: (value: T) => boolean): Promise<T>
}

/** Stores state without retaining promises. Use immutable values when updating it. */
export class StateHolder<T> implements StateStream<T> {
	private readonly listeners = new Set<(value: T) => void>()

	constructor(private current: T) {}

	get value(): T {
		return this.current
	}

	set(value: T): void {
		if (Object.is(this.current, value)) return
		this.current = value
		for (const listener of [...this.listeners]) {
			if (this.listeners.has(listener)) listener(value)
		}
	}

	subscribe(listener: (value: T) => void): StateSubscription {
		// Each subscription owns its registration, even for the same callback.
		const subscriber = (value: T) => listener(value)
		this.listeners.add(subscriber)
		try {
			subscriber(this.current)
		} catch (error) {
			this.listeners.delete(subscriber)
			throw error
		}
		return {
			unsubscribe: () => {
				this.listeners.delete(subscriber)
			},
		}
	}

	waitFor(predicate: (value: T) => boolean): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const listener = (value: T) => {
				try {
					if (!predicate(value)) return
					this.listeners.delete(listener)
					resolve(value)
				} catch (error) {
					this.listeners.delete(listener)
					reject(error)
				}
			}
			// Register before checking current state so synchronous replay cannot leak a listener.
			this.listeners.add(listener)
			listener(this.current)
		})
	}
}
