import type { ExtensionMessage } from "@roo-code/types"
import {
	createTranscriptTransportState,
	reduceTranscriptTransport,
	transcriptFrameMessage,
	type TranscriptAction,
	type TranscriptFrame,
	type TranscriptJob,
	type TranscriptTransportState,
} from "../transcriptTransport"

type TaskId = "a" | "b"
type Intent =
	| "snapshot"
	| "append"
	| "update"
	| "resync"
	| "invalidate"
	| "switch"
	| "clear"
	| "focus"
	| "stale-snapshot"
	| "replace-instance"
	| "sync-instance"
	| "stale-instance-append"
	| "stale-instance-snapshot"
	| "empty-append"
	| "empty-update"
	| "empty-snapshot"
type Capture = {
	job: TranscriptJob
	taskInstanceId: string | undefined
	scope: string
	values: number[]
	failed: boolean
}
type ModelState = {
	transport: TranscriptTransportState
	focus: TaskId | undefined
	focusInstance: string | undefined
	instanceSyncPending: boolean
	staleInstanceRejected: boolean
	discardedInstanceJobs: string[]
	rejectedInstancePhases: string[]
	appliedInstanceDeltas: string[]
	producer: number
	controller: number
	failures: number
	data: Record<TaskId, number[]>
	epochs: Record<TaskId, number>
	captures: Capture[]
	payloads: number[]
	callers: number[]
	physical?: TranscriptFrame
	physicalMessage?: ExtensionMessage
	allocated: Record<string, number>
	sent: Record<string, number>
	visible: number[]
	appliedSeq: number
	staging?: { id: number; values: number[] }
	committed: number[]
	staleCompletions: number
	staleCommitCompletions: number
}
type Scenario = { name: string; producer: Intent[]; controller: Intent[] }
type Event = { name: string; actor?: "producer" | "controller"; intent?: Intent; action?: TranscriptAction }
type Node = { state: ModelState; parent: number; event: string; depth: number }
type Reducer = typeof reduceTranscriptTransport
type ReceiverScope = Pick<ModelState, "focus" | "focusInstance">
type Faults = {
	wire?: typeof transcriptFrameMessage
	accepts?: (message: ExtensionMessage, scope: ReceiverScope) => boolean
}
type Mutation = Faults & { name: string; expected: string; reduce?: Reducer }

export const TRANSPORT_MODEL_BOUNDS = { depth: 40, states: 30_000, chunkSize: 2, failures: 1 } as const
export const TRANSPORT_SCENARIOS: Scenario[] = [
	{
		name: "queued-deltas-repeated-resync",
		producer: ["snapshot", "append", "update"],
		controller: ["resync", "resync"],
	},
	{ name: "task-switch-and-clear", producer: ["snapshot", "append", "snapshot"], controller: ["switch", "clear"] },
	{
		name: "invalidation-and-recovery",
		producer: ["snapshot", "update", "snapshot"],
		controller: ["invalidate", "resync"],
	},
	{
		name: "focus-before-sync-and-stale-request",
		producer: ["snapshot", "append", "update"],
		controller: ["focus", "resync", "stale-snapshot"],
	},
	{
		name: "same-task-instance-snapshot-before-sync",
		producer: ["snapshot", "stale-instance-append"],
		controller: ["replace-instance", "sync-instance", "append", "update"],
	},
	{
		name: "same-task-instance-deltas-before-sync",
		producer: ["append", "update", "stale-instance-snapshot"],
		controller: ["replace-instance", "sync-instance"],
	},
	{
		name: "empty-deltas-before-valid-work",
		producer: ["empty-append", "empty-update", "append", "empty-snapshot"],
		controller: [],
	},
]
export const TRANSPORT_ACTIONS = [
	"snapshot",
	"append",
	"update",
	"resync",
	"invalidate",
	"switch",
	"clear",
	"focus",
	"stale-snapshot",
	"replace-instance",
	"sync-instance",
	"stale-instance-append",
	"stale-instance-snapshot",
	"empty-append",
	"empty-update",
	"empty-snapshot",
	"pump",
	"start",
	"chunk",
	"end",
	"settle",
	"fail",
	"discard",
]
export const TRANSPORT_LANDMARKS = {
	"held-post-with-queued-delta": (s: ModelState) =>
		!!s.physical && s.transport.queue.some((job) => job.kind !== "snapshot"),
	"repeated-invalidation-while-held": (s: ModelState) =>
		!!s.physical && s.transport.generation - s.physical.job.generation >= 2,
	"cancelled-active-suffix-released": (s: ModelState) =>
		!!s.physical && s.physical.job.generation < s.transport.generation && !s.payloads.includes(s.physical.job.id),
	"new-generation-waits-for-old-send": (s: ModelState) =>
		!!s.physical && s.physical.job.generation < s.transport.generation && s.transport.queue.length > 0,
	"stale-physical-completion": (s: ModelState) => s.staleCompletions > 0,
	"already-initiated-stale-end-can-complete": (s: ModelState) => s.staleCommitCompletions > 0,
	"task-switch-with-held-send": (s: ModelState) => s.focus === "b" && s.physical?.job.taskId === "a",
	"focus-changed-before-invalidation": (s: ModelState) =>
		s.focus === "b" && s.transport.generation === 0 && !!s.transport.active,
	"clear-prunes-task-sequences": (s: ModelState) => !s.focus && s.transport.sequences.size === 0,
	"empty-snapshot-committed": (s: ModelState) => s.committed.some((id) => s.captures[id - 1].job.total === 0),
	"multi-chunk-snapshot-committed": (s: ModelState) =>
		s.committed.some((id) => s.captures[id - 1].job.total > TRANSPORT_MODEL_BOUNDS.chunkSize),
	"failed-post-with-queued-recovery": (s: ModelState) =>
		s.failures > 0 && s.transport.queue.some((job) => job.kind === "snapshot"),
	"snapshot-recovery-after-failure": (s: ModelState) =>
		s.committed.some((id) => s.captures.some((c) => c.failed && c.job.id < id)),
	"delta-applied-after-snapshot": (s: ModelState) =>
		s.committed.length > 0 && s.appliedSeq > s.captures[s.committed.at(-1)! - 1].job.seq,
	"same-task-instance-published-before-sync": (s: ModelState) =>
		s.focus === "a" && s.focusInstance === "a:1" && s.instanceSyncPending && s.transport.generation === 0,
	"instance-replacement-with-held-send": (s: ModelState) =>
		s.focusInstance === "a:1" && s.physical?.job.taskInstanceId === "a:0",
	"stale-instance-current-generation-rejected": (s: ModelState) => s.staleInstanceRejected,
	"stale-instance-queued-job-discarded": (s: ModelState) => s.discardedInstanceJobs.includes("queued"),
	"stale-instance-active-suffix-discarded": (s: ModelState) => s.discardedInstanceJobs.includes("active"),
	"old-instance-end-ignored": (s: ModelState) => s.rejectedInstancePhases.includes("end"),
	"old-instance-append-ignored": (s: ModelState) => s.rejectedInstancePhases.includes("append"),
	"old-instance-update-ignored": (s: ModelState) => s.rejectedInstancePhases.includes("update"),
	"new-instance-snapshot-committed": (s: ModelState) =>
		s.committed.some((id) => s.captures[id - 1].job.taskInstanceId === "a:1"),
	"new-instance-append-applied": (s: ModelState) => s.appliedInstanceDeltas.includes("append"),
	"new-instance-update-applied": (s: ModelState) => s.appliedInstanceDeltas.includes("update"),
	"new-instance-recovers-after-old-end-rejected": (s: ModelState) =>
		s.rejectedInstancePhases.includes("end") &&
		s.committed.some((id) => s.captures[id - 1].job.taskInstanceId === "a:1") &&
		s.appliedInstanceDeltas.includes("append") &&
		s.appliedInstanceDeltas.includes("update"),
} satisfies Record<string, (s: ModelState) => boolean>

function initialState(): ModelState {
	return {
		transport: createTranscriptTransportState(TRANSPORT_MODEL_BOUNDS.chunkSize),
		focus: "a",
		focusInstance: "a:0",
		instanceSyncPending: false,
		staleInstanceRejected: false,
		discardedInstanceJobs: [],
		rejectedInstancePhases: [],
		appliedInstanceDeltas: [],
		producer: 0,
		controller: 0,
		failures: 0,
		data: { a: [1, 2, 3], b: [7] },
		epochs: { a: 0, b: 0 },
		captures: [],
		payloads: [],
		callers: [],
		allocated: {},
		sent: {},
		visible: [],
		appliedSeq: 0,
		committed: [],
		staleCompletions: 0,
		staleCommitCompletions: 0,
	}
}

function enabled(s: ModelState, scenario: Scenario): Event[] {
	const events: Event[] = []
	for (const actor of ["producer", "controller"] as const) {
		const intent = scenario[actor][s[actor]]
		// A delayed old producer resumes only after the replacement has been published.
		if (intent?.startsWith("stale-instance-") && s.focusInstance !== "a:1") continue
		if (intent) events.push({ name: `${actor}:${intent}`, actor, intent })
	}
	if (!s.transport.inFlight && (s.transport.active || s.transport.queue.length)) {
		events.push({
			name: "pump",
			action: { type: "pump", focusedTaskId: s.focus, focusedTaskInstanceId: s.focusInstance },
		})
	}
	if (s.transport.inFlight) {
		events.push({ name: "settle", action: { type: "settle", success: true } })
		if (s.failures < TRANSPORT_MODEL_BOUNDS.failures)
			events.push({ name: "fail", action: { type: "settle", success: false } })
	}
	return events
}

function requireInvariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

function acceptsFocusedMessage(message: ExtensionMessage, scope: ReceiverScope): boolean {
	return message.taskId === scope.focus && message.taskInstanceId === scope.focusInstance
}

/** Independent receiver oracle. It sees captured wire identity, not private generation tokens. */
function deliver(s: ModelState, frame: TranscriptFrame, message: ExtensionMessage, faults: Faults): void {
	const { job, phase } = frame
	const accepted = (faults.accepts ?? acceptsFocusedMessage)(message, s)
	const current = message.taskId === s.focus && message.taskInstanceId === s.focusInstance
	requireInvariant(!accepted || current, "receiver accepted a stale-instance frame")
	if (!accepted) {
		if (message.taskId === s.focus && message.taskInstanceId !== s.focusInstance) {
			s.rejectedInstancePhases = [...new Set([...s.rejectedInstancePhases, phase])].sort()
		}
		return
	}
	const capture = s.captures[job.id - 1]
	const oldVisible = [...s.visible]
	const oldSeq = s.appliedSeq
	const seq = message.clineMessagesSeq ?? 0
	if (phase === "start") {
		if (seq >= s.appliedSeq) s.staging = { id: job.id, values: [] }
	} else if (phase === "chunk") {
		if (s.staging?.id === job.id) {
			requireInvariant(message.snapshotStartIndex === s.staging.values.length, "non-contiguous snapshot chunk")
			s.staging.values.push(...(message.clineMessages ?? []).map((m) => m.ts))
		}
	} else if (phase === "end") {
		requireInvariant(s.staging?.id === job.id, "snapshot commit without matching start")
		requireInvariant(
			JSON.stringify(s.staging.values) === JSON.stringify(capture.values),
			"snapshot commit before complete chunks",
		)
		if (seq >= s.appliedSeq) {
			s.visible = s.staging.values
			s.appliedSeq = seq
			s.committed.push(job.id)
		}
		s.staging = undefined
	} else if (!s.staging && seq === s.appliedSeq + 1) {
		requireInvariant(message.clineMessage, "delta lacks a wire payload")
		if (phase === "append") s.visible.push(message.clineMessage.ts)
		else if (s.visible.length) s.visible[0] = message.clineMessage.ts
		s.appliedSeq = seq
		if (message.taskInstanceId === "a:1") {
			s.appliedInstanceDeltas = [...new Set([...s.appliedInstanceDeltas, phase])].sort()
		}
	}
	if (phase === "start" || phase === "chunk") {
		requireInvariant(
			JSON.stringify(s.visible) === JSON.stringify(oldVisible),
			"snapshot exposed a partial transcript",
		)
		requireInvariant(s.appliedSeq === oldSeq, "snapshot applied sequence before commit")
	}
	requireInvariant(s.appliedSeq >= oldSeq, "applied sequence regressed within focus scope")
}

class ModelViolation extends Error {
	constructor(
		message: string,
		readonly state: ModelState,
	) {
		super(message)
	}
}

function step(source: ModelState, event: Event, reducer: Reducer, coverage: Set<string>, faults: Faults): ModelState {
	const s = structuredClone(source)
	try {
		return executeStep(s, event, reducer, coverage, faults)
	} catch (error) {
		throw new ModelViolation(error instanceof Error ? error.message : String(error), s)
	}
}

function executeStep(s: ModelState, event: Event, reducer: Reducer, coverage: Set<string>, faults: Faults): ModelState {
	const apply = (action: TranscriptAction, values: number[] = []) => {
		const before = s.transport
		const transition = reducer(before, action)
		s.transport = transition.state
		requireInvariant(
			s.transport.generation === before.generation + (action.type === "invalidate" ? 1 : 0),
			"generation is not monotonic",
		)
		if (action.type === "enqueue") {
			const unchanged =
				!transition.accepted &&
				s.transport === before &&
				!transition.post &&
				transition.release.length === 0 &&
				transition.settle.length === 0
			if (action.request.kind !== "snapshot" && action.total === 0) {
				requireInvariant(unchanged, "empty delta allocated work")
			}
			if (action.request.taskInstanceId !== action.focusedTaskInstanceId) {
				requireInvariant(unchanged, "stale-instance request allocated work")
				if (action.request.generation === before.generation) s.staleInstanceRejected = true
			}
		}
		if (
			action.type === "enqueue" &&
			action.request.generation !== undefined &&
			action.request.generation !== before.generation
		) {
			requireInvariant(
				!transition.accepted &&
					s.transport.nextJobId === before.nextJobId &&
					s.transport.nextSnapshotId === before.nextSnapshotId,
				"stale-generation request allocated work",
			)
		}
		if (transition.accepted) {
			const job = transition.accepted
			requireInvariant(
				action.type === "enqueue" && job.taskInstanceId === action.request.taskInstanceId,
				"descriptor lost originating instance identity",
			)
			const scope = job.taskId ? `${job.taskId}:${s.epochs[job.taskId as TaskId]}` : "none"
			const previousSeq = s.allocated[scope] ?? 0
			const expectedSeq =
				previousSeq +
				(action.type === "enqueue" &&
				(action.request.kind !== "snapshot" || action.request.bumpSeq) &&
				job.taskId
					? 1
					: 0)
			requireInvariant(job.seq === expectedSeq, "allocated sequence diverged from capture order")
			requireInvariant(job.total === values.length, "job total differs from captured payload")
			if (job.kind === "snapshot") {
				requireInvariant(
					typeof job.snapshotId === "string" &&
						job.snapshotId.length > 0 &&
						!s.captures.some((capture) => capture.job.snapshotId === job.snapshotId),
					"snapshot lacks a unique identity",
				)
			} else {
				requireInvariant(!("snapshotId" in job), "delta carries snapshot metadata")
			}
			s.allocated[scope] = job.seq
			s.captures.push({
				job,
				taskInstanceId: action.request.taskInstanceId,
				scope,
				values: [...values],
				failed: false,
			})
			s.payloads.push(job.id)
			s.callers.push(job.id)
		}
		for (const id of transition.release) {
			if (action.type === "pump") {
				const job = s.captures[id - 1].job
				if (job.taskId === s.focus && job.taskInstanceId !== s.focusInstance) {
					const location = before.active?.job.id === id ? "active" : "queued"
					s.discardedInstanceJobs = [...new Set([...s.discardedInstanceJobs, location])].sort()
				}
			}
			s.payloads = s.payloads.filter((value) => value !== id)
		}
		for (const { id } of transition.settle) {
			requireInvariant(s.callers.includes(id), "settlement lacks a registered caller")
			s.callers = s.callers.filter((value) => value !== id)
		}
		if (action.type === "invalidate") {
			requireInvariant(
				s.transport.queue.length === 0 && !s.transport.active && s.payloads.length === 0,
				"invalidation retained obsolete queue or payload",
			)
			requireInvariant(
				s.callers.every((id) => id === s.physical?.job.id),
				"discarded caller did not settle immediately",
			)
		}
		if (action.type === "settle") {
			const physical = s.physical
			requireInvariant(physical, "settled without physical send")
			if (physical.job.generation < s.transport.generation) s.staleCompletions++
			if (
				action.success &&
				physical.phase === "end" &&
				physical.job.generation < s.transport.generation &&
				physical.job.taskId === s.focus &&
				physical.job.taskInstanceId === s.focusInstance
			)
				s.staleCommitCompletions++
			if (action.success) {
				requireInvariant(s.physicalMessage, "physical send lost its captured wire message")
				requireInvariant(
					s.physicalMessage.taskInstanceId === s.captures[physical.job.id - 1].taskInstanceId,
					"wire lost originating instance identity",
				)
				deliver(s, physical, s.physicalMessage, faults)
			} else {
				s.captures[physical.job.id - 1].failed = true
				s.failures++
			}
			s.physical = undefined
			s.physicalMessage = undefined
		}
		if (transition.post) {
			const frame = transition.post
			const capture = s.captures[frame.job.id - 1]
			requireInvariant(!s.physical, "overlapping physical sends")
			requireInvariant(
				capture.job.generation === s.transport.generation && frame.job.taskId === s.focus,
				"post or commit initiated after invalidation",
			)
			requireInvariant(capture.taskInstanceId === s.focusInstance, "post initiated for a stale instance")
			requireInvariant(
				frame.job.taskInstanceId === capture.taskInstanceId,
				"frame lost originating instance identity",
			)
			const message = (faults.wire ?? transcriptFrameMessage)(
				frame,
				capture.values.map((value) => ({ ts: value, type: "say", text: String(value) })),
			)
			requireInvariant(
				message.taskId === capture.job.taskId && message.taskInstanceId === capture.taskInstanceId,
				"wire lost originating instance identity",
			)
			requireInvariant(!capture.failed, "failed snapshot continued posting")
			if (frame.phase === "chunk") {
				// Check the descriptor before wire slicing can clamp an overlarge count.
				requireInvariant(
					Number.isSafeInteger(frame.start) &&
						frame.start >= 0 &&
						frame.start === s.staging?.values.length &&
						frame.count > 0 &&
						frame.count === capture.values.slice(frame.start, frame.start + before.chunkSize).length &&
						frame.start + frame.count <= capture.values.length,
					"chunk descriptor differs from captured payload range",
				)
			} else {
				requireInvariant(frame.start === 0 && frame.count === 0, "non-chunk frame carries a payload range")
			}
			requireInvariant(
				frame.job.seq >= (s.sent[capture.scope] ?? 0),
				"sent sequence regressed within task lifetime",
			)
			requireInvariant(frame.job.seq <= s.allocated[capture.scope], "sent sequence exceeds allocation")
			requireInvariant(s.payloads.includes(frame.job.id), "post without payload ownership")
			s.sent[capture.scope] = frame.job.seq
			s.physical = frame
			s.physicalMessage = message
			coverage.add(frame.phase)
		}
		if ((action.type === "pump" || action.type === "invalidate") && transition.release.length)
			coverage.add("discard")
		const owned = [
			...s.transport.queue.map((job) => job.id),
			...(s.transport.active ? [s.transport.active.job.id] : []),
		].sort((a, b) => a - b)
		requireInvariant(
			JSON.stringify(s.payloads) === JSON.stringify(owned),
			"payload ownership differs from queue and active job",
		)
		const callers = [...new Set([...owned, ...(s.physical ? [s.physical.job.id] : [])])].sort((a, b) => a - b)
		requireInvariant(
			JSON.stringify(s.callers) === JSON.stringify(callers),
			"caller ownership differs from queued and physical work",
		)
	}

	if (event.action) {
		coverage.add(event.name)
		apply(event.action)
	} else if (event.intent && event.actor) {
		s[event.actor]++
		coverage.add(event.intent)
		const intent = event.intent
		if (intent === "switch" || intent === "clear" || intent === "focus" || intent === "replace-instance") {
			const previous = s.focus
			s.focus = intent === "replace-instance" ? "a" : intent === "clear" ? undefined : "b"
			s.focusInstance = intent === "replace-instance" ? "a:1" : s.focus ? `${s.focus}:0` : undefined
			if (intent === "replace-instance") {
				// Publication is synchronous; later sync/invalidation may not have resumed yet.
				s.instanceSyncPending = true
				s.data.a = [5]
			}
			s.visible = []
			s.appliedSeq = 0
			s.staging = undefined
			if (previous && (intent === "switch" || intent === "clear")) {
				apply({ type: "forget-task", taskId: previous })
				s.epochs[previous]++
			}
		}
		if (["switch", "clear", "invalidate", "resync", "sync-instance"].includes(intent)) apply({ type: "invalidate" })
		if (intent === "sync-instance") s.instanceSyncPending = false
		if (intent !== "invalidate" && intent !== "focus" && intent !== "replace-instance") {
			const staleInstance = intent.startsWith("stale-instance-")
			const empty = intent.startsWith("empty-")
			const kind = intent.endsWith("append") ? "append" : intent.endsWith("update") ? "update" : "snapshot"
			if (s.focus && !staleInstance && !empty) {
				if (kind === "append") s.data[s.focus].push(4)
				if (kind === "update") s.data[s.focus][0] = 9
			}
			const values =
				empty || !s.focus
					? []
					: staleInstance
						? [8]
						: kind === "snapshot"
							? s.data[s.focus]
							: kind === "append"
								? [4]
								: [9]
			apply(
				{
					type: "enqueue",
					request: {
						kind,
						taskId: s.focus,
						taskInstanceId: staleInstance ? "a:0" : s.focusInstance,
						bumpSeq: intent === "snapshot",
						generation: s.transport.generation - (intent === "stale-snapshot" ? 1 : 0),
					},
					total: values.length,
					focusedTaskId: s.focus,
					focusedTaskInstanceId: s.focusInstance,
				},
				values,
			)
		}
	}
	return s
}

function canonical(s: ModelState): string {
	return JSON.stringify({ ...s, transport: { ...s.transport, sequences: [...s.transport.sequences].sort() } })
}

export function exploreTranscriptTransport(
	scenario: Scenario,
	reducer: Reducer = reduceTranscriptTransport,
	bounds: { depth: number; states: number } = TRANSPORT_MODEL_BOUNDS,
	faults: Faults = {},
) {
	const nodes: Node[] = [{ state: initialState(), parent: -1, event: "initial", depth: 0 }]
	const visited = new Set([canonical(nodes[0].state)])
	const actions = new Set<string>()
	const landmarks = new Set<string>()
	let transitions = 0
	let maximumDepth = 0
	const trace = (index: number, lastEvent: string, failureState: ModelState) => {
		const path: Array<{ event: string; state: ModelState }> = []
		for (let i = index; i >= 0; i = nodes[i].parent) path.push({ event: nodes[i].event, state: nodes[i].state })
		return [...path.reverse(), { event: lastEvent, state: failureState }]
	}
	for (let index = 0; index < nodes.length; index++) {
		const node = nodes[index]
		maximumDepth = Math.max(maximumDepth, node.depth)
		for (const [name, predicate] of Object.entries(TRANSPORT_LANDMARKS))
			if (predicate(node.state)) landmarks.add(name)
		for (const event of enabled(node.state, scenario)) {
			let next: ModelState
			try {
				next = step(node.state, event, reducer, actions, faults)
			} catch (error) {
				const witness = trace(index, event.name, error instanceof ModelViolation ? error.state : node.state)
				return {
					states: visited.size,
					transitions,
					maximumDepth,
					actions,
					landmarks,
					violation: error instanceof Error ? error.message : String(error),
					witness,
				}
			}
			transitions++
			const key = canonical(next)
			if (visited.has(key)) continue
			if (node.depth >= bounds.depth)
				throw new Error(`${scenario.name}: depth ${bounds.depth} truncation at ${event.name}`)
			if (visited.size >= bounds.states)
				throw new Error(`${scenario.name}: state budget ${bounds.states} exceeded`)
			visited.add(key)
			nodes.push({ state: next, parent: index, event: event.name, depth: node.depth + 1 })
		}
	}
	return {
		states: visited.size,
		transitions,
		maximumDepth,
		actions,
		landmarks,
		violation: undefined,
		witness: undefined,
	}
}

export const TRANSPORT_MUTATIONS: Mutation[] = [
	{
		name: "stale-completion-starts-end",
		expected: "post or commit initiated after invalidation",
		reduce: (state, action) => {
			const result = reduceTranscriptTransport(state, action)
			if (
				action.type === "settle" &&
				state.inFlight &&
				state.inFlight.job.generation < state.generation &&
				state.inFlight.phase !== "end"
			) {
				result.post = { ...state.inFlight, phase: "end" }
				result.state = { ...result.state, inFlight: result.post }
			}
			return result
		},
	},
	{
		name: "admit-stale-generation",
		expected: "stale-generation request allocated work",
		reduce: (state, action) =>
			reduceTranscriptTransport(
				state,
				action.type === "enqueue"
					? { ...action, request: { ...action.request, generation: state.generation } }
					: action,
			),
	},
	{
		name: "ignore-focus-at-post",
		expected: "post or commit initiated after invalidation",
		reduce: (state, action) =>
			reduceTranscriptTransport(
				state,
				action.type === "pump"
					? {
							...action,
							focusedTaskId: state.active?.job.taskId ?? state.queue[0]?.taskId,
							focusedTaskInstanceId: state.active?.job.taskInstanceId ?? state.queue[0]?.taskInstanceId,
						}
					: action,
			),
	},
	{
		name: "legacy-generation-only-invalidation",
		expected: "invalidation retained obsolete queue or payload",
		reduce: (state, action) =>
			action.type === "invalidate"
				? { state: { ...state, generation: state.generation + 1 }, release: [], settle: [] }
				: reduceTranscriptTransport(state, action),
	},
	{
		name: "reset-promise-barrier",
		expected: "overlapping physical sends",
		reduce: (state, action) => {
			const result = reduceTranscriptTransport(state, action)
			if (action.type === "invalidate") result.state = { ...result.state, inFlight: undefined }
			return result
		},
	},
	{
		name: "commit-before-chunks",
		expected: "snapshot commit before complete chunks",
		reduce: (state, action) => {
			const result = reduceTranscriptTransport(state, action)
			if (result.post?.phase === "chunk") {
				result.post = { ...result.post, phase: "end", start: 0, count: 0 }
				result.state = { ...result.state, inFlight: result.post }
			}
			return result
		},
	},
	{
		name: "reuse-delta-sequence",
		expected: "allocated sequence diverged from capture order",
		reduce: (state, action) => {
			const result = reduceTranscriptTransport(state, action)
			if (result.accepted && result.accepted.kind !== "snapshot") {
				const job = { ...result.accepted, seq: result.accepted.seq - 1 }
				result.accepted = job
				result.state = { ...result.state, queue: [...result.state.queue.slice(0, -1), job] }
			}
			return result
		},
	},
	{
		name: "continue-after-rejection",
		expected: "failed snapshot continued posting",
		reduce: (state, action) =>
			reduceTranscriptTransport(state, action.type === "settle" ? { ...action, success: true } : action),
	},
	{
		name: "delta-snapshot-metadata",
		expected: "delta carries snapshot metadata",
		reduce: (state, action) => {
			const result = reduceTranscriptTransport(state, action)
			if (result.accepted && result.accepted.kind !== "snapshot") {
				const job = { ...result.accepted, snapshotId: "unused" }
				result.accepted = job
				result.state = { ...result.state, queue: [...result.state.queue.slice(0, -1), job] }
			}
			return result
		},
	},
	{
		name: "non-chunk-payload-range",
		expected: "non-chunk frame carries a payload range",
		reduce: (state, action) => {
			const result = reduceTranscriptTransport(state, action)
			if (result.post && result.post.phase !== "chunk") {
				result.post = { ...result.post, start: 1, count: 1 }
				result.state = { ...result.state, inFlight: result.post }
			}
			return result
		},
	},
	{
		name: "overrun-final-chunk",
		expected: "chunk descriptor differs from captured payload range",
		reduce: (state, action) => {
			const result = reduceTranscriptTransport(state, action)
			if (result.post?.phase === "chunk") {
				result.post = { ...result.post, count: state.chunkSize }
				result.state = { ...result.state, inFlight: result.post }
			}
			return result
		},
	},
	{
		name: "settle-caller-twice",
		expected: "settlement lacks a registered caller",
		reduce: (state, action) => {
			const result = reduceTranscriptTransport(state, action)
			result.settle.push(...result.settle)
			return result
		},
	},
	{
		name: "admit-empty-delta",
		expected: "empty delta allocated work",
		reduce: (state, action) =>
			reduceTranscriptTransport(
				state,
				action.type === "enqueue" && action.request.kind !== "snapshot" && action.total === 0
					? { ...action, total: 1 }
					: action,
			),
	},
	{
		name: "admit-stale-instance",
		expected: "stale-instance request allocated work",
		reduce: (state, action) =>
			reduceTranscriptTransport(
				state,
				action.type === "enqueue"
					? { ...action, focusedTaskInstanceId: action.request.taskInstanceId }
					: action,
			),
	},
	{
		name: "ignore-instance-at-post",
		expected: "post initiated for a stale instance",
		reduce: (state, action) =>
			reduceTranscriptTransport(
				state,
				action.type === "pump"
					? { ...action, focusedTaskInstanceId: (state.active?.job ?? state.queue[0])?.taskInstanceId }
					: action,
			),
	},
	{
		name: "drop-descriptor-instance",
		expected: "descriptor lost originating instance identity",
		reduce: (state, action) => {
			const result = reduceTranscriptTransport(state, action)
			if (result.accepted) {
				const job = { ...result.accepted, taskInstanceId: undefined }
				result.accepted = job
				result.state = { ...result.state, queue: [...result.state.queue.slice(0, -1), job] }
			}
			return result
		},
	},
	{
		name: "drop-wire-instance",
		expected: "wire lost originating instance identity",
		wire: (frame, messages) => ({ ...transcriptFrameMessage(frame, messages), taskInstanceId: undefined }),
	},
	{
		name: "receiver-ignores-instance",
		expected: "receiver accepted a stale-instance frame",
		accepts: (message, scope) => message.taskId === scope.focus,
	},
	{
		name: "receiver-accepts-stale-end",
		expected: "receiver accepted a stale-instance frame",
		accepts: (message, scope) =>
			message.taskId === scope.focus &&
			(message.type === "clineMessagesSnapshotEnd" || message.taskInstanceId === scope.focusInstance),
	},
	{
		name: "receiver-accepts-stale-delta",
		expected: "receiver accepted a stale-instance frame",
		accepts: (message, scope) =>
			message.taskId === scope.focus &&
			(message.type === "clineMessageAppended" ||
				message.type === "clineMessageUpdated" ||
				message.taskInstanceId === scope.focusInstance),
	},
]

export function checkTranscriptTransportScenarios() {
	const results = TRANSPORT_SCENARIOS.map((scenario) => ({
		name: scenario.name,
		...exploreTranscriptTransport(scenario),
	}))
	for (const result of results) {
		if (result.violation)
			throw new Error(
				`${result.name}: ${result.violation}\nBounds: ${JSON.stringify(TRANSPORT_MODEL_BOUNDS)}\n${JSON.stringify(result.witness, (_key, value: unknown) => (value instanceof Map ? [...value] : value), 2)}`,
			)
	}
	const actions = new Set(results.flatMap((result) => [...result.actions]))
	const landmarks = new Set(results.flatMap((result) => [...result.landmarks]))
	for (const action of TRANSPORT_ACTIONS) requireInvariant(actions.has(action), `unreachable action: ${action}`)
	for (const landmark of Object.keys(TRANSPORT_LANDMARKS))
		requireInvariant(landmarks.has(landmark), `unreachable landmark: ${landmark}`)
	return { results, actions: [...actions].sort(), landmarks: [...landmarks].sort() }
}

export function checkTranscriptTransportMutation(mutation: Mutation) {
	const failures = TRANSPORT_SCENARIOS.map((scenario) => ({
		scenario: scenario.name,
		...exploreTranscriptTransport(scenario, mutation.reduce, TRANSPORT_MODEL_BOUNDS, mutation),
	})).filter((result) => result.violation)
	const result = failures.sort((a, b) => a.witness!.length - b.witness!.length)[0]
	requireInvariant(result, `${mutation.name}: expected a counterexample`)
	requireInvariant(
		result.violation === mutation.expected,
		`${mutation.name}: expected ${mutation.expected}; got ${result.violation}`,
	)
	return {
		name: mutation.name,
		scenario: result.scenario,
		violation: result.violation,
		trace: result.witness!.map((entry) => entry.event),
	}
}

export function checkTranscriptTransportModel() {
	return {
		...checkTranscriptTransportScenarios(),
		counterexamples: TRANSPORT_MUTATIONS.map(checkTranscriptTransportMutation),
	}
}
