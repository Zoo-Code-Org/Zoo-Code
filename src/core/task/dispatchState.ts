export enum DispatchState {
	IDLE = "idle",
	SERIAL = "serial",
	PARALLEL = "parallel",
}

export type PendingWork = { mode: "serial" | "parallel" }

const VALID_TRANSITIONS: Record<DispatchState, readonly DispatchState[]> = {
	[DispatchState.IDLE]: [DispatchState.SERIAL, DispatchState.PARALLEL],
	[DispatchState.SERIAL]: [DispatchState.IDLE],
	[DispatchState.PARALLEL]: [DispatchState.IDLE],
}

export function transitionDispatch(from: DispatchState, to: DispatchState): DispatchState {
	if (!VALID_TRANSITIONS[from].includes(to)) {
		throw new Error(`[DispatchState] invalid transition ${from} -> ${to}`)
	}
	return to
}
