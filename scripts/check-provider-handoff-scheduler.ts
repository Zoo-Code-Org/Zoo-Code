import assert from "node:assert/strict"

import type { HistoryItem, ProviderSettings } from "@roo-code/types"

import { selectHandoffExecutionContext } from "../src/core/task/providerHandoff"
import { completeDelegatedChild, delegateTaskToChild } from "../src/core/task-persistence/taskLifecycle"

const PROVIDERS = ["a", "b"] as const
type Provider = (typeof PROVIDERS)[number]
type Generation = 0 | 1
type PublishedTask = "parent" | `child-${Generation}-${Provider}`

type Policy = {
	name: string
	startBeforeCommit?: boolean
	resumeBeforePermitRelease?: boolean
	redelegateBeforePermitRelease?: boolean
	emptyPublication?: boolean
	staleConcurrentCommits?: boolean
	releaseParentTransitionAfterPublication?: boolean
}

type ModelState = {
	generation: Generation
	parent: HistoryItem
	children: Partial<Record<PublishedTask, HistoryItem>>
	claims: Partial<Record<Provider, { generation: Generation; snapshot: HistoryItem }>>
	prepared?: { provider: Provider; generation: Generation }
	commitOwner?: Provider
	committedProviders: Provider[]
	startedProviders: Provider[]
	childPermit: "free" | "held" | "released"
	parentQueued: boolean
	parentPublished: boolean
	parentResumeStarted: boolean
	parentResumed: boolean
	redelegationOpened: boolean
	priorPermitReleased: boolean
	parentTransitionOwner?: Generation
	pendingParentContinuations: Generation[]
	resumedContinuation?: Generation
	resumeInvocationOwner?: Generation
	resumeInvocationPermitReleased?: boolean
	earlyRedelegation: boolean
	continuationPublished: boolean
	publishedTask?: PublishedTask
}

type Transition = { name: string; kind: string; next: ModelState }
type TraceStep = { action: string; state: ModelState }

const MAX_DEPTH = 15
const MAX_STATES = 20_000
const EXPECTED_ACTIONS = [
	"claim",
	"prepare",
	"commit",
	"start",
	"complete",
	"publish-parent",
	"release-permit",
	"resume-parent",
	"settle-parent",
	"redelegate",
] as const
const LANDMARKS = {
	"competing-claims": (state: ModelState) => Object.keys(state.claims).length === 2,
	"prepared-before-commit": (state: ModelState) => state.prepared !== undefined && state.commitOwner === undefined,
	"committed-before-start": (state: ModelState) =>
		state.commitOwner !== undefined && state.startedProviders.length === 0,
	"child-running-with-permit": (state: ModelState) =>
		state.startedProviders.length === 1 && state.childPermit === "held",
	"completed-parent-queued": (state: ModelState) => state.parentQueued && !state.parentPublished,
	"parent-published-before-release": (state: ModelState) => state.parentPublished && state.childPermit === "held",
	"permit-released-before-resume": (state: ModelState) =>
		state.childPermit === "released" && !state.parentResumeStarted,
	"parent-resume-started": (state: ModelState) => state.parentResumeStarted,
	"parent-resumed": (state: ModelState) => state.parentResumed,
	"bounded-redelegation": (state: ModelState) => state.generation === 1,
	"second-generation-start": (state: ModelState) => state.generation === 1 && state.startedProviders.length === 1,
	"resumed-run-with-new-transition": (state: ModelState) =>
		state.resumedContinuation === 0 && state.parentTransitionOwner === 1,
} satisfies Record<string, (state: ModelState) => boolean>

const FIXED_POLICY: Policy = { name: "fixed" }
const LEGACY_POLICIES: Array<Policy & { expectedViolation: string }> = [
	{ name: "start-before-commit", startBeforeCommit: true, expectedViolation: "child started without exact commit" },
	{
		name: "resume-before-permit-release",
		resumeBeforePermitRelease: true,
		expectedViolation: "parent resumed before child permit release",
	},
	{
		name: "redelegate-before-permit-release",
		redelegateBeforePermitRelease: true,
		expectedViolation: "parent redelegated before child permit release",
	},
	{ name: "empty-publication", emptyPublication: true, expectedViolation: "observable current task is empty" },
	{
		name: "stale-concurrent-provider-commits",
		staleConcurrentCommits: true,
		expectedViolation: "multiple provider commits for one parent generation",
	},
	{
		name: "publication-releases-parent-transition",
		releaseParentTransitionAfterPublication: true,
		expectedViolation: "stale parent continuation crossed a newer transition",
	},
]

const parentConfiguration: ProviderSettings = { apiProvider: "anthropic", consecutiveMistakeLimit: 3 }
const savedConfiguration: ProviderSettings = { apiProvider: "openrouter", consecutiveMistakeLimit: 7 }
const parentContext = { mode: "code", apiConfigName: undefined, apiConfiguration: parentConfiguration }
const otherViewContext = {
	mode: "debug",
	apiConfigName: "other-view",
	apiConfiguration: { apiProvider: "openai", consecutiveMistakeLimit: 99 } satisfies ProviderSettings,
}
const PROFILE_SCENARIOS = [
	{ name: "unsaved", locked: false, saved: undefined, expectedName: undefined, expectedLimit: 3 },
	{
		name: "saved",
		locked: false,
		saved: { name: "ask-profile", apiConfiguration: savedConfiguration },
		expectedName: "ask-profile",
		expectedLimit: 7,
	},
	{
		name: "locked",
		locked: true,
		saved: { name: "ask-profile", apiConfiguration: savedConfiguration },
		expectedName: undefined,
		expectedLimit: 3,
	},
] as const

const FOCUSED_VIEWS = ["parent", "other"] as const
for (const scenario of PROFILE_SCENARIOS) {
	for (const focusedBefore of FOCUSED_VIEWS) {
		const viewContexts = { parent: structuredClone(parentContext), other: structuredClone(otherViewContext) }
		const taskContext = viewContexts.parent
		assert.equal(
			viewContexts[focusedBefore].apiConfigName,
			focusedBefore === "parent" ? undefined : "other-view",
			`${scenario.name}/${focusedBefore}: focused view setup`,
		)
		const selected = selectHandoffExecutionContext(
			taskContext,
			"ask",
			taskContext.mode,
			scenario.locked,
			scenario.saved,
		)
		for (const focusedAfter of FOCUSED_VIEWS) {
			viewContexts[focusedAfter].apiConfiguration.consecutiveMistakeLimit = 101
			assert.equal(selected.mode, "ask", `${scenario.name}/${focusedBefore}->${focusedAfter}: task-local mode`)
			assert.equal(
				selected.apiConfigName,
				scenario.expectedName,
				`${scenario.name}/${focusedBefore}->${focusedAfter}: profile identity`,
			)
			assert.equal(
				selected.apiConfiguration.consecutiveMistakeLimit,
				scenario.expectedLimit,
				`${scenario.name}/${focusedBefore}->${focusedAfter}: profile config`,
			)
		}
		assert.equal(
			parentContext.apiConfiguration.consecutiveMistakeLimit,
			3,
			`${scenario.name}: parent context mutated`,
		)
	}
}

const fixed = explore(FIXED_POLICY, false)
const counterexamples = LEGACY_POLICIES.map((policy) => {
	const result = explore(policy, true)
	assert.equal(result.violation, policy.expectedViolation, `${policy.name}: unexpected violation`)
	assert.ok(result.trace, `${policy.name}: expected a counterexample trace`)
	return { name: policy.name, violation: result.violation, trace: result.trace }
})

console.log(
	`Provider handoff/scheduler model check passed: ${fixed.states} distinct reachable states, ${PROFILE_SCENARIOS.length * FOCUSED_VIEWS.length * FOCUSED_VIEWS.length}/${PROFILE_SCENARIOS.length * FOCUSED_VIEWS.length * FOCUSED_VIEWS.length} profile/focus schedules, ${fixed.actions.size}/${EXPECTED_ACTIONS.length} actions, ${fixed.landmarks.size}/${Object.keys(LANDMARKS).length} landmarks, depth <= ${MAX_DEPTH}, states <= ${MAX_STATES}, ${counterexamples.length}/${LEGACY_POLICIES.length} legacy counterexamples`,
)
for (const counterexample of counterexamples) {
	console.log(
		`Legacy counterexample ${counterexample.name}: ${counterexample.violation}\n  ${counterexample
			.trace!.map((step) => step.action)
			.join(" -> ")}`,
	)
}

function explore(
	policy: Policy,
	stopAtViolation: boolean,
): {
	states: number
	actions: Set<string>
	landmarks: Set<string>
	violation?: string
	trace?: TraceStep[]
} {
	const start = initialState()
	const queue: Array<{ state: ModelState; trace: TraceStep[] }> = [
		{ state: start, trace: [{ action: "initial", state: start }] },
	]
	const visited = new Set([canonical(start)])
	const actions = new Set<string>()
	const landmarks = new Set<string>()
	const frontier: ModelState[] = []

	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		for (const [name, predicate] of Object.entries(LANDMARKS)) {
			if (predicate(node.state)) landmarks.add(name)
		}
		const currentViolations = invariantViolations(node.state)
		if (currentViolations.length) {
			if (stopAtViolation) {
				return { states: visited.size, actions, landmarks, violation: currentViolations[0], trace: node.trace }
			}
			throw new Error(formatViolation(policy, currentViolations, node.trace))
		}
		if (node.trace.length - 1 === MAX_DEPTH) {
			frontier.push(node.state)
			continue
		}

		for (const transition of transitions(node.state, policy)) {
			actions.add(transition.kind)
			const trace = [...node.trace, { action: transition.name, state: transition.next }]
			const violations = invariantViolations(transition.next)
			if (violations.length) {
				if (stopAtViolation) {
					return { states: visited.size, actions, landmarks, violation: violations[0], trace }
				}
				throw new Error(formatViolation(policy, violations, trace))
			}
			const key = canonical(transition.next)
			if (visited.has(key)) continue
			visited.add(key)
			queue.push({ state: transition.next, trace })
			if (visited.size > MAX_STATES) {
				throw new Error(`${policy.name}: exceeded ${MAX_STATES}-state budget`)
			}
		}
	}

	if (stopAtViolation) throw new Error(`${policy.name}: expected counterexample was not found`)
	const missingActions = EXPECTED_ACTIONS.filter((action) => !actions.has(action))
	if (missingActions.length) throw new Error(`Fixed model has unreachable actions: ${missingActions.join(", ")}`)
	const missingLandmarks = Object.keys(LANDMARKS).filter((name) => !landmarks.has(name))
	if (missingLandmarks.length)
		throw new Error(`Fixed model has unreachable landmarks: ${missingLandmarks.join(", ")}`)
	const unseen = frontier
		.flatMap((state) => transitions(state, policy))
		.find(({ next }) => !visited.has(canonical(next)))
	if (unseen) {
		throw new Error(`Fixed model reached depth ${MAX_DEPTH} with unseen successor ${unseen.name}`)
	}
	return { states: visited.size, actions, landmarks }
}

function transitions(state: ModelState, policy: Policy): Transition[] {
	const result: Transition[] = []
	for (const provider of PROVIDERS) {
		if (!state.parentQueued && !state.claims[provider] && state.commitOwner === undefined) {
			result.push(
				action(`claim(${provider}, g${state.generation})`, "claim", state, (next) => {
					next.claims[provider] = { generation: state.generation, snapshot: structuredClone(state.parent) }
				}),
			)
		}
		const claim = state.claims[provider]
		if (
			claim?.generation === state.generation &&
			!state.parentQueued &&
			state.prepared === undefined &&
			(state.commitOwner === undefined || policy.staleConcurrentCommits)
		) {
			result.push(
				action(`prepare(${provider}, g${state.generation})`, "prepare", state, (next) => {
					next.prepared = { provider, generation: state.generation }
					const childId = childIdFor(state.generation, provider)
					next.children[childId] = task(childId, "active", "parent")
					next.publishedTask = policy.emptyPublication ? undefined : childId
				}),
			)
		}
		if (claim?.generation === state.generation && state.prepared?.provider === provider) {
			const mayCommit = !state.parentQueued && (state.commitOwner === undefined || policy.staleConcurrentCommits)
			if (mayCommit && (!state.committedProviders.includes(provider) || state.commitOwner === undefined)) {
				result.push(
					action(`commit(${provider}, g${state.generation})`, "commit", state, (next) => {
						const base = policy.staleConcurrentCommits ? claim.snapshot : state.parent
						next.parent = delegateTaskToChild(base, childIdFor(state.generation, provider))
						next.commitOwner = provider
						next.committedProviders = [...state.committedProviders, provider]
						next.parentTransitionOwner = state.generation
						next.prepared = undefined
					}),
				)
			}
		}
		const exactCommit =
			state.commitOwner === provider && state.parent.awaitingChildId === childIdFor(state.generation, provider)
		if (
			state.children[childIdFor(state.generation, provider)] !== undefined &&
			state.startedProviders.length === 0 &&
			(exactCommit || policy.startBeforeCommit)
		) {
			result.push(
				action(`start(${provider}, g${state.generation})`, "start", state, (next) => {
					next.startedProviders = [provider]
					next.childPermit = "held"
				}),
			)
		}
	}

	if (state.generation === 0 && state.commitOwner && state.startedProviders.includes(state.commitOwner)) {
		const childId = childIdFor(0, state.commitOwner)
		const child = state.children[childId]
		if (child?.status === "active" && state.parent.status === "delegated") {
			result.push(
				action("complete-child", "complete", state, (next) => {
					const completed = completeDelegatedChild(state.parent, child, "done")
					next.parent = completed.parent
					next.children[childId] = completed.child
					next.parentQueued = true
					next.parentTransitionOwner = 0
					next.pendingParentContinuations = [0]
				}),
			)
		}
	}
	if (state.parentQueued && !state.parentPublished) {
		result.push(
			action("publish-parent", "publish-parent", state, (next) => {
				next.parentPublished = true
				next.continuationPublished = true
				next.publishedTask = "parent"
				if (policy.releaseParentTransitionAfterPublication) next.parentTransitionOwner = undefined
			}),
		)
	}
	if (
		state.childPermit === "held" &&
		((state.parentQueued && !policy.releaseParentTransitionAfterPublication) ||
			(policy.releaseParentTransitionAfterPublication &&
				state.generation === 1 &&
				state.commitOwner !== undefined))
	) {
		result.push(
			action("release-child-permit", "release-permit", state, (next) => {
				next.childPermit = "released"
			}),
		)
	}
	const pendingContinuation = state.pendingParentContinuations[0]
	if (
		pendingContinuation !== undefined &&
		state.continuationPublished &&
		!state.parentResumeStarted &&
		(state.childPermit === "released" || policy.resumeBeforePermitRelease)
	) {
		result.push(
			action(`resume-parent(g${pendingContinuation})`, "resume-parent", state, (next) => {
				next.parentResumeStarted = true
				next.resumedContinuation = pendingContinuation
				next.resumeInvocationOwner = state.parentTransitionOwner
				next.resumeInvocationPermitReleased = state.childPermit === "released"
				next.pendingParentContinuations = state.pendingParentContinuations.slice(1)
				if (state.parentTransitionOwner === pendingContinuation) next.parentTransitionOwner = undefined
			}),
		)
	}
	if (state.resumedContinuation !== undefined) {
		result.push(
			action(`settle-parent(g${state.resumedContinuation})`, "settle-parent", state, (next) => {
				next.parentResumed = true
				next.resumedContinuation = undefined
				next.resumeInvocationOwner = undefined
			}),
		)
	}
	if (
		state.generation === 0 &&
		!state.redelegationOpened &&
		((state.parentResumeStarted && state.childPermit === "released") ||
			(policy.releaseParentTransitionAfterPublication &&
				state.parentPublished &&
				state.parentTransitionOwner === undefined) ||
			(policy.redelegateBeforePermitRelease &&
				state.parentQueued &&
				state.parentPublished &&
				state.childPermit === "held"))
	) {
		result.push(
			action("redelegate(g1)", "redelegate", state, (next) => {
				next.generation = 1
				next.claims = {}
				next.prepared = undefined
				next.commitOwner = undefined
				next.committedProviders = []
				next.startedProviders = []
				next.childPermit = policy.releaseParentTransitionAfterPublication ? state.childPermit : "free"
				next.parentQueued = false
				next.parentPublished = false
				next.redelegationOpened = true
				next.priorPermitReleased = state.childPermit === "released"
				next.earlyRedelegation =
					state.childPermit !== "released" && policy.releaseParentTransitionAfterPublication === true
			}),
		)
	}
	return result
}

function invariantViolations(state: ModelState): string[] {
	const violations: string[] = []
	if (!state.publishedTask) violations.push("observable current task is empty")
	if (state.startedProviders.length > 1) violations.push("multiple child starts for one parent generation")
	if (state.committedProviders.length > 1) violations.push("multiple provider commits for one parent generation")
	for (const provider of state.parentQueued ? [] : state.startedProviders) {
		if (state.commitOwner !== provider || state.parent.awaitingChildId !== childIdFor(state.generation, provider)) {
			violations.push("child started without exact commit")
		}
	}
	if (state.parentResumeStarted && !state.resumeInvocationPermitReleased) {
		violations.push("parent resumed before child permit release")
	}
	if (state.generation === 1 && !state.priorPermitReleased) {
		if (!state.earlyRedelegation) violations.push("parent redelegated before child permit release")
	}
	if (state.resumedContinuation !== undefined && state.resumedContinuation !== state.resumeInvocationOwner) {
		violations.push("stale parent continuation crossed a newer transition")
	}
	if (state.parentPublished && state.publishedTask !== "parent") {
		violations.push("published parent does not match current task")
	}
	if (state.parentQueued) {
		const completedChildId = state.parent.completedByChildId as PublishedTask | undefined
		if (
			!completedChildId ||
			state.children[completedChildId]?.status !== "completed" ||
			state.parent.status !== "active"
		) {
			violations.push("final child/parent publication is inconsistent")
		}
	}
	return violations
}

function initialState(): ModelState {
	return {
		generation: 0,
		parent: task("parent", "active"),
		children: {},
		claims: {},
		committedProviders: [],
		startedProviders: [],
		childPermit: "free",
		parentQueued: false,
		parentPublished: false,
		parentResumeStarted: false,
		parentResumed: false,
		redelegationOpened: false,
		priorPermitReleased: false,
		pendingParentContinuations: [],
		earlyRedelegation: false,
		continuationPublished: false,
		publishedTask: "parent",
	}
}

function action(name: string, kind: string, state: ModelState, update: (next: ModelState) => void): Transition {
	const next = structuredClone(state)
	update(next)
	return { name, kind, next }
}

function childIdFor(generation: Generation, provider: Provider): `child-${Generation}-${Provider}` {
	return `child-${generation}-${provider}`
}

function canonical(state: ModelState): string {
	return JSON.stringify({
		...state,
		children: Object.fromEntries(
			Object.entries(state.children).sort(([left], [right]) => left.localeCompare(right)),
		),
		claims: Object.fromEntries(
			PROVIDERS.flatMap((provider) => (state.claims[provider] ? [[provider, state.claims[provider]]] : [])),
		),
		committedProviders: [...state.committedProviders].sort(),
		startedProviders: [...state.startedProviders].sort(),
	})
}

function formatViolation(policy: Policy, violations: string[], trace: TraceStep[]): string {
	return [
		`${policy.name}: ${violations.join("; ")}`,
		`Bounds: depth=${MAX_DEPTH}, states=${MAX_STATES}`,
		...trace.map((step, index) => `${index}. ${step.action}\n   ${canonical(step.state)}`),
	].join("\n")
}

function task(id: string, status: HistoryItem["status"], parentTaskId?: string): HistoryItem {
	return { id, status, parentTaskId, task: id, ts: 1, tokensIn: 0, tokensOut: 0, totalCost: 0 }
}
