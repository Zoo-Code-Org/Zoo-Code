import assert from "node:assert/strict"

import type { HistoryItem } from "../packages/types/src/history"
import {
	applyProviderHandoffEvent,
	createProviderHandoffPlan,
	decideProviderHandoffProfile,
	initialProviderHandoffState,
	type ProviderHandoffEvent,
	type ProviderHandoffProjectionBoundary,
	type ProviderHandoffState,
	type ProviderProfileRef,
} from "../src/core/task-persistence/providerHandoff"
import { delegateTaskToChild } from "../src/core/task-persistence/taskLifecycle"

/**
 * Bounded model of the provider handoff transaction protocol
 * (`src/core/task-persistence/providerHandoff.ts`). The explorer drives the
 * production reducer with nondeterministic coarse failure outcomes and checks
 * safety invariants over every reachable state. Profile identities are opaque
 * names/IDs; no API keys or provider secrets are modeled.
 */

type TaskId = "root" | "parent" | "child"
type Topology = "sole-parent" | "exposed-root"
type ProfilePath = "saved" | "unsaved" | "locked"
type CurrentTaskId = TaskId | undefined

const { requestedMode } = createProviderHandoffPlan("child-mode")
const currentProfile: ProviderProfileRef = { name: "root-profile", id: "root-profile-id" }
const savedProfile: ProviderProfileRef = { name: "child-profile", id: "child-profile-id" }
const MAX_STATES = 600
const MAX_DEPTH = 16

function handoffGeneration(path: ProfilePath): string {
	return `handoff-generation-${path}`
}
const FOREIGN_GENERATION = "foreign-generation"

interface Environment {
	topology: Topology
	profilePath: ProfilePath
	currentTaskId: CurrentTaskId
	rootTask: { mode: string; profile: string }
	rootHistory: HistoryItem
	parentHistory: HistoryItem
	childTask?: { mode: string; profile: string; generation: string }
	childStarted: boolean
	globalMode: string
	globalProfile: string
	modeProfileId?: string
	publications: Array<"empty" | "child">
	publishedMode?: string
	publishedProfile?: string
	/** Number of delegation writes that actually persisted (protocol + observations). */
	commitCount: number
	/**
	 * Set when a legacy projection write has started. Mirrors production queue
	 * ownership: a started projection write is never modeled as cancellable —
	 * its outcome always settles into the protocol (synchronized/stale) — but
	 * the child start and publication do not wait for it.
	 */
	projectionWriteStarted: boolean
	/**
	 * The child's durable history record is optional at the commit boundary.
	 * The model never creates one, so an observed-committed reconciliation is
	 * always "exact parent delegation without child history", matching
	 * production's TaskHistoryStore readFresh observation.
	 */
	childHistoryPresent: boolean
	/** Set only by the legacy witness driver: a pre-commit mutating projection. */
	preCommitProjectionMutation: boolean
	/** Set only by the legacy witness driver: a pending-state publication. */
	pendingPublication: boolean
}

interface ModelState {
	protocol: ProviderHandoffState
	env: Environment
}

interface TraceStep {
	action: string
	state: ModelState
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

function initialEnvironment(topology: Topology, profilePath: ProfilePath): Environment {
	const parentHistory = history("parent", topology === "exposed-root" ? "root" : undefined)
	const rootHistory = topology === "exposed-root" ? delegateTaskToChild(history("root"), "parent") : history("root")
	return {
		topology,
		profilePath,
		currentTaskId: "parent",
		rootTask: { mode: "root-mode", profile: currentProfile.name },
		rootHistory,
		parentHistory,
		childStarted: false,
		globalMode: "root-mode",
		globalProfile: currentProfile.name,
		publications: [],
		commitCount: 0,
		projectionWriteStarted: false,
		childHistoryPresent: false,
		preCommitProjectionMutation: false,
		pendingPublication: false,
	}
}

function initialState(topology: Topology, profilePath: ProfilePath): ModelState {
	return {
		protocol: initialProviderHandoffState(),
		env: initialEnvironment(topology, profilePath),
	}
}

function profileDecision(env: Environment) {
	return decideProviderHandoffProfile({
		locked: env.profilePath === "locked",
		currentProfile,
		savedProfile: env.profilePath === "saved" ? savedProfile : undefined,
	})
}

/** The profile the prepared context binds, resolved like production preparation. */
function expectedProfile(env: Environment): string {
	return profileDecision(env).profile?.name ?? currentProfile.name
}

/** Durable mode mapping intent, resolved like production preparation. */
function expectedModeProfileId(env: Environment): string | undefined {
	return env.profilePath === "saved" ? savedProfile.id : env.profilePath === "unsaved" ? currentProfile.id : undefined
}

// ---------------------------------------------------------------------------
// Nondeterministic protocol events per phase
// ---------------------------------------------------------------------------

interface Candidate {
	name: string
	event: ProviderHandoffEvent
}

function candidateEvents(ms: ModelState): Candidate[] {
	const { protocol: p, env } = ms
	const generation = handoffGeneration(env.profilePath)
	switch (p.phase) {
		case "initial":
			return [
				{ name: "prepare", event: { type: "prepare", generation } },
				{ name: "prepare-failed", event: { type: "prepare-failed" } },
			]
		case "prepared":
			return [{ name: "remove-parent", event: { type: "remove-parent" } }]
		case "parent-removed":
			return [
				{ name: "create-child", event: { type: "create-child", generation } },
				{ name: "create-child-failed", event: { type: "create-child-failed" } },
			]
		case "child-created":
			return [
				{ name: "commit-delegation", event: { type: "commit-delegation" } },
				{ name: "commit-failed", event: { type: "commit-failed" } },
			]
		case "delegation-committed":
			return [{ name: "activate-context", event: { type: "activate-context", generation } }]
		case "context-active": {
			// The child starts immediately after context activation and must
			// never await the legacy projection; the projection itself is
			// fire-and-forget background work that may settle before OR after
			// the child started. Both orders (and a projection that never
			// completes before publication) are protocol states.
			const candidates: Candidate[] = [{ name: "start-child", event: { type: "start-child" } }]
			if (p.projection === "original") {
				candidates.push(
					{
						name: "project-legacy:ok",
						event: { type: "project-legacy", boundary: "profile-store", ok: true },
					},
					{
						name: "project-legacy:fail-profile-store",
						event: { type: "project-legacy", boundary: "profile-store", ok: false },
					},
					{
						name: "project-legacy:fail-context-proxy",
						event: { type: "project-legacy", boundary: "context-proxy", ok: false },
					},
				)
			}
			return candidates
		}
		case "child-running": {
			// A projection still unresolved when the child started may settle
			// while the child runs; publication is policy-gated and independent.
			const candidates: Candidate[] = [{ name: "publish", event: { type: "publish" } }]
			if (p.projection === "original") {
				candidates.push(
					{
						name: "project-legacy:ok",
						event: { type: "project-legacy", boundary: "profile-store", ok: true },
					},
					{
						name: "project-legacy:fail-profile-store",
						event: { type: "project-legacy", boundary: "profile-store", ok: false },
					},
					{
						name: "project-legacy:fail-context-proxy",
						event: { type: "project-legacy", boundary: "context-proxy", ok: false },
					},
				)
			}
			return candidates
		}
		case "aborting": {
			const candidates: Candidate[] = []
			if (p.failure?.boundary === "delegation-commit" && p.failure.commitDurability === "unresolved") {
				// Production authoritatively reconciles the failed commit before
				// any rollback: strictly re-read the parent from disk (child
				// history is optional) and observe the outcome. The observation
				// labels mirror the fresh-read classifications.
				return [
					{
						name: "observe-commit-durability:uncommitted",
						event: {
							type: "observe-commit-durability",
							durability: "uncommitted",
							observation: "unchanged",
						},
					},
					{
						name: "observe-commit-durability:committed",
						event: { type: "observe-commit-durability", durability: "committed", observation: "exact" },
					},
					{
						name: "observe-commit-durability:incoherent",
						event: {
							type: "observe-commit-durability",
							durability: "incoherent",
							observation: "other-child",
						},
					},
				]
			}
			// Each rollback step runs at most once, like the production rollback.
			if (p.childPresence === "paused" && !p.rollbackFailures.includes("child-cleanup")) {
				candidates.push(
					{ name: "rollback-cleanup:ok", event: { type: "rollback-cleanup", ok: true } },
					{ name: "rollback-cleanup:failed", event: { type: "rollback-cleanup", ok: false } },
				)
			}
			const cleanupHandled = p.childPresence === "absent" || p.rollbackFailures.includes("child-cleanup")
			if (cleanupHandled && !p.rollbackFailures.includes("parent-restoration")) {
				candidates.push(
					{ name: "rollback-restore:ok", event: { type: "rollback-restore", ok: true } },
					{ name: "rollback-restore:failed", event: { type: "rollback-restore", ok: false } },
				)
			}
			return candidates
		}
		default:
			return []
	}
}

/**
 * Environment effect of one protocol step. Mirrors production: preparation is
 * read-only, projections happen strictly post-commit, the delegation record
 * refines the production `delegateTaskToChild`, and a commit that is observed
 * as durable leaves a delegated parent record on disk.
 */
function applyEnvironment(ms: ModelState, candidate: Candidate): ModelState {
	const env = structuredClone(ms.env)
	switch (candidate.event.type) {
		case "prepare":
		case "prepare-failed":
		case "create-child-failed":
		case "activate-context":
		case "rollback-cleanup":
			// Read-only steps and protocol-only bookkeeping: no observable change.
			break
		case "remove-parent":
			env.currentTaskId = env.topology === "exposed-root" ? "root" : undefined
			break
		case "create-child":
			env.currentTaskId = "child"
			env.childTask = {
				mode: requestedMode,
				profile: expectedProfile(env),
				generation: candidate.event.generation,
			}
			break
		case "commit-delegation":
			env.parentHistory = delegateTaskToChild(env.parentHistory, "child")
			env.commitCount += 1
			break
		case "observe-commit-durability":
			if (candidate.event.durability === "committed") {
				// Exact parent delegation, no child history: production keeps
				// the durable delegation and continues with the running child.
				env.parentHistory = delegateTaskToChild(env.parentHistory, "child")
				env.commitCount += 1
			}
			break
		case "project-legacy":
			// The write starts before its outcome is known; it is never
			// cancellable once started (bounded queue ownership lives in the
			// production provider, enforced by tests, not by this protocol).
			env.projectionWriteStarted = true
			if (candidate.event.ok) {
				env.globalMode = requestedMode
				// Profile intent: locked handoffs preserve the pinned identity
				// (no profile write); saved/unsaved set the prepared identity.
				if (env.profilePath !== "locked") {
					env.globalProfile = expectedProfile(env)
				}
				env.modeProfileId = expectedModeProfileId(env)
			}
			break
		case "start-child":
			env.childStarted = true
			break
		case "publish": {
			const stale = ms.protocol.projection === "stale"
			env.publications = ["child"]
			env.publishedMode = stale ? (env.childTask?.mode ?? requestedMode) : env.globalMode
			env.publishedProfile = stale ? (env.childTask?.profile ?? expectedProfile(env)) : env.globalProfile
			break
		}
		case "rollback-restore":
			if (candidate.event.ok) env.currentTaskId = "parent"
			break
	}
	return { protocol: ms.protocol, env }
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

function violations(ms: ModelState): string[] {
	const { protocol: p, env: e } = ms
	const found: string[] = []
	const initial = initialEnvironment(e.topology, e.profilePath)
	const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

	// No unrelated-root mutation (both topologies; the sole parent has no root).
	if (!sameJson(e.rootTask, initial.rootTask) || !sameJson(e.rootHistory, initial.rootHistory)) {
		found.push("mutated the unrelated exposed root task")
	}
	// No global/profile projection mutation before the delegation is committed.
	if (p.delegation === "none") {
		if (
			e.globalMode !== initial.globalMode ||
			e.globalProfile !== initial.globalProfile ||
			e.modeProfileId !== initial.modeProfileId
		) {
			found.push("mutated the global/profile projection before the delegation commit")
		}
	}
	if (e.preCommitProjectionMutation) {
		found.push("mutated the global/profile projection before the delegation commit")
	}
	if (e.pendingPublication) {
		found.push("published an empty task while child handoff was pending")
	}

	// Exactly one lifecycle commit, and the environment agrees with the
	// protocol on which commits are durable. After a failed commit attempt the
	// protocol records the attempt while the environment records only writes
	// that actually persisted (resolved by the durability observation).
	if (p.delegation === "committed" && e.commitCount !== 1) {
		found.push("a committed delegation without exactly one persisted commit")
	}
	if (p.delegation === "none" && e.commitCount !== 0) {
		found.push("a persisted delegation commit that the protocol does not record as committed")
	}
	if (e.commitCount > 1) {
		found.push("performed more than one delegation commit")
	}
	if (p.commitAttempts > 1) {
		found.push("attempted more than one delegation commit")
	}

	// One prepared generation binds child creation, delegation, and authority.
	if (e.childTask && p.generation !== undefined && e.childTask.generation !== p.generation) {
		found.push("used a generation other than the one prepared context")
	}

	// Start/publication require durable commit plus context activation.
	if (e.childStarted && (p.delegation !== "committed" || p.contextAuthority !== "child")) {
		found.push("started the child before the delegation was durable and the context authority moved")
	}
	if (
		e.publications.length > 0 &&
		(!e.childStarted || p.delegation !== "committed" || p.contextAuthority !== "child")
	) {
		found.push("published child state before durable commit, context activation, and start")
	}
	// No empty or intermediate publication.
	if (e.publications.some((publication) => publication !== "child")) {
		found.push("published an intermediate or empty state instead of the settled child")
	}

	// A committed delegation is exactly the production refinement of the parent record.
	const refinedParent = delegateTaskToChild(initial.parentHistory, "child")
	if (p.delegation === "committed" && !sameJson(e.parentHistory, refinedParent)) {
		found.push("a committed delegation was not reflected in the refined parent record")
	}
	if (!sameJson(e.parentHistory, initial.parentHistory) && !sameJson(e.parentHistory, refinedParent)) {
		found.push("parent history diverged from the original and the refined delegation")
	}

	// Stale projection cannot alter child authority or published values.
	if (p.projection === "stale") {
		if (p.contextAuthority !== "child") {
			found.push("a stale projection changed the context authority")
		}
		if (
			e.publications.length > 0 &&
			(e.publishedMode !== e.childTask?.mode || e.publishedProfile !== e.childTask?.profile)
		) {
			found.push("publication used stale global values instead of the child's prepared context")
		}
	}

	// Clean abort: parent/current restored, no child, delegation, publication,
	// or projection residue, and the original parent record back.
	if (p.phase === "aborted") {
		if (p.parentPresence !== "current" && p.parentPresence !== "restored") {
			found.push("clean abort left the parent neither current nor restored")
		}
		if (e.currentTaskId !== "parent") {
			found.push("clean abort did not leave the parent as the current task")
		}
		if (
			p.childPresence !== "absent" ||
			p.delegation !== "none" ||
			p.publication !== "none" ||
			p.projection !== "original"
		) {
			found.push("clean abort left child, delegation, publication, or projection residue")
		}
		if (!sameJson(e.parentHistory, initial.parentHistory)) {
			found.push("clean abort did not restore the original parent record")
		}
	}

	// Degraded abort stays visible with its original failure and rollback labels.
	if (p.phase === "degraded-abort") {
		if (!p.failure) found.push("degraded abort lost its primary failure boundary")
		if (p.failure?.commitDurability === "committed" && p.delegation !== "committed") {
			found.push("degraded abort hid a durable delegation")
		}
		// An incoherent reconciliation is non-destructive: the paused child and
		// the parent record are left exactly as they were, publication never
		// runs, and the ambiguity stays visible for operators.
		if (p.failure?.commitDurability === "incoherent") {
			if (p.childPresence !== "paused" || p.parentPresence !== "removed") {
				found.push("an incoherent commit reconciliation mutated the paused child or the parent record")
			}
			if (p.publication !== "none" || e.publications.length > 0) {
				found.push("published after an incoherent commit reconciliation")
			}
			if (p.rollbackFailures.length > 0) {
				found.push("an incoherent commit reconciliation ran rollback steps")
			}
		}
	}

	// Settlement contract: one committed, activated, running child publication
	// that refines the production delegation transition.
	if (p.phase === "settled") {
		if (
			!(
				p.delegation === "committed" &&
				p.contextAuthority === "child" &&
				p.childPresence === "running" &&
				p.publication === "child"
			)
		) {
			found.push("settled without a committed, activated, running child publication")
		}
		if (!sameJson(e.parentHistory, refinedParent)) {
			found.push("settlement did not refine delegateTaskToChild")
		}
		if (p.projection === "synchronized") {
			if (e.globalMode !== requestedMode) {
				found.push("synchronized projection did not match the prepared context")
			}
			// Profile intent: locked paths preserve the pinned identity, so the
			// global profile must still equal the root's original identity.
			const expectedGlobalProfile = e.profilePath === "locked" ? initial.globalProfile : expectedProfile(e)
			if (e.globalProfile !== expectedGlobalProfile) {
				found.push("synchronized projection did not match the prepared profile intent")
			}
			if (e.modeProfileId !== expectedModeProfileId(e)) {
				found.push("synchronized projection did not persist the resolved mode mapping intent")
			}
		}
		// Queue ownership: once a projection write has started it is never
		// modeled as cancelled — the protocol records its settled outcome
		// (synchronized or stale) in the same step, so a settled state whose
		// projection is still `original` proves publication legitimately raced
		// ahead of a projection that had not yet started (bounded model checks
		// publish-before-project as a legal background-work interleaving).
		if (p.projection === "original" && e.projectionWriteStarted) {
			found.push("a started projection write vanished without settling")
		}
		// A started-but-stale projection never overwrites a newer generation's
		// publication: stale publication derives from the child's prepared
		// context regardless of the projection write outcome.
		if (e.projectionWriteStarted && p.projection === "stale" && e.publications.length > 0) {
			if (e.publishedMode !== e.childTask?.mode || e.publishedProfile !== e.childTask?.profile) {
				found.push("a settled stale projection published values that are not the child's")
			}
		}
	}

	return found
}

// ---------------------------------------------------------------------------
// Landmarks, rejection coverage, and applied-action coverage
// ---------------------------------------------------------------------------

function landmarksOf(ms: ModelState): string[] {
	const { protocol: p, env: e } = ms
	const marks: string[] = []
	if (p.phase === "settled") {
		marks.push(`settlement:${e.profilePath}`)
		marks.push(`settlement:${e.topology}`)
		marks.push("settlement:success")
		if (p.projection === "stale" && p.projectionFailure === "profile-store") {
			marks.push("projection:stale-profile-store")
		}
		if (p.projection === "stale" && p.projectionFailure === "context-proxy") {
			marks.push("projection:stale-context-proxy")
		}
	}
	if (p.phase === "aborted") {
		marks.push("abort:clean")
		if (p.failure?.boundary === "preparation") marks.push("abort:preparation-failure")
		if (p.failure?.boundary === "child-creation") marks.push("abort:child-creation-failure")
	}
	if (p.phase === "degraded-abort") {
		marks.push("abort:degraded")
		if (p.rollbackFailures.includes("child-cleanup")) marks.push("rollback:cleanup-failure")
		if (p.rollbackFailures.includes("parent-restoration")) marks.push("rollback:restoration-failure")
	}
	if (p.failure?.boundary === "delegation-commit" && p.failure.commitDurability === "uncommitted") {
		marks.push("commit-ambiguity:observed-uncommitted")
	}
	if (p.failure?.boundary === "delegation-commit" && p.failure.commitDurability === "committed") {
		marks.push("commit-ambiguity:observed-committed")
		// Production reconciliation keeps the child running: an observed
		// committed delegation settles instead of degrading.
		if (p.phase === "settled") marks.push("commit-ambiguity:observed-committed-settled")
	}
	if (p.phase === "degraded-abort" && p.failure?.commitDurability === "incoherent") {
		marks.push("commit-ambiguity:incoherent-degraded")
	}
	if (e.childStarted && p.projection === "original" && (p.phase === "child-running" || p.phase === "settled")) {
		// The child started while the legacy projection was still unresolved.
		marks.push("start:projection-unresolved")
	}
	if (p.phase === "settled" && e.projectionWriteStarted && e.profilePath === "locked") {
		// A locked handoff settled without ever rewriting the pinned identity.
		marks.push("projection:preserve-pinned-identity")
	}
	if (p.phase === "settled" && p.projection === "original" && e.childStarted) {
		// Publication may settle before the background projection completes;
		// the published values are derived from the child, not from global.
		if (e.publications.length > 0) marks.push("settlement:projection-still-original")
	}
	return marks
}

const REQUIRED_LANDMARKS = [
	"settlement:saved",
	"settlement:unsaved",
	"settlement:locked",
	"settlement:sole-parent",
	"settlement:exposed-root",
	"settlement:success",
	"projection:stale-profile-store",
	"projection:stale-context-proxy",
	"abort:clean",
	"abort:preparation-failure",
	"abort:child-creation-failure",
	"abort:degraded",
	"rollback:cleanup-failure",
	"rollback:restoration-failure",
	"commit-ambiguity:observed-uncommitted",
	"commit-ambiguity:observed-committed",
	"commit-ambiguity:observed-committed-settled",
	"commit-ambiguity:incoherent-degraded",
	"start:projection-unresolved",
	"projection:preserve-pinned-identity",
	"settlement:projection-still-original",
] as const

/** Probes attempted on every state to prove illegal orderings are rejected. */
function probeEvents(profilePath: ProfilePath): Array<{ name: string; event: ProviderHandoffEvent }> {
	const generation = handoffGeneration(profilePath)
	return [
		{ name: "prepare", event: { type: "prepare", generation } },
		{ name: "prepare-failed", event: { type: "prepare-failed" } },
		{ name: "remove-parent", event: { type: "remove-parent" } },
		{ name: "create-child", event: { type: "create-child", generation } },
		{ name: "create-child:mismatch", event: { type: "create-child", generation: FOREIGN_GENERATION } },
		{ name: "create-child-failed", event: { type: "create-child-failed" } },
		{ name: "commit-delegation", event: { type: "commit-delegation" } },
		{ name: "commit-failed", event: { type: "commit-failed" } },
		{
			name: "observe-commit-durability",
			event: { type: "observe-commit-durability", durability: "uncommitted" },
		},
		{ name: "activate-context", event: { type: "activate-context", generation } },
		{ name: "activate-context:mismatch", event: { type: "activate-context", generation: FOREIGN_GENERATION } },
		{ name: "project-legacy", event: { type: "project-legacy", boundary: "profile-store", ok: true } },
		{ name: "start-child", event: { type: "start-child" } },
		{ name: "publish", event: { type: "publish" } },
		{ name: "rollback-cleanup", event: { type: "rollback-cleanup", ok: true } },
		{ name: "rollback-restore", event: { type: "rollback-restore", ok: true } },
	]
}

const REQUIRED_REJECTIONS = [
	"initial:remove-parent", // remove before prepare
	"prepared:create-child", // create before remove
	"parent-removed:commit-delegation", // commit before child
	"child-created:activate-context", // context authority before commit
	"child-created:start-child", // start before durable commit + activation
	"child-created:publish", // publish before durable commit + activation
	"delegation-committed:start-child", // start before activation
	"delegation-committed:publish",
	"delegation-committed:rollback-restore", // rollback after a committed delegation
	"delegation-committed:commit-delegation", // exactly one lifecycle commit
	"delegation-committed:observe-commit-durability", // observation requires a failed commit
	"aborting:commit-delegation", // commit during abort
	"aborting:rollback-cleanup", // reconciliation precedes any destructive rollback
	"aborting:rollback-restore",
	"context-active:publish", // publish before start
	"context-active:project-legacy", // projection runs at most once
	"settled:commit-delegation", // terminal state
	"aborted:start-child", // terminal state
	"parent-removed:create-child:mismatch", // generation binding
	"delegation-committed:activate-context:mismatch", // generation binding
] as const

const REQUIRED_APPLIED_ACTIONS = [
	"prepare",
	"prepare-failed",
	"remove-parent",
	"create-child",
	"create-child-failed",
	"commit-delegation",
	"commit-failed",
	"observe-commit-durability:uncommitted",
	"observe-commit-durability:committed",
	"observe-commit-durability:incoherent",
	"activate-context",
	"project-legacy:ok",
	"project-legacy:fail-profile-store",
	"project-legacy:fail-context-proxy",
	"start-child",
	"publish",
	"rollback-cleanup:ok",
	"rollback-cleanup:failed",
	"rollback-restore:ok",
	"rollback-restore:failed",
] as const

// ---------------------------------------------------------------------------
// Breadth-first exploration
// ---------------------------------------------------------------------------

interface ModelResult {
	states: number
	terminals: number
	landmarks: Set<string>
	rejections: Set<string>
	appliedActions: Set<string>
}

function canonical(ms: ModelState): string {
	return JSON.stringify(ms)
}

function runModel(): ModelResult {
	const queue: Array<{ ms: ModelState; depth: number }> = []
	const visited = new Set<string>()
	for (const topology of ["sole-parent", "exposed-root"] as const) {
		for (const profilePath of ["saved", "unsaved", "locked"] as const) {
			const ms = initialState(topology, profilePath)
			visited.add(canonical(ms))
			queue.push({ ms, depth: 0 })
		}
	}

	const landmarks = new Set<string>()
	const rejections = new Set<string>()
	const appliedActions = new Set<string>()
	let terminals = 0

	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		const { ms } = node
		const found = violations(ms)
		if (found.length) throw new Error(`${found.join("; ")}\n${formatTrace(ms)}`)

		for (const mark of landmarksOf(ms)) landmarks.add(mark)
		const candidateList = candidateEvents(ms)
		if (candidateList.length === 0) terminals += 1

		for (const candidate of candidateList) {
			const transition = applyProviderHandoffEvent(ms.protocol, candidate.event)
			if (!transition.ok) {
				throw new Error(
					`checker bug: candidate ${candidate.name} was rejected in phase ${ms.protocol.phase}: ${transition.reason}`,
				)
			}
			appliedActions.add(candidate.name)
			const next = applyEnvironment({ protocol: ms.protocol, env: ms.env }, candidate)
			const nextState: ModelState = { protocol: transition.state, env: next.env }
			const key = canonical(nextState)
			if (!visited.has(key)) {
				visited.add(key)
				if (visited.size > MAX_STATES) {
					throw new Error(`Provider handoff exploration exceeded its ${MAX_STATES}-state budget`)
				}
				if (node.depth + 1 > MAX_DEPTH) {
					throw new Error(`Provider handoff exploration exceeded its ${MAX_DEPTH}-event depth budget`)
				}
				queue.push({ ms: nextState, depth: node.depth + 1 })
			}
		}

		// Rejection probes: illegal orderings must be rejected everywhere.
		for (const probe of probeEvents(ms.env.profilePath)) {
			const transition = applyProviderHandoffEvent(ms.protocol, probe.event)
			if (!transition.ok) rejections.add(`${ms.protocol.phase}:${probe.name}`)
		}
	}

	return { states: visited.size, terminals, landmarks, rejections, appliedActions }
}

// ---------------------------------------------------------------------------
// Legacy counterexample witnesses (pre-Phase-1 remove-then-prepare flow)
// ---------------------------------------------------------------------------

interface Witness {
	violation: string
	trace: string[]
}

function formatTrace(ms: ModelState): string {
	return [
		`phase=${ms.protocol.phase}`,
		`current=${ms.env.currentTaskId ?? "none"}`,
		`globalMode=${ms.env.globalMode}`,
		`globalProfile=${ms.env.globalProfile}`,
		`publications=${JSON.stringify(ms.env.publications)}`,
	].join(", ")
}

/**
 * Deterministic legacy drive reproducing the pre-Phase-1 unsafe flow: remove
 * the parent first, then run the mutating implicit-current profile switch that
 * wrote global state and published while the handoff was still pending. Both
 * witnesses must remain detectable as regression ratchets.
 */
function legacyWitness(topology: Topology, expectViolation: string): Witness {
	const ms = initialState(topology, "saved")
	const trace: string[] = ["initial"]

	// Legacy step 1: remove the parent before any preparation (now illegal).
	ms.env.currentTaskId = topology === "exposed-root" ? "root" : undefined
	trace.push("remove-parent")

	// Legacy step 2: mutating profile switch targeting the implicit current task.
	ms.env.preCommitProjectionMutation = true
	ms.env.globalMode = requestedMode
	ms.env.globalProfile = savedProfile.name
	if (topology === "exposed-root") {
		ms.env.rootTask = { mode: requestedMode, profile: savedProfile.name }
		ms.env.rootHistory = { ...ms.env.rootHistory, mode: requestedMode }
	} else {
		ms.env.pendingPublication = true
		ms.env.publications.push("empty")
	}
	trace.push("legacy-project")

	const found = violations(ms)
	const violation = found.find((candidate) => candidate === expectViolation)
	assert(
		violation,
		`legacy witness for "${expectViolation}" (${topology}) not detected; got: ${JSON.stringify(found)}`,
	)
	return { violation, trace }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const result = runModel()

for (const required of REQUIRED_LANDMARKS) {
	assert(result.landmarks.has(required), `semantic landmark became unreachable: ${required}`)
}
for (const required of REQUIRED_REJECTIONS) {
	assert(result.rejections.has(required), `illegal-ordering rejection not exercised: ${required}`)
}
for (const required of REQUIRED_APPLIED_ACTIONS) {
	assert(result.appliedActions.has(required), `modeled action became unreachable: ${required}`)
}

const emptyPublication = legacyWitness("sole-parent", "published an empty task while child handoff was pending")
const rootMutation = legacyWitness("exposed-root", "mutated the unrelated exposed root task")
assert.deepEqual(emptyPublication.trace, ["initial", "remove-parent", "legacy-project"])
assert.deepEqual(rootMutation.trace, ["initial", "remove-parent", "legacy-project"])

console.log(
	`Provider handoff model check passed: ${result.states} reachable states, ${result.terminals} terminal states, ` +
		`${result.appliedActions.size}/${REQUIRED_APPLIED_ACTIONS.length} actions reachable, ` +
		`${result.landmarks.size} landmarks (all ${REQUIRED_LANDMARKS.length} required present), ` +
		`${result.rejections.size} exercised illegal-ordering rejections, ` +
		`3/3 profile paths, 2/2 topologies, 2/2 legacy counterexamples reproduced`,
)
console.log(
	`Legacy empty-publication counterexample: ${emptyPublication.trace.join(" -> ")} (${emptyPublication.violation})`,
)
console.log(
	`Legacy exposed-root mutation counterexample: ${rootMutation.trace.join(" -> ")} (${rootMutation.violation})`,
)
