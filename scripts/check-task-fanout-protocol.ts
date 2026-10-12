import assert from "node:assert/strict"

const CHILDREN = ["a", "b"] as const
type Child = (typeof CHILDREN)[number]
type ChildState = "idle" | "running" | "ready" | "delivered" | "cancelled"

type ModelState = {
	parentLive: boolean
	children: Record<Child, ChildState>
	permitOwners: Child[]
	resultWriters: Partial<Record<Child, Child>>
	deliveries: Child[]
	deliveryAfterParentLoss: boolean
}

type Transition = { name: string; kind: string; next: ModelState }
type TraceStep = { action: string; state: ModelState }

const MAX_DEPTH = 10
const MAX_STATES = 500
const EXPECTED_ACTIONS = ["launch", "finish", "deliver", "lose-parent", "cancel-orphan", "release"] as const
const LANDMARKS = {
	"live-parent-with-two-children": (state: ModelState) =>
		state.parentLive && CHILDREN.every((child) => state.children[child] === "running"),
	"out-of-order-results": (state: ModelState) => state.deliveries.join(",") === "b,a",
	"single-writer-results": (state: ModelState) =>
		CHILDREN.every((child) => state.resultWriters[child] === undefined || state.resultWriters[child] === child),
	"parent-loss-with-running-child": (state: ModelState) =>
		!state.parentLive && CHILDREN.some((child) => state.children[child] === "running"),
	"orphan-cleanup": (state: ModelState) =>
		!state.parentLive &&
		state.permitOwners.length === 0 &&
		CHILDREN.every((child) => !["running", "ready"].includes(state.children[child])),
} satisfies Record<string, (state: ModelState) => boolean>

const start = initialState()
const queue: Array<{ state: ModelState; trace: TraceStep[] }> = [
	{ state: start, trace: [{ action: "initial", state: start }] },
]
const visited = new Set([canonical(start)])
const actions = new Set<string>()
const landmarks = new Set<string>()
const frontier: ModelState[] = []

const KNOWN_BAD_STATES: Array<{ name: string; state: ModelState; expected: string }> = [
	{
		name: "wrong-result-writer",
		state: {
			...initialState(),
			children: { a: "ready", b: "idle" },
			permitOwners: ["a"],
			resultWriters: { a: "b" },
		},
		expected: "a: result has the wrong writer",
	},
	{
		name: "early-delivery",
		state: { ...initialState(), children: { a: "delivered", b: "idle" }, deliveries: ["a"] },
		expected: "a: result delivered before readiness",
	},
	{
		name: "duplicate-delivery",
		state: {
			...initialState(),
			children: { a: "delivered", b: "idle" },
			resultWriters: { a: "a" },
			deliveries: ["a", "a"],
		},
		expected: "a: result delivered more than once",
	},
	{
		name: "post-parent-loss-delivery",
		state: { ...initialState(), parentLive: false, deliveryAfterParentLoss: true },
		expected: "result routed after parent loss",
	},
	{
		name: "scheduler-over-allocation",
		state: { ...initialState(), permitOwners: ["a", "b", "a"] },
		expected: "scheduler capacity exceeded",
	},
	{
		name: "duplicate-permit-owner",
		state: { ...initialState(), children: { a: "running", b: "idle" }, permitOwners: ["a", "a"] },
		expected: "duplicate permit owner",
	},
	{
		name: "active-without-permit",
		state: { ...initialState(), children: { a: "running", b: "idle" }, permitOwners: [] },
		expected: "a: active without permit ownership",
	},
	{
		name: "idle-child-owns-permit",
		state: { ...initialState(), permitOwners: ["a"] },
		expected: "a: idle child owns a permit",
	},
]

for (const unsafe of KNOWN_BAD_STATES) {
	assert.ok(invariantViolations(unsafe.state).includes(unsafe.expected), `${unsafe.name}: invariant did not fire`)
}

for (let index = 0; index < queue.length; index++) {
	const node = queue[index]!
	for (const [name, predicate] of Object.entries(LANDMARKS)) {
		if (predicate(node.state)) landmarks.add(name)
	}
	const violations = invariantViolations(node.state)
	assert.deepEqual(violations, [], formatViolation(violations, node.trace))
	if (node.trace.length - 1 === MAX_DEPTH) {
		frontier.push(node.state)
		continue
	}

	for (const transition of transitions(node.state)) {
		actions.add(transition.kind)
		const trace = [...node.trace, { action: transition.name, state: transition.next }]
		const nextViolations = invariantViolations(transition.next)
		assert.deepEqual(nextViolations, [], formatViolation(nextViolations, trace))
		const key = canonical(transition.next)
		if (visited.has(key)) continue
		visited.add(key)
		queue.push({ state: transition.next, trace })
		assert.ok(visited.size <= MAX_STATES, `exceeded ${MAX_STATES}-state budget`)
	}
}

const missingActions = EXPECTED_ACTIONS.filter((action) => !actions.has(action))
assert.deepEqual(missingActions, [], `unreachable actions: ${missingActions.join(", ")}`)
const missingLandmarks = Object.keys(LANDMARKS).filter((name) => !landmarks.has(name))
assert.deepEqual(missingLandmarks, [], `unreachable landmarks: ${missingLandmarks.join(", ")}`)
const unseen = frontier.flatMap(transitions).find(({ next }) => !visited.has(canonical(next)))
assert.equal(unseen, undefined, `depth ${MAX_DEPTH} has unseen successor ${unseen?.name}`)

console.log(
	`Task fan-out protocol model check passed: ${visited.size} distinct reachable states, ${actions.size}/${EXPECTED_ACTIONS.length} actions, ${landmarks.size}/${Object.keys(LANDMARKS).length} landmarks, ${KNOWN_BAD_STATES.length}/${KNOWN_BAD_STATES.length} unsafe counterexamples, depth <= ${MAX_DEPTH}, states <= ${MAX_STATES}`,
)

function transitions(state: ModelState): Transition[] {
	const result: Transition[] = []
	for (const child of CHILDREN) {
		if (state.parentLive && state.children[child] === "idle" && state.permitOwners.length < 2) {
			result.push(
				action(`launch(${child})`, "launch", state, (next) => {
					next.children[child] = "running"
					next.permitOwners.push(child)
				}),
			)
		}
		if (state.children[child] === "running") {
			result.push(
				action(`finish(${child})`, "finish", state, (next) => {
					next.children[child] = "ready"
					next.resultWriters[child] = child
				}),
			)
		}
		if (state.parentLive && state.children[child] === "ready" && state.resultWriters[child] === child) {
			result.push(
				action(`deliver(${child}, parent)`, "deliver", state, (next) => {
					next.children[child] = "delivered"
					next.deliveries.push(child)
					// Record the parent-liveness observed at delivery time so the "result routed
					// after parent loss" invariant is coupled to the delivery mechanism, not a flag
					// no transition writes. The guard above keeps this false in the correct spec, so
					// the model still passes; if a future edit drops the guard, delivery fires with
					// !parentLive, this sets the flag, and the invariant catches the regression.
					next.deliveryAfterParentLoss ||= !state.parentLive
				}),
			)
		}
		if (!state.parentLive && ["running", "ready"].includes(state.children[child])) {
			result.push(
				action(`cancel-orphan(${child})`, "cancel-orphan", state, (next) => {
					next.children[child] = "cancelled"
				}),
			)
		}
		if (state.permitOwners.includes(child) && ["delivered", "cancelled"].includes(state.children[child])) {
			result.push(
				action(`release(${child})`, "release", state, (next) => {
					next.permitOwners = next.permitOwners.filter((owner) => owner !== child)
				}),
			)
		}
	}
	if (state.parentLive && CHILDREN.some((child) => state.children[child] !== "idle")) {
		result.push(
			action("lose-parent", "lose-parent", state, (next) => {
				next.parentLive = false
			}),
		)
	}
	return result
}

function invariantViolations(state: ModelState): string[] {
	const violations: string[] = []
	if (new Set(state.permitOwners).size !== state.permitOwners.length) violations.push("duplicate permit owner")
	if (state.permitOwners.length > 2) violations.push("scheduler capacity exceeded")
	if (state.deliveryAfterParentLoss) violations.push("result routed after parent loss")
	for (const child of CHILDREN) {
		const active = ["running", "ready"].includes(state.children[child])
		if (active && !state.permitOwners.includes(child)) violations.push(`${child}: active without permit ownership`)
		if (state.children[child] === "idle" && state.permitOwners.includes(child)) {
			violations.push(`${child}: idle child owns a permit`)
		}
		if (state.resultWriters[child] !== undefined && state.resultWriters[child] !== child) {
			violations.push(`${child}: result has the wrong writer`)
		}
		if (state.deliveries.filter((delivered) => delivered === child).length > 1) {
			violations.push(`${child}: result delivered more than once`)
		}
		if (state.children[child] === "delivered" && state.resultWriters[child] !== child) {
			violations.push(`${child}: result delivered before readiness`)
		}
	}
	return violations
}

function initialState(): ModelState {
	return {
		parentLive: true,
		children: { a: "idle", b: "idle" },
		permitOwners: [],
		resultWriters: {},
		deliveries: [],
		deliveryAfterParentLoss: false,
	}
}

function action(name: string, kind: string, state: ModelState, update: (next: ModelState) => void): Transition {
	const next = structuredClone(state)
	update(next)
	return { name, kind, next }
}

function canonical(state: ModelState): string {
	// resultWriters is built incrementally in finish(), so key insertion order varies by
	// interleaving; sort keys so logically identical states dedupe. deliveries stays ordered
	// (the out-of-order-results landmark depends on it).
	const resultWriters = Object.fromEntries(
		(Object.keys(state.resultWriters) as Child[]).sort().map((child) => [child, state.resultWriters[child]]),
	)
	return JSON.stringify({ ...state, permitOwners: [...state.permitOwners].sort(), resultWriters })
}

function formatViolation(violations: string[], trace: TraceStep[]): string {
	return [
		violations.join("; "),
		`Bounds: depth=${MAX_DEPTH}, states=${MAX_STATES}`,
		...trace.map((step, index) => `${index}. ${step.action}\n   ${canonical(step.state)}`),
	].join("\n")
}
