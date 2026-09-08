import { isSecretStateKey, type PendingHandoff, type ProviderSettings } from "@roo-code/types"

export interface ProviderProfileRef {
	name: string
	id?: string
}

export interface ProviderHandoffPolicy {
	targetTask: null
	mutateExposedTask: boolean
	publishWhilePending: boolean
	applyProviderSettingsToContext: boolean
}

export const PRODUCTION_PROVIDER_HANDOFF_POLICY = {
	targetTask: null,
	mutateExposedTask: false,
	publishWhilePending: false,
	applyProviderSettingsToContext: true,
} as const satisfies ProviderHandoffPolicy

export function createProviderHandoffPlan(requestedMode: string) {
	return {
		requestedMode,
		policy: PRODUCTION_PROVIDER_HANDOFF_POLICY,
	} as const
}

export type ProviderHandoffProfileDecision =
	| { source: "locked-current"; profile?: ProviderProfileRef }
	| { source: "saved"; profile: ProviderProfileRef }
	| { source: "unsaved-current"; profile?: ProviderProfileRef; persistModeProfileId?: string }

export function decideProviderHandoffProfile(params: {
	locked: true
	currentProfile?: ProviderProfileRef
	savedProfile?: ProviderProfileRef
}): Extract<ProviderHandoffProfileDecision, { source: "locked-current" }>
export function decideProviderHandoffProfile(params: {
	locked: false
	currentProfile?: ProviderProfileRef
	savedProfile: ProviderProfileRef
}): Extract<ProviderHandoffProfileDecision, { source: "saved" }>
export function decideProviderHandoffProfile(params: {
	locked: false
	currentProfile?: ProviderProfileRef
	savedProfile?: undefined
}): Extract<ProviderHandoffProfileDecision, { source: "unsaved-current" }>
export function decideProviderHandoffProfile(params: {
	locked: boolean
	currentProfile?: ProviderProfileRef
	savedProfile?: ProviderProfileRef
}): ProviderHandoffProfileDecision
export function decideProviderHandoffProfile(params: {
	locked: boolean
	currentProfile?: ProviderProfileRef
	savedProfile?: ProviderProfileRef
}): ProviderHandoffProfileDecision {
	const { locked, currentProfile, savedProfile } = params
	if (locked) return { source: "locked-current", profile: currentProfile }
	if (savedProfile) return { source: "saved", profile: savedProfile }
	return {
		source: "unsaved-current",
		profile: currentProfile,
		persistModeProfileId: currentProfile?.id,
	}
}

/**
 * Immutable execution context produced by read-only provider handoff
 * preparation. The delegating parent captures this snapshot while it is still
 * the current task; after the durable delegation commit it becomes the
 * authoritative task-local mode/profile/apiConfiguration of the child. Legacy
 * global writes that happen afterwards are projections only and can never
 * change what the child executes.
 */
/**
 * Explicit profile projection intent carried by the prepared handoff context
 * and the stale-projection marker. The three kinds replace the previous
 * ambiguous "undefined name means skip the write" behavior:
 *
 * - `set`: durably project this profile identity onto legacy global state and
 *   the profile store (saved and unsaved-current handoffs with a profile).
 * - `preserve`: perform no profile-identity write at all. Used when the
 *   profile identity is pinned across modes (workspace profile locking): the
 *   handoff must never rewrite what the user pinned, even as background work.
 * - `clear`: the handoff carries no profile identity (no current profile).
 *   The child executes with `apiConfigName: undefined` and the projection must
 *   explicitly write `undefined` (not skip) so legacy global state and
 *   publication stop claiming a profile that no longer exists.
 */
export type ProviderHandoffProfileIntent =
	| { readonly kind: "preserve" }
	| { readonly kind: "set"; readonly name: string }
	| { readonly kind: "clear" }

/**
 * Derive the explicit projection intent from a prepared profile decision.
 * A named profile projects as `set` — except under workspace profile locking,
 * where the identity is user-pinned and the projection must not rewrite it
 * (`preserve`). A profile without a usable name (absent or empty string) is an
 * explicit `clear`: an empty name carries no durable identity, and a `set`
 * marker with an empty profile name would be rejected by
 * `isValidPendingHandoff` and by the persisted schema. Names are exact
 * identities, so a whitespace-only name stays a `set` intent.
 */
export function deriveProviderHandoffProfileIntent(profile: {
	source: ProviderHandoffProfileDecision["source"]
	name: string | undefined
}): ProviderHandoffProfileIntent {
	if (!profile.name) return { kind: "clear" }
	if (profile.source === "locked-current") return { kind: "preserve" }
	return { kind: "set", name: profile.name }
}

export interface PreparedProviderHandoffProfile {
	/** Which rule produced this profile decision (saved / unsaved-current / locked-current). */
	readonly source: ProviderHandoffProfileDecision["source"]
	readonly name: string | undefined
	readonly id: string | undefined
	/** Explicit post-commit projection intent for the profile identity. */
	readonly intent: ProviderHandoffProfileIntent
}

export interface PreparedProviderHandoffContext {
	readonly requestedMode: string
	readonly profile: PreparedProviderHandoffProfile
	/** Deep-cloned full API configuration, including provider secret fields. Never log or serialize this context. */
	readonly apiConfiguration: ProviderSettings
	/** Post-commit intent: durably map this profile id to the requested mode (unsaved mode defaults, and saved-profile parity). */
	readonly persistModeProfileId: string | undefined
}

/**
 * Build a frozen, deep-cloned handoff context. Callers must pass data they do
 * not need to mutate afterwards: the prepared context shares no object identity
 * with its inputs, and later mutation of the inputs cannot affect the child.
 */
export function createPreparedProviderHandoffContext(params: {
	requestedMode: string
	/** Profile identity without intent; the intent is derived explicitly below. */
	profile: Omit<PreparedProviderHandoffProfile, "intent">
	apiConfiguration: ProviderSettings
	persistModeProfileId?: string
}): PreparedProviderHandoffContext {
	const context: PreparedProviderHandoffContext = Object.freeze({
		requestedMode: params.requestedMode,
		profile: Object.freeze({ ...params.profile, intent: deriveProviderHandoffProfileIntent(params.profile) }),
		apiConfiguration: Object.freeze(structuredClone(params.apiConfiguration)),
		persistModeProfileId: params.persistModeProfileId,
	})
	return context
}

/** Current durable write-ahead marker schema version. */
export const PENDING_HANDOFF_VERSION = 1

/**
 * Derive the secret-free durable child write-ahead marker from a prepared
 * handoff context. This is what the child's history record carries BEFORE the
 * parent delegation is durably committed, so a crash between the two writes
 * can always classify the child as a recoverable pre-commit orphan. It carries
 * the execution identity (mode + explicit profile intent) only — never the API
 * configuration, and never any provider secret.
 */
export function createPendingHandoffMarker(params: { prepared: PreparedProviderHandoffContext }): PendingHandoff {
	const { prepared } = params
	const base = { version: PENDING_HANDOFF_VERSION, mode: prepared.requestedMode } as const
	switch (prepared.profile.intent.kind) {
		case "set":
			return { kind: "set", ...base, profileName: prepared.profile.intent.name }
		case "preserve":
			return prepared.profile.name
				? { kind: "preserve", ...base, profileName: prepared.profile.name }
				: { kind: "preserve", ...base }
		case "clear":
			return { kind: "clear", ...base }
	}
}

/**
 * Runtime validation for a parsed `pendingHandoff` marker. Used by restart
 * reconciliation so an unknown-version or malformed marker is left untouched
 * (fail safe: conservative false negatives, never destructive false
 * positives).
 */
export function isValidPendingHandoff(value: unknown): value is PendingHandoff {
	if (!value || typeof value !== "object") return false
	const candidate = value as Record<string, unknown>
	if (candidate.version !== PENDING_HANDOFF_VERSION) return false
	if (typeof candidate.mode !== "string" || candidate.mode.length === 0) return false
	switch (candidate.kind) {
		case "set":
			return typeof candidate.profileName === "string" && candidate.profileName.length > 0
		case "preserve":
			return candidate.profileName === undefined || typeof candidate.profileName === "string"
		case "clear":
			return true
		default:
			return false
	}
}

/**
 * Best-effort secret redaction for error messages logged around handoff
 * state. Removes values of provider secret fields so projection failures can
 * be logged without leaking credentials.
 */
export function redactProviderHandoffSecrets(message: string, apiConfiguration: ProviderSettings): string {
	let redacted = message
	for (const [key, value] of Object.entries(apiConfiguration)) {
		if (isSecretStateKey(key) && typeof value === "string" && value.length > 0) {
			redacted = redacted.split(value).join("[redacted]")
		}
	}
	return redacted
}

export function getProviderHandoffActivationOptions(policy: ProviderHandoffPolicy) {
	return {
		skipCurrentTaskRebuild: !policy.mutateExposedTask,
		applyProviderSettingsToContext: policy.applyProviderSettingsToContext,
		suppressStatePost: !policy.publishWhilePending,
	}
}

export function shouldPublishProviderHandoffState(
	targetTaskIsNotNull: boolean,
	policy?: ProviderHandoffPolicy,
): boolean {
	return targetTaskIsNotNull && (policy?.publishWhilePending ?? true)
}

export async function publishProviderHandoffState(
	targetTaskIsNotNull: boolean,
	policy: ProviderHandoffPolicy | undefined,
	publish: () => Promise<void>,
): Promise<void> {
	if (shouldPublishProviderHandoffState(targetTaskIsNotNull, policy)) await publish()
}

// ---------------------------------------------------------------------------
// Provider handoff transaction protocol
//
// A pure, secret-free state machine for the delegation handoff transaction
// that `ClineProvider.delegateParentAndOpenChild` implements and
// `scripts/check-provider-handoff.ts` model-checks. It validates ordering and
// records coarse bookkeeping only: it never persists anything and never
// touches profile or secret data. Generations and profiles are opaque labels.
// ---------------------------------------------------------------------------

/** Coarse phase of the delegation handoff transaction. */
export type ProviderHandoffPhase =
	| "initial"
	| "prepared"
	| "parent-removed"
	| "child-created"
	| "child-wal-durable"
	| "delegation-committed"
	| "context-active"
	| "child-running"
	| "settled"
	| "aborting"
	| "aborted"
	| "degraded-abort"

/** Coarse boundary labels for handoff failures. Never carry error details or secrets. */
export type ProviderHandoffFailureBoundary =
	| "preparation"
	| "child-creation"
	| "child-wal"
	| "delegation-commit"
	| "child-cleanup"
	| "parent-restoration"

/** Which legacy projection store failed post-commit, or that the queued projection never ran. */
export type ProviderHandoffProjectionBoundary = "profile-store" | "context-proxy" | "queue"

/**
 * Named post-commit projection operations. Failures are classified per
 * operation instead of by dynamic result-array index so the coarse
 * profile-store versus ContextProxy boundary stays accurate when the write
 * list changes.
 */
export type ProviderHandoffProjectionOperation =
	| "global-mode"
	| "profile-meta-read"
	| "global-config-meta"
	| "global-profile-name"
	| "provider-settings"
	| "profile-store"

/** Outcome of one named projection operation. `error` is never protocol state. */
export interface NamedProviderHandoffProjectionResult {
	readonly operation: ProviderHandoffProjectionOperation
	readonly ok: boolean
	/** Failure reason when `ok` is false; used for redacted logging only. */
	readonly error?: unknown
}

/** The coarse legacy store a named projection operation belongs to. */
export function providerHandoffProjectionBoundary(
	operation: ProviderHandoffProjectionOperation,
): Exclude<ProviderHandoffProjectionBoundary, "queue"> {
	switch (operation) {
		// Reads/writes of the durable profile store file.
		case "profile-meta-read":
		case "profile-store":
			return "profile-store"
		// Everything else is legacy global ContextProxy state.
		default:
			return "context-proxy"
	}
}

/**
 * Classify named projection results into the coarse projection outcome. The
 * first failed operation determines the boundary; `queue` is never produced
 * here because it means the queued batch never ran at all.
 */
export function classifyProviderHandoffProjectionResults(
	results: readonly NamedProviderHandoffProjectionResult[],
): ProviderHandoffProjectionOutcome {
	const firstFailed = results.find((result) => !result.ok)
	if (!firstFailed) return { ok: true }
	return {
		ok: false,
		boundary: providerHandoffProjectionBoundary(firstFailed.operation),
		failedOperation: firstFailed.operation,
	}
}

/**
 * Durability of a failed delegation commit attempt. Production can only
 * observe "unresolved": the store write rejected, but the write may still have
 * persisted before the failure surfaced. The model explores both observations.
 */
export type ProviderHandoffCommitDurability = "unresolved" | "uncommitted" | "committed" | "incoherent"

export type ProviderHandoffParentPresence = "current" | "removed" | "restored"
export type ProviderHandoffChildPresence = "absent" | "paused" | "running"
export type ProviderHandoffDelegationDurability = "none" | "committed"
export type ProviderHandoffContextAuthority = "parent" | "child"
export type ProviderHandoffProjectionState = "original" | "synchronized" | "stale"
export type ProviderHandoffPublicationState = "none" | "child"

/**
 * What the strict fresh parent re-read observed after a rejected delegation
 * commit. Coarse, secret-free labels for the reconciliation decision:
 *
 * - `exact`: the parent record is durably delegated to the attempted child
 *   (the child record is optional; only a PRESENT child record that
 *   contradicts the lineage makes the observation incoherent — see
 *   `contradictory-child`).
 * - `contradictory-child`: the parent is delegated to the attempted child but
 *   a present child record contradicts that lineage (incoherent).
 * - `other-child`: the parent record shows a delegation to a different child.
 * - `unchanged`: the parent record exactly matches the safe nondelegated
 *   preimage captured before the commit attempt — nothing persisted.
 * - `drifted`: the parent record matches neither the attempted delegation nor
 *   the preimage — another writer moved it (incoherent).
 * - `missing`: the parent record is absent.
 * - `unreadable`: the parent record exists but could not be read or parsed.
 *
 * Safety is label-independent: only `exact` continues as committed and only
 * `unchanged` (the exact preimage) permits the rollback; every other label is
 * a non-destructive incoherent observation.
 */
export type ProviderHandoffCommitObservation =
	| "exact"
	| "contradictory-child"
	| "other-child"
	| "unchanged"
	| "drifted"
	| "missing"
	| "unreadable"

/** Primary failure that diverted the transaction onto the abort/rollback path. */
export interface ProviderHandoffFailure {
	readonly boundary: ProviderHandoffFailureBoundary
	readonly commitDurability?: ProviderHandoffCommitDurability
	/** Which fresh parent observation resolved a failed commit's durability. */
	readonly commitObservation?: ProviderHandoffCommitObservation
}

/**
 * Secret-free, coarse protocol state. Profile and generation values are
 * opaque labels; no provider settings, API keys, or task payloads appear here.
 */
export interface ProviderHandoffState {
	readonly phase: ProviderHandoffPhase
	readonly parentPresence: ProviderHandoffParentPresence
	readonly childPresence: ProviderHandoffChildPresence
	readonly delegation: ProviderHandoffDelegationDurability
	/** Opaque label of the one prepared execution-context generation. */
	readonly generation: string | undefined
	/** Owner of the child execution context: the parent until the commit, the child after. */
	readonly contextAuthority: ProviderHandoffContextAuthority
	/**
	 * Durability of the child-side write-ahead handoff record. The
	 * delegation commit is legal only once the child's pending-handoff
	 * record is durable ("durable"); "finalized"/"finalize-failed" record
	 * the best-effort post-commit marker strip, which production starts as
	 * background work after the child is scheduled. "durable" persisting
	 * after activation means the strip has not settled yet; restart replay
	 * covers a failed or never-settling strip.
	 */
	readonly childWal: "none" | "durable" | "finalized" | "finalize-failed"
	readonly projection: ProviderHandoffProjectionState
	readonly projectionFailure: ProviderHandoffProjectionBoundary | undefined
	readonly publication: ProviderHandoffPublicationState
	readonly failure: ProviderHandoffFailure | undefined
	/** Rollback step failures in the order they were observed. */
	readonly rollbackFailures: readonly ProviderHandoffFailureBoundary[]
	/** Number of delegation commit attempts (successful or failed). At most one. */
	readonly commitAttempts: number
}

/** Pure protocol events. The three generation-carrying events bind the prepared context. */
export type ProviderHandoffEvent =
	| { type: "prepare"; generation: string }
	| { type: "prepare-failed" }
	| { type: "remove-parent" }
	| { type: "create-child"; generation: string }
	| { type: "create-child-failed" }
	/** The child's durable write-ahead handoff record persisted (WAL before commit). */
	| { type: "wal-child" }
	/** The child WAL write failed: fail closed, clean up the child, restore the parent. */
	| { type: "wal-child-failed" }
	| { type: "commit-delegation" }
	| { type: "commit-failed" }
	/**
	 * Best-effort background strip of the child's pending-handoff marker,
	 * started after the child is scheduled. It may settle before or after
	 * the child started. A failure is non-fatal: restart reconciliation
	 * replays the strip.
	 */
	| { type: "finalize-child-wal"; ok: boolean }
	| {
			type: "observe-commit-durability"
			durability: "uncommitted" | "committed" | "incoherent"
			/** Coarse observation label recorded on the failure, never protocol state. */
			observation?: ProviderHandoffCommitObservation
	  }
	| { type: "activate-context"; generation: string }
	| { type: "project-legacy"; boundary: ProviderHandoffProjectionBoundary; ok: boolean }
	| { type: "start-child" }
	| { type: "publish" }
	| { type: "rollback-cleanup"; ok: boolean }
	| { type: "rollback-restore"; ok: boolean }

type GenerationCarryingAction = Extract<ProviderHandoffEvent, { type: "prepare" | "create-child" | "activate-context" }>

/** Protocol events without generation labels; used by the transaction wrapper. */
export type ProviderHandoffAction =
	| Exclude<ProviderHandoffEvent, GenerationCarryingAction>
	| Omit<GenerationCarryingAction, "generation">

/** Why a protocol event was rejected. Naming mirrors the guarded ordering rule. */
export type ProviderHandoffRejection =
	| "unexpected-event"
	| "preparation-required"
	| "parent-not-removed"
	| "child-required"
	| "wal-required"
	| "commit-required"
	| "context-activation-required"
	| "child-not-running"
	| "commit-already-attempted"
	| "commit-not-failed"
	| "commit-durability-resolved"
	| "generation-mismatch"
	| "rollback-not-active"
	| "rollback-already-attempted"
	| "commit-durability-unresolved"
	| "cleanup-not-attempted"
	| "projection-already-attempted"
	| "terminal-state"

export type ProviderHandoffTransition =
	| { ok: true; state: ProviderHandoffState }
	| { ok: false; state: ProviderHandoffState; reason: ProviderHandoffRejection }

export function initialProviderHandoffState(): ProviderHandoffState {
	return {
		phase: "initial",
		parentPresence: "current",
		childPresence: "absent",
		delegation: "none",
		generation: undefined,
		contextAuthority: "parent",
		childWal: "none",
		projection: "original",
		projectionFailure: undefined,
		publication: "none",
		failure: undefined,
		rollbackFailures: [],
		commitAttempts: 0,
	}
}

function accept(state: ProviderHandoffState): ProviderHandoffTransition {
	return { ok: true, state }
}

function reject(state: ProviderHandoffState, reason: ProviderHandoffRejection): ProviderHandoffTransition {
	return { ok: false, state, reason }
}

/** Terminal abort: degraded when a durable delegation or any rollback failure remains visible. */
function settleAbort(state: ProviderHandoffState): ProviderHandoffState {
	const degraded = state.delegation === "committed" || state.rollbackFailures.length > 0
	return { ...state, phase: degraded ? "degraded-abort" : "aborted" }
}

/**
 * Apply one protocol event. Total function: never throws. An illegal event
 * leaves the state unchanged and reports a semantic rejection reason.
 */
export function applyProviderHandoffEvent(
	state: ProviderHandoffState,
	event: ProviderHandoffEvent,
): ProviderHandoffTransition {
	if (state.phase === "settled" || state.phase === "aborted" || state.phase === "degraded-abort") {
		return reject(state, "terminal-state")
	}

	switch (event.type) {
		case "prepare":
			return state.phase === "initial"
				? accept({ ...state, phase: "prepared", generation: event.generation })
				: reject(state, "unexpected-event")
		case "prepare-failed":
			return state.phase === "initial"
				? accept({ ...state, phase: "aborted", failure: { boundary: "preparation" } })
				: reject(state, "unexpected-event")
		case "remove-parent":
			if (state.phase === "initial") return reject(state, "preparation-required")
			if (state.phase !== "prepared") return reject(state, "unexpected-event")
			return accept({ ...state, phase: "parent-removed", parentPresence: "removed" })
		case "create-child":
			if (state.phase === "initial" || state.phase === "prepared") return reject(state, "parent-not-removed")
			if (state.phase !== "parent-removed") return reject(state, "unexpected-event")
			if (event.generation !== state.generation) return reject(state, "generation-mismatch")
			return accept({ ...state, phase: "child-created", childPresence: "paused" })
		case "create-child-failed":
			if (state.phase !== "parent-removed") return reject(state, "unexpected-event")
			return accept({ ...state, phase: "aborting", failure: { boundary: "child-creation" } })
		case "wal-child":
			// Write-ahead durability: the child's pending-handoff record must be
			// on disk before the delegation commit becomes legal.
			if (state.phase !== "child-created") return reject(state, "unexpected-event")
			return accept({ ...state, phase: "child-wal-durable", childWal: "durable" })
		case "wal-child-failed":
			if (state.phase !== "child-created") return reject(state, "unexpected-event")
			return accept({ ...state, phase: "aborting", failure: { boundary: "child-wal" } })
		case "commit-delegation":
			if (state.commitAttempts > 0) return reject(state, "commit-already-attempted")
			if (state.phase === "child-created") return reject(state, "wal-required")
			if (state.phase !== "child-wal-durable") return reject(state, "child-required")
			return accept({ ...state, phase: "delegation-committed", delegation: "committed", commitAttempts: 1 })
		case "commit-failed":
			if (state.commitAttempts > 0) return reject(state, "commit-already-attempted")
			if (state.phase === "child-created") return reject(state, "wal-required")
			if (state.phase !== "child-wal-durable") return reject(state, "child-required")
			return accept({
				...state,
				phase: "aborting",
				commitAttempts: 1,
				failure: { boundary: "delegation-commit", commitDurability: "unresolved" },
			})
		case "observe-commit-durability": {
			const failure = state.failure
			if (state.phase !== "aborting" || failure?.boundary !== "delegation-commit") {
				return reject(state, "commit-not-failed")
			}
			if (failure.commitDurability !== "unresolved") return reject(state, "commit-durability-resolved")
			const observedFailure: ProviderHandoffFailure = event.observation
				? { ...failure, commitObservation: event.observation }
				: failure
			if (event.durability === "committed") {
				// Authoritative reconciliation: the rejected write actually
				// persisted. The protocol returns to the committed success path
				// (context activation, projection, start), keeping the retained
				// failure as honest bookkeeping of the observed rejection.
				return accept({
					...state,
					phase: "delegation-committed",
					delegation: "committed",
					failure: { ...observedFailure, commitDurability: "committed" },
				})
			}
			if (event.durability === "incoherent") {
				// Reconciliation could not read the records or the lineage does
				// not match. Degraded terminal: keep the paused child and never
				// restore the parent over potentially committed lineage.
				return accept({
					...state,
					phase: "degraded-abort",
					failure: { ...observedFailure, commitDurability: "incoherent" },
				})
			}
			const next: ProviderHandoffState = {
				...state,
				failure: { ...observedFailure, commitDurability: event.durability },
			}
			// Once the rollback is complete (parent restored), the observation
			// settles the abort; before that, cleanup/restore steps continue
			// from the resolved view.
			if (next.parentPresence === "restored") {
				return accept(settleAbort(next))
			}
			return accept(next)
		}
		case "activate-context":
			if (state.phase !== "delegation-committed") {
				return reject(state, state.contextAuthority === "child" ? "unexpected-event" : "commit-required")
			}
			if (event.generation !== state.generation) return reject(state, "generation-mismatch")
			return accept({ ...state, phase: "context-active", contextAuthority: "child" })
		case "finalize-child-wal":
			// Best-effort background marker strip: production starts it after
			// the child is scheduled, so it may settle while the protocol is
			// still in context-active OR after the child already started
			// (child-running). Single-shot either way. A failure stays visible
			// ("finalize-failed") and is replayed by the restart
			// reconciliation; it never blocks the child from starting.
			if (state.phase !== "context-active" && state.phase !== "child-running") {
				return reject(state, "unexpected-event")
			}
			if (state.childWal !== "durable") return reject(state, "unexpected-event")
			return accept({ ...state, childWal: event.ok ? "finalized" : "finalize-failed" })
		case "project-legacy":
			// Legacy projection is background work: it may settle while the
			// protocol is still in context-active OR after the child already
			// started (child-running). It is single-shot either way.
			if (state.phase !== "context-active" && state.phase !== "child-running") {
				return reject(
					state,
					state.contextAuthority === "child" ? "unexpected-event" : "context-activation-required",
				)
			}
			if (state.projection !== "original") return reject(state, "projection-already-attempted")
			return event.ok
				? accept({ ...state, projection: "synchronized" })
				: accept({ ...state, projection: "stale", projectionFailure: event.boundary })
		case "start-child":
			// The child starts immediately after context activation; it must
			// never await the (possibly slow or abandoned) legacy projection.
			if (state.phase !== "context-active") return reject(state, "context-activation-required")
			return accept({ ...state, phase: "child-running", childPresence: "running" })
		case "publish":
			if (state.phase !== "child-running") return reject(state, "child-not-running")
			return accept({ ...state, phase: "settled", publication: "child" })
		case "rollback-cleanup":
			if (state.phase !== "aborting" || state.childPresence !== "paused")
				return reject(state, "rollback-not-active")
			// Production reconciles commit durability before any rollback, so a
			// still-unresolved failed commit must not be rolled back destructively.
			if (state.failure?.boundary === "delegation-commit" && state.failure.commitDurability === "unresolved") {
				return reject(state, "commit-durability-unresolved")
			}
			// Each rollback step runs at most once, like the production rollback.
			if (state.rollbackFailures.includes("child-cleanup")) return reject(state, "rollback-already-attempted")
			return event.ok
				? accept({ ...state, childPresence: "absent" })
				: accept({ ...state, rollbackFailures: [...state.rollbackFailures, "child-cleanup"] })
		case "rollback-restore": {
			if (state.phase !== "aborting") return reject(state, "rollback-not-active")
			if (state.failure?.boundary === "delegation-commit" && state.failure.commitDurability === "unresolved") {
				return reject(state, "commit-durability-unresolved")
			}
			if (state.rollbackFailures.includes("parent-restoration")) {
				return reject(state, "rollback-already-attempted")
			}
			const cleanupHandled = state.childPresence === "absent" || state.rollbackFailures.includes("child-cleanup")
			if (!cleanupHandled) return reject(state, "cleanup-not-attempted")
			const next: ProviderHandoffState = event.ok
				? { ...state, parentPresence: "restored" }
				: { ...state, rollbackFailures: [...state.rollbackFailures, "parent-restoration"] }
			// An ambiguous commit observation stays open: production cannot know
			// whether a rejected store write persisted, so the protocol stays in
			// "aborting" until the durability is resolved (model-only event).
			const durabilityUnresolved =
				next.failure?.boundary === "delegation-commit" && next.failure.commitDurability === "unresolved"
			if (durabilityUnresolved) return accept(next)
			return accept(settleAbort(next))
		}
	}
}

function attachGeneration(action: ProviderHandoffAction, generation: string): ProviderHandoffEvent {
	switch (action.type) {
		case "prepare":
			return { type: "prepare", generation }
		case "create-child":
			return { type: "create-child", generation }
		case "activate-context":
			return { type: "activate-context", generation }
		default:
			return action
	}
}

export interface ProviderHandoffTransaction {
	/** Opaque label binding prepare, child creation, and context activation. */
	readonly generation: string
	snapshot(): ProviderHandoffState
	/**
	 * Advance the protocol. Never throws and never changes persisted state; a
	 * rejected event leaves the snapshot unchanged. Bookkeeping failures can
	 * therefore never obscure or alter real rollback behavior.
	 */
	advance(action: ProviderHandoffAction): ProviderHandoffTransition
}

let providerHandoffTransactionCounter = 0

/**
 * Create a transaction-scoped protocol bookkeeper for one delegation attempt.
 * The wrapper binds a single opaque generation so production call sites can
 * advance semantic landmarks without threading labels through the flow.
 */
export function createProviderHandoffTransaction(generation?: string): ProviderHandoffTransaction {
	const resolvedGeneration = generation ?? `handoff-generation-${(providerHandoffTransactionCounter += 1)}`
	let current = initialProviderHandoffState()
	return {
		generation: resolvedGeneration,
		snapshot: () => current,
		advance(action) {
			const transition = applyProviderHandoffEvent(current, attachGeneration(action, resolvedGeneration))
			if (transition.ok) current = transition.state
			return transition
		},
	}
}

/** Outcome of the best-effort post-commit legacy projection in production. */
export interface ProviderHandoffProjectionOutcome {
	/** False when at least one legacy projection write failed (projection is stale). */
	ok: boolean
	/** Coarse boundary of the first failed write; "queue" when the queued batch never ran. */
	boundary?: ProviderHandoffProjectionBoundary
	/** Named operation that failed first; undefined when ok or when the queue never ran. */
	failedOperation?: ProviderHandoffProjectionOperation
}
