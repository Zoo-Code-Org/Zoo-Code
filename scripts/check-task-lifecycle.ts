import assert from "node:assert/strict"

import type { HistoryItem } from "../packages/types/src/history"

import {
	abandonDelegatedChild,
	completeDelegatedChild,
	delegateTaskToChild,
	interruptDelegatedChild,
} from "../src/core/task-persistence/taskLifecycle"

const taskIds = ["parent", "child-a", "child-b"] as const
type TaskId = (typeof taskIds)[number]
type TaskMap = Record<TaskId, HistoryItem | undefined>

/**
 * Abstract cross-window liveness flag. Production decides whether an active
 * child awaited by a delegated parent belongs to another live window by
 * comparing the child's history-file mtime against a 5-minute threshold
 * (`TaskHistoryStore.LIVE_CHILD_MTIME_THRESHOLD_MS`). The model never reads
 * wall-clock time: `liveElsewhere[child]` is true exactly when the modeled
 * mtime is "recent" (the child is owned by another window) and false when it
 * is "stale" or unreadable (the child is a crash orphan, repaired
 * conservatively).
 */
type LivenessMap = Record<TaskId, boolean>

interface ModelState {
	tasks: TaskMap
	liveElsewhere: LivenessMap
}

interface Transition {
	name: string
	next: ModelState
}

interface TraceStep {
	action: string
	state: ModelState
}

const MAX_DEPTH = 12
const MAX_STATES = 10_000
const expectedActions = [
	"delegate",
	"interrupt",
	"complete",
	"abandon",
	"markLiveElsewhere",
	"expireLiveElsewhere",
	"reconcileStartup",
] as const
const semanticLandmarks = {
	"interrupted-child-redelegation": (state: ModelState) =>
		state.tasks.parent?.status === "delegated" &&
		state.tasks.parent.awaitingChildId === "child-b" &&
		state.tasks["child-a"]?.status === "interrupted",
	"nested-delegation": (state: ModelState) =>
		state.tasks.parent?.status === "delegated" &&
		state.tasks.parent.awaitingChildId === "child-a" &&
		state.tasks["child-a"]?.status === "delegated" &&
		state.tasks["child-a"].awaitingChildId === "child-b",
	// Proves the fix for the cross-window misrepair bug (PR #1495): startup
	// reconciliation must leave a delegated parent awaiting an active child
	// owned by another window untouched. The reconciliation skip is an identity
	// transition, so this landmark plus the universal transition invariant in
	// `checkTransitionInvariants` (no reachable action may clear the link while
	// the child is active and live-elsewhere) formalizes "not repaired".
	"live-child-preserved-across-reconciliation": (state: ModelState) => {
		const parent = state.tasks.parent
		if (parent?.status !== "delegated" || !parent.awaitingChildId) {
			return false
		}
		const childId = parent.awaitingChildId as TaskId
		return state.tasks[childId]?.status === "active" && state.liveElsewhere[childId]
	},
	// Proves the repair half of the same reconciliation outcome still works: a
	// non-live (crash-orphan) active child is repaired to interrupted while the
	// parent resumes as active with both delegation pointers cleared. This
	// state class is only reachable through `reconcileStartup`, never through
	// `interrupt`/`abandon`/`complete`.
	"crash-orphan-repaired-by-startup": (state: ModelState) => {
		const parent = state.tasks.parent
		const child = state.tasks["child-a"]
		return (
			parent?.status === "active" &&
			!parent.awaitingChildId &&
			child?.status === "interrupted" &&
			child.parentTaskId === "parent" &&
			!state.liveElsewhere["child-a"]
		)
	},
} satisfies Record<string, (state: ModelState) => boolean>

function task(id: TaskId, parentTaskId?: TaskId): HistoryItem {
	return {
		id,
		number: taskIds.indexOf(id),
		ts: taskIds.indexOf(id),
		task: id,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		parentTaskId,
		rootTaskId: parentTaskId ? "parent" : undefined,
		childIds: [],
	}
}

function initialState(): ModelState {
	return {
		tasks: { parent: task("parent"), "child-a": undefined, "child-b": undefined },
		liveElsewhere: { parent: false, "child-a": false, "child-b": false },
	}
}

function replace(state: ModelState, ...updates: HistoryItem[]): ModelState {
	const tasks = { ...state.tasks }
	for (const update of updates) tasks[update.id as TaskId] = update
	return { tasks, liveElsewhere: state.liveElsewhere }
}

function transitions(state: ModelState): Transition[] {
	const result: Transition[] = []
	for (const parentId of taskIds) {
		const parent = state.tasks[parentId]
		if (!parent) continue

		for (const childId of taskIds) {
			if (childId === parentId || state.tasks[childId]) continue
			const awaitedStatus = parent.awaitingChildId
				? state.tasks[parent.awaitingChildId as TaskId]?.status
				: undefined
			if (parent.status !== "active" && !(parent.status === "delegated" && awaitedStatus === "interrupted")) {
				continue
			}
			const delegated = delegateTaskToChild(parent, childId, awaitedStatus)
			result.push({
				name: `delegate(${parentId}, ${childId})`,
				next: replace(state, delegated, task(childId, parentId)),
			})
		}
	}

	for (const childId of taskIds) {
		const child = state.tasks[childId]
		if (!child?.parentTaskId) continue
		const parent = state.tasks[child.parentTaskId as TaskId]
		if (!parent) continue

		// A child marked live-elsewhere is owned by another window's session, so
		// window-local lifecycle operations cannot target it until the flag
		// expires. `checkTransitionInvariants` re-proves universally that no
		// reachable action clears the parent's link while the child is active
		// and live-elsewhere.
		if (state.liveElsewhere[childId]) continue

		if (parent.status === "delegated" && parent.awaitingChildId === child.id && child.status === "active") {
			const interrupted = interruptDelegatedChild(parent, child)
			result.push({ name: `interrupt(${childId})`, next: replace(state, interrupted) })
		}

		if (
			(parent.status === "delegated" || parent.status === "active") &&
			parent.awaitingChildId === child.id &&
			(child.status === "active" || child.status === "interrupted")
		) {
			const completed = completeDelegatedChild(parent, child, `${childId} result`)
			result.push({
				name: `complete(${childId})`,
				next: replace(state, completed.parent, completed.child),
			})
		}

		if (parent.status === "delegated" && parent.awaitingChildId === child.id && child.status === "interrupted") {
			const abandoned = abandonDelegatedChild(parent, child)
			result.push({
				name: `abandon(${childId})`,
				next: replace(state, abandoned.parent, abandoned.child),
			})
		}
	}

	// Cross-window startup reconciliation (`TaskHistoryStore.reconcileDelegationStateCore`,
	// run at initialize() and on every periodic tick). For every delegated parent
	// whose awaited child is active, the outcome is decided solely by the
	// abstract liveness flag:
	//  - stale/unreadable mtime (not live-elsewhere) → repair: child → interrupted
	//    via the shared production reducer, parent → active with both delegation
	//    pointers cleared. The parent-side rewrite is modeled directly here
	//    because production performs it as administrative recovery through
	//    `upsertCore(..., { skipTransitionCheck: true })`, outside the shared
	//    `taskLifecycle.ts` reducers; the child side matches `interruptDelegatedChild`.
	//  - recent mtime (live-elsewhere) → skip: the pre-fix bug repaired exactly
	//    this child, breaking the delegation link so the subtask's completion
	//    could no longer return to the parent. The fix `continue`s, so the
	//    action stays observable (it still marks `reconcileStartup` as executed)
	//    while intentionally not producing a new state.
	for (const parentId of taskIds) {
		const parent = state.tasks[parentId]
		if (parent?.status !== "delegated" || !parent.awaitingChildId) continue
		const childId = parent.awaitingChildId as TaskId
		const child = state.tasks[childId]
		if (child?.status !== "active") continue
		if (state.liveElsewhere[childId]) {
			result.push({ name: `reconcileStartup(${parentId})`, next: state })
			continue
		}
		const repairedParent: HistoryItem = {
			...parent,
			status: "active",
			awaitingChildId: undefined,
			delegatedToId: undefined,
		}
		const repairedChild = interruptDelegatedChild(parent, child)
		result.push({
			name: `reconcileStartup(${parentId})`,
			next: replace(state, repairedParent, repairedChild),
		})
	}

	// Model actions for the abstract mtime liveness flag: `markLiveElsewhere`
	// represents another window actively persisting the child (recent mtime),
	// and `expireLiveElsewhere` represents the owning window going quiet past
	// the threshold (e.g. it crashed after startup skipped its repair), after
	// which the next `reconcileStartup` repairs it as a crash orphan. Only
	// active tasks that are themselves children can toggle the flag; the root
	// slot has no owning window in this bug class, and restricting the flag to
	// child sessions keeps the liveness dimension from multiplying the state
	// space beyond the explicit budget.
	for (const id of taskIds) {
		const current = state.tasks[id]
		if (current?.status !== "active" || !current.parentTaskId) continue
		const id2 = id as TaskId
		if (!state.liveElsewhere[id2]) {
			result.push({
				name: `markLiveElsewhere(${id2})`,
				next: { tasks: state.tasks, liveElsewhere: { ...state.liveElsewhere, [id2]: true } },
			})
		} else {
			result.push({
				name: `expireLiveElsewhere(${id2})`,
				next: { tasks: state.tasks, liveElsewhere: { ...state.liveElsewhere, [id2]: false } },
			})
		}
	}
	return result
}

function invariantViolations(state: ModelState): string[] {
	const violations: string[] = []
	for (const id of taskIds) {
		const current = state.tasks[id]
		if (!current) continue

		if (current.status === "delegated") {
			if (!current.awaitingChildId || current.delegatedToId !== current.awaitingChildId) {
				violations.push(`${id}: delegated task must point to exactly one awaited child`)
				continue
			}
			const child = state.tasks[current.awaitingChildId as TaskId]
			if (!child || child.parentTaskId !== id || child.status === "completed") {
				violations.push(`${id}: awaited child must exist, link back, and not be completed`)
			}
			if (!current.childIds?.includes(current.awaitingChildId)) {
				violations.push(`${id}: awaited child must be retained in childIds`)
			}
		} else if (current.awaitingChildId || current.delegatedToId) {
			violations.push(`${id}: only delegated tasks may retain an awaited-child pointer`)
		}

		if (current.parentTaskId && current.status !== "interrupted") {
			const parent = state.tasks[current.parentTaskId as TaskId]
			if (current.status !== "completed" && parent?.awaitingChildId !== id) {
				violations.push(`${id}: active or delegated linked child must be the child its parent awaits`)
			}
		}

		const ancestors = new Set<string>([id])
		let cursor = current.parentTaskId
		while (cursor) {
			if (ancestors.has(cursor)) {
				violations.push(`${id}: parentTaskId lineage must be acyclic`)
				break
			}
			ancestors.add(cursor)
			cursor = state.tasks[cursor as TaskId]?.parentTaskId
		}
	}
	return violations
}

function canonical(state: ModelState): string {
	return JSON.stringify([taskIds.map((id) => state.tasks[id] ?? null), taskIds.map((id) => state.liveElsewhere[id])])
}

function formatCounterexample(message: string, trace: TraceStep[]): string {
	const steps = trace.map(
		(step, index) =>
			`${index}. ${step.action}\n${JSON.stringify(step.state, null, 2)
				.split("\n")
				.map((line) => `   ${line}`)
				.join("\n")}`,
	)
	return [
		`Task lifecycle invariant failed: ${message}`,
		`Bounds: depth=${MAX_DEPTH}, states=${MAX_STATES}`,
		...steps,
	].join("\n")
}

function checkTransitionInvariants(previous: ModelState, transition: Transition): string[] {
	const violations: string[] = []
	for (const id of taskIds) {
		const before = previous.tasks[id]
		const after = transition.next.tasks[id]
		if (before?.status === "completed" && canonicalTask(before) !== canonicalTask(after)) {
			violations.push(`${id}: completed task changed after ${transition.name}`)
			continue
		}
		// Cross-window ownership guard (PR #1495 bug class): no transition may
		// clear a delegated parent's link to a child that is active AND marked
		// live-elsewhere. Pre-fix, startup reconciliation repaired exactly these
		// children; the mtime guard skips them, so the only enabled successor for
		// such a state is the identity reconciliation. Any future model edit
		// that reintroduces a link-clearing transition on a live-elsewhere child
		// fails here with the shortest causal trace.
		if (before?.status === "delegated" && before.awaitingChildId) {
			const childId = before.awaitingChildId as TaskId
			const childBefore = previous.tasks[childId]
			if (childBefore?.status === "active" && previous.liveElsewhere[childId]) {
				if (after?.status !== "delegated" || after.awaitingChildId !== childId) {
					violations.push(
						`${id}: ${transition.name} cleared delegation to active live-elsewhere child ${childId}`,
					)
				}
			}
		}
	}
	return violations
}

function canonicalTask(value: HistoryItem | undefined): string {
	return JSON.stringify(value ?? null)
}

function runModelCheck(): number {
	const start = initialState()
	const queue: Array<{ state: ModelState; trace: TraceStep[] }> = [
		{ state: start, trace: [{ action: "initial", state: start }] },
	]
	const visited = new Set([canonical(start)])
	const reachedActions = new Set<string>()
	const reachedLandmarks = new Set<string>()
	const frontier: ModelState[] = []

	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		for (const [name, predicate] of Object.entries(semanticLandmarks)) {
			if (predicate(node.state)) reachedLandmarks.add(name)
		}
		const violations = invariantViolations(node.state)
		if (violations.length) throw new Error(formatCounterexample(violations.join("; "), node.trace))
		if (node.trace.length - 1 === MAX_DEPTH) {
			frontier.push(node.state)
			continue
		}

		for (const transition of transitions(node.state)) {
			reachedActions.add(transition.name.slice(0, transition.name.indexOf("(")))
			const transitionViolations = checkTransitionInvariants(node.state, transition)
			const trace = [...node.trace, { action: transition.name, state: transition.next }]
			if (transitionViolations.length) {
				throw new Error(formatCounterexample(transitionViolations.join("; "), trace))
			}
			const key = canonical(transition.next)
			if (visited.has(key)) continue
			visited.add(key)
			queue.push({ state: transition.next, trace })
			if (visited.size > MAX_STATES) {
				throw new Error(
					`Task lifecycle exploration exceeded its ${MAX_STATES}-state budget; increase or reduce bounds`,
				)
			}
		}
	}
	const unreachableActions = expectedActions.filter((action) => !reachedActions.has(action))
	if (unreachableActions.length) {
		throw new Error(`Task lifecycle model has unreachable actions: ${unreachableActions.join(", ")}`)
	}
	const missingLandmarks = Object.keys(semanticLandmarks).filter((name) => !reachedLandmarks.has(name))
	if (missingLandmarks.length) {
		throw new Error(`Task lifecycle model has unreachable semantic landmarks: ${missingLandmarks.join(", ")}`)
	}
	const unexploredSuccessor = frontier
		.flatMap((state) => transitions(state))
		.find((transition) => !visited.has(canonical(transition.next)))
	if (unexploredSuccessor) {
		throw new Error(
			`Task lifecycle exploration reached depth ${MAX_DEPTH} with an unseen successor (${unexploredSuccessor.name}); increase the depth bound`,
		)
	}
	return visited.size
}

function runRepresentativeScenarios(): void {
	const parent = task("parent")
	const childA = task("child-a", "parent")
	const delegated = delegateTaskToChild(parent, childA.id)

	assert.throws(() => delegateTaskToChild(delegated, "child-b", "active"), /not interrupted/)

	const interruptedA = interruptDelegatedChild(delegated, childA)
	const redelegated = delegateTaskToChild(delegated, "child-b", interruptedA.status)
	assert.throws(() => completeDelegatedChild(redelegated, interruptedA, "stale"), /not delegated to child/)

	const abandoned = abandonDelegatedChild(delegated, interruptedA)
	assert.throws(() => completeDelegatedChild(abandoned.parent, abandoned.child, "late"), /not delegated to child/)

	const childB = task("child-b", "child-a")
	const nestedParent = delegateTaskToChild(childA, childB.id)
	const nestedCompletion = completeDelegatedChild(nestedParent, childB, "nested result")
	assert.equal(nestedCompletion.parent.status, "active")
	assert.equal(nestedCompletion.parent.completedByChildId, childB.id)

	const interruptedCompletion = completeDelegatedChild(delegated, interruptedA, "resumed result")
	assert.equal(interruptedCompletion.child.status, "completed")
	assert.equal(interruptedCompletion.parent.status, "active")
}

runRepresentativeScenarios()
const checkedStates = runModelCheck()
console.log(
	`Task lifecycle model check passed: ${checkedStates} reachable states, ${expectedActions.length}/${expectedActions.length} actions reachable, ${Object.keys(semanticLandmarks).length}/${Object.keys(semanticLandmarks).length} landmarks reached, depth <= ${MAX_DEPTH}, ${taskIds.length} task slots`,
)
