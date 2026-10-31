// Pure recovery decisions shared by the provider and the bounded protocol checker.
// VS Code effects, Promise settlement, and timer delivery remain in ClineProvider.
export const WEBVIEW_RECOVERY_LIMITS = { attempts: 3, healthyMs: 60_000, staleMs: 90_000 } as const

export function preservesRecoveryIncident(inProgress: boolean, pendingSidebar: boolean): boolean {
	return inProgress || pendingSidebar
}

export function resolutionFailureAction(input: {
	recoveringHost: boolean
	disposed: boolean
	isCurrent: boolean
}): "propagate" | "ignore" | "retry" {
	if (!input.recoveringHost) return "propagate"
	return input.disposed || !input.isCurrent ? "ignore" : "retry"
}

export function canCommitRecovery(input: {
	disposed: boolean
	isCurrent: boolean
	epochMatches: boolean
	heartbeatMatches: boolean
	visible: boolean
}): boolean {
	return !input.disposed && input.isCurrent && input.epochMatches && input.heartbeatMatches && input.visible
}

export function nextRecoveryAttempt(attempts: number, inFlight: boolean): number | undefined {
	return inFlight || attempts >= WEBVIEW_RECOVERY_LIMITS.attempts ? undefined : attempts + 1
}

export function releaseRecoveryOwner(owner: number | undefined, completedEpoch: number): number | undefined {
	return owner === completedEpoch ? undefined : owner
}

export function pendingSidebarAfterCommandFailure(input: {
	started: boolean
	focusSucceeded: boolean
	pending: boolean
}): boolean {
	return input.started && !input.focusSucceeded ? false : input.pending
}

export function recordRecoveryFailure(
	state: { attempts: number; reported: boolean; stopLogged: boolean },
	stopRecovery: boolean,
): { attempts: number; reported: boolean; notify: boolean; stopLogged: boolean; log: boolean } {
	return {
		attempts: stopRecovery ? WEBVIEW_RECOVERY_LIMITS.attempts : state.attempts,
		reported: true,
		notify: !state.reported,
		stopLogged: state.stopLogged || stopRecovery,
		log: stopRecovery ? !state.stopLogged : !state.reported && !state.stopLogged,
	}
}

export function recoveryHealth(
	state: { attempts: number; lastHeartbeatAt: number | undefined; healthySince: number | undefined },
	now: number,
): { attempts: number; healthySince: number | undefined } {
	const healthySince =
		state.lastHeartbeatAt === undefined || now - state.lastHeartbeatAt > WEBVIEW_RECOVERY_LIMITS.staleMs
			? now
			: state.healthySince
	return {
		healthySince,
		attempts:
			healthySince !== undefined && now - healthySince >= WEBVIEW_RECOVERY_LIMITS.healthyMs ? 0 : state.attempts,
	}
}

export function recoveryWarningAction(
	choice: string | undefined,
	disposed: boolean,
	sameHeartbeat: boolean,
	sameGeneration = true,
): "reload" | "retry" | "logs" | "none" {
	if (choice === "Show Logs") return "logs"
	if (disposed || !sameHeartbeat || !sameGeneration) return "none"
	if (choice === "Retry Interface Recovery") return "retry"
	return choice === "Reload Window" ? "reload" : "none"
}

export function isRecoveryGenerationCurrent(captured: number, current: number): boolean {
	return captured === current
}

export function beginExplicitRecovery(generation: number): {
	generation: number
	attempts: number
	reported: boolean
	stopLogged: boolean
} {
	return { generation: generation + 1, attempts: 1, reported: false, stopLogged: false }
}
