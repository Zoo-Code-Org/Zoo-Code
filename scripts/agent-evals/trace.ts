import { createHash } from "node:crypto"
import { RooCodeEventName, taskEventSchema, type TaskEvent } from "@roo-code/types"

export const TRACE_SCHEMA_VERSION = 1
export const TRACE_KIND = "agent-evals-trace"

export type Measured<T> = { available: true; value: T } | { available: false; reason: string }
export type MeasuredString = Measured<string>
export type Accountant = ReturnType<typeof createAccountant>

export const measured = <T>(value: T | undefined | null, reason: string): Measured<T> =>
	value === undefined || value === null ? { available: false, reason } : { available: true, value }

export interface TraceRunIdentity {
	commit: MeasuredString
	extensionVersion: MeasuredString
	vscodeTarget: MeasuredString
	nodeVersion: string
	platform: string
	arch: string
}

export const identityUnavailable = (reason = "identityUnavailable"): TraceRunIdentity => ({
	commit: { available: false, reason },
	extensionVersion: { available: false, reason },
	vscodeTarget: { available: false, reason },
	nodeVersion: process.version,
	platform: process.platform,
	arch: process.arch,
})

export type AgentExecutionCode =
	| "COMPLETED"
	| "STOPPED"
	| "SETUP_FAILED"
	| "ACTIVATION_FAILED"
	| "TASK_START_FAILED"
	| "SESSION_LOST"
	| "TASK_RUN_TIMEOUT"

export type AgentStopReason =
	| "taskCompleted"
	| "adapterStop"
	| "adapterStopAfterCompletionMessage"
	| "runTimeout"
	| "sessionLost"
	| "startNotAccepted"
	| "activationFailed"
	| "credentialMissing"
	| "fixtureRejected"
	| "setupError"

export interface AgentEventFlow {
	observed: number
	malformed: number
	foreignTaskEvents: number
	bufferedBeforeAck: number
	replayedAfterAck: number
	eventBufferLimit: number
	bufferOverflow: boolean
	droppedByOverflow: number
}

export interface TraceRequestRow {
	index: number
	ts: number
	apiProtocol: MeasuredString
	tokensIn: Measured<number>
	tokensOut: Measured<number>
	cacheWrites: Measured<number>
	cacheReads: Measured<number>
	cost: Measured<number>
	cancelReason?: string
	streamingFailed: boolean
	firstObservedMs: number
	lastUpdatedMs: number
	messageCount: number
}

export interface CumulativeUsageSnapshot {
	source: "taskTokenUsageUpdated" | "taskCompleted"
	observedAtMs: number
	tokensIn: number
	tokensOut: number
	cacheWrites: Measured<number>
	cacheReads: Measured<number>
	cost: number
	contextTokens: number
}

export interface TraceUsage {
	available: boolean
	unavailableReason?: string
	snapshotsObserved: number
	lastSnapshot?: CumulativeUsageSnapshot
}

export interface TraceToolSnapshot {
	snapshot?: Record<string, { attempts: number; failures: number }>
	observedAtMs?: number
}

export interface TraceAccounting {
	requests: TraceRequestRow[]
	requestCount: number
	requestsMissingUsage: number
	apiReqRetriedMarkers: number
	usage: TraceUsage
	toolSnapshot: TraceToolSnapshot
	toolFailureEvents: number
	toolFailuresByTool: Record<string, number>
	completeness: { status: "complete" | "partial"; reasons: string[] }
}

export interface AgentTeardown {
	status: "ok" | "failed"
	hostExited: boolean
	closeTaskSent: boolean
	escalatedSignals: string[]
	cleanup: "done" | "skippedLiveHost" | "failed" | "notNeeded"
	failures: string[]
}

export interface AgentTrace {
	traceSchemaVersion: typeof TRACE_SCHEMA_VERSION
	kind: typeof TRACE_KIND
	run: {
		runId: string
		fixture: { name: string; version: string }
		startedAt: string
		finishedAt: string
		durationMs: number
		identity: TraceRunIdentity
	}
	settings: {
		available: boolean
		reason?: string
		projection?: Record<string, unknown>
		digest?: string
	}
	execution: {
		code: AgentExecutionCode
		stopReason: AgentStopReason
		activated: boolean
		taskAccepted: boolean
		sessionLost: boolean
		// True when the final completion_result message for the accepted task
		// was observed. This is model output, not acceptance.
		completionMessageSeen: boolean
		timings: {
			activationMs?: number
			taskStartMs?: number
			taskRunMs?: number
			usageDrainMs?: number
			teardownMs?: number
			totalMs: number
		}
	}
	eventFlow: AgentEventFlow
	accounting: TraceAccounting
	teardown: AgentTeardown
	notes: string[]
}

// Fixed vocabulary. Reviewers can rely on these sentences across trace versions.
export const TRACE_NOTES = [
	"Usage numbers come from extension events. The trace never sums cumulative snapshots.",
	"Zero token or cost values can be defaults from the adapter or task layer. They do not prove the provider measured zero.",
	"contextTokens is an extension context estimate, not a provider measurement.",
	"Request rows use per-request fields from api_req_started message updates, keyed by message timestamp.",
	"apiReqRetriedMarkers counts retry marker messages. It is not an HTTP retry count.",
	"The trace is metadata only. Prompts, model output, reasoning, tool arguments, error payloads, and storage paths are excluded. Provider settings appear only as the nonsecret settings projection.",
	"Missing measurements carry a reason. They are never filled with zero.",
	"execution.code COMPLETED requires the extension taskCompleted event. The extension emits it only after the completion result is accepted, or a delegated subtask hands back, and the turn is persisted.",
	"The final completion_result message is model output, not acceptance. execution.completionMessageSeen records it and never produces COMPLETED.",
	"An observer stop after that message is stopReason adapterStopAfterCompletionMessage with code STOPPED. An observer stop without it stays adapterStop.",
]

const sortValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(sortValue)
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, entry]) => [key, sortValue(entry)]),
		)
	}
	return value
}

export const stableStringify = (value: unknown): string => JSON.stringify(sortValue(value))

export const digestProjection = (projection: Record<string, unknown>): string =>
	createHash("sha256").update(stableStringify(projection)).digest("hex")

interface RequestRowState {
	index: number
	ts: number
	apiProtocol?: string
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	cost?: number
	cancelReason?: string
	streamingFailed: boolean
	firstObservedMs: number
	lastUpdatedMs: number
	messageCount: number
	hasUsage: boolean
}

const MAX_REQUEST_TEXT_CHARS = 4_096
const MAX_CANCEL_REASON_CHARS = 32
const MAX_PROTOCOL_CHARS = 16

export interface AccountingInputs {
	accepted: boolean
	sessionLost: boolean
	// True when the session died inside the post-completion usage drain. Late
	// usage may be truncated, so the accounting carries its own caveat.
	sessionLostDuringDrain?: boolean
	bufferOverflow: boolean
	malformedEvents: number
	foreignTaskEvents: number
}

export function createAccountant(nowMs: () => number): {
	observe(event: TaskEvent): void
	snapshot(inputs: AccountingInputs): TraceAccounting
} {
	const rows = new Map<number, RequestRowState>()
	let snapshotsObserved = 0
	let lastUsageSnapshot: CumulativeUsageSnapshot | undefined
	let lastToolSnapshot: TraceToolSnapshot = {}
	let apiReqRetriedMarkers = 0
	let toolFailureEvents = 0
	const toolFailuresByTool: Record<string, number> = {}

	const usageSnapshot = (
		source: CumulativeUsageSnapshot["source"],
		usage: {
			totalTokensIn: number
			totalTokensOut: number
			totalCacheWrites?: number
			totalCacheReads?: number
			totalCost: number
			contextTokens: number
		},
	): CumulativeUsageSnapshot => ({
		source,
		observedAtMs: nowMs(),
		tokensIn: usage.totalTokensIn,
		tokensOut: usage.totalTokensOut,
		cacheWrites: measured(usage.totalCacheWrites, "notReported"),
		cacheReads: measured(usage.totalCacheReads, "notReported"),
		cost: usage.totalCost,
		contextTokens: usage.contextTokens,
	})

	const observe = (event: TaskEvent): void => {
		if (event.eventName === RooCodeEventName.Message) {
			const entry = event.payload[0]
			const message = entry.message
			if (message.type !== "say") return
			if (message.say === "api_req_retried") {
				apiReqRetriedMarkers++
				return
			}
			if (message.say !== "api_req_started") return
			const ts = message.ts
			const at = nowMs()
			const row: RequestRowState = rows.get(ts) ?? {
				index: rows.size,
				ts,
				streamingFailed: false,
				firstObservedMs: at,
				lastUpdatedMs: at,
				messageCount: 0,
				hasUsage: false,
			}
			row.messageCount++
			row.lastUpdatedMs = at
			if (typeof message.text === "string" && message.text.length <= MAX_REQUEST_TEXT_CHARS) {
				try {
					const info = JSON.parse(message.text) as {
						apiProtocol?: string
						tokensIn?: number
						tokensOut?: number
						cacheWrites?: number
						cacheReads?: number
						cost?: number
						cancelReason?: string
						streamingFailedMessage?: string
					}
					if (typeof info.apiProtocol === "string" && info.apiProtocol.length <= MAX_PROTOCOL_CHARS)
						row.apiProtocol = info.apiProtocol
					if (typeof info.tokensIn === "number") {
						row.tokensIn = info.tokensIn
						row.hasUsage = true
					}
					if (typeof info.tokensOut === "number") {
						row.tokensOut = info.tokensOut
						row.hasUsage = true
					}
					if (typeof info.cacheWrites === "number") {
						row.cacheWrites = info.cacheWrites
						row.hasUsage = true
					}
					if (typeof info.cacheReads === "number") {
						row.cacheReads = info.cacheReads
						row.hasUsage = true
					}
					if (typeof info.cost === "number") row.cost = info.cost
					if (typeof info.cancelReason === "string" && info.cancelReason.length <= MAX_CANCEL_REASON_CHARS)
						row.cancelReason = info.cancelReason
					// Presence only. The failure text itself is never stored.
					if (typeof info.streamingFailedMessage === "string") row.streamingFailed = true
				} catch {
					// Unreadable request text stays an availability gap, not an error payload.
				}
			}
			rows.set(ts, row)
			return
		}
		if (event.eventName === RooCodeEventName.TaskTokenUsageUpdated) {
			snapshotsObserved++
			lastUsageSnapshot = usageSnapshot("taskTokenUsageUpdated", event.payload[1])
			lastToolSnapshot = { snapshot: event.payload[2], observedAtMs: nowMs() }
			return
		}
		if (event.eventName === RooCodeEventName.TaskCompleted) {
			snapshotsObserved++
			lastUsageSnapshot = usageSnapshot("taskCompleted", event.payload[1])
			lastToolSnapshot = { snapshot: event.payload[2], observedAtMs: nowMs() }
			return
		}
		if (event.eventName === RooCodeEventName.TaskToolFailed) {
			const tool = event.payload[1]
			toolFailureEvents++
			toolFailuresByTool[tool] = (toolFailuresByTool[tool] ?? 0) + 1
		}
	}

	const snapshot = (inputs: AccountingInputs): TraceAccounting => {
		const requests: TraceRequestRow[] = [...rows.values()]
			.sort((a, b) => a.index - b.index)
			.map((row) => ({
				index: row.index,
				ts: row.ts,
				apiProtocol: measured(row.apiProtocol, "notReported"),
				tokensIn: measured(row.tokensIn, "notReported"),
				tokensOut: measured(row.tokensOut, "notReported"),
				cacheWrites: measured(row.cacheWrites, "notReported"),
				cacheReads: measured(row.cacheReads, "notReported"),
				cost: measured(row.cost, "notReported"),
				cancelReason: row.cancelReason,
				streamingFailed: row.streamingFailed,
				firstObservedMs: row.firstObservedMs,
				lastUpdatedMs: row.lastUpdatedMs,
				messageCount: row.messageCount,
			}))
		const requestsMissingUsage = [...rows.values()].filter((row) => !row.hasUsage).length
		const reasons: string[] = []
		if (!inputs.accepted) reasons.push("taskNotAccepted")
		if (snapshotsObserved === 0) reasons.push("noUsageEventsObserved")
		if (requestsMissingUsage > 0) reasons.push("finalRequestMissingUsage")
		if (inputs.bufferOverflow) reasons.push("eventBufferOverflow")
		if (inputs.malformedEvents > 0) reasons.push("malformedEventsObserved")
		if (inputs.foreignTaskEvents > 0) reasons.push("foreignTaskEventsDropped")
		if (inputs.sessionLost) reasons.push("sessionLost")
		if (inputs.sessionLostDuringDrain) reasons.push("sessionLostDuringUsageDrain")
		return {
			requests,
			requestCount: requests.length,
			requestsMissingUsage,
			apiReqRetriedMarkers,
			usage: {
				available: snapshotsObserved > 0,
				unavailableReason: snapshotsObserved > 0 ? undefined : "noUsageEventsObserved",
				snapshotsObserved,
				lastSnapshot: lastUsageSnapshot,
			},
			toolSnapshot: lastToolSnapshot,
			toolFailureEvents,
			toolFailuresByTool,
			completeness: { status: reasons.length === 0 ? "complete" : "partial", reasons },
		}
	}

	return { observe, snapshot }
}

// Defense in depth for replay: schema-valid events only, and only their task
// identity is read. No payload content passes through this helper.
export const parseTaskEvent = (raw: unknown): TaskEvent | undefined => {
	const parsed = taskEventSchema.safeParse(raw)
	return parsed.success ? parsed.data : undefined
}

export const eventTaskId = (event: TaskEvent): string | undefined => {
	const first: unknown = (event.payload as readonly unknown[])[0]
	if (typeof first === "string") return first
	if (typeof first === "object" && first !== null && "taskId" in first) {
		const taskId = (first as { taskId?: unknown }).taskId
		if (typeof taskId === "string") return taskId
	}
	return undefined
}
