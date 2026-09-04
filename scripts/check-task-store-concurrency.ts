import type { HistoryItem } from "../packages/types/src/history"

import {
	abandonDelegatedChild,
	completeDelegatedChild,
	delegateTaskToChild,
	interruptDelegatedChild,
} from "../src/core/task-persistence/taskLifecycle"
import {
	computeHistoryDelta,
	DeltaRejectedError,
	mergeHistoryDelta,
} from "../src/core/task-persistence/taskStoreConcurrency"

const hosts = ["A", "B"] as const
type Host = (typeof hosts)[number]
type TaskId = "parent" | "child-a" | "child-b"
type OperationId =
	| "metadata-a"
	| "metadata-b"
	| "distinct-a"
	| "distinct-b"
	| "complete-a"
	| "redelegate-b"
	| "stale-save-a"
	| "abandon-b"
	| "reject-a"
type RecordMap = Partial<Record<TaskId, HistoryItem>>

interface PreparedWrite {
	taskId: TaskId
	incoming: HistoryItem
	delta: Partial<HistoryItem>
}

interface OperationState {
	phase: "idle" | "read" | "prepared" | "revalidated" | "done" | "rejected" | "failed"
	snapshot?: RecordMap
	writes?: PreparedWrite[]
	writeIndex: number
	candidate?: HistoryItem
}

interface CommitEntry {
	operationId: OperationId
	taskId: TaskId
	previous?: HistoryItem
	delta: Partial<HistoryItem>
	next: HistoryItem
}

interface ModelState {
	disk: RecordMap
	caches: Record<Host, RecordMap>
	hostMutexes: Partial<Record<Host, OperationId>>
	locks: Partial<Record<TaskId, OperationId>>
	operations: Partial<Record<OperationId, OperationState>>
	commits: CommitEntry[]
}

interface OperationSpec {
	id: OperationId
	host: Host
	externalSnapshot?: boolean
	allowRefreshAfterRead?: boolean
	publishCacheAtEnd?: boolean
	isEnabled?(snapshot: RecordMap): boolean
	buildWrites(snapshot: RecordMap): HistoryItem[]
}

interface Scenario {
	name: string
	operations: OperationSpec[]
	targetViolation?: { issue: "#1469" | "#1021"; message: string; expectedActions: string[] }
	check(state: ModelState): string[]
}

interface TraceStep {
	action: string
	state: ModelState
}

const MAX_DEPTH = 32
const MAX_STATES = 100_000
const commonInvariantNames = [
	"host mutex ownership",
	"file lock ownership",
	"disk field preservation",
	"childIds union",
	"pair write order",
	"whole-delta rejection",
] as const
const expectedPhases = ["read", "prepare", "revalidate", "commit", "refresh", "reject", "fail"] as const
const semanticLandmarks = {
	"stale-cache-newer-disk": (state: ModelState) =>
		state.commits.length > 0 &&
		hosts.some((host) =>
			(Object.keys(state.disk) as TaskId[]).some(
				(taskId) => canonical(state.caches[host][taskId]) !== canonical(state.disk[taskId]),
			),
		),
	"pair-first-commit-second-pending": (state: ModelState) =>
		(["complete-a", "abandon-b"] as OperationId[]).some((operationId) => {
			const operation = state.operations[operationId]
			return (
				operation?.writeIndex === 1 &&
				(operation.phase === "prepared" || operation.phase === "revalidated") &&
				state.commits.filter((entry) => entry.operationId === operationId).length === 1
			)
		}),
	"pair-first-commit-second-failed": (state: ModelState) =>
		state.operations["complete-a"]?.phase === "failed" &&
		state.commits.filter((entry) => entry.operationId === "complete-a").length === 1 &&
		state.caches.A["child-a"]?.status === "completed" &&
		state.caches.A.parent?.status === "delegated",
} satisfies Record<string, (state: ModelState) => boolean>

function item(id: TaskId, overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id,
		number: id === "parent" ? 0 : id === "child-a" ? 1 : 2,
		ts: id === "parent" ? 0 : id === "child-a" ? 1 : 2,
		task: id,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		childIds: [],
		...overrides,
	}
}

function baseRecords(): RecordMap {
	return {
		parent: item("parent", {
			status: "delegated",
			awaitingChildId: "child-a",
			delegatedToId: "child-a",
			childIds: ["child-a"],
		}),
		"child-a": item("child-a", { parentTaskId: "parent", rootTaskId: "parent" }),
	}
}

function clone<T>(value: T): T {
	return structuredClone(value)
}

function initialState(operationIds: OperationId[], disk = baseRecords()): ModelState {
	return {
		disk: clone(disk),
		caches: { A: clone(disk), B: clone(disk) },
		hostMutexes: {},
		locks: {},
		operations: Object.fromEntries(
			operationIds.map((id) => [id, { phase: "idle", writeIndex: 0 } satisfies OperationState]),
		),
		commits: [],
	}
}

function getRequired(records: RecordMap, taskId: TaskId): HistoryItem {
	const record = records[taskId]
	if (!record) throw new Error(`Model setup is missing ${taskId}`)
	return record
}

const operationSpecs: Record<OperationId, OperationSpec> = {
	"metadata-a": {
		id: "metadata-a",
		host: "A",
		buildWrites: (snapshot) => [{ ...getRequired(snapshot, "parent"), mode: "architect" }],
	},
	"metadata-b": {
		id: "metadata-b",
		host: "B",
		buildWrites: (snapshot) => [{ ...getRequired(snapshot, "parent"), totalCost: 42 }],
	},
	"distinct-a": {
		id: "distinct-a",
		host: "A",
		buildWrites: (snapshot) => [{ ...getRequired(snapshot, "parent"), mode: "architect" }],
	},
	"distinct-b": {
		id: "distinct-b",
		host: "B",
		buildWrites: (snapshot) => [{ ...getRequired(snapshot, "child-a"), totalCost: 42 }],
	},
	"complete-a": {
		id: "complete-a",
		host: "A",
		externalSnapshot: true,
		publishCacheAtEnd: true,
		isEnabled: (snapshot) => {
			const parent = snapshot.parent
			const child = snapshot["child-a"]
			return (
				(parent?.status === "delegated" || parent?.status === "active") &&
				parent.awaitingChildId === "child-a" &&
				(child?.status === "active" || child?.status === "interrupted")
			)
		},
		buildWrites: (snapshot) => {
			const completed = completeDelegatedChild(
				getRequired(snapshot, "parent"),
				getRequired(snapshot, "child-a"),
				"child-a result",
			)
			return [completed.child, completed.parent]
		},
	},
	"redelegate-b": {
		id: "redelegate-b",
		host: "B",
		isEnabled: (snapshot) =>
			snapshot.parent?.status === "delegated" &&
			snapshot.parent.awaitingChildId === "child-a" &&
			snapshot["child-a"]?.status === "active",
		buildWrites: (snapshot) => {
			const parent = getRequired(snapshot, "parent")
			const interrupted = interruptDelegatedChild(parent, getRequired(snapshot, "child-a"))
			const delegated = delegateTaskToChild(parent, "child-b", "interrupted")
			return [interrupted, item("child-b", { parentTaskId: "parent", rootTaskId: "parent" }), delegated]
		},
	},
	"stale-save-a": {
		id: "stale-save-a",
		host: "A",
		externalSnapshot: true,
		allowRefreshAfterRead: true,
		buildWrites: (snapshot) => {
			const stale = getRequired(snapshot, "child-a")
			return [{ ...stale, tokensOut: stale.tokensOut + 1 }]
		},
	},
	"abandon-b": {
		id: "abandon-b",
		host: "B",
		publishCacheAtEnd: true,
		isEnabled: (snapshot) =>
			snapshot.parent?.status === "delegated" &&
			snapshot.parent.awaitingChildId === "child-a" &&
			snapshot["child-a"]?.status === "active",
		buildWrites: (snapshot) => {
			const parent = getRequired(snapshot, "parent")
			const interrupted = interruptDelegatedChild(parent, getRequired(snapshot, "child-a"))
			const abandoned = abandonDelegatedChild(parent, interrupted)
			return [abandoned.child, abandoned.parent]
		},
	},
	"reject-a": {
		id: "reject-a",
		host: "A",
		buildWrites: (snapshot) => [
			{ ...getRequired(snapshot, "parent"), status: "interrupted", mode: "must-not-commit" },
		],
	},
}

function prepareWrites(state: ModelState, spec: OperationSpec, operation: OperationState): PreparedWrite[] {
	return spec.buildWrites(operation.snapshot!).map((built) => {
		const taskId = built.id as TaskId
		const cached = state.caches[spec.host][taskId]
		// Task.saveClineMessages rebuilds lineage from the live Task but preserves the
		// store's current status before upsert, so stale lineage is not accompanied by
		// a stale status transition.
		const incoming = spec.id === "stale-save-a" && cached?.status ? { ...built, status: cached.status } : built
		return {
			taskId,
			incoming,
			delta: cached ? { id: taskId, ...computeHistoryDelta(cached, incoming) } : { ...incoming },
		}
	})
}

function transition(state: ModelState, action: string, mutate: (next: ModelState) => void): TraceStep {
	const next = clone(state)
	mutate(next)
	return { action, state: next }
}

function nextSteps(state: ModelState, scenario: Scenario): TraceStep[] {
	const result: TraceStep[] = []
	for (const spec of scenario.operations) {
		const operation = state.operations[spec.id]!
		if (
			operation.phase === "idle" &&
			!state.hostMutexes[spec.host] &&
			(spec.isEnabled?.(state.caches[spec.host]) ?? true)
		) {
			result.push(
				transition(state, `${spec.id}.read`, (next) => {
					const target = next.operations[spec.id]!
					if (!spec.externalSnapshot) next.hostMutexes[spec.host] = spec.id
					target.phase = "read"
					target.snapshot = clone(next.caches[spec.host])
				}),
			)
		} else if (
			operation.phase === "read" &&
			(spec.externalSnapshot ? !state.hostMutexes[spec.host] : state.hostMutexes[spec.host] === spec.id)
		) {
			result.push(
				transition(state, `${spec.id}.prepare`, (next) => {
					const target = next.operations[spec.id]!
					if (spec.externalSnapshot) next.hostMutexes[spec.host] = spec.id
					target.writes = prepareWrites(next, spec, target)
					target.phase = "prepared"
				}),
			)
		} else if (operation.phase === "prepared") {
			const write = operation.writes![operation.writeIndex]!
			if (!state.locks[write.taskId]) {
				result.push(
					transition(state, `${spec.id}.revalidate(${write.taskId})`, (next) => {
						const target = next.operations[spec.id]!
						const targetWrite = target.writes![target.writeIndex]!
						next.locks[targetWrite.taskId] = spec.id
						try {
							target.candidate = mergeHistoryDelta(
								next.disk[targetWrite.taskId],
								targetWrite.incoming,
								targetWrite.delta,
							)
							target.phase = "revalidated"
						} catch (error) {
							if (!(error instanceof DeltaRejectedError)) throw error
							target.phase = "rejected"
							delete next.locks[targetWrite.taskId]
							delete next.hostMutexes[spec.host]
						}
					}),
				)
			}
		} else if (operation.phase === "revalidated") {
			const write = operation.writes![operation.writeIndex]!
			result.push(
				transition(state, `${spec.id}.commit(${write.taskId})`, (next) => {
					const target = next.operations[spec.id]!
					const targetWrite = target.writes![target.writeIndex]!
					if (next.locks[targetWrite.taskId] !== spec.id || !target.candidate) {
						throw new Error(`${spec.id} committed without owning ${targetWrite.taskId}`)
					}
					const previous = next.disk[targetWrite.taskId]
					next.disk[targetWrite.taskId] = target.candidate
					if (!spec.publishCacheAtEnd) next.caches[spec.host][targetWrite.taskId] = target.candidate
					next.commits.push({
						operationId: spec.id,
						taskId: targetWrite.taskId,
						previous,
						delta: targetWrite.delta,
						next: target.candidate,
					})
					delete next.locks[targetWrite.taskId]
					target.candidate = undefined
					target.writeIndex++
					target.phase = target.writeIndex === target.writes!.length ? "done" : "prepared"
					if (target.phase === "done") {
						if (spec.publishCacheAtEnd) {
							for (const commit of next.commits.filter((entry) => entry.operationId === spec.id)) {
								next.caches[spec.host][commit.taskId] = commit.next
							}
						}
						delete next.hostMutexes[spec.host]
					}
				}),
			)
			if (spec.publishCacheAtEnd && operation.writeIndex > 0) {
				result.push(
					transition(state, `${spec.id}.fail(${write.taskId})`, (next) => {
						const target = next.operations[spec.id]!
						const targetWrite = target.writes![target.writeIndex]!
						if (next.locks[targetWrite.taskId] !== spec.id) {
							throw new Error(`${spec.id} failed without owning ${targetWrite.taskId}`)
						}
						for (const commit of next.commits.filter((entry) => entry.operationId === spec.id)) {
							next.caches[spec.host][commit.taskId] = commit.next
						}
						target.candidate = undefined
						target.phase = "failed"
						delete next.locks[targetWrite.taskId]
						delete next.hostMutexes[spec.host]
					}),
				)
			}
		}
	}

	for (const host of hosts) {
		const hostHasPreparedWork =
			Boolean(state.hostMutexes[host]) ||
			scenario.operations.some((spec) => {
				const operation = state.operations[spec.id]!
				return (
					spec.host === host &&
					(["prepared", "revalidated"].includes(operation.phase) ||
						(operation.phase === "read" && !spec.allowRefreshAfterRead))
				)
			})
		if (!hostHasPreparedWork && canonical(state.caches[host]) !== canonical(state.disk)) {
			result.push(
				transition(state, `${host}.refresh`, (next) => {
					next.caches[host] = clone(next.disk)
				}),
			)
		}
	}
	return result
}

function commonViolations(state: ModelState, scenario: Scenario): string[] {
	const violations: string[] = []
	for (const [host, owner] of Object.entries(state.hostMutexes) as Array<[Host, OperationId]>) {
		const operation = state.operations[owner]
		if (!operation || !["read", "prepared", "revalidated"].includes(operation.phase)) {
			violations.push(`${owner} holds host ${host} mutex outside its write phase`)
		}
	}
	for (const [taskId, owner] of Object.entries(state.locks) as Array<[TaskId, OperationId]>) {
		const operation = state.operations[owner]
		if (operation?.phase !== "revalidated" || operation.writes?.[operation.writeIndex]?.taskId !== taskId) {
			violations.push(`${owner} holds ${taskId} without a revalidated write`)
		}
	}
	for (const commit of state.commits) {
		if (commit.previous) {
			for (const [key, value] of Object.entries(commit.previous)) {
				if (!(key in commit.delta) && !deepEqual(value, commit.next[key as keyof HistoryItem])) {
					violations.push(`${commit.operationId} lost disk field ${key} absent from its delta`)
				}
			}
			if (commit.delta.childIds && commit.previous.childIds) {
				const expected = new Set([...commit.previous.childIds, ...commit.delta.childIds])
				if ([...expected].some((id) => !commit.next.childIds?.includes(id))) {
					violations.push(`${commit.operationId} lost a concurrent childIds entry`)
				}
			}
		}
	}
	for (const spec of scenario.operations) {
		const operation = state.operations[spec.id]!
		const committed = state.commits.filter((entry) => entry.operationId === spec.id)
		const expectedOrder = operation.writes?.slice(0, committed.length).map((write) => write.taskId) ?? []
		if (committed.some((entry, index) => entry.taskId !== expectedOrder[index])) {
			violations.push(`${spec.id} committed pair records out of production order`)
		}
		if (operation.phase === "rejected" && committed.length > operation.writeIndex) {
			violations.push(`${spec.id} committed a rejected file delta`)
		}
	}
	return violations
}

function deepEqual(left: unknown, right: unknown): boolean {
	return canonical(left) === canonical(right)
}

function canonical(value: unknown): string {
	return JSON.stringify(value)
}

function phaseName(action: string): string {
	if (action.endsWith(".read")) return "read"
	if (action.endsWith(".prepare")) return "prepare"
	if (action.includes(".revalidate(")) return "revalidate"
	if (action.includes(".commit(")) return "commit"
	if (action.includes(".fail(")) return "fail"
	if (action.endsWith(".refresh")) return "refresh"
	return "reject"
}

function formatTrace(scenario: Scenario, message: string, trace: TraceStep[]): string {
	return [
		`Shared-store model violation in ${scenario.name}: ${message}`,
		`Bounds: depth=${MAX_DEPTH}, states=${MAX_STATES}`,
		...trace.map((step, index) => `${index}. ${step.action}\n${JSON.stringify(step.state, null, 2)}`),
	].join("\n")
}

function targetViolation(state: ModelState, scenario: Scenario): string | undefined {
	if (scenario.targetViolation?.issue === "#1469") {
		const completionDone = state.operations["complete-a"]?.phase === "done"
		const redelegationDone = state.operations["redelegate-b"]?.phase === "done"
		const redelegationParentCommit = state.commits.findIndex(
			(entry) => entry.operationId === "redelegate-b" && entry.taskId === "parent",
		)
		const completionParentCommit = state.commits.findIndex(
			(entry) => entry.operationId === "complete-a" && entry.taskId === "parent",
		)
		const parent = state.disk.parent
		const child = state.disk["child-b"]
		if (
			completionDone &&
			redelegationDone &&
			redelegationParentCommit >= 0 &&
			redelegationParentCommit < completionParentCommit &&
			child?.status === "active" &&
			child.parentTaskId === "parent"
		) {
			if (parent?.status !== "delegated" || parent.awaitingChildId !== "child-b") {
				return scenario.targetViolation.message
			}
		}
	}
	if (scenario.targetViolation?.issue === "#1021") {
		const abandonDone = state.operations["abandon-b"]?.phase === "done"
		const staleSaveDone = state.operations["stale-save-a"]?.phase === "done"
		const detachCommit = state.commits.findIndex(
			(entry) =>
				entry.operationId === "abandon-b" &&
				entry.taskId === "child-a" &&
				entry.next.parentTaskId === undefined &&
				entry.next.rootTaskId === undefined,
		)
		const reattachCommit = state.commits.findIndex(
			(entry) =>
				entry.operationId === "stale-save-a" &&
				entry.taskId === "child-a" &&
				entry.previous?.parentTaskId === undefined &&
				entry.next.parentTaskId === "parent",
		)
		if (abandonDone && staleSaveDone && detachCommit >= 0 && detachCommit < reattachCommit) {
			return scenario.targetViolation.message
		}
	}
	return undefined
}

function runScenario(scenario: Scenario): {
	states: number
	witness?: TraceStep[]
	phases: Set<string>
	landmarks: Set<string>
} {
	const startDisk =
		scenario.name === "status rejection"
			? { parent: item("parent", { status: "completed", mode: "stable" }) }
			: baseRecords()
	const start = initialState(
		scenario.operations.map((operation) => operation.id),
		startDisk,
	)
	const queue: Array<{ state: ModelState; trace: TraceStep[] }> = [
		{ state: start, trace: [{ action: "initial", state: start }] },
	]
	const visited = new Set([canonical(start)])
	const frontier: ModelState[] = []
	const phases = new Set<string>()
	const landmarks = new Set<string>()
	let witness: TraceStep[] | undefined

	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		for (const [name, predicate] of Object.entries(semanticLandmarks)) {
			if (predicate(node.state)) landmarks.add(name)
		}
		const violations = [...commonViolations(node.state, scenario), ...scenario.check(node.state)]
		if (violations.length) throw new Error(formatTrace(scenario, violations.join("; "), node.trace))
		const expectedViolation = targetViolation(node.state, scenario)
		if (expectedViolation && !witness) witness = node.trace
		if (node.trace.length - 1 === MAX_DEPTH) {
			frontier.push(node.state)
			continue
		}

		for (const step of nextSteps(node.state, scenario)) {
			phases.add(phaseName(step.action))
			if (step.state.operations["reject-a"]?.phase === "rejected") phases.add("reject")
			const key = canonical(step.state)
			if (visited.has(key)) continue
			visited.add(key)
			queue.push({ state: step.state, trace: [...node.trace, step] })
			if (visited.size > MAX_STATES) throw new Error(`${scenario.name} exceeded ${MAX_STATES} states`)
		}
	}

	if (scenario.targetViolation && !witness) {
		throw new Error(
			`${scenario.name} no longer reproduces ${scenario.targetViolation.issue}; promote it to an invariant`,
		)
	}
	const unseen = frontier
		.flatMap((state) => nextSteps(state, scenario))
		.find((step) => !visited.has(canonical(step.state)))
	if (unseen) throw new Error(`${scenario.name} truncated before unseen action ${unseen.action}`)
	return { states: visited.size, witness, phases, landmarks }
}

const scenarios: Scenario[] = [
	{
		name: "peer field merge",
		operations: [operationSpecs["metadata-a"], operationSpecs["metadata-b"]],
		check: (state) => {
			if (state.operations["metadata-a"]?.phase !== "done" || state.operations["metadata-b"]?.phase !== "done") {
				return []
			}
			return state.disk.parent?.mode === "architect" && state.disk.parent.totalCost === 42
				? []
				: ["concurrent writes to different fields lost an update"]
		},
	},
	{
		name: "status rejection",
		operations: [operationSpecs["reject-a"]],
		check: (state) => {
			if (state.operations["reject-a"]?.phase !== "rejected") return []
			return state.disk.parent?.status === "completed" && state.disk.parent.mode === "stable"
				? []
				: ["rejected status delta applied companion fields"]
		},
	},
	{
		name: "pair second-write failure",
		operations: [operationSpecs["complete-a"]],
		check: (state) => {
			if (state.operations["complete-a"]?.phase !== "failed") return []
			return state.disk["child-a"]?.status === "completed" &&
				state.disk.parent?.status === "delegated" &&
				state.caches.A["child-a"]?.status === "completed" &&
				state.caches.A.parent?.status === "delegated"
				? []
				: ["pair failure cache did not reflect the committed first-record prefix"]
		},
	},
	{
		name: "distinct task writes (#920)",
		operations: [operationSpecs["distinct-a"], operationSpecs["distinct-b"]],
		check: (state) => {
			if (state.operations["distinct-a"]?.phase !== "done" || state.operations["distinct-b"]?.phase !== "done") {
				return []
			}
			return state.disk.parent?.mode === "architect" && state.disk["child-a"]?.totalCost === 42
				? []
				: ["#920 distinct task writes lost an entry"]
		},
	},
	{
		name: "stale completion ownership",
		operations: [operationSpecs["complete-a"], operationSpecs["redelegate-b"]],
		targetViolation: {
			issue: "#1469",
			message: "stale child completion cleared a newer parent handoff",
			expectedActions: [
				"complete-a.read",
				"complete-a.prepare",
				"redelegate-b.read",
				"redelegate-b.prepare",
				"redelegate-b.revalidate(child-a)",
				"redelegate-b.commit(child-a)",
				"complete-a.revalidate(child-a)",
				"complete-a.commit(child-a)",
				"redelegate-b.revalidate(child-b)",
				"redelegate-b.commit(child-b)",
				"redelegate-b.revalidate(parent)",
				"redelegate-b.commit(parent)",
				"complete-a.revalidate(parent)",
				"complete-a.commit(parent)",
			],
		},
		check: () => [],
	},
	{
		name: "stale save detachment",
		operations: [operationSpecs["stale-save-a"], operationSpecs["abandon-b"]],
		targetViolation: {
			issue: "#1021",
			message: "stale live-task save reattached abandoned lineage",
			expectedActions: [
				"stale-save-a.read",
				"abandon-b.read",
				"abandon-b.prepare",
				"abandon-b.revalidate(child-a)",
				"abandon-b.commit(child-a)",
				"abandon-b.revalidate(parent)",
				"abandon-b.commit(parent)",
				"A.refresh",
				"stale-save-a.prepare",
				"stale-save-a.revalidate(child-a)",
				"stale-save-a.commit(child-a)",
			],
		},
		check: () => [],
	},
]

let totalStates = 0
const reachedPhases = new Set<string>()
const reachedLandmarks = new Set<string>()
for (const scenario of scenarios) {
	const result = runScenario(scenario)
	totalStates += result.states
	for (const phase of result.phases) reachedPhases.add(phase)
	for (const landmark of result.landmarks) reachedLandmarks.add(landmark)
	if (scenario.targetViolation) {
		const actions = result.witness!.slice(1).map((step) => step.action)
		if (canonical(actions) !== canonical(scenario.targetViolation.expectedActions)) {
			throw new Error(
				formatTrace(
					scenario,
					`${scenario.targetViolation.issue} shortest causal witness changed`,
					result.witness!,
				),
			)
		}
		console.log(
			`Known unsafe ${scenario.targetViolation.issue}: ${scenario.targetViolation.message}\n  ${result
				.witness!.slice(1)
				.map((step) => step.action)
				.join(" -> ")}`,
		)
	}
}

const missingPhases = expectedPhases.filter((phase) => !reachedPhases.has(phase))
if (missingPhases.length) throw new Error(`Shared-store model has unreachable phases: ${missingPhases.join(", ")}`)
const missingLandmarks = Object.keys(semanticLandmarks).filter((name) => !reachedLandmarks.has(name))
if (missingLandmarks.length) {
	throw new Error(`Shared-store model has unreachable semantic landmarks: ${missingLandmarks.join(", ")}`)
}

console.log(
	`Shared-store model check passed: ${totalStates} states, ${scenarios.length} scenarios, ${commonInvariantNames.length} invariants, ${expectedPhases.length}/${expectedPhases.length} phases reachable, ${Object.keys(semanticLandmarks).length}/${Object.keys(semanticLandmarks).length} landmarks reached`,
)

type HandoffMode = "unsafe" | "fixed"
type HandoffLockOwner = "A" | "B"
type CompletionPhase =
	| "idle"
	| "scheduled"
	| "begun"
	| "ui-written"
	| "api-written"
	| "parent-record-written"
	| "c-record-written"
	| "c-removed"
	| "parent-installed"
	| "callback-failed"
	| "records-compensated"
	| "conversations-compensated"
	| "c-restored"
	| "rejected"
	| "done"
	| "failed"
type ReplacementPhase = "idle" | "locked" | "c-interrupted" | "d-written" | "parent-written" | "d-installed" | "done"
type ParentRecordState = "awaiting-c" | "awaiting-d" | "completed-c"
type CRecordState = "active" | "interrupted" | "completed"
type DRecordState = "missing" | "active"
type ConversationState = "original" | "c-result"
type LiveHandoffState = "c" | "none" | "d" | "parent"

interface HandoffState {
	mode: HandoffMode
	lockOwner?: HandoffLockOwner
	completionPhase: CompletionPhase
	replacementPhase: ReplacementPhase
	scheduledOwnership?: "c" | "d"
	uiConversation: ConversationState
	apiConversation: ConversationState
	parentRecord: ParentRecordState
	cRecord: CRecordState
	dRecord: DRecordState
	live: LiveHandoffState
	dOwnershipEstablished: boolean
	compensationCompleted: boolean
}

interface HandoffTraceStep {
	action: string
	state: HandoffState
}

const HANDOFF_MAX_DEPTH = 20
const HANDOFF_MAX_STATES = 25_000
const handoffMechanicalInvariantNames = [
	"parent transition lock ownership",
	"completion phase lock discipline",
	"replacement phase lock discipline",
] as const
const handoffFixedInvariantNames = [
	...handoffMechanicalInvariantNames,
	"active linked child exact ownership",
	"replacement ownership monotonicity",
	"lock-free handoff bundle coherence",
] as const
const unsafeHandoffLandmarks = {
	"internal partial handoff while locked": (state: HandoffState) =>
		state.lockOwner !== undefined && !isCoherentHandoff(state),
	"stale schedule after D ownership": (state: HandoffState) =>
		state.dOwnershipEstablished && state.completionPhase === "scheduled" && state.scheduledOwnership === "d",
	"successful callback compensation": (state: HandoffState) => state.compensationCompleted,
} satisfies Record<string, (state: HandoffState) => boolean>
const fixedHandoffLandmarks = {
	...unsafeHandoffLandmarks,
	"stale completion rejection": (state: HandoffState) => state.completionPhase === "rejected",
} satisfies Record<string, (state: HandoffState) => boolean>
const expectedUnsafe1469Actions = [
	"handoff.stale-completion.schedule",
	"handoff.unsafe-completion.begin",
	"handoff.completion.write-UI",
	"handoff.completion.write-API",
	"handoff.B.acquire-parent-lock",
	"handoff.B.interrupt-C",
	"handoff.B.write-D",
	"handoff.B.write-parent-awaiting-D",
	"handoff.B.install-D",
	"handoff.B.release",
	"handoff.completion.write-parent-record",
	"handoff.completion.write-C-record",
	"handoff.completion.remove-C",
	"handoff.completion.install-parent",
	"handoff.completion.release",
] as const

function initialHandoffState(mode: HandoffMode): HandoffState {
	return {
		mode,
		completionPhase: "idle",
		replacementPhase: "idle",
		uiConversation: "original",
		apiConversation: "original",
		parentRecord: "awaiting-c",
		cRecord: "active",
		dRecord: "missing",
		live: "c",
		dOwnershipEstablished: false,
		compensationCompleted: false,
	}
}

function handoffTransition(
	state: HandoffState,
	action: string,
	mutate: (next: HandoffState) => void,
): HandoffTraceStep {
	const next = clone(state)
	mutate(next)
	return { action, state: next }
}

function nextHandoffSteps(state: HandoffState): HandoffTraceStep[] {
	const steps: HandoffTraceStep[] = []

	if (state.completionPhase === "idle") {
		steps.push(
			handoffTransition(state, "handoff.stale-completion.schedule", (next) => {
				next.completionPhase = "scheduled"
				next.scheduledOwnership = next.parentRecord === "awaiting-d" ? "d" : "c"
			}),
		)
	} else if (state.completionPhase === "scheduled") {
		if (state.mode === "unsafe") {
			steps.push(
				handoffTransition(state, "handoff.unsafe-completion.begin", (next) => {
					next.completionPhase = "begun"
				}),
			)
		} else if (!state.lockOwner) {
			steps.push(
				handoffTransition(state, "handoff.fixed-completion.begin", (next) => {
					next.lockOwner = "A"
					// withTaskFileLock refreshes the authoritative parent before this exact-child guard.
					next.completionPhase =
						next.parentRecord === "awaiting-c" && next.cRecord !== "completed" ? "begun" : "rejected"
				}),
			)
		}
	} else if (state.completionPhase === "begun") {
		steps.push(
			handoffTransition(state, "handoff.completion.write-UI", (next) => {
				next.uiConversation = "c-result"
				next.completionPhase = "ui-written"
			}),
		)
	} else if (state.completionPhase === "ui-written") {
		steps.push(
			handoffTransition(state, "handoff.completion.write-API", (next) => {
				next.apiConversation = "c-result"
				next.completionPhase = "api-written"
			}),
		)
	} else if (state.completionPhase === "api-written") {
		steps.push(
			handoffTransition(state, "handoff.completion.write-parent-record", (next) => {
				next.parentRecord = "completed-c"
				next.completionPhase = "parent-record-written"
			}),
		)
	} else if (state.completionPhase === "parent-record-written") {
		steps.push(
			handoffTransition(state, "handoff.completion.write-C-record", (next) => {
				next.cRecord = "completed"
				next.completionPhase = "c-record-written"
			}),
		)
	} else if (state.completionPhase === "c-record-written") {
		steps.push(
			handoffTransition(state, "handoff.completion.remove-C", (next) => {
				if (next.live === "c") next.live = "none"
				next.completionPhase = "c-removed"
			}),
		)
	} else if (state.completionPhase === "c-removed") {
		steps.push(
			handoffTransition(state, "handoff.completion.install-parent", (next) => {
				next.live = "parent"
				next.completionPhase = "parent-installed"
			}),
			handoffTransition(state, "handoff.completion.callback-fail", (next) => {
				next.completionPhase = "callback-failed"
			}),
		)
	} else if (state.completionPhase === "parent-installed") {
		steps.push(
			handoffTransition(state, "handoff.completion.release", (next) => {
				if (next.mode === "fixed") delete next.lockOwner
				next.completionPhase = "done"
			}),
		)
	} else if (state.completionPhase === "callback-failed") {
		steps.push(
			handoffTransition(state, "handoff.completion.compensate-records", (next) => {
				next.parentRecord = "awaiting-c"
				next.cRecord = "active"
				next.completionPhase = "records-compensated"
			}),
		)
	} else if (state.completionPhase === "records-compensated") {
		steps.push(
			handoffTransition(state, "handoff.completion.compensate-conversations", (next) => {
				next.uiConversation = "original"
				next.apiConversation = "original"
				next.completionPhase = "conversations-compensated"
			}),
		)
	} else if (state.completionPhase === "conversations-compensated") {
		steps.push(
			handoffTransition(state, "handoff.completion.restore-C", (next) => {
				next.live = "c"
				next.completionPhase = "c-restored"
			}),
		)
	} else if (state.completionPhase === "c-restored") {
		steps.push(
			handoffTransition(state, "handoff.completion.release", (next) => {
				if (next.mode === "fixed") delete next.lockOwner
				next.completionPhase = "failed"
				next.compensationCompleted = true
			}),
		)
	} else if (state.completionPhase === "rejected") {
		steps.push(
			handoffTransition(state, "handoff.completion.release", (next) => {
				delete next.lockOwner
				next.completionPhase = "done"
			}),
		)
	}

	if (
		state.replacementPhase === "idle" &&
		!state.lockOwner &&
		state.parentRecord === "awaiting-c" &&
		state.cRecord === "active"
	) {
		steps.push(
			handoffTransition(state, "handoff.B.acquire-parent-lock", (next) => {
				next.lockOwner = "B"
				next.replacementPhase = "locked"
			}),
		)
	} else if (state.replacementPhase === "locked") {
		steps.push(
			handoffTransition(state, "handoff.B.interrupt-C", (next) => {
				next.cRecord = "interrupted"
				if (next.live === "c") next.live = "none"
				next.replacementPhase = "c-interrupted"
			}),
		)
	} else if (state.replacementPhase === "c-interrupted") {
		steps.push(
			handoffTransition(state, "handoff.B.write-D", (next) => {
				next.dRecord = "active"
				next.replacementPhase = "d-written"
			}),
		)
	} else if (state.replacementPhase === "d-written") {
		steps.push(
			handoffTransition(state, "handoff.B.write-parent-awaiting-D", (next) => {
				next.parentRecord = "awaiting-d"
				next.replacementPhase = "parent-written"
			}),
		)
	} else if (state.replacementPhase === "parent-written") {
		steps.push(
			handoffTransition(state, "handoff.B.install-D", (next) => {
				next.live = "d"
				next.replacementPhase = "d-installed"
			}),
		)
	} else if (state.replacementPhase === "d-installed") {
		steps.push(
			handoffTransition(state, "handoff.B.release", (next) => {
				delete next.lockOwner
				next.replacementPhase = "done"
				if (next.parentRecord === "awaiting-d" && next.dRecord === "active" && next.live === "d") {
					next.dOwnershipEstablished = true
				}
			}),
		)
	}

	return steps
}

function isOriginalCOwnership(state: HandoffState): boolean {
	return (
		state.uiConversation === "original" &&
		state.apiConversation === "original" &&
		state.parentRecord === "awaiting-c" &&
		state.cRecord === "active" &&
		state.dRecord === "missing" &&
		state.live === "c"
	)
}

function isCompletedCOwnership(state: HandoffState): boolean {
	return (
		state.uiConversation === "c-result" &&
		state.apiConversation === "c-result" &&
		state.parentRecord === "completed-c" &&
		state.cRecord === "completed" &&
		state.dRecord === "missing" &&
		state.live === "parent"
	)
}

function isDOwnership(state: HandoffState): boolean {
	return (
		state.uiConversation === "original" &&
		state.apiConversation === "original" &&
		state.parentRecord === "awaiting-d" &&
		state.cRecord === "interrupted" &&
		state.dRecord === "active" &&
		state.live === "d"
	)
}

function isCoherentHandoff(state: HandoffState): boolean {
	return isOriginalCOwnership(state) || isCompletedCOwnership(state) || isDOwnership(state)
}

function handoffMechanicalViolations(state: HandoffState): string[] {
	const violations: string[] = []
	const replacementHoldsLock = ["locked", "c-interrupted", "d-written", "parent-written", "d-installed"].includes(
		state.replacementPhase,
	)
	const completionHoldsLock = [
		"begun",
		"ui-written",
		"api-written",
		"parent-record-written",
		"c-record-written",
		"c-removed",
		"parent-installed",
		"callback-failed",
		"records-compensated",
		"conversations-compensated",
		"c-restored",
		"rejected",
	].includes(state.completionPhase)

	if (replacementHoldsLock !== (state.lockOwner === "B")) {
		violations.push("B replacement phase and parent transition lock ownership disagree")
	}
	if (state.mode === "fixed" && completionHoldsLock !== (state.lockOwner === "A")) {
		violations.push("fixed completion phase and parent transition lock ownership disagree")
	}
	if (state.mode === "unsafe" && state.lockOwner === "A") {
		violations.push("unsafe completion unexpectedly acquired the parent transition lock")
	}
	return violations
}

function fixedHandoffViolations(state: HandoffState): string[] {
	const violations = handoffMechanicalViolations(state)
	if (state.lockOwner) return violations

	if (state.cRecord === "active" && state.parentRecord !== "awaiting-c") {
		violations.push("active linked C is not the exact child awaited by the delegated parent")
	}
	if (state.dRecord === "active" && state.parentRecord !== "awaiting-d") {
		violations.push("active linked D is not the exact child awaited by the delegated parent")
	}
	if (
		state.dOwnershipEstablished &&
		(state.parentRecord !== "awaiting-d" || state.dRecord !== "active" || state.live !== "d")
	) {
		violations.push("established D ownership was not preserved")
	}
	if (!isCoherentHandoff(state)) violations.push("a partial handoff bundle is observable without the parent lock")
	return violations
}

function isUnsafe1469Violation(state: HandoffState): boolean {
	return (
		state.mode === "unsafe" &&
		state.completionPhase === "done" &&
		state.replacementPhase === "done" &&
		state.scheduledOwnership === "c" &&
		state.dOwnershipEstablished &&
		state.parentRecord === "completed-c" &&
		state.dRecord === "active"
	)
}

function formatHandoffTrace(message: string, trace: HandoffTraceStep[]): string {
	return [
		message,
		`Bounds: depth=${HANDOFF_MAX_DEPTH}, states=${HANDOFF_MAX_STATES}`,
		...trace.map((step, index) => `${index}. ${step.action}\n${JSON.stringify(step.state, null, 2)}`),
	].join("\n")
}

function runHandoffExplorer(mode: HandoffMode): {
	states: number
	maxDepth: number
	errors: number
	landmarks: Set<string>
	witness?: HandoffTraceStep[]
} {
	const start = initialHandoffState(mode)
	const queue: Array<{ state: HandoffState; trace: HandoffTraceStep[] }> = [
		{ state: start, trace: [{ action: "initial", state: start }] },
	]
	const visited = new Set([canonical(start)])
	const frontier: HandoffState[] = []
	const landmarks = new Set<string>()
	const landmarkPredicates = mode === "fixed" ? fixedHandoffLandmarks : unsafeHandoffLandmarks
	let maxDepth = 0
	let witness: HandoffTraceStep[] | undefined

	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		const depth = node.trace.length - 1
		maxDepth = Math.max(maxDepth, depth)
		for (const [name, predicate] of Object.entries(landmarkPredicates)) {
			if (predicate(node.state)) landmarks.add(name)
		}
		const violations =
			mode === "fixed" ? fixedHandoffViolations(node.state) : handoffMechanicalViolations(node.state)
		if (violations.length) {
			throw new Error(
				formatHandoffTrace(`Cross-host ${mode} handoff violation: ${violations.join("; ")}`, node.trace),
			)
		}
		if (isUnsafe1469Violation(node.state) && !witness) witness = node.trace
		if (depth === HANDOFF_MAX_DEPTH) {
			frontier.push(node.state)
			continue
		}

		for (const step of nextHandoffSteps(node.state)) {
			const key = canonical(step.state)
			if (visited.has(key)) continue
			visited.add(key)
			queue.push({ state: step.state, trace: [...node.trace, step] })
			if (visited.size > HANDOFF_MAX_STATES) {
				throw new Error(`Cross-host ${mode} handoff exceeded ${HANDOFF_MAX_STATES} states`)
			}
		}
	}

	const unseen = frontier
		.flatMap((state) => nextHandoffSteps(state))
		.find((step) => !visited.has(canonical(step.state)))
	if (unseen) throw new Error(`Cross-host ${mode} handoff truncated before unseen action ${unseen.action}`)
	const missingLandmarks = Object.keys(landmarkPredicates).filter((name) => !landmarks.has(name))
	if (missingLandmarks.length) {
		throw new Error(`Cross-host ${mode} handoff has unreachable landmarks: ${missingLandmarks.join(", ")}`)
	}
	if (mode === "unsafe" && !witness) {
		throw new Error("Cross-host unsafe handoff no longer reproduces #1469; promote it to an invariant")
	}
	return { states: visited.size, maxDepth, errors: witness ? 1 : 0, landmarks, witness }
}

const unsafeHandoff = runHandoffExplorer("unsafe")
const unsafeHandoffActions = unsafeHandoff.witness!.slice(1).map((step) => step.action)
if (canonical(unsafeHandoffActions) !== canonical(expectedUnsafe1469Actions)) {
	throw new Error(
		formatHandoffTrace("Cross-host unsafe handoff #1469 shortest causal witness changed", unsafeHandoff.witness!),
	)
}
console.log(
	`Known unsafe #1469 protocol: stale child completion cleared replacement D ownership\n  ${unsafeHandoffActions.join(" -> ")}`,
)
console.log(
	`Cross-host unsafe handoff explored: ${unsafeHandoff.states} states, max depth ${unsafeHandoff.maxDepth}, ${unsafeHandoff.errors} expected error, ${handoffMechanicalInvariantNames.length} invariants, ${unsafeHandoff.landmarks.size}/${Object.keys(unsafeHandoffLandmarks).length} landmarks reached`,
)

const fixedHandoff = runHandoffExplorer("fixed")
console.log(
	`Cross-host fixed handoff model check passed: ${fixedHandoff.states} states, max depth ${fixedHandoff.maxDepth}, ${fixedHandoff.errors} errors, ${handoffFixedInvariantNames.length} invariants, ${fixedHandoff.landmarks.size}/${Object.keys(fixedHandoffLandmarks).length} landmarks reached`,
)
