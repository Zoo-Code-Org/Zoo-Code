// Interrupt handling for the comparison driver's detached children. Each
// bounded child, the preparation steps and the coding side alike, runs in its
// own process group, so a terminal signal aimed at the driver alone never
// reaches it. When the driver receives SIGINT or SIGTERM, this guard
// terminates the tracked group: SIGTERM first, a bounded grace, then SIGKILL
// for anything that remained. Repeated calls are a no-op, so several signals
// can share one guard without double cleanup.
export type SideKillOutcome = "terminated" | "killed" | "none"

export interface SideProcessGuard {
	// Tracks the active detached child process id. undefined clears the
	// tracking, for example after the child exited on its own.
	track(pid: number | undefined): void
	// Terminates the tracked process group. Resolves after the group is gone
	// ("terminated"), after the SIGKILL escalation fired ("killed"), or at
	// once when nothing is tracked or a kill already ran ("none").
	interrupt(): Promise<SideKillOutcome>
}

// Probes one process group. Only ESRCH proves the group is gone. EPERM and
// any other error mean the probe was refused for a group that still exists,
// so the group counts as alive and the SIGKILL escalation still fires. The
// probe parameter is a test seam; production callers use process.kill.
export const groupAlive = (
	pid: number,
	probe: (pid: number, signal?: NodeJS.Signals | number) => void = process.kill,
): boolean => {
	try {
		probe(-pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH"
	}
}

// One side-level interrupt flag. The handler arms it at most once, so
// repeated signals cannot un-arm or re-arm it. Listeners that share the
// process, the substrate's host teardown for example, observe their own
// handlers and never consume this flag.
export interface InterruptFlag {
	// Arms the flag. Later calls are no-ops.
	signal(name: NodeJS.Signals): void
	// True once any signal arrived.
	isInterrupted(): boolean
	// The observed signal name, for diagnostics.
	name(): NodeJS.Signals | undefined
	// The conventional shell exit code for the observed signal.
	exitCode(): number
}

export const createInterruptFlag = (): InterruptFlag => {
	let signal: NodeJS.Signals | undefined
	return {
		signal: (name) => {
			if (signal === undefined) signal = name
		},
		isInterrupted: () => signal !== undefined,
		name: () => signal,
		exitCode: () => (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1),
	}
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const createSideProcessGuard = (graceMs: number): SideProcessGuard => {
	let pid: number | undefined
	let interrupted = false
	const signalGroup = (group: number, signal: NodeJS.Signals): void => {
		try {
			process.kill(-group, signal)
		} catch {
			// The group may already be gone; fall back to the direct child.
			try {
				process.kill(group, signal)
			} catch {
				/* The child already exited. */
			}
		}
	}
	return {
		track: (childPid) => {
			pid = childPid
		},
		interrupt: async (): Promise<SideKillOutcome> => {
			// The group id is snapshotted, so an untrack that races the
			// escalation, for example the tracked child's own exit handler,
			// cannot cut the wait short while descendants still run.
			const group = pid
			if (interrupted || group === undefined) {
				interrupted = true
				return "none"
			}
			interrupted = true
			signalGroup(group, "SIGTERM")
			const deadline = Date.now() + graceMs
			while (Date.now() < deadline) {
				if (!groupAlive(group)) return "terminated"
				await delay(25)
			}
			signalGroup(group, "SIGKILL")
			return "killed"
		},
	}
}
