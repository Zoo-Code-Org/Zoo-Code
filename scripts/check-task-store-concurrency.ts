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

function runScenario(scenario: Scenario): { states: number; witness?: TraceStep[]; phases: Set<string> } {
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
	let witness: TraceStep[] | undefined

	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
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
	return { states: visited.size, witness, phases }
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
for (const scenario of scenarios) {
	const result = runScenario(scenario)
	totalStates += result.states
	for (const phase of result.phases) reachedPhases.add(phase)
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

console.log(
	`Shared-store model check passed: ${totalStates} states, ${scenarios.length} scenarios, ${commonInvariantNames.length} invariants, ${expectedPhases.length}/${expectedPhases.length} phases reachable`,
)
