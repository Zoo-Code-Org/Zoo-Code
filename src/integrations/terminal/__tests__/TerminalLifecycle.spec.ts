// npx vitest run src/integrations/terminal/__tests__/TerminalLifecycle.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"

import {
	TerminalLifecycle,
	isValidTransition,
	MAX_RECOVERY_ATTEMPTS,
	IllegalTransitionError,
	OwnershipError,
	RecoveryLimitExceededError,
} from "../TerminalLifecycle"
import type { TerminalReuseExternalChecks } from "../TerminalLifecycle"
import { TerminalExecutionError, ShellIntegrationError, ShellIntegrationErrorDetails } from "../types"
import type {
	TerminalErrorCode,
	TerminalErrorPhase,
	TerminalErrorOutcome,
	TerminalErrorRetryDisposition,
} from "../types"

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic clock for testing. Returns incrementing timestamps. */
function makeFakeClock(start: number = 1_000): { now: () => number; advance: (ms: number) => void } {
	let current = start
	return {
		now: () => current,
		advance: (ms: number) => {
			current += ms
		},
	}
}

/** All-true external checks for a VS Code terminal. */
const vscodeReuseChecksAllTrue: TerminalReuseExternalChecks = {
	isClosed: false,
	hasProcess: false,
	reuseKeyMatches: true,
	cwdMatches: true,
	shellIntegrationDefined: true,
	hasStaleActiveShellExecution: false,
}

/** All-true external checks for an Execa terminal. */
const execaReuseChecksAllTrue: TerminalReuseExternalChecks = {
	isClosed: false,
	hasProcess: false,
	reuseKeyMatches: true,
	cwdMatches: true,
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("TerminalLifecycle", () => {
	describe("initial state", () => {
		it("starts in 'creating' state with 'unknown' health and no owner", () => {
			const lc = new TerminalLifecycle("vscode")
			expect(lc.state).toBe("creating")
			expect(lc.health).toBe("unknown")
			expect(lc.ownerExecutionId).toBeUndefined()
			expect(lc.commandSubmittedAt).toBeUndefined()
			expect(lc.recoveryAttempts).toBe(0)
			expect(lc.lastErrorCode).toBeUndefined()
		})

		it("initializes with the injected clock for stateChangedAt", () => {
			const clock = makeFakeClock(5_000)
			const lc = new TerminalLifecycle("execa", clock.now)
			expect(lc.stateChangedAt).toBe(5_000)
		})
	})

	describe("derived busy and running", () => {
		it("busy is true when state is not idle/disposed", () => {
			const lc = new TerminalLifecycle("vscode")
			// Transition to a non-idle state
			lc.acquireOwner("exec-1")
			lc.transition("process-started", "exec-1")
			expect(lc.busy).toBe(true) // process-started
		})

		it("busy is false when state is idle", () => {
			const lc = new TerminalLifecycle("vscode")
			// creating → process-started → integration-pending → integration-ready → running → idle
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			expect(lc.busy).toBe(false)
		})

		it("busy is false when state is disposed", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("disposed")
			expect(lc.busy).toBe(false)
		})

		it("running is true only when state is exactly 'running'", () => {
			const lc = new TerminalLifecycle("vscode")
			expect(lc.running).toBe(false) // creating

			lc.transition("process-started")
			expect(lc.running).toBe(false)

			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			expect(lc.running).toBe(true)

			lc.transition("idle")
			expect(lc.running).toBe(false)
		})
	})

	describe("transition table", () => {
		it("allows creating → process-started", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("process-started")
			expect(lc.state).toBe("process-started")
		})

		it("allows creating → failed", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("failed")
			expect(lc.state).toBe("failed")
		})

		it("allows creating → disposed", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("disposed")
			expect(lc.state).toBe("disposed")
		})

		it("throws IllegalTransitionError for creating → running", () => {
			const lc = new TerminalLifecycle("vscode")
			expect(() => lc.transition("running")).toThrow(IllegalTransitionError)
		})

		it("throws IllegalTransitionError for creating → idle", () => {
			const lc = new TerminalLifecycle("vscode")
			expect(() => lc.transition("idle")).toThrow(IllegalTransitionError)
		})

		it("throws IllegalTransitionError for idle → running (must go through integration-ready or fallback-ready)", () => {
			const lc = new TerminalLifecycle("vscode")
			// Get to idle first
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			expect(() => lc.transition("running")).toThrow(IllegalTransitionError)
		})

		it("allows idle → integration-ready (reused VS Code terminal)", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			lc.transition("integration-ready")
			expect(lc.state).toBe("integration-ready")
		})

		it("allows idle → fallback-ready (Execa reused)", () => {
			const lc = new TerminalLifecycle("execa")
			lc.transition("fallback-ready")
			lc.transition("running")
			lc.transition("idle")
			lc.transition("fallback-ready")
			expect(lc.state).toBe("fallback-ready")
		})

		it("allows failed → integration-pending (one recovery)", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("failed")
			lc.transition("integration-pending")
			expect(lc.state).toBe("integration-pending")
		})

		it("allows failed → disposed", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("failed")
			lc.transition("disposed")
			expect(lc.state).toBe("disposed")
		})

		it("throws IllegalTransitionError for disposed → anything", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("disposed")
			expect(() => lc.transition("idle")).toThrow(IllegalTransitionError)
			expect(() => lc.transition("failed")).toThrow(IllegalTransitionError)
			expect(() => lc.transition("creating")).toThrow(IllegalTransitionError)
		})

		it("updates stateChangedAt on each transition", () => {
			const clock = makeFakeClock(1_000)
			const lc = new TerminalLifecycle("vscode", clock.now)
			expect(lc.stateChangedAt).toBe(1_000)

			clock.advance(500)
			lc.transition("process-started")
			expect(lc.stateChangedAt).toBe(1_500)

			clock.advance(300)
			lc.transition("integration-pending")
			expect(lc.stateChangedAt).toBe(1_800)
		})
	})

	describe("isValidTransition function", () => {
		it("returns true for legal transitions", () => {
			expect(isValidTransition("creating", "process-started")).toBe(true)
			expect(isValidTransition("integration-pending", "integration-ready")).toBe(true)
			expect(isValidTransition("running", "idle")).toBe(true)
			expect(isValidTransition("failed", "disposed")).toBe(true)
		})

		it("returns false for illegal transitions", () => {
			expect(isValidTransition("creating", "running")).toBe(false)
			expect(isValidTransition("idle", "running")).toBe(false)
			expect(isValidTransition("disposed", "idle")).toBe(false)
		})
	})

	describe("ownership CAS", () => {
		it("acquireOwner sets ownerExecutionId", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.acquireOwner("exec-1")
			expect(lc.ownerExecutionId).toBe("exec-1")
		})

		it("acquireOwner is idempotent for the same execution", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.acquireOwner("exec-1")
			lc.acquireOwner("exec-1") // should not throw
			expect(lc.ownerExecutionId).toBe("exec-1")
		})

		it("acquireOwner throws OwnershipError when already owned by different execution", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.acquireOwner("exec-1")
			expect(() => lc.acquireOwner("exec-2")).toThrow(OwnershipError)
		})

		it("releaseOwner clears ownerExecutionId", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.acquireOwner("exec-1")
			lc.releaseOwner("exec-1")
			expect(lc.ownerExecutionId).toBeUndefined()
		})

		it("releaseOwner throws OwnershipError for wrong owner", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.acquireOwner("exec-1")
			expect(() => lc.releaseOwner("exec-2")).toThrow(OwnershipError)
		})

		it("releaseOwner throws OwnershipError when unowned", () => {
			const lc = new TerminalLifecycle("vscode")
			expect(() => lc.releaseOwner("exec-1")).toThrow(OwnershipError)
		})
	})

	describe("transition with ownership check", () => {
		it("allows transition when executionId matches owner", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.acquireOwner("exec-1")
			lc.transition("process-started", "exec-1")
			expect(lc.state).toBe("process-started")
		})

		it("allows transition when executionId is provided but terminal is unowned", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("process-started", "exec-1")
			expect(lc.state).toBe("process-started")
		})

		it("throws OwnershipError when executionId does not match owner", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.acquireOwner("exec-1")
			expect(() => lc.transition("process-started", "exec-2")).toThrow(OwnershipError)
			// State should not have changed
			expect(lc.state).toBe("creating")
		})

		it("allows transition without executionId (no owner check)", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.acquireOwner("exec-1")
			lc.transition("process-started")
			expect(lc.state).toBe("process-started")
		})
	})

	describe("markCommandSubmitted", () => {
		it("sets commandSubmittedAt to current time", () => {
			const clock = makeFakeClock(2_000)
			const lc = new TerminalLifecycle("vscode", clock.now)
			lc.acquireOwner("exec-1")
			clock.advance(500)
			lc.markCommandSubmitted("exec-1")
			expect(lc.commandSubmittedAt).toBe(2_500)
			expect(lc.commandSubmitted).toBe(true)
		})

		it("throws OwnershipError when caller is not the owner", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.acquireOwner("exec-1")
			expect(() => lc.markCommandSubmitted("exec-2")).toThrow(OwnershipError)
		})

		it("throws when command was already submitted", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.acquireOwner("exec-1")
			lc.markCommandSubmitted("exec-1")
			expect(() => lc.markCommandSubmitted("exec-1")).toThrow()
		})
	})

	describe("recovery", () => {
		it("canRecover is true initially", () => {
			const lc = new TerminalLifecycle("vscode")
			expect(lc.canRecover).toBe(true)
		})

		it("incrementRecovery increases recoveryAttempts", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.incrementRecovery()
			expect(lc.recoveryAttempts).toBe(1)
		})

		it("canRecover is false after max attempts", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.incrementRecovery()
			expect(lc.canRecover).toBe(false)
		})

		it("throws RecoveryLimitExceededError when exceeding max", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.incrementRecovery()
			expect(() => lc.incrementRecovery()).toThrow(RecoveryLimitExceededError)
		})

		it("MAX_RECOVERY_ATTEMPTS is 1", () => {
			expect(MAX_RECOVERY_ATTEMPTS).toBe(1)
		})
	})

	describe("health management", () => {
		it("markHealthy sets health to 'healthy'", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.markHealthy()
			expect(lc.health).toBe("healthy")
		})

		it("markSuspect sets health to 'suspect'", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.markSuspect()
			expect(lc.health).toBe("suspect")
		})

		it("markBroken sets health to 'broken'", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.markBroken()
			expect(lc.health).toBe("broken")
		})

		it("markUnsupported sets health to 'unsupported'", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.markUnsupported()
			expect(lc.health).toBe("unsupported")
		})
	})

	describe("setLastError", () => {
		it("records the error code without changing state", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.setLastError("SI_ACTIVATION_TIMEOUT")
			expect(lc.lastErrorCode).toBe("SI_ACTIVATION_TIMEOUT")
			expect(lc.state).toBe("creating") // unchanged
		})
	})

	describe("snapshot", () => {
		it("returns an immutable snapshot of all fields", () => {
			const clock = makeFakeClock(1_000)
			const lc = new TerminalLifecycle("vscode", clock.now)
			lc.acquireOwner("exec-1")
			clock.advance(500)
			lc.transition("process-started", "exec-1")
			lc.markHealthy()
			lc.setLastError("EXEC_START_TIMEOUT")

			const snap = lc.snapshot()
			expect(snap.state).toBe("process-started")
			expect(snap.ownerExecutionId).toBe("exec-1")
			expect(snap.stateChangedAt).toBe(1_500)
			expect(snap.commandSubmittedAt).toBeUndefined()
			expect(snap.recoveryAttempts).toBe(0)
			expect(snap.lastErrorCode).toBe("EXEC_START_TIMEOUT")
			expect(snap.health).toBe("healthy")
		})
	})

	describe("resetForReuse", () => {
		it("clears ownership, command submission, and recovery count", () => {
			const lc = new TerminalLifecycle("vscode")
			// Get to idle
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			lc.acquireOwner("exec-1")
			lc.markCommandSubmitted("exec-1")
			lc.incrementRecovery()

			lc.resetForReuse()

			expect(lc.ownerExecutionId).toBeUndefined()
			expect(lc.commandSubmittedAt).toBeUndefined()
			expect(lc.recoveryAttempts).toBe(0)
		})

		it("preserves health across reset", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			lc.markHealthy()

			lc.resetForReuse()

			expect(lc.health).toBe("healthy")
		})

		it("throws IllegalTransitionError when not in idle state", () => {
			const lc = new TerminalLifecycle("vscode")
			// Transition to a non-idle state first
			lc.acquireOwner("exec-1")
			lc.transition("process-started", "exec-1")
			expect(() => lc.resetForReuse()).toThrow(IllegalTransitionError)
		})
	})

	describe("canReuse — VS Code provider", () => {
		it("returns true when all 8 conditions are met", () => {
			const lc = new TerminalLifecycle("vscode")
			// Get to idle
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			lc.markHealthy()

			expect(lc.canReuse(vscodeReuseChecksAllTrue)).toBe(true)
		})

		it("returns false when state is not idle", () => {
			const lc = new TerminalLifecycle("vscode")
			// Transition to a non-idle state
			lc.acquireOwner("exec-1")
			lc.transition("process-started", "exec-1")
			lc.markHealthy()
			expect(lc.canReuse(vscodeReuseChecksAllTrue)).toBe(false)
		})

		it("returns false when ownerExecutionId is set", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			lc.markHealthy()
			lc.acquireOwner("exec-1")
			expect(lc.canReuse(vscodeReuseChecksAllTrue)).toBe(false)
		})

		it("returns false when process is present", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			lc.markHealthy()
			expect(lc.canReuse({ ...vscodeReuseChecksAllTrue, hasProcess: true })).toBe(false)
		})

		it("returns false when terminal is closed", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			lc.markHealthy()
			expect(lc.canReuse({ ...vscodeReuseChecksAllTrue, isClosed: true })).toBe(false)
		})

		it("returns false when reuse key does not match", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			lc.markHealthy()
			expect(lc.canReuse({ ...vscodeReuseChecksAllTrue, reuseKeyMatches: false })).toBe(false)
		})

		it("returns false when CWD does not match", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			lc.markHealthy()
			expect(lc.canReuse({ ...vscodeReuseChecksAllTrue, cwdMatches: false })).toBe(false)
		})

		it("returns false when health is not 'healthy'", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			// health is 'unknown' by default
			expect(lc.canReuse(vscodeReuseChecksAllTrue)).toBe(false)

			lc.markSuspect()
			expect(lc.canReuse(vscodeReuseChecksAllTrue)).toBe(false)

			lc.markBroken()
			expect(lc.canReuse(vscodeReuseChecksAllTrue)).toBe(false)

			lc.markUnsupported()
			expect(lc.canReuse(vscodeReuseChecksAllTrue)).toBe(false)
		})

		it("returns false when shellIntegration is not defined", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			lc.markHealthy()
			expect(lc.canReuse({ ...vscodeReuseChecksAllTrue, shellIntegrationDefined: false })).toBe(false)
		})

		it("returns false when stale activeShellExecution remains", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			lc.markHealthy()
			expect(lc.canReuse({ ...vscodeReuseChecksAllTrue, hasStaleActiveShellExecution: true })).toBe(false)
		})
	})

	describe("canReuse — Execa provider", () => {
		it("returns true when idle, no owner, no process, not closed, key and CWD match", () => {
			const lc = new TerminalLifecycle("execa")
			// Execa path: creating → fallback-ready → running → idle
			lc.transition("fallback-ready")
			lc.transition("running")
			lc.transition("idle")

			expect(lc.canReuse(execaReuseChecksAllTrue)).toBe(true)
		})

		it("returns true even with 'unknown' health (Execa does not require 'healthy')", () => {
			const lc = new TerminalLifecycle("execa")
			lc.transition("fallback-ready")
			lc.transition("running")
			lc.transition("idle")
			// health is 'unknown'
			expect(lc.canReuse(execaReuseChecksAllTrue)).toBe(true)
		})

		it("returns false when state is not idle", () => {
			const lc = new TerminalLifecycle("execa")
			// state is 'creating' — canReuse should reject non-idle states
			expect(lc.canReuse(execaReuseChecksAllTrue)).toBe(false)
		})

		it("returns false when process is present", () => {
			const lc = new TerminalLifecycle("execa")
			lc.transition("fallback-ready")
			lc.transition("running")
			lc.transition("idle")
			expect(lc.canReuse({ ...execaReuseChecksAllTrue, hasProcess: true })).toBe(false)
		})

		it("returns false when closed", () => {
			const lc = new TerminalLifecycle("execa")
			lc.transition("fallback-ready")
			lc.transition("running")
			lc.transition("idle")
			expect(lc.canReuse({ ...execaReuseChecksAllTrue, isClosed: true })).toBe(false)
		})

		it("returns false when reuse key does not match", () => {
			const lc = new TerminalLifecycle("execa")
			lc.transition("fallback-ready")
			lc.transition("running")
			lc.transition("idle")
			expect(lc.canReuse({ ...execaReuseChecksAllTrue, reuseKeyMatches: false })).toBe(false)
		})

		it("returns false when CWD does not match", () => {
			const lc = new TerminalLifecycle("execa")
			lc.transition("fallback-ready")
			lc.transition("running")
			lc.transition("idle")
			expect(lc.canReuse({ ...execaReuseChecksAllTrue, cwdMatches: false })).toBe(false)
		})
	})

	describe("full VS Code lifecycle paths", () => {
		it("new terminal: creating → process-started → integration-pending → integration-ready → running → idle", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.acquireOwner("exec-1")
			lc.transition("process-started", "exec-1")
			lc.transition("integration-pending", "exec-1")
			lc.transition("integration-ready", "exec-1")
			lc.markCommandSubmitted("exec-1")
			lc.transition("running", "exec-1")
			lc.transition("idle", "exec-1")
			lc.releaseOwner("exec-1")
			lc.markHealthy()

			expect(lc.state).toBe("idle")
			expect(lc.health).toBe("healthy")
			expect(lc.ownerExecutionId).toBeUndefined()
			expect(lc.commandSubmitted).toBe(true)
		})

		it("reused terminal: idle → integration-ready → running → idle", () => {
			const lc = new TerminalLifecycle("vscode")
			// Get to idle first
			lc.transition("process-started")
			lc.transition("integration-pending")
			lc.transition("integration-ready")
			lc.transition("running")
			lc.transition("idle")
			lc.markHealthy()

			// Reuse
			lc.acquireOwner("exec-2")
			lc.transition("integration-ready", "exec-2")
			lc.markCommandSubmitted("exec-2")
			lc.transition("running", "exec-2")
			lc.transition("idle", "exec-2")
			lc.releaseOwner("exec-2")

			expect(lc.state).toBe("idle")
		})

		it("recovery: integration-pending → failed → integration-pending → integration-ready", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.acquireOwner("exec-1")
			lc.transition("process-started", "exec-1")
			lc.transition("integration-pending", "exec-1")
			lc.transition("failed", "exec-1")
			lc.incrementRecovery()
			lc.transition("integration-pending", "exec-1")
			lc.transition("integration-ready", "exec-1")

			expect(lc.state).toBe("integration-ready")
			expect(lc.recoveryAttempts).toBe(1)
		})

		it("recovery failure: integration-pending → failed → disposed", () => {
			const lc = new TerminalLifecycle("vscode")
			lc.acquireOwner("exec-1")
			lc.transition("process-started", "exec-1")
			lc.transition("integration-pending", "exec-1")
			lc.transition("failed", "exec-1")
			lc.incrementRecovery()
			lc.transition("disposed", "exec-1")

			expect(lc.state).toBe("disposed")
		})

		it("Execa path: creating → fallback-ready → running → idle", () => {
			const lc = new TerminalLifecycle("execa")
			lc.acquireOwner("exec-1")
			lc.transition("fallback-ready", "exec-1")
			lc.markCommandSubmitted("exec-1")
			lc.transition("running", "exec-1")
			lc.transition("idle", "exec-1")
			lc.releaseOwner("exec-1")

			expect(lc.state).toBe("idle")
		})
	})

	describe("error classes", () => {
		it("IllegalTransitionError contains from and to states", () => {
			try {
				throw new IllegalTransitionError("idle", "creating")
			} catch (e) {
				expect(e).toBeInstanceOf(IllegalTransitionError)
				expect((e as IllegalTransitionError).from).toBe("idle")
				expect((e as IllegalTransitionError).to).toBe("creating")
			}
		})

		it("OwnershipError contains expected and actual owner", () => {
			try {
				throw new OwnershipError("test", "exec-1", "exec-2")
			} catch (e) {
				expect(e).toBeInstanceOf(OwnershipError)
				expect((e as OwnershipError).expectedOwner).toBe("exec-1")
				expect((e as OwnershipError).actualOwner).toBe("exec-2")
			}
		})

		it("RecoveryLimitExceededError contains attempts", () => {
			try {
				throw new RecoveryLimitExceededError(1)
			} catch (e) {
				expect(e).toBeInstanceOf(RecoveryLimitExceededError)
				expect((e as RecoveryLimitExceededError).attempts).toBe(1)
			}
		})
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// Typed error contract tests
// ─────────────────────────────────────────────────────────────────────────────

describe("TerminalExecutionError", () => {
	it("constructs with all required fields", () => {
		const err = new TerminalExecutionError({
			code: "SI_ACTIVATION_TIMEOUT",
			message: "Shell integration did not activate within timeout",
			phase: "prepare",
			provider: "vscode",
			terminalId: "term-1",
			commandSubmitted: false,
			outcome: "not-started",
			retryDisposition: "same-terminal-once",
		})

		expect(err.code).toBe("SI_ACTIVATION_TIMEOUT")
		expect(err.phase).toBe("prepare")
		expect(err.provider).toBe("vscode")
		expect(err.terminalId).toBe("term-1")
		expect(err.commandSubmitted).toBe(false)
		expect(err.outcome).toBe("not-started")
		expect(err.retryDisposition).toBe("same-terminal-once")
		expect(err.causeName).toBeUndefined()
		expect(err.name).toBe("TerminalExecutionError")
		expect(err.message).toBe("Shell integration did not activate within timeout")
	})

	it("constructs with optional causeName", () => {
		const err = new TerminalExecutionError({
			code: "EXEC_START_TIMEOUT",
			message: "Start event did not arrive",
			phase: "start",
			provider: "vscode",
			commandSubmitted: true,
			outcome: "unknown",
			retryDisposition: "never",
			causeName: "TimeoutError",
		})

		expect(err.causeName).toBe("TimeoutError")
	})

	it("is an instance of Error", () => {
		const err = new TerminalExecutionError({
			code: "COMMAND_FAILED",
			message: "Command exited with code 1",
			phase: "end",
			provider: "execa",
			commandSubmitted: true,
			outcome: "completed",
			retryDisposition: "never",
		})

		expect(err).toBeInstanceOf(Error)
	})

	it("does not contain command text, CWD, output, env vars, or shell args", () => {
		const err = new TerminalExecutionError({
			code: "SI_NEVER_AVAILABLE",
			message: "Shell integration was not available at submission gate",
			phase: "submit",
			provider: "vscode",
			commandSubmitted: false,
			outcome: "not-started",
			retryDisposition: "fallback-safe",
		})

		// Verify no sensitive fields exist on the error object
		const keys = Object.keys(err)
		expect(keys).not.toContain("command")
		expect(keys).not.toContain("cwd")
		expect(keys).not.toContain("output")
		expect(keys).not.toContain("env")
		expect(keys).not.toContain("shellArgs")
		expect(keys).not.toContain("args")
	})
})

describe("ShellIntegrationError", () => {
	it("extends TerminalExecutionError", () => {
		const err = new ShellIntegrationError("test message", false)
		expect(err).toBeInstanceOf(TerminalExecutionError)
		expect(err).toBeInstanceOf(Error)
	})

	it("preserves backward-compatible two-argument constructor", () => {
		const err = new ShellIntegrationError("test message", false)
		expect(err.message).toBe("test message")
		expect(err.commandSubmitted).toBe(false)
	})

	it("defaults code to SI_ACTIVATION_TIMEOUT when not specified", () => {
		const err = new ShellIntegrationError("test", false)
		expect(err.code).toBe("SI_ACTIVATION_TIMEOUT")
	})

	it("defaults phase to 'prepare' when not specified", () => {
		const err = new ShellIntegrationError("test", false)
		expect(err.phase).toBe("prepare")
	})

	it("defaults provider to 'vscode' when not specified", () => {
		const err = new ShellIntegrationError("test", false)
		expect(err.provider).toBe("vscode")
	})

	it("defaults outcome to 'not-started' when commandSubmitted is false", () => {
		const err = new ShellIntegrationError("test", false)
		expect(err.outcome).toBe("not-started")
	})

	it("defaults outcome to 'unknown' when commandSubmitted is true", () => {
		const err = new ShellIntegrationError("test", true)
		expect(err.outcome).toBe("unknown")
	})

	it("defaults retryDisposition to 'same-terminal-once' when commandSubmitted is false", () => {
		const err = new ShellIntegrationError("test", false)
		expect(err.retryDisposition).toBe("same-terminal-once")
	})

	it("defaults retryDisposition to 'never' when commandSubmitted is true", () => {
		const err = new ShellIntegrationError("test", true)
		expect(err.retryDisposition).toBe("never")
	})

	it("accepts explicit code and extra fields", () => {
		const err = new ShellIntegrationError("test", true, "EXEC_START_TIMEOUT", {
			phase: "start",
			provider: "vscode",
			terminalId: "term-5",
			outcome: "unknown",
			retryDisposition: "never",
			causeName: "TimeoutError",
		})

		expect(err.code).toBe("EXEC_START_TIMEOUT")
		expect(err.phase).toBe("start")
		expect(err.terminalId).toBe("term-5")
		expect(err.causeName).toBe("TimeoutError")
	})

	it("name is 'ShellIntegrationError'", () => {
		const err = new ShellIntegrationError("test", false)
		expect(err.name).toBe("ShellIntegrationError")
	})

	describe("fromDetails factory", () => {
		it("creates error from ShellIntegrationErrorDetails with code", () => {
			const details: ShellIntegrationErrorDetails = {
				message: "Integration timed out",
				commandSubmitted: false,
				code: "SI_ACTIVATION_TIMEOUT",
				phase: "prepare",
				provider: "vscode",
				outcome: "not-started",
				retryDisposition: "same-terminal-once",
			}

			const err = ShellIntegrationError.fromDetails(details)

			expect(err.message).toBe("Integration timed out")
			expect(err.commandSubmitted).toBe(false)
			expect(err.code).toBe("SI_ACTIVATION_TIMEOUT")
			expect(err.phase).toBe("prepare")
			expect(err.provider).toBe("vscode")
			expect(err.outcome).toBe("not-started")
			expect(err.retryDisposition).toBe("same-terminal-once")
		})

		it("fills safe defaults for optional fields not provided", () => {
			const details: ShellIntegrationErrorDetails = {
				message: "Integration missing",
				commandSubmitted: false,
				code: "SI_NEVER_AVAILABLE",
			}

			const err = ShellIntegrationError.fromDetails(details)

			expect(err.code).toBe("SI_NEVER_AVAILABLE")
			expect(err.phase).toBe("prepare") // default
			expect(err.provider).toBe("vscode") // default
			expect(err.outcome).toBe("not-started") // default for commandSubmitted=false
			expect(err.retryDisposition).toBe("same-terminal-once") // default for commandSubmitted=false
		})

		it("accepts optional causeName", () => {
			const details: ShellIntegrationErrorDetails = {
				message: "test",
				commandSubmitted: false,
				code: "SI_ACTIVATION_TIMEOUT",
			}

			const err = ShellIntegrationError.fromDetails(details, { causeName: "AbortError" })
			expect(err.causeName).toBe("AbortError")
		})
	})
})

describe("TerminalErrorCode type coverage", () => {
	it("includes all codes from the architect report", () => {
		const codes: TerminalErrorCode[] = [
			"SI_ACTIVATION_TIMEOUT",
			"SI_NEVER_AVAILABLE",
			"EXEC_START_TIMEOUT",
			"EXEC_END_TIMEOUT",
			"OUTPUT_MISSING",
			"PROVIDER_SWITCH",
			"TERMINAL_BUSY_STALE",
			"TERMINAL_DISPOSED",
			"PROCESS_EXITED_EARLY",
			"COMMAND_FAILED",
		]

		for (const code of codes) {
			const err = new TerminalExecutionError({
				code,
				message: `test ${code}`,
				phase: "prepare",
				provider: "vscode",
				commandSubmitted: false,
				outcome: "not-started",
				retryDisposition: "never",
			})
			expect(err.code).toBe(code)
		}
	})
})

describe("TerminalErrorPhase type coverage", () => {
	it("includes all phases from the architect report", () => {
		const phases: TerminalErrorPhase[] = [
			"prepare",
			"submit",
			"start",
			"stream",
			"end",
			"cleanup",
			"provider-switch",
		]

		for (const phase of phases) {
			const err = new TerminalExecutionError({
				code: "COMMAND_FAILED",
				message: `test ${phase}`,
				phase,
				provider: "vscode",
				commandSubmitted: false,
				outcome: "not-started",
				retryDisposition: "never",
			})
			expect(err.phase).toBe(phase)
		}
	})
})

describe("TerminalErrorOutcome type coverage", () => {
	it("includes all outcomes from the architect report", () => {
		const outcomes: TerminalErrorOutcome[] = ["not-started", "running", "completed", "unknown"]

		for (const outcome of outcomes) {
			const err = new TerminalExecutionError({
				code: "COMMAND_FAILED",
				message: `test ${outcome}`,
				phase: "end",
				provider: "vscode",
				commandSubmitted: true,
				outcome,
				retryDisposition: "never",
			})
			expect(err.outcome).toBe(outcome)
		}
	})
})

describe("TerminalErrorRetryDisposition type coverage", () => {
	it("includes all dispositions from the architect report", () => {
		const dispositions: TerminalErrorRetryDisposition[] = ["same-terminal-once", "fallback-safe", "never"]

		for (const retryDisposition of dispositions) {
			const err = new TerminalExecutionError({
				code: "SI_ACTIVATION_TIMEOUT",
				message: `test ${retryDisposition}`,
				phase: "prepare",
				provider: "vscode",
				commandSubmitted: false,
				outcome: "not-started",
				retryDisposition,
			})
			expect(err.retryDisposition).toBe(retryDisposition)
		}
	})
})
