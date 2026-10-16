/** Nickname-only workspace label — never an absolute disk path. */
export function workspaceNicknameFromFsPath(workspaceRoot: string | undefined) {
	if (!workspaceRoot) {
		return undefined
	}

	// Avoid trailing-separator regexes (CodeQL js/polynomial-redos on long `/` runs).
	let end = workspaceRoot.length
	while (end > 0) {
		const code = workspaceRoot.charCodeAt(end - 1)
		if (code !== 47 /* / */ && code !== 92 /* \ */) {
			break
		}
		end -= 1
	}
	if (end === 0) {
		return undefined
	}

	let start = 0
	for (let i = end - 1; i >= 0; i -= 1) {
		const code = workspaceRoot.charCodeAt(i)
		if (code === 47 || code === 92) {
			start = i + 1
			break
		}
	}

	const nickname = workspaceRoot.slice(start, end)
	return nickname.length > 0 ? nickname : undefined
}

export function remoteMessageKey(taskId: string, message: { messageId?: string; ts: number }) {
	return message.messageId ?? `${taskId}:${message.ts}`
}

export function resolveRemoteMessageAction(
	action: string | undefined,
	partial: boolean | undefined,
): "created" | "updated" {
	if (action === "created" || action === "updated") {
		return action
	}

	return partial ? "updated" : "created"
}

/** Keep failed batch ahead of newer events; retain the newest `max` under pressure. */
export function requeueRemoteEventsKeepingNewest<T>(failedBatch: T[], pending: T[], max = 200) {
	return [...failedBatch, ...pending].slice(-max)
}

export function partialFlushDecision(
	lastPartialFlushAt: number,
	now: number,
	minIntervalMs: number,
): "arm" | "wait" | "flush" {
	if (lastPartialFlushAt === 0) {
		return "arm"
	}

	return now - lastPartialFlushAt < minIntervalMs ? "wait" : "flush"
}

export function isRemoteAuthBlockedStatus(status: number | undefined) {
	return status === 401 || status === 402 || status === 403
}

export function isRemoteNotFoundStatus(status: number | undefined) {
	return status === 404
}

export function resolveZooRemoteEventSeq(existing: number | undefined) {
	return typeof existing === "number" && Number.isFinite(existing) && existing >= 0 ? existing : 0
}

export function generateZooRemoteInstanceId(now: number, sessionId: string | undefined) {
	if (typeof sessionId === "string" && sessionId.length > 0) {
		return sessionId
	}
	return `zoo-${now}-${Math.random().toString(36).slice(2, 10)}`
}

export type RemoteControlHttpKind = "auth_blocked" | "unavailable" | "success" | "failed"

export function classifyRemoteControlHttpResult(result: { ok: boolean; status?: number }): RemoteControlHttpKind {
	if (isRemoteAuthBlockedStatus(result.status)) {
		return "auth_blocked"
	}
	if (isRemoteNotFoundStatus(result.status)) {
		return "unavailable"
	}
	return result.ok ? "success" : "failed"
}
