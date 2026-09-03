import assert from "node:assert/strict"

import type { HistoryItem } from "../packages/types/src/history"
import {
	createProviderHandoffPlan,
	decideProviderHandoffProfile,
	type ProviderProfileRef,
} from "../src/core/task-persistence/providerHandoff"
import { delegateTaskToChild } from "../src/core/task-persistence/taskLifecycle"

type TaskId = "root" | "parent" | "child"
type Topology = "sole-parent" | "exposed-root"
type ProfileScenario = "saved" | "unsaved" | "locked"
type Phase =
	| "parent-open"
	| "parent-removed"
	| "profile-prepared"
	| "child-created"
	| "delegation-committed"
	| "child-running"
	| "settled"

interface RuntimeTask {
	mode: string
	profile: string
}

interface ModelState {
	topology: Topology
	scenario: ProfileScenario
	phase: Phase
	currentTaskId?: TaskId
	rootTask: RuntimeTask
	rootHistory: HistoryItem
	parentHistory: HistoryItem
	childTask?: RuntimeTask
	childStarted: boolean
	globalMode: string
	globalProfile: string
	modeProfileId?: string
	publications: Array<TaskId | undefined>
	refinementCommits: number
}

interface ModelPolicy {
	target: "none" | "implicit-current"
	mutateExposedTask: boolean
	publishWhilePending: boolean
	applyProviderSettingsToContext: boolean
}

interface TraceStep {
	action: string
	state: ModelState
}

interface ModelResult {
	states: number
	traces: number
	actions: Set<string>
}

interface Counterexample {
	violation: string
	trace: TraceStep[]
}

const requestedMode = "child-mode"
const currentProfile: ProviderProfileRef = { name: "root-profile", id: "root-profile-id" }
const savedProfile: ProviderProfileRef = { name: "child-profile", id: "child-profile-id" }
const MAX_STATES = 100
const actionOrder = [
	"remove-parent",
	"prepare-profile",
	"create-child",
	"persist-delegation",
	"start-child",
	"publish-child",
] as const

const legacyPolicy: ModelPolicy = {
	target: "implicit-current",
	mutateExposedTask: true,
	publishWhilePending: true,
	applyProviderSettingsToContext: true,
}

function history(id: TaskId, parentTaskId?: TaskId): HistoryItem {
	return {
		id,
		number: id === "root" ? 0 : id === "parent" ? 1 : 2,
		ts: id === "root" ? 0 : id === "parent" ? 1 : 2,
		task: id,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		mode: "root-mode",
		parentTaskId,
		rootTaskId: parentTaskId ? "root" : undefined,
		childIds: [],
	}
}

function initialState(topology: Topology, scenario: ProfileScenario): ModelState {
	const parentHistory = history("parent", topology === "exposed-root" ? "root" : undefined)
	const rootHistory = topology === "exposed-root" ? delegateTaskToChild(history("root"), "parent") : history("root")
	return {
		topology,
		scenario,
		phase: "parent-open",
		currentTaskId: "parent",
		rootTask: { mode: "root-mode", profile: currentProfile.name },
		rootHistory,
		parentHistory,
		childStarted: false,
		globalMode: "root-mode",
		globalProfile: currentProfile.name,
		publications: [],
		refinementCommits: 0,
	}
}

function profileDecision(state: ModelState) {
	return decideProviderHandoffProfile({
		locked: state.scenario === "locked",
		currentProfile,
		savedProfile: state.scenario === "saved" ? savedProfile : undefined,
	})
}

function productionPolicy(): ModelPolicy {
	const { policy } = createProviderHandoffPlan(requestedMode)
	return {
		target: policy.targetTask === null ? "none" : "implicit-current",
		mutateExposedTask: policy.mutateExposedTask,
		publishWhilePending: policy.publishWhilePending,
		applyProviderSettingsToContext: policy.applyProviderSettingsToContext,
	}
}

function nextAction(phase: Phase): (typeof actionOrder)[number] | undefined {
	switch (phase) {
		case "parent-open":
			return "remove-parent"
		case "parent-removed":
			return "prepare-profile"
		case "profile-prepared":
			return "create-child"
		case "child-created":
			return "persist-delegation"
		case "delegation-committed":
			return "start-child"
		case "child-running":
			return "publish-child"
		case "settled":
			return undefined
	}
}

function transition(state: ModelState, action: (typeof actionOrder)[number], policy: ModelPolicy): ModelState {
	const next = structuredClone(state)
	const decision = profileDecision(state)

	switch (action) {
		case "remove-parent":
			next.phase = "parent-removed"
			next.currentTaskId = state.topology === "exposed-root" ? "root" : undefined
			return next
		case "prepare-profile": {
			next.phase = "profile-prepared"
			next.globalMode = requestedMode
			if (policy.applyProviderSettingsToContext && decision.profile) {
				next.globalProfile = decision.profile.name
			}
			if (decision.source === "unsaved-current") {
				next.modeProfileId = decision.persistModeProfileId
			}
			if (policy.target === "implicit-current" && policy.mutateExposedTask && next.currentTaskId === "root") {
				next.rootTask = { mode: requestedMode, profile: next.globalProfile }
				next.rootHistory = { ...next.rootHistory, mode: requestedMode }
			}
			if (policy.publishWhilePending) next.publications.push(next.currentTaskId)
			return next
		}
		case "create-child":
			next.phase = "child-created"
			next.currentTaskId = "child"
			next.childTask = { mode: next.globalMode, profile: next.globalProfile }
			return next
		case "persist-delegation":
			next.phase = "delegation-committed"
			next.parentHistory = delegateTaskToChild(next.parentHistory, "child")
			next.refinementCommits++
			return next
		case "start-child":
			next.phase = "child-running"
			next.childStarted = true
			return next
		case "publish-child":
			next.phase = "settled"
			next.publications.push(next.currentTaskId)
			return next
	}
}

function phaseAtLeast(state: ModelState, phase: Phase): boolean {
	const phases: Phase[] = [
		"parent-open",
		"parent-removed",
		"profile-prepared",
		"child-created",
		"delegation-committed",
		"child-running",
		"settled",
	]
	return phases.indexOf(state.phase) >= phases.indexOf(phase)
}

function violations(state: ModelState): string[] {
	const result: string[] = []
	const initialRoot = initialState(state.topology, state.scenario)
	const decision = profileDecision(state)
	const expectedProfile = decision.profile?.name ?? currentProfile.name

	if (state.publications.some((taskId) => taskId === undefined)) {
		result.push("published an empty task while child handoff was pending")
	}
	if (state.phase !== "settled" && state.publications.length > 0) {
		result.push("published state before child handoff settled")
	}
	if (
		JSON.stringify(state.rootTask) !== JSON.stringify(initialRoot.rootTask) ||
		JSON.stringify(state.rootHistory) !== JSON.stringify(initialRoot.rootHistory)
	) {
		result.push("mutated the unrelated exposed root task")
	}
	if (phaseAtLeast(state, "profile-prepared") && state.globalProfile !== expectedProfile) {
		result.push("prepared the wrong child profile")
	}
	if (state.scenario === "unsaved" && phaseAtLeast(state, "profile-prepared")) {
		if (state.modeProfileId !== currentProfile.id) result.push("did not persist the inherited unsaved profile")
	}
	if (state.scenario !== "unsaved" && state.modeProfileId !== undefined) {
		result.push("persisted an unexpected mode profile")
	}
	if (phaseAtLeast(state, "child-created")) {
		if (state.childTask?.mode !== requestedMode || state.childTask.profile !== expectedProfile) {
			result.push("created the child with the wrong mode or profile")
		}
	}
	if (state.childStarted && state.refinementCommits !== 1) {
		result.push("started the child before the atomic delegation commit")
	}
	if (phaseAtLeast(state, "delegation-committed")) {
		const expectedParent = delegateTaskToChild(initialRoot.parentHistory, "child")
		if (JSON.stringify(state.parentHistory) !== JSON.stringify(expectedParent)) {
			result.push("delegation commit did not refine delegateTaskToChild")
		}
		if (state.refinementCommits !== 1) result.push("atomic delegation commit count was not exactly one")
	}
	if (state.phase === "settled" && state.publications.at(-1) !== "child") {
		result.push("final publication did not identify the child")
	}
	return result
}

function canonical(state: ModelState): string {
	return JSON.stringify(state)
}

function runModel(policy: ModelPolicy): ModelResult {
	const queue: Array<{ state: ModelState; trace: TraceStep[] }> = []
	for (const topology of ["sole-parent", "exposed-root"] as const) {
		for (const scenario of ["saved", "unsaved", "locked"] as const) {
			const state = initialState(topology, scenario)
			queue.push({ state, trace: [{ action: "initial", state }] })
		}
	}

	const visited = new Set(queue.map(({ state }) => canonical(state)))
	const actions = new Set<string>()
	let settledTraces = 0
	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		const found = violations(node.state)
		if (found.length) throw new Error(`${found.join("; ")}\n${formatTrace(node.trace)}`)
		const action = nextAction(node.state.phase)
		if (!action) {
			settledTraces++
			continue
		}
		actions.add(action)
		const next = transition(node.state, action, policy)
		const key = canonical(next)
		if (!visited.has(key)) {
			visited.add(key)
			if (visited.size > MAX_STATES) {
				throw new Error(`Provider handoff exploration exceeded its ${MAX_STATES}-state budget`)
			}
			queue.push({ state: next, trace: [...node.trace, { action, state: next }] })
		}
	}
	return { states: visited.size, traces: settledTraces, actions }
}

function findCounterexample(
	policy: ModelPolicy,
	topology: Topology,
	violationText: string,
): Counterexample | undefined {
	let state = initialState(topology, "saved")
	const trace: TraceStep[] = [{ action: "initial", state }]
	while (true) {
		const found = violations(state).find((violation) => violation === violationText)
		if (found) return { violation: found, trace }
		const action = nextAction(state.phase)
		if (!action) return undefined
		state = transition(state, action, policy)
		trace.push({ action, state })
	}
}

function formatTrace(trace: TraceStep[]): string {
	return trace
		.map(
			({ action, state }) =>
				`${action}: phase=${state.phase}, current=${state.currentTaskId ?? "none"}, rootMode=${state.rootTask.mode}, globalProfile=${state.globalProfile}, publications=${JSON.stringify(state.publications)}`,
		)
		.join(" -> ")
}

const result = runModel(productionPolicy())
assert.deepEqual([...result.actions], actionOrder)
assert.equal(result.traces, 6)

const emptyPublication = findCounterexample(
	legacyPolicy,
	"sole-parent",
	"published an empty task while child handoff was pending",
)
const rootMutation = findCounterexample(legacyPolicy, "exposed-root", "mutated the unrelated exposed root task")
assert(emptyPublication)
assert(rootMutation)
assert.deepEqual(
	emptyPublication.trace.map(({ action }) => action),
	["initial", "remove-parent", "prepare-profile"],
)
assert.deepEqual(
	rootMutation.trace.map(({ action }) => action),
	["initial", "remove-parent", "prepare-profile"],
)

console.log(
	`Provider handoff model check passed: ${result.states} reachable states, ${result.traces} scenario traces, ${result.actions.size}/${actionOrder.length} actions reachable, 3/3 profile paths, 2/2 legacy counterexamples reproduced`,
)
console.log(`Legacy empty-publication counterexample: ${formatTrace(emptyPublication.trace)}`)
console.log(`Legacy exposed-root mutation counterexample: ${formatTrace(rootMutation.trace)}`)
