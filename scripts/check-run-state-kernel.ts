import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { nextRunState, initialRunState } from "../src/core/task/run-state/runState"
import type { AbortReason, Ask, RunEvent, RunState, Transition } from "../src/core/task/run-state/runState"

type Source = "init" | "stream" | "ask" | "cancel" | "dispose"
type EventTag = RunEvent["tag"]
type StartedAsk = Exclude<Ask, { tag: "none" }>
type Step = (state: RunState, event: RunEvent) => Transition | undefined

interface ModelState {
	run: RunState
	askCount: number
	completionAsks: number[]
	lastEndedStreamCleaned: boolean
}

interface ModelEvent {
	name: string
	source: Source
	event: RunEvent
}

interface TraceStep {
	action: string
	source: Source | "initial"
	state: ModelState
}

interface Options {
	step: Step
	useTable: boolean
	maxDepth: number
	maxStates: number
}

interface Applied {
	next: ModelState
	accepted: boolean
	problems: string[]
}

interface WitnessContext {
	prev: ModelState
	next: ModelState
	event: RunEvent
}

const MAX_DEPTH = 20
const MAX_STATES = 20_000
const MAX_GENERATION = 3
const MAX_ASK_TS = 3
const KERNEL_PATH = fileURLToPath(new URL("../src/core/task/run-state/runState.ts", import.meta.url))

const abortReasons: Record<AbortReason, true> = { user_cancelled: true, streaming_failed: true }
const askBuilders: Record<string, (askTs: number) => StartedAsk> = {
	approval: (askTs) => ({ tag: "approval", askTs, toolCallId: `tool-${askTs}`, approvalId: `approval-${askTs}` }),
	approvalWithoutIds: (askTs) => ({ tag: "approval", askTs }),
	completion: (askTs) => ({ tag: "completion", askTs }),
	other: (askTs) => ({ tag: "other", askTs }),
}
const eventSources = ["stream", "ask", "cancel", "dispose"] as const

// One field per cell of the state described in the target-architecture doc, so rows read like the doc table.
interface Flat {
	phase: RunState["phase"]
	generation: number
	streamLive: boolean
	streamGeneration: number | null
	cleanupFinished: boolean | null
	askTag: Ask["tag"]
	askTs: number | null
	toolCallId: string | null
	approvalId: string | null
	abort: boolean
	abandoned: boolean
	disposed: boolean
	reason: AbortReason | null
	lastCompletionAskTs: number | null
}

function flatten(run: RunState): Flat {
	const ask = run.ask
	return {
		phase: run.phase,
		generation: run.generation,
		streamLive: run.stream.tag === "live",
		streamGeneration: run.stream.tag === "live" ? run.stream.generation : null,
		cleanupFinished: run.stream.tag === "live" ? run.stream.cleanupFinished : null,
		askTag: ask.tag,
		askTs: ask.tag === "none" ? null : ask.askTs,
		toolCallId: ("toolCallId" in ask && ask.toolCallId) || null,
		approvalId: ("approvalId" in ask && ask.approvalId) || null,
		abort: run.latches.abort,
		abandoned: run.latches.abandoned,
		disposed: run.latches.disposed,
		reason: run.latches.reason ?? null,
		lastCompletionAskTs: run.lastCompletionAskTs ?? null,
	}
}

interface Row<E extends RunEvent> {
	guard?: Record<string, (f: Flat, e: E) => boolean>
	effect: (f: Flat, e: E) => void
}

type Rows = { [T in EventTag]: Row<Extract<RunEvent, { tag: T }>> }

const clearAsk = (f: Flat) => {
	f.askTag = "none"
	f.askTs = f.toolCallId = f.approvalId = null
}

// Transcribes the Guard and Effect columns of task-lifecycle-target-architecture.md (Transitions).
const rows: Rows = {
	initialized: {
		guard: { uninitialized: (f) => f.phase === "uninitialized" },
		effect: (f) => void (f.phase = "running"),
	},
	streamStarted: {
		guard: { running: (f) => f.phase === "running", "no live stream": (f) => !f.streamLive },
		effect: (f) => {
			f.generation += 1
			f.streamLive = true
			f.streamGeneration = f.generation
			f.cleanupFinished = false
			f.lastCompletionAskTs = null
		},
	},
	streamCleanupFinished: {
		guard: { "live stream": (f) => f.streamLive },
		effect: (f) => void (f.cleanupFinished = true),
	},
	streamEnded: {
		guard: { "live stream": (f) => f.streamLive },
		effect: (f) => {
			f.streamLive = false
			f.streamGeneration = f.cleanupFinished = null
		},
	},
	askStarted: {
		guard: { running: (f) => f.phase === "running", "not aborted": (f) => !f.abort },
		effect: (f, e) => {
			f.askTag = e.ask.tag
			f.askTs = e.ask.askTs
			f.toolCallId = (e.ask.tag === "approval" && e.ask.toolCallId) || null
			f.approvalId = (e.ask.tag === "approval" && e.ask.approvalId) || null
			f.lastCompletionAskTs = e.ask.tag === "completion" ? e.ask.askTs : null
		},
	},
	askSettled: {
		effect: (f, e) => {
			if (f.askTs === e.askTs) clearAsk(f)
		},
	},
	completionAccepted: {
		guard: {
			running: (f) => f.phase === "running",
			"not aborted": (f) => !f.abort,
			"latest completion ask": (f, e) => e.askTs === f.lastCompletionAskTs,
		},
		effect: (f) => {
			f.phase = "completed"
			clearAsk(f)
		},
	},
	reasonSet: {
		effect: (f, e) => void (f.reason ??= e.reason),
	},
	abortRequested: {
		effect: (f, e) => {
			f.abort = true
			if (e.abandoned) f.abandoned = true
		},
	},
	abandonRequested: {
		guard: { aborted: (f) => f.abort },
		effect: (f) => void (f.abandoned = true),
	},
	disposeRequested: {
		effect: (f) => {
			f.abort = true
			f.disposed = true
		},
	},
}

const eventTags = Object.keys(rows) as EventTag[]
const guardClauses = eventTags.flatMap((tag) =>
	Object.keys((rows[tag] as Row<RunEvent>).guard ?? {}).map((clause) => `${tag}: ${clause}`),
)
const expectedActions = [...eventTags, "askSettledStale"]

function referenceResult(run: RunState, event: RunEvent): { accepted: boolean; flat: Flat; failedClauses: string[] } {
	const flat = flatten(run)
	const row = rows[event.tag] as Row<RunEvent>
	const failedClauses = Object.entries(row.guard ?? {})
		.filter(([, holds]) => !holds(flat, event))
		.map(([clause]) => `${event.tag}: ${clause}`)
	const accepted = failedClauses.length === 0
	if (accepted) row.effect(flat, event)
	return { accepted, flat, failedClauses }
}

function kernelEventTags(): string[] {
	const source = readFileSync(KERNEL_PATH, "utf8")
	return [...source.matchAll(/case "(\w+)":/g)].map((match) => match[1]!)
}

const rejectionWitnesses = new Set(["late-completion-accept-rejected-after-new-ask"])
const semanticWitnesses = {
	"abort-during-pending-approval-in-live-stream": ({ prev, next, event }: WitnessContext) =>
		event.tag === "abortRequested" &&
		prev.run.stream.tag === "live" &&
		prev.run.ask.tag === "approval" &&
		!prev.run.latches.abort &&
		next.run.latches.abort,
	"ask-after-stream-ended": ({ prev, next, event }: WitnessContext) =>
		event.tag === "askStarted" &&
		prev.run.stream.tag === "none" &&
		prev.run.generation > 0 &&
		next.run.ask.tag !== "none",
	"abandon-after-stream-ended": ({ prev, next, event }: WitnessContext) =>
		(event.tag === "abandonRequested" || (event.tag === "abortRequested" && event.abandoned)) &&
		prev.run.stream.tag === "none" &&
		prev.run.generation > 0 &&
		!prev.run.latches.abandoned &&
		next.run.latches.abandoned,
	"dispose-after-completion": ({ prev, next, event }: WitnessContext) =>
		event.tag === "disposeRequested" && prev.run.phase === "completed" && next.run.latches.disposed,
	"stream-after-failure-cleanup": ({ prev, next, event }: WitnessContext) =>
		event.tag === "streamStarted" &&
		prev.lastEndedStreamCleaned &&
		!prev.run.latches.abort &&
		next.run.stream.tag === "live" &&
		!next.run.stream.cleanupFinished &&
		next.run.generation >= 2,
	"first-stream-without-ask": ({ prev, next, event }: WitnessContext) =>
		event.tag === "streamStarted" &&
		prev.run.phase === "running" &&
		prev.run.generation === 0 &&
		prev.run.ask.tag === "none" &&
		next.run.stream.tag === "live",
	"approval-before-first-stream": ({ prev, next, event }: WitnessContext) =>
		event.tag === "askStarted" &&
		prev.run.phase === "running" &&
		prev.run.generation === 0 &&
		next.run.ask.tag === "approval",
	"late-completion-accept-rejected-after-new-ask": ({ prev, event }: WitnessContext) =>
		event.tag === "completionAccepted" &&
		prev.completionAsks.includes(event.askTs) &&
		prev.askCount > event.askTs &&
		prev.run.lastCompletionAskTs !== event.askTs &&
		prev.run.phase === "running" &&
		!prev.run.latches.abort,
} satisfies Record<string, (context: WitnessContext) => boolean>

function initialState(): ModelState {
	return { run: structuredClone(initialRunState), askCount: 0, completionAsks: [], lastEndedStreamCleaned: false }
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable)
	if (typeof value !== "object" || value === null) return value
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, child]) => child !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([key, child]) => [key, stable(child)]),
	)
}

function canonical(value: unknown): string {
	return JSON.stringify(stable(value))
}

function eventsFor({ run, askCount }: ModelState): ModelEvent[] {
	const events: ModelEvent[] = [{ name: "initialized()", source: "init", event: { tag: "initialized" } }]
	if (run.generation < MAX_GENERATION) {
		events.push({ name: "streamStarted()", source: "stream", event: { tag: "streamStarted" } })
	}
	events.push(
		{ name: "streamCleanupFinished()", source: "stream", event: { tag: "streamCleanupFinished" } },
		{ name: "streamEnded()", source: "stream", event: { tag: "streamEnded" } },
	)
	if (askCount < MAX_ASK_TS) {
		for (const [kind, build] of Object.entries(askBuilders)) {
			const ask = build(askCount + 1)
			events.push({ name: `askStarted(${kind}, ${ask.askTs})`, source: "ask", event: { tag: "askStarted", ask } })
		}
	}
	for (let askTs = 1; askTs <= MAX_ASK_TS; askTs++) {
		const supersededByNewerAsk = run.ask.tag !== "none" && run.ask.askTs > askTs
		events.push(
			{
				name: `${supersededByNewerAsk ? "askSettledStale" : "askSettled"}(${askTs})`,
				source: "ask",
				event: { tag: "askSettled", askTs },
			},
			{ name: `completionAccepted(${askTs})`, source: "ask", event: { tag: "completionAccepted", askTs } },
		)
	}
	for (const reason of Object.keys(abortReasons) as AbortReason[]) {
		events.push({ name: `reasonSet(${reason})`, source: "cancel", event: { tag: "reasonSet", reason } })
	}
	for (const abandoned of [false, true]) {
		events.push({
			name: `abortRequested(${abandoned})`,
			source: "cancel",
			event: { tag: "abortRequested", abandoned },
		})
	}
	events.push(
		{ name: "abandonRequested()", source: "cancel", event: { tag: "abandonRequested" } },
		{ name: "disposeRequested()", source: "dispose", event: { tag: "disposeRequested" } },
	)
	return events
}

const phaseOrder = { uninitialized: 0, running: 1, completed: 2 } as const

function stateViolations({ run, askCount }: ModelState): string[] {
	const violations: string[] = []
	if (run.latches.abandoned && !run.latches.abort) violations.push("abandoned without abort")
	if (run.latches.disposed && !run.latches.abort) violations.push("disposed without abort")
	if (run.phase === "completed" && run.ask.tag !== "none") violations.push("completed task has a pending ask")
	if (run.ask.tag !== "none" && run.ask.askTs !== askCount) violations.push("pending ask is not the newest ask")
	if (run.stream.tag === "live" && run.stream.generation !== run.generation) {
		violations.push("live stream generation differs from run generation")
	}
	return violations
}

function transitionViolations(before: RunState, after: RunState): string[] {
	const violations: string[] = []
	for (const latch of ["abort", "abandoned", "disposed"] as const) {
		if (before.latches[latch] && !after.latches[latch]) violations.push(`latch ${latch} returned to false`)
	}
	if (before.latches.reason !== undefined && after.latches.reason !== before.latches.reason) {
		violations.push("abort reason changed after the first write")
	}
	if (after.generation < before.generation) violations.push("generation decreased")
	if (phaseOrder[after.phase] < phaseOrder[before.phase]) violations.push("phase moved backwards")
	const askChanged = canonical(after.ask) !== canonical(before.ask)
	if (after.latches.abort && after.ask.tag !== "none" && askChanged) violations.push("an ask started after abort")
	if (before.phase === "completed" && before.stream.tag === "none" && after.stream.tag === "live") {
		violations.push("a stream started after completion")
	}
	if (
		after.phase === "completed" &&
		before.phase !== "completed" &&
		before.stream.tag === "none" &&
		after.stream.tag === "live"
	) {
		violations.push("a task completed and started a stream at once")
	}
	if (
		before.stream.tag === "live" &&
		after.stream.tag === "live" &&
		after.stream.generation !== before.stream.generation
	) {
		violations.push("a live stream was replaced")
	}
	if (before.stream.tag === "none" && after.stream.tag === "live" && after.stream.cleanupFinished) {
		violations.push("a new stream started with cleanupFinished true")
	}
	return violations
}

function apply(options: Options, state: ModelState, { event }: ModelEvent): Applied {
	const input = structuredClone(state.run)
	const eventInput = structuredClone(event)
	let result: Transition | undefined
	try {
		result = options.step(input, eventInput)
	} catch (error) {
		return { next: state, accepted: false, problems: [`${event.tag} threw: ${String(error)}`] }
	}
	if (result === undefined || !("ok" in result || "rejected" in result)) {
		return { next: state, accepted: false, problems: [`${event.tag} returned neither ok nor rejected`] }
	}

	const problems: string[] = []
	if (canonical(input) !== canonical(state.run)) problems.push(`${event.tag} mutated its state`)
	if (canonical(eventInput) !== canonical(event)) problems.push(`${event.tag} mutated its event`)
	const accepted = "ok" in result
	const actual = "ok" in result ? result.ok : result.rejected
	if (options.useTable) {
		const wanted = referenceResult(state.run, event)
		if (accepted !== wanted.accepted)
			problems.push(`${event.tag} ${accepted ? "accepted" : "rejected"} against the table`)
		if (canonical(flatten(actual)) !== canonical(wanted.flat))
			problems.push(`${event.tag} result differs from the table`)
	}
	if (!accepted && canonical(actual) !== canonical(state.run)) problems.push(`${event.tag} rejection changed state`)
	if (!accepted) return { next: state, accepted, problems }

	problems.push(...transitionViolations(state.run, actual))
	const next: ModelState = { ...state, run: actual }
	if (event.tag === "askStarted") {
		next.askCount = event.ask.askTs
		if (event.ask.tag === "completion") next.completionAsks = [...state.completionAsks, event.ask.askTs]
	}
	if (event.tag === "streamEnded" && state.run.stream.tag === "live") {
		next.lastEndedStreamCleaned = state.run.stream.cleanupFinished
	}
	return { next, accepted, problems }
}

function formatCounterexample(message: string, trace: TraceStep[], options: Options): string {
	const steps = trace.map(
		(step, index) =>
			`${index}. ${step.action}\n${JSON.stringify(step.state, null, 2)
				.split("\n")
				.map((line) => `   ${line}`)
				.join("\n")}`,
	)
	return [
		`Run-state kernel invariant failed: ${message}`,
		`Bounds: depth=${options.maxDepth}, states=${options.maxStates}, generations=${MAX_GENERATION}, asks=${MAX_ASK_TS}`,
		...steps,
	].join("\n")
}

interface CheckResult {
	states: number
	deepest: number
}

function runModelCheck(options: Options): CheckResult {
	const start = initialState()
	const startTrace: TraceStep[] = [{ action: "initial", source: "initial", state: start }]
	const startProblems = stateViolations(start)
	if (startProblems.length) throw new Error(formatCounterexample(startProblems.join("; "), startTrace, options))

	const queue = [{ state: start, trace: startTrace }]
	const visited = new Set([canonical(start)])
	const reachedActions = new Set<string>()
	const reachedRejections = new Set<string>()
	const reachedWitnesses = new Set<string>()
	const reachedInterleavings = new Set<string>()
	let deepest = 0

	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		const depth = node.trace.length - 1
		deepest = Math.max(deepest, depth)
		const previousStep = node.trace[depth]!
		const previousChangedState =
			depth > 0 && canonical(previousStep.state.run) !== canonical(node.trace[depth - 1]!.state.run)

		for (const modelEvent of eventsFor(node.state)) {
			const applied = apply(options, node.state, modelEvent)
			const trace = [...node.trace, { action: modelEvent.name, source: modelEvent.source, state: applied.next }]
			const problems = [...applied.problems, ...(applied.accepted ? stateViolations(applied.next) : [])]
			if (problems.length) throw new Error(formatCounterexample(problems.join("; "), trace, options))

			for (const [name, matches] of Object.entries(semanticWitnesses)) {
				if (applied.accepted === rejectionWitnesses.has(name)) continue
				if (matches({ prev: node.state, next: applied.next, event: modelEvent.event }))
					reachedWitnesses.add(name)
			}
			if (!applied.accepted) {
				const { failedClauses } = referenceResult(node.state.run, modelEvent.event)
				if (failedClauses.length === 1) reachedRejections.add(failedClauses[0]!)
				continue
			}
			reachedActions.add(modelEvent.name.slice(0, modelEvent.name.indexOf("(")))
			const changesState = canonical(applied.next.run) !== canonical(node.state.run)
			if (previousChangedState && changesState && previousStep.source !== modelEvent.source) {
				reachedInterleavings.add(`${previousStep.source}->${modelEvent.source}`)
			}

			const key = canonical(applied.next)
			if (visited.has(key)) continue
			if (depth === options.maxDepth) {
				throw new Error(
					`Run-state kernel exploration reached depth ${options.maxDepth} with an unseen successor (${modelEvent.name}); increase the depth bound`,
				)
			}
			visited.add(key)
			queue.push({ state: applied.next, trace })
			if (visited.size > options.maxStates) {
				throw new Error(
					`Run-state kernel exploration exceeded its ${options.maxStates}-state budget; increase or reduce bounds`,
				)
			}
		}
	}

	const assertNoneMissing = (label: string, names: string[]) => {
		if (names.length) throw new Error(`Run-state kernel model has ${label}: ${names.join(", ")}`)
	}
	assertNoneMissing(
		"unreachable actions",
		expectedActions.filter((action) => !reachedActions.has(action)),
	)
	assertNoneMissing(
		"guard clauses that are never the only reason for a rejection",
		guardClauses.filter((clause) => !reachedRejections.has(clause)),
	)
	assertNoneMissing(
		"unreachable semantic witnesses",
		Object.keys(semanticWitnesses).filter((name) => !reachedWitnesses.has(name)),
	)
	assertNoneMissing(
		"missing event-source interleavings between state changes",
		eventSources
			.flatMap((from) => eventSources.filter((to) => to !== from).map((to) => `${from}->${to}`))
			.filter((pair) => !reachedInterleavings.has(pair)),
	)
	return { states: visited.size, deepest }
}

function assertKernelHandlesTableEvents(): void {
	const handled = new Set(kernelEventTags())
	const missingFromKernel = eventTags.filter((tag) => !handled.has(tag))
	const missingFromTable = [...handled].filter((tag) => !(tag in rows))
	assert.deepEqual(
		{ missingFromKernel, missingFromTable },
		{ missingFromKernel: [], missingFromTable: [] },
		`the event tags in ${KERNEL_PATH} and in the checker table differ`,
	)
}

const freshLive = (generation: number): RunState["stream"] => ({ tag: "live", generation, cleanupFinished: false })

interface UnsafeKernel {
	step: Step
	caughtBy: RegExp
	useTable: boolean
}

const differsFor = (tag: EventTag) =>
	new RegExp(`${tag} (result differs from the table|(accepted|rejected) against the table)`)
const unsafeKernels: Record<string, UnsafeKernel> = {
	"second-stream-replaces-live-stream": {
		step: (state, event) =>
			event.tag === "streamStarted" && state.phase === "running" && state.stream.tag === "live"
				? { ok: { ...state, generation: state.generation + 1, stream: freshLive(state.generation + 1) } }
				: nextRunState(state, event),
		caughtBy: /live stream was replaced/,
		useTable: false,
	},
	"stream-end-clears-ask": {
		step: (state, event) => {
			const result = nextRunState(state, event)
			return event.tag === "streamEnded" && "ok" in result
				? { ok: { ...result.ok, ask: { tag: "none" } } }
				: result
		},
		caughtBy: differsFor("streamEnded"),
		useTable: true,
	},
	"ask-starts-after-abort": {
		step: (state, event) =>
			event.tag === "askStarted" && state.phase === "running" && state.latches.abort
				? { ok: { ...state, ask: event.ask } }
				: nextRunState(state, event),
		caughtBy: /ask started after abort/,
		useTable: false,
	},
	"stale-settle-clears-newer-ask": {
		step: (state, event) =>
			event.tag === "askSettled" ? { ok: { ...state, ask: { tag: "none" } } } : nextRunState(state, event),
		caughtBy: differsFor("askSettled"),
		useTable: true,
	},
	"abandon-without-abort": {
		step: (state, event) =>
			event.tag === "abandonRequested"
				? { ok: { ...state, latches: { ...state.latches, abandoned: true } } }
				: nextRunState(state, event),
		caughtBy: /abandoned without abort/,
		useTable: false,
	},
	"later-reason-overwrites-first": {
		step: (state, event) =>
			event.tag === "reasonSet"
				? { ok: { ...state, latches: { ...state.latches, reason: event.reason } } }
				: nextRunState(state, event),
		caughtBy: /abort reason changed/,
		useTable: false,
	},
	"dispose-without-abort": {
		step: (state, event) =>
			event.tag === "disposeRequested"
				? { ok: { ...state, latches: { ...state.latches, disposed: true } } }
				: nextRunState(state, event),
		caughtBy: /disposed without abort/,
		useTable: false,
	},
	"stream-starts-after-completion": {
		step: (state, event) =>
			event.tag === "streamStarted" && state.phase === "completed"
				? { ok: { ...state, stream: freshLive(state.generation) } }
				: nextRunState(state, event),
		caughtBy: /stream started after completion/,
		useTable: false,
	},
	"completion-starts-a-stream": {
		step: (state, event) => {
			const result = nextRunState(state, event)
			return event.tag === "completionAccepted" && "ok" in result && result.ok.stream.tag === "none"
				? { ok: { ...result.ok, stream: freshLive(result.ok.generation) } }
				: result
		},
		caughtBy: /completed and started a stream/,
		useTable: false,
	},
	"abort-drops-abandon": {
		step: (state, event) => {
			const result = nextRunState(state, event)
			return event.tag === "abortRequested" && "ok" in result
				? { ok: { ...result.ok, latches: { ...result.ok.latches, abandoned: state.latches.abandoned } } }
				: result
		},
		caughtBy: differsFor("abortRequested"),
		useTable: true,
	},
	"cleanup-flag-survives-new-stream": {
		step: (state, event) => {
			const result = nextRunState(state, event)
			return event.tag === "streamStarted" && "ok" in result && result.ok.stream.tag === "live"
				? { ok: { ...result.ok, stream: { ...result.ok.stream, cleanupFinished: true } } }
				: result
		},
		caughtBy: /cleanupFinished true/,
		useTable: false,
	},
	"approval-drops-opaque-ids": {
		step: (state, event) =>
			event.tag === "askStarted" && event.ask.tag === "approval"
				? nextRunState(state, { ...event, ask: { tag: "approval", askTs: event.ask.askTs } })
				: nextRunState(state, event),
		caughtBy: differsFor("askStarted"),
		useTable: true,
	},
	"ask-merges-previous-ask": {
		step: (state, event) => {
			const result = nextRunState(state, event)
			return event.tag === "askStarted" && "ok" in result
				? { ok: { ...result.ok, ask: { ...state.ask, ...event.ask } } }
				: result
		},
		caughtBy: differsFor("askStarted"),
		useTable: true,
	},
	"late-completion-accepted": {
		step: (state, event) =>
			event.tag === "completionAccepted" && state.phase === "running" && !state.latches.abort
				? { ok: { ...state, phase: "completed", ask: { tag: "none" } } }
				: nextRunState(state, event),
		caughtBy: differsFor("completionAccepted"),
		useTable: true,
	},
	"reason-set-clears-abort": {
		step: (state, event) =>
			event.tag === "reasonSet" && state.latches.abort
				? { ok: { ...state, latches: { ...state.latches, abort: false } } }
				: nextRunState(state, event),
		caughtBy: /latch abort returned to false/,
		useTable: false,
	},
	"reason-set-clears-abandoned": {
		step: (state, event) =>
			event.tag === "reasonSet" && state.latches.abandoned
				? { ok: { ...state, latches: { ...state.latches, abandoned: false } } }
				: nextRunState(state, event),
		caughtBy: /latch abandoned returned to false/,
		useTable: false,
	},
	"reason-set-clears-disposed": {
		step: (state, event) =>
			event.tag === "reasonSet" && state.latches.disposed
				? { ok: { ...state, latches: { ...state.latches, disposed: false } } }
				: nextRunState(state, event),
		caughtBy: /latch disposed returned to false/,
		useTable: false,
	},
	"repeated-reason-rejected": {
		step: (state, event) =>
			event.tag === "reasonSet" && state.latches.reason !== undefined
				? { rejected: state }
				: nextRunState(state, event),
		caughtBy: /reasonSet rejected against the table/,
		useTable: true,
	},
	"stream-start-guard-dropped": {
		step: (state, event) =>
			event.tag === "streamStarted" && state.phase !== "running" && state.stream.tag === "none"
				? { ok: state }
				: nextRunState(state, event),
		caughtBy: /never the only reason for a rejection: streamStarted: running$/,
		useTable: false,
	},
	"abandon-guard-dropped": {
		step: (state, event) =>
			event.tag === "abandonRequested" && !state.latches.abort ? { ok: state } : nextRunState(state, event),
		caughtBy: /never the only reason for a rejection: abandonRequested: aborted$/,
		useTable: false,
	},
	"dispose-always-rejected": {
		step: (state, event) => (event.tag === "disposeRequested" ? { rejected: state } : nextRunState(state, event)),
		caughtBy: /unreachable actions: disposeRequested$/,
		useTable: false,
	},
	"completion-keeps-ask": {
		step: (state, event) => {
			const result = nextRunState(state, event)
			return event.tag === "completionAccepted" && "ok" in result
				? { ok: { ...result.ok, ask: state.ask } }
				: result
		},
		caughtBy: /completed task has a pending ask/,
		useTable: false,
	},
	"stream-start-lowers-generation": {
		step: (state, event) => {
			const result = nextRunState(state, event)
			return event.tag === "streamStarted" && "ok" in result
				? { ok: { ...result.ok, generation: state.generation - 1 } }
				: result
		},
		caughtBy: /generation decreased/,
		useTable: false,
	},
	"ask-timestamp-skips-ahead": {
		step: (state, event) =>
			event.tag === "askStarted" && state.phase === "running" && !state.latches.abort
				? { ok: { ...state, ask: { ...event.ask, askTs: event.ask.askTs + 1 } } }
				: nextRunState(state, event),
		caughtBy: /pending ask is not the newest ask/,
		useTable: false,
	},
	"abort-reopens-completed-task": {
		step: (state, event) =>
			event.tag === "abortRequested" && state.phase === "completed"
				? { ok: { ...state, phase: "running", latches: { ...state.latches, abort: true } } }
				: nextRunState(state, event),
		caughtBy: /phase moved backwards/,
		useTable: false,
	},
	"stream-start-skews-live-generation": {
		step: (state, event) => {
			const result = nextRunState(state, event)
			return event.tag === "streamStarted" && "ok" in result
				? { ok: { ...result.ok, stream: freshLive(result.ok.generation + 1) } }
				: result
		},
		caughtBy: /live stream generation differs/,
		useTable: false,
	},
	"rejection-bumps-generation": {
		step: (state, event) => {
			const result = nextRunState(state, event)
			return "rejected" in result
				? { rejected: { ...result.rejected, generation: state.generation + 1 } }
				: result
		},
		caughtBy: /rejection changed state/,
		useTable: false,
	},
	"mutates-its-state": {
		step: (state, event) => {
			if (event.tag === "abortRequested") state.latches.abort = true
			return nextRunState(state, event)
		},
		caughtBy: /abortRequested mutated its state/,
		useTable: false,
	},
	"mutates-its-event": {
		step: (state, event) => {
			if (event.tag === "askSettled" && state.ask.tag !== "none") event.askTs = state.ask.askTs
			return nextRunState(state, event)
		},
		caughtBy: /askSettled mutated its event/,
		useTable: false,
	},
	"returns-nothing": {
		step: (state, event) => (event.tag === "streamEnded" ? undefined : nextRunState(state, event)),
		caughtBy: /returned neither/,
		useTable: false,
	},
	"throws-on-stale-settle": {
		step: (state, event) => {
			if (event.tag === "askSettled" && state.ask.tag !== "none" && state.ask.askTs !== event.askTs) {
				throw new Error("stale settle")
			}
			return nextRunState(state, event)
		},
		caughtBy: /threw/,
		useTable: false,
	},
}

function runUnsafeKernels(): void {
	for (const [name, { step, caughtBy, useTable }] of Object.entries(unsafeKernels)) {
		const options = { step, useTable, maxDepth: MAX_DEPTH, maxStates: MAX_STATES }
		assert.throws(() => runModelCheck(options), caughtBy, `unsafe kernel not caught as expected: ${name}`)
	}
}

function runBoundSelfTests(): void {
	const base = { step: nextRunState, useTable: true, maxDepth: MAX_DEPTH, maxStates: MAX_STATES }
	assert.throws(() => runModelCheck({ ...base, maxDepth: 3 }), /unseen successor/)
	assert.throws(() => runModelCheck({ ...base, maxStates: 50 }), /state budget/)
}

function runRepresentativeScenarios(): void {
	const running = nextRunState(structuredClone(initialRunState), { tag: "initialized" })
	assert.ok("ok" in running)
	const asked = nextRunState(running.ok, { tag: "askStarted", ask: { tag: "approval", askTs: 1 } })
	assert.ok("ok" in asked)
	const aborted = nextRunState(asked.ok, { tag: "abortRequested", abandoned: false })
	assert.ok("ok" in aborted)
	assert.ok("rejected" in nextRunState(aborted.ok, { tag: "askStarted", ask: { tag: "other", askTs: 2 } }))
	assert.deepEqual(nextRunState(asked.ok, { tag: "askSettled", askTs: 2 }), { ok: asked.ok })
}

assertKernelHandlesTableEvents()
runRepresentativeScenarios()
const { states, deepest } = runModelCheck({
	step: nextRunState,
	useTable: true,
	maxDepth: MAX_DEPTH,
	maxStates: MAX_STATES,
})
runUnsafeKernels()
runBoundSelfTests()
console.log(
	`Run-state kernel model check passed: ${states} reachable states, ${expectedActions.length}/${expectedActions.length} actions reachable, ${guardClauses.length}/${guardClauses.length} guard clauses isolated, ${Object.keys(semanticWitnesses).length}/${Object.keys(semanticWitnesses).length} witnesses reached, ${eventSources.length * (eventSources.length - 1)} source interleavings, ${Object.keys(unsafeKernels).length} unsafe kernels caught, fixed point at depth ${deepest} (bound ${MAX_DEPTH}), generations <= ${MAX_GENERATION}, asks <= ${MAX_ASK_TS}`,
)
