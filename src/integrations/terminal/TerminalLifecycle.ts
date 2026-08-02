/**
 * TerminalLifecycle — pure terminal ownership and state-machine model.
 *
 * This module is intentionally free of VS Code and Execa dependencies. It owns
 * the authoritative terminal state, health, and compare-and-set ownership
 * checks described in the architect report (Sections 1.4, 1.5, 1.6).
 *
 * The lifecycle is consumed by {@link BaseTerminal} through compatibility
 * getters and by {@link TerminalRegistry} for atomic reservation.
 */

import type { TerminalErrorCode } from "./types"

// ─────────────────────────────────────────────────────────────────────────────
// State and health sets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authoritative terminal lifecycle states.
 *
 * See architect report Section 1.4 for the full transition table.
 */
export type TerminalState =
	| "creating"
	| "process-started"
	| "integration-pending"
	| "integration-ready"
	| "fallback-ready"
	| "running"
	| "idle"
	| "failed"
	| "disposed"

/**
 * Shell-integration health, independent from transient execution state.
 *
 * See architect report Section 1.5 for the health set and reuse policy.
 */
export type TerminalHealth = "unknown" | "healthy" | "suspect" | "broken" | "unsupported"

/**
 * Maximum number of pre-submission recovery attempts per execution.
 */
export const MAX_RECOVERY_ATTEMPTS = 1

// ─────────────────────────────────────────────────────────────────────────────
// Transition table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legal forward transitions from each state.
 *
 * `failed → disposed` and `failed → integration-pending` (one recovery) are
 * the only outgoing edges from `failed`.
 *
 * `disposed` is terminal — no outgoing edges.
 */
const TRANSITION_TABLE: Readonly<Record<TerminalState, readonly TerminalState[]>> = {
	creating: ["process-started", "integration-pending", "integration-ready", "fallback-ready", "failed", "disposed"],
	"process-started": ["integration-pending", "failed", "disposed"],
	"integration-pending": ["integration-ready", "failed", "disposed"],
	"integration-ready": ["running", "failed", "disposed"],
	"fallback-ready": ["running", "failed", "disposed"],
	running: ["idle", "failed", "disposed"],
	idle: ["process-started", "integration-ready", "fallback-ready", "failed", "disposed"],
	failed: ["integration-pending", "disposed"],
	disposed: [],
}

/**
 * Returns true if transitioning from `from` to `to` is legal per the table.
 */
export function isValidTransition(from: TerminalState, to: TerminalState): boolean {
	const allowed = TRANSITION_TABLE[from]
	return allowed !== undefined && allowed.includes(to)
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle snapshot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Immutable snapshot of the lifecycle at a point in time.
 * Used for atomic compare-and-set checks.
 */
export interface TerminalLifecycleSnapshot {
	readonly state: TerminalState
	readonly ownerExecutionId: string | undefined
	readonly stateChangedAt: number
	readonly commandSubmittedAt: number | undefined
	readonly recoveryAttempts: number
	readonly lastErrorCode: TerminalErrorCode | undefined
	readonly health: TerminalHealth
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a state transition violates the transition table.
 */
export class IllegalTransitionError extends Error {
	constructor(
		public readonly from: TerminalState,
		public readonly to: TerminalState,
	) {
		super(`Illegal terminal state transition: ${from} → ${to}`)
		this.name = "IllegalTransitionError"
	}
}

/**
 * Thrown when an ownership compare-and-set fails.
 */
export class OwnershipError extends Error {
	constructor(
		message: string,
		public readonly expectedOwner: string | undefined,
		public readonly actualOwner: string | undefined,
	) {
		super(message)
		this.name = "OwnershipError"
	}
}

/**
 * Thrown when a recovery attempt exceeds the maximum.
 */
export class RecoveryLimitExceededError extends Error {
	constructor(public readonly attempts: number) {
		super(`Recovery attempts exceeded maximum (${MAX_RECOVERY_ATTEMPTS})`)
		this.name = "RecoveryLimitExceededError"
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// TerminalLifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure terminal lifecycle state machine with compare-and-set ownership.
 *
 * This class is not thread-safe by itself — callers must hold the scheduler
 * lease or creation permit before mutating. The CAS checks prevent logical
 * races where a stale caller tries to transition a terminal it no longer owns.
 */
export class TerminalLifecycle {
	// ── Ownership fields (Section 1.4) ──────────────────────────────────
	private _state: TerminalState
	private _ownerExecutionId: string | undefined
	private _stateChangedAt: number
	private _commandSubmittedAt: number | undefined
	private _recoveryAttempts: number = 0
	private _lastErrorCode: TerminalErrorCode | undefined
	private _health: TerminalHealth

	/**
	 * @param provider The terminal provider, used for provider-specific reuse logic.
	 * @param now Injected clock function for deterministic testing. Defaults to `Date.now`.
	 */
	constructor(
		public readonly provider: "vscode" | "execa",
		now: () => number = Date.now,
	) {
		// New terminals start in `creating` so the registry can treat them as
		// busy until they progress through the shell-integration handshake and
		// reach `running`. This matches the architect report's VS Code path:
		// creating → process-started → integration-pending → integration-ready
		// → running → idle.
		this._state = "creating"
		this._ownerExecutionId = undefined
		this._stateChangedAt = now()
		this._commandSubmittedAt = undefined
		this._recoveryAttempts = 0
		this._lastErrorCode = undefined
		this._health = "unknown"
		this._now = now
	}

	private readonly _now: () => number

	// ── Read-only accessors ─────────────────────────────────────────────

	/** Current lifecycle state. */
	get state(): TerminalState {
		return this._state
	}

	/** Current owner execution ID, or undefined if unowned. */
	get ownerExecutionId(): string | undefined {
		return this._ownerExecutionId
	}

	/** Timestamp (ms) of the last state change. */
	get stateChangedAt(): number {
		return this._stateChangedAt
	}

	/** Timestamp (ms) when the command was submitted, or undefined. */
	get commandSubmittedAt(): number | undefined {
		return this._commandSubmittedAt
	}

	/** Number of recovery attempts used (max {@link MAX_RECOVERY_ATTEMPTS}). */
	get recoveryAttempts(): number {
		return this._recoveryAttempts
	}

	/** Last error code recorded on this terminal, or undefined. */
	get lastErrorCode(): TerminalErrorCode | undefined {
		return this._lastErrorCode
	}

	/** Current shell-integration health. */
	get health(): TerminalHealth {
		return this._health
	}

	/** True if the command has been submitted (commandSubmittedAt is set). */
	get commandSubmitted(): boolean {
		return this._commandSubmittedAt !== undefined
	}

	/**
	 * Derived busy flag: the terminal is busy when it is not idle and not
	 * disposed. This replaces the old mutable `busy` boolean.
	 */
	get busy(): boolean {
		return this._state !== "idle" && this._state !== "disposed"
	}

	/**
	 * Derived running flag: true only when state is exactly "running".
	 */
	get running(): boolean {
		return this._state === "running"
	}

	/**
	 * Returns an immutable snapshot for atomic compare-and-set checks.
	 */
	snapshot(): TerminalLifecycleSnapshot {
		return {
			state: this._state,
			ownerExecutionId: this._ownerExecutionId,
			stateChangedAt: this._stateChangedAt,
			commandSubmittedAt: this._commandSubmittedAt,
			recoveryAttempts: this._recoveryAttempts,
			lastErrorCode: this._lastErrorCode,
			health: this._health,
		}
	}

	// ── Ownership CAS ───────────────────────────────────────────────────

	/**
	 * Atomically acquire ownership for `executionId`.
	 *
	 * @throws {OwnershipError} if the terminal is already owned by a different execution.
	 */
	acquireOwner(executionId: string): void {
		if (this._ownerExecutionId !== undefined && this._ownerExecutionId !== executionId) {
			throw new OwnershipError(
				`TerminalLifecycle/acquireOwner/001: terminal is already owned by ${this._ownerExecutionId}`,
				undefined,
				this._ownerExecutionId,
			)
		}
		this._ownerExecutionId = executionId
	}

	/**
	 * Atomically release ownership. Only the current owner may release.
	 *
	 * @throws {OwnershipError} if `executionId` is not the current owner.
	 */
	releaseOwner(executionId: string): void {
		if (this._ownerExecutionId !== executionId) {
			throw new OwnershipError(
				`TerminalLifecycle/releaseOwner/001: ${executionId} is not the current owner (${this._ownerExecutionId})`,
				executionId,
				this._ownerExecutionId,
			)
		}
		this._ownerExecutionId = undefined
	}

	// ── State transitions ──────────────────────────────────────────────

	/**
	 * Validate and apply a state transition.
	 *
	 * If `executionId` is provided, the caller must be the current owner
	 * (or the terminal must be unowned). This prevents a stale caller from
	 * transitioning a terminal it no longer owns.
	 *
	 * @throws {IllegalTransitionError} if the transition is not in the table.
	 * @throws {OwnershipError} if `executionId` does not match the current owner.
	 */
	transition(newState: TerminalState, executionId?: string): void {
		// Owner check: if an executionId is provided, it must match.
		if (
			executionId !== undefined &&
			this._ownerExecutionId !== undefined &&
			this._ownerExecutionId !== executionId
		) {
			throw new OwnershipError(
				`TerminalLifecycle/transition/001: ${executionId} cannot transition a terminal owned by ${this._ownerExecutionId}`,
				executionId,
				this._ownerExecutionId,
			)
		}

		if (!isValidTransition(this._state, newState)) {
			throw new IllegalTransitionError(this._state, newState)
		}

		this._state = newState
		this._stateChangedAt = this._now()
	}

	/**
	 * Mark the command as submitted. Sets `commandSubmittedAt` to the current time.
	 * Only the current owner may call this.
	 *
	 * @throws {OwnershipError} if `executionId` is not the current owner.
	 * @throws {Error} if the command was already submitted.
	 */
	markCommandSubmitted(executionId: string): void {
		if (this._ownerExecutionId !== executionId) {
			throw new OwnershipError(
				`TerminalLifecycle/markCommandSubmitted/001: ${executionId} is not the current owner (${this._ownerExecutionId})`,
				executionId,
				this._ownerExecutionId,
			)
		}
		if (this._commandSubmittedAt !== undefined) {
			throw new Error(
				`TerminalLifecycle/markCommandSubmitted/002: command was already submitted at ${this._commandSubmittedAt}`,
			)
		}
		this._commandSubmittedAt = this._now()
	}

	/**
	 * Record an error code on the terminal. Does not change state.
	 */
	setLastError(code: TerminalErrorCode): void {
		this._lastErrorCode = code
	}

	// ── Recovery ────────────────────────────────────────────────────────

	/**
	 * Increment the recovery attempt counter.
	 *
	 * @throws {RecoveryLimitExceededError} if already at the maximum.
	 */
	incrementRecovery(): void {
		if (this._recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
			throw new RecoveryLimitExceededError(this._recoveryAttempts)
		}
		this._recoveryAttempts++
	}

	/**
	 * Returns true if a recovery attempt is still available.
	 */
	get canRecover(): boolean {
		return this._recoveryAttempts < MAX_RECOVERY_ATTEMPTS
	}

	// ── Health management ───────────────────────────────────────────────

	/**
	 * Mark the terminal as healthy: integration exists and last execution
	 * completed without infrastructure failure.
	 */
	markHealthy(): void {
		this._health = "healthy"
	}

	/**
	 * Mark the terminal as suspect: one activation or event observation
	 * failure occurred. The same owner may perform its one recovery.
	 */
	markSuspect(): void {
		this._health = "suspect"
	}

	/**
	 * Mark the terminal as broken: recovery failed, integration disappeared,
	 * or an execution outcome is unknown. Quarantine and dispose.
	 */
	markBroken(): void {
		this._health = "broken"
	}

	/**
	 * Mark the terminal as unsupported: the provider and shell combination
	 * cannot supply integration (e.g., cmd.exe). Route directly to Execa.
	 */
	markUnsupported(): void {
		this._health = "unsupported"
	}

	// ── Reuse predicate ─────────────────────────────────────────────────

	/**
	 * Provider-specific reuse predicate.
	 *
	 * For VS Code terminals, all 8 conditions from Section 1.5 must be true.
	 * The caller supplies the external checks via the `external` parameter
	 * because they require access to VS Code API objects that this pure
	 * lifecycle class must not depend on.
	 *
	 * For Execa terminals, a simpler set is checked.
	 *
	 * @param external Provider-specific external checks that require VS Code
	 *   or process access. For VS Code: `isClosed`, `hasProcess`,
	 *   `cwdMatches`, `reuseKeyMatches`, `shellIntegrationDefined`,
	 *   `hasStaleActiveShellExecution`. For Execa: `isClosed`, `hasProcess`,
	 *   `cwdMatches`, `reuseKeyMatches`.
	 */
	canReuse(external: TerminalReuseExternalChecks): boolean {
		// Universal conditions (both providers):
		// 1. State is idle.
		if (this._state !== "idle") {
			return false
		}
		// 2. ownerExecutionId and process are absent.
		if (this._ownerExecutionId !== undefined) {
			return false
		}
		if (external.hasProcess) {
			return false
		}
		// 3. isClosed() is false.
		if (external.isClosed) {
			return false
		}

		if (this.provider === "vscode") {
			// 4. Provider and reuse key match.
			if (!external.reuseKeyMatches) {
				return false
			}
			// 5. CWD matches.
			if (!external.cwdMatches) {
				return false
			}
			// 6. Health is healthy.
			if (this._health !== "healthy") {
				return false
			}
			// 7. terminal.shellIntegration is currently defined.
			if (!external.shellIntegrationDefined) {
				return false
			}
			// 8. No stale activeShellExecution remains.
			if (external.hasStaleActiveShellExecution) {
				return false
			}
			return true
		}

		// Execa: simpler checks.
		// 4. Provider and reuse key match.
		if (!external.reuseKeyMatches) {
			return false
		}
		// 5. CWD matches.
		if (!external.cwdMatches) {
			return false
		}
		return true
	}

	// ── Reset ───────────────────────────────────────────────────────────

	/**
	 * Reset the lifecycle to a fresh idle state for reuse by a new execution.
	 * Clears ownership, command submission, and recovery count, but preserves
	 * health (which is independent from execution state).
	 *
	 * Only valid from `idle` state.
	 */
	resetForReuse(): void {
		if (this._state !== "idle") {
			throw new IllegalTransitionError(this._state, "idle")
		}
		this._ownerExecutionId = undefined
		this._commandSubmittedAt = undefined
		this._recoveryAttempts = 0
	}

	/**
	 * Force the lifecycle to `idle` from any non-disposed, non-failed state.
	 *
	 * This is the escape hatch for cleanup paths (shellExecutionComplete,
	 * completed event handler, early-completion races) that must return the
	 * terminal to a reusable state regardless of the current pre-idle state.
	 *
	 * - If already `idle`: no-op (idempotent).
	 * - If `failed` or `disposed`: no-op (terminal is in a terminal state;
	 *   `failed` terminals require explicit recovery or disposal).
	 * - Otherwise: transitions to `idle` and clears ownership, submission
	 *   timestamp, and recovery count.
	 */
	resetToIdle(): void {
		if (this._state === "disposed" || this._state === "failed" || this._state === "idle") {
			return
		}
		this._state = "idle"
		this._stateChangedAt = this._now()
		this._ownerExecutionId = undefined
		this._commandSubmittedAt = undefined
		this._recoveryAttempts = 0
	}

	/**
	 * Full reset for testing. Restores the lifecycle to its initial `creating`
	 * state with `unknown` health and no ownership.
	 */
	_resetForTest(): void {
		this._state = "creating"
		this._ownerExecutionId = undefined
		this._stateChangedAt = this._now()
		this._commandSubmittedAt = undefined
		this._recoveryAttempts = 0
		this._lastErrorCode = undefined
		this._health = "unknown"
	}

	/**
	 * Force the lifecycle to a specific state, bypassing the transition table.
	 *
	 * This is the escape hatch for cleanup and race-recovery paths that must
	 * set the state directly when the normal transition sequence was disrupted
	 * (e.g., setActiveStream called after an early-completion race left the
	 * terminal in an unexpected state). Only use this when there is positive
	 * evidence for the target state.
	 *
	 * @param state The target state.
	 * @param owner Optional owner execution ID to set.
	 */
	forceState(state: TerminalState, owner?: string): void {
		this._state = state
		this._stateChangedAt = this._now()
		if (owner !== undefined) {
			this._ownerExecutionId = owner
		}
	}

	/**
	 * Test-only helper to force the lifecycle into a specific state without
	 * going through the transition table. Delegates to {@link forceState}.
	 *
	 * @param state The target state.
	 * @param owner Optional owner execution ID to set.
	 */
	_setStateForTest(state: TerminalState, owner?: string): void {
		this.forceState(state, owner)
	}

	/**
	 * Test-only helper to set the last state-change timestamp without going
	 * through the transition table. Used by watchdog tests to simulate stale
	 * terminals without exposing the field as mutable in production code.
	 *
	 * @param timestamp The timestamp to record (ms since epoch).
	 */
	_setStateChangedAtForTest(timestamp: number): void {
		this._stateChangedAt = timestamp
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// External reuse checks (provider-specific)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * External checks required by {@link TerminalLifecycle.canReuse} that depend
 * on VS Code API or process state outside the pure lifecycle model.
 */
export interface TerminalReuseExternalChecks {
	/** True if the terminal is closed (VS Code exitStatus defined, or Execa never closes). */
	isClosed: boolean
	/** True if a RooTerminalProcess is currently attached. */
	hasProcess: boolean
	/** True if the reuse key matches the requesting execution's expected key. */
	reuseKeyMatches: boolean
	/** True if the current working directory matches the requesting execution's CWD. */
	cwdMatches: boolean
	/** True if `terminal.shellIntegration` is currently defined (VS Code only). */
	shellIntegrationDefined?: boolean
	/** True if a stale `activeShellExecution` remains (VS Code only). */
	hasStaleActiveShellExecution?: boolean
}
