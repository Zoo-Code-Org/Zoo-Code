/** Owns immutable state snapshots; subclasses expose domain-specific transitions. */
export abstract class StateHolder<TState> {
	protected constructor(private current: TState) {}

	get state(): TState {
		return this.current
	}

	isCurrent(snapshot: TState): boolean {
		return this.current === snapshot
	}

	protected replaceState(state: TState): void {
		this.current = state
	}
}
