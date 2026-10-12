import assert from "node:assert/strict"

// Bounded model of tool-turn continuation: the presenter dispatch lock, the one-shot
// `userMessageContentReady` latch, and the derived readiness check that
// `Task.hasCompleteToolResultsForCurrentTurn()` adds to the request wait (#1883).
// It models one assistant turn with up to two tool blocks and one trailing text block.
// Tool handlers, approvals, and timing liveness are outside this model.

type Phase = "absent" | "streaming" | "final" | "running" | "resulted"
type PassStep = "block" | "running" | "settling" | "check" | "done"
type Request = "waiting" | "released" | "started" | "aborted"

interface Pass {
	id: number
	epoch: number
	step: PassStep
}

interface ModelState {
	phase: Phase[] // Task.assistantMessageContent partial flag plus tool_result presence
	stream: "open" | "complete" // Task.didCompleteReadingStream
	index: number // Task.currentStreamingContentIndex
	lock: boolean // Task.presentAssistantMessageLocked
	owner: number
	pending: boolean // Task.presentAssistantMessageHasPendingUpdates
	latch: boolean // Task.userMessageContentReady
	abort: boolean
	threw: boolean
	epoch: number // Task.ts request-loop reset of the turn state
	nextId: number
	passes: Pass[]
	request: Request // the request wait and the next API request
}

interface Policy {
	name: string
	derived: "every" | "first" | "off"
	lockGate: boolean
	release: "unconditional" | "owner"
	releaseOnThrow: boolean
	abortCheck: boolean
	retry: boolean
	toolThrow: boolean // also allow a failure on a tool block before its result is pushed
}

interface Step {
	action: string
	state: ModelState
	tag?: string
}

interface Violation {
	invariant: string
	message: string
	trace: Step[]
}

const kinds = ["tool", "tool", "text"] as const
const MAX_DEPTH = 60
const MAX_STATES = 500_000
const expectedActions = [
	"begin",
	"finalize",
	"complete",
	"start-block",
	"push",
	"finish",
	"check",
	"throw",
	"abort",
	"retry-reset",
	"stale-unwind",
	"poll",
	"post-wait",
] as const

const production: Policy = {
	name: "production",
	derived: "every",
	lockGate: true,
	release: "unconditional",
	releaseOnThrow: true,
	abortCheck: true,
	retry: false,
	toolThrow: false,
}
const ownerToken: Policy = { ...production, name: "owner-token", release: "owner", retry: true }
const unconditionalWithRetry: Policy = { ...production, name: "unconditional-release-with-retry", retry: true }
const toolThrowGap: Policy = { ...production, name: "tool-throw-before-result", toolThrow: true }
const injected: Array<{ policy: Policy; expected: string; detectStuck?: false }> = [
	{ policy: { ...production, name: "latch-only", derived: "off" }, expected: "stuck" },
	{ policy: { ...production, name: "no-lock-gate", lockGate: false }, expected: "continue-under-pass" },
	{
		policy: { ...production, name: "first-tool-only", derived: "first", toolThrow: true },
		expected: "premature-continue",
		detectStuck: false, // the shortest violation is the hang, which hides the premature continue
	},
	{ policy: { ...production, name: "no-finally-on-throw", releaseOnThrow: false }, expected: "stranded-lock" },
	{ policy: { ...production, name: "no-abort-check", abortCheck: false }, expected: "continue-after-abort" },
]

function initialState(): ModelState {
	return {
		phase: ["absent", "absent", "absent"],
		stream: "open",
		index: 0,
		lock: false,
		owner: 0,
		pending: false,
		latch: false,
		abort: false,
		threw: false,
		epoch: 0,
		nextId: 1,
		passes: [],
		request: "waiting",
	}
}

function clone(state: ModelState): ModelState {
	return structuredClone(state)
}

function blockCount(state: ModelState): number {
	return state.phase.filter((phase) => phase !== "absent").length
}

function currentPasses(state: ModelState): Pass[] {
	return state.passes.filter((pass) => pass.epoch === state.epoch && pass.step !== "done")
}

// Mirrors presentAssistantMessage(): queue when locked, otherwise take the lock.
function enter(state: ModelState): ModelState {
	const next = clone(state)
	if (next.abort) return next
	if (next.lock) {
		next.pending = true
		return next
	}
	next.lock = true
	next.owner = next.nextId
	next.passes.push({ id: next.nextId, epoch: next.epoch, step: "block" })
	next.nextId += 1
	return next
}

// Mirrors the wrapper's `finally`. The owner policy is the proposed fix for a stale pass.
function release(state: ModelState, pass: Pass, policy: Policy): void {
	pass.step = "done"
	if (policy.release === "owner" && state.owner !== pass.id) return
	state.lock = false
	state.owner = 0
}

function afterBlock(state: ModelState, pass: Pass): void {
	if (state.index >= blockCount(state)) {
		if (state.stream === "complete") state.latch = true
		pass.step = "check"
	} else {
		pass.step = "block"
	}
}

// Mirrors Task.hasCompleteToolResultsForCurrentTurn().
function derivedReady(state: ModelState, policy: Policy): boolean {
	if (policy.derived === "off") return false
	if (state.stream !== "complete" || (policy.lockGate && state.lock)) return false
	if (state.phase.includes("streaming")) return false
	const tools = [0, 1].filter((index) => state.phase[index] !== "absent")
	if (tools.length === 0) return false
	return policy.derived === "every"
		? tools.every((index) => state.phase[index] === "resulted")
		: state.phase[tools[0]!] === "resulted"
}

function transitions(state: ModelState, policy: Policy): Step[] {
	const result: Step[] = []
	if (state.request === "started" || state.request === "aborted") return result

	if (state.request === "released") {
		const next = clone(state)
		next.request = policy.abortCheck && next.abort ? "aborted" : "started"
		return [{ action: "post-wait()", state: next }]
	}

	for (const pass of currentPasses(state)) {
		const index = state.index
		if (pass.step === "block") {
			const next = clone(state)
			const current = next.passes.find((candidate) => candidate.id === pass.id)!
			if (next.abort) {
				current.step = "check"
			} else {
				next.pending = false
				if (index >= blockCount(next)) {
					if (next.stream === "complete") next.latch = true
					current.step = "check"
				} else if (next.phase[index] === "streaming") {
					current.step = "check"
				} else if (kinds[index] === "tool") {
					next.phase[index] = "running"
					current.step = "running"
				} else {
					next.phase[index] = "resulted"
					next.index += 1
					afterBlock(next, current)
				}
			}
			result.push({ action: `start-block(${pass.id})`, state: next })

			// A non-abort presenter failure. By default it hits the trailing text block, as in the PR's
			// real-presenter test. The toolThrow variant hits a tool block before it pushes a result.
			const failsHere = kinds[index] === "text" || policy.toolThrow
			if (!state.abort && index < blockCount(state) && failsHere && state.phase[index] === "final") {
				const failed = clone(state)
				const failedPass = failed.passes.find((candidate) => candidate.id === pass.id)!
				failed.threw = true
				if (policy.releaseOnThrow) release(failed, failedPass, policy)
				else failedPass.step = "done"
				result.push({ action: `throw(${pass.id})`, state: failed })
			}
		} else if (pass.step === "running") {
			// The handler pushes its result, then keeps running (for example a checkpoint save).
			const next = clone(state)
			const current = next.passes.find((candidate) => candidate.id === pass.id)!
			next.phase[index] = "resulted"
			current.step = "settling"
			result.push({ action: `push(${pass.id})`, state: next })
		} else if (pass.step === "settling") {
			const next = clone(state)
			const current = next.passes.find((candidate) => candidate.id === pass.id)!
			next.index += 1
			afterBlock(next, current)
			result.push({ action: `finish(${pass.id})`, state: next })
		} else if (pass.step === "check") {
			const next = clone(state)
			const current = next.passes.find((candidate) => candidate.id === pass.id)!
			const drains = next.pending && !next.abort
			if (drains) current.step = "block"
			else release(next, current, policy)
			result.push({ action: `check(${pass.id})`, state: next, tag: drains ? "drain-loop" : undefined })
		}
	}

	for (const pass of state.passes) {
		if (pass.epoch < state.epoch && pass.step !== "done") {
			const next = clone(state)
			release(next, next.passes.find((candidate) => candidate.id === pass.id)!, policy)
			result.push({ action: `stale-unwind(${pass.id})`, state: next })
		}
	}

	// Block and check steps run synchronously after an await resolves, so timers and the retry catch
	// cannot interleave with them. Only running and settling passes are suspended on an await.
	const microtaskPending = currentPasses(state).some((pass) => pass.step === "block" || pass.step === "check")
	if (state.stream === "open") {
		const first = state.phase.indexOf("absent")
		if (first !== -1) {
			const next = clone(state)
			next.phase[first] = "streaming"
			result.push({ action: `begin(${first})`, state: next })
		}
		for (const [index, phase] of state.phase.entries()) {
			if (phase === "streaming" && kinds[index] === "tool") {
				const next = clone(state)
				next.phase[index] = "final"
				result.push({ action: `finalize(${index})`, state: enter(next) })
			}
		}
		if (blockCount(state) > 0) {
			const next = clone(state)
			const hadPartial = next.phase.includes("streaming")
			next.phase = next.phase.map((phase) => (phase === "streaming" ? "final" : phase))
			next.stream = "complete"
			result.push({ action: "complete()", state: hadPartial ? enter(next) : next })
		}
		if (policy.retry && state.epoch === 0 && !microtaskPending) {
			const next = clone(state)
			next.phase = ["absent", "absent", "absent"]
			next.index = 0
			next.lock = false
			next.owner = 0
			next.pending = false
			next.latch = false
			next.threw = false
			next.epoch = 1
			result.push({ action: "retry-reset()", state: next })
		}
	}

	if (!state.abort) {
		const next = clone(state)
		next.abort = true
		result.push({ action: "abort()", state: next })
	}

	if (!microtaskPending && (state.latch || derivedReady(state, policy) || state.abort)) {
		const next = clone(state)
		next.request = "released"
		result.push({ action: "poll()", state: next })
	}
	return result
}

function invariantViolations(state: ModelState): Array<{ invariant: string; message: string }> {
	const violations: Array<{ invariant: string; message: string }> = []
	const livePasses = currentPasses(state)
	if (state.request === "started") {
		const unresolved = [0, 1].some((index) => state.phase[index] !== "absent" && state.phase[index] !== "resulted")
		if (unresolved) {
			violations.push({
				invariant: "premature-continue",
				message: "next request started while a tool block has no result",
			})
		}
		if (livePasses.length > 0) {
			violations.push({
				invariant: "continue-under-pass",
				message: "next request started while a presenter pass was live",
			})
		}
		if (state.abort) {
			violations.push({ invariant: "continue-after-abort", message: "next request started after abort" })
		}
	}
	if (livePasses.length === 0 && state.lock) {
		violations.push({ invariant: "stranded-lock", message: "presenter lock held with no live pass" })
	}
	if (!state.lock && state.pending && !state.abort && !state.threw) {
		violations.push({ invariant: "stranded-update", message: "pending update left behind a released lock" })
	}
	if (livePasses.length > 0 && !state.lock) {
		violations.push({ invariant: "ownership", message: "a live pass runs while the lock is released" })
	}
	return violations
}

function canonical(state: ModelState): string {
	return JSON.stringify(state)
}

function formatTrace(trace: Step[]): string {
	return trace.map((step, index) => `${index + 1}. ${step.action}`).join("\n")
}

interface Exploration {
	violation?: Violation
	states: number
	actions: Set<string>
	landmarks: Set<string>
	drainLoopSeen: boolean
}

const landmarkPredicates: Record<string, (state: ModelState) => boolean> = {
	"lost-latch-recovered-by-derived-path": (state) => state.request === "started" && !state.latch,
	"latch-path-continues": (state) => state.request === "started" && state.latch,
	"two-tool-turn-continues": (state) =>
		state.request === "started" && state.phase[0] === "resulted" && state.phase[1] === "resulted",
	"presenter-throw-then-continue": (state) => state.request === "started" && state.threw,
	"abort-stops-ready-turn": (state) =>
		state.request === "aborted" && state.stream === "complete" && state.phase[0] === "resulted",
	"stale-pass-unwinds-after-retry": (state) =>
		state.passes.some((pass) => pass.epoch < state.epoch && pass.step === "done"),
}

function explore(policy: Policy, detectStuck = true): Exploration {
	const start = initialState()
	const queue: Array<{ state: ModelState; trace: Step[] }> = [{ state: start, trace: [] }]
	const visited = new Set([canonical(start)])
	const actions = new Set<string>()
	const landmarks = new Set<string>()
	const frontier: ModelState[] = []
	let drainLoopSeen = false

	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		for (const [name, predicate] of Object.entries(landmarkPredicates)) {
			if (predicate(node.state)) landmarks.add(name)
		}
		const found = invariantViolations(node.state)[0]
		if (found) {
			return {
				violation: { ...found, trace: node.trace },
				states: visited.size,
				actions,
				landmarks,
				drainLoopSeen,
			}
		}
		const next = transitions(node.state, policy)
		// Abort is always available, so a state whose only enabled action is abort has no way to continue.
		if (detectStuck && node.state.request === "waiting" && next.every((step) => step.action === "abort()")) {
			return {
				violation: {
					invariant: "stuck",
					message: "only abort is enabled and the next request has not started",
					trace: node.trace,
				},
				states: visited.size,
				actions,
				landmarks,
				drainLoopSeen,
			}
		}
		if (node.trace.length === MAX_DEPTH) {
			frontier.push(node.state)
			continue
		}
		for (const step of next) {
			actions.add(step.action.slice(0, step.action.indexOf("(")))
			if (step.tag === "drain-loop") drainLoopSeen = true
			const key = canonical(step.state)
			if (visited.has(key)) continue
			visited.add(key)
			queue.push({ state: step.state, trace: [...node.trace, step] })
			if (visited.size > MAX_STATES) {
				throw new Error(`Tool-turn model exceeded its ${MAX_STATES}-state budget for ${policy.name}`)
			}
		}
	}
	const unseen = frontier.flatMap((state) => transitions(state, policy)).find((s) => !visited.has(canonical(s.state)))
	if (unseen) throw new Error(`Tool-turn model truncated before unseen action ${unseen.action}`)
	return { states: visited.size, actions, landmarks, drainLoopSeen }
}

function requireClean(policy: Policy): Exploration {
	const result = explore(policy)
	if (result.violation) {
		throw new Error(
			`Tool-turn invariant failed under ${policy.name}: ${result.violation.invariant}: ${result.violation.message}\n${formatTrace(result.violation.trace)}`,
		)
	}
	return result
}

const fixed = [requireClean(production), requireClean(ownerToken)]
const full = fixed[1]!

const missingActions = expectedActions.filter((action) => !full.actions.has(action))
assert.deepEqual(missingActions, [], `Tool-turn model has unreachable actions: ${missingActions.join(", ")}`)
const missingLandmarks = Object.keys(landmarkPredicates).filter((name) => !full.landmarks.has(name))
assert.deepEqual(missingLandmarks, [], `Tool-turn model has unreachable landmarks: ${missingLandmarks.join(", ")}`)
assert.ok(full.drainLoopSeen, "Tool-turn model never reaches the pending-update drain loop")

const witnesses: string[] = []
for (const { policy, expected, detectStuck } of injected) {
	const result = explore(policy, detectStuck)
	assert.equal(
		result.violation?.invariant,
		expected,
		`Injected policy ${policy.name} must violate ${expected}, got ${result.violation?.invariant ?? "no violation"}`,
	)
	witnesses.push(`${policy.name}=${expected}(${result.violation!.trace.length} steps)`)
}

// Known gap (#1884 review finding 3): the production `finally` clears the lock unconditionally.
// After a request-loop reset, a stale pass can release the lock of a newer pass. The owner-token
// policy above is the proposed fix. This witness keeps the gap visible until production changes.
const gap = explore(unconditionalWithRetry)
assert.ok(gap.violation, "Known stale-pass gap no longer reproduces: update the model and the document")

// Known gap (#1884 review finding 2): a failure on a tool block before it pushes a result releases the
// lock, but no result exists, so the derived check stays false and the wait has no timeout. The hang
// existed before the PR (the lock stayed held). The PR deliberately does not synthesize a result.
const throwGap = explore(toolThrowGap)
assert.equal(throwGap.violation?.invariant, "stuck", "Known tool-throw hang no longer reproduces: update the model")

console.log(
	`Tool-turn continuation model check passed: ${fixed.map((r) => r.states).join("/")} reachable states (production/owner-token), ${full.actions.size}/${expectedActions.length} actions, ${full.landmarks.size}/${Object.keys(landmarkPredicates).length} landmarks, depth <= ${MAX_DEPTH}`,
)
console.log(`Known-unsafe witnesses: ${witnesses.join(", ")}`)
console.log(`Known gap (tool failure before result): stuck after ${throwGap.violation!.trace.length} steps`)
console.log(
	`Known gap (stale unconditional release): ${gap.violation!.invariant} after ${gap.violation!.trace.length} steps\n${formatTrace(gap.violation!.trace)}`,
)
