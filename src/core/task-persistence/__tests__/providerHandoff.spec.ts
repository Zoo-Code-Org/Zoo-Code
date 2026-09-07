import { describe, expect, it } from "vitest"

import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import {
	applyProviderHandoffEvent,
	createPreparedProviderHandoffContext,
	createProviderHandoffPlan,
	createProviderHandoffTransaction,
	classifyProviderHandoffProjectionResults,
	decideProviderHandoffProfile,
	getProviderHandoffActivationOptions,
	initialProviderHandoffState,
	PRODUCTION_PROVIDER_HANDOFF_POLICY,
	publishProviderHandoffState,
	deriveProviderHandoffProfileIntent,
	redactProviderHandoffSecrets,
	shouldPublishProviderHandoffState,
	type ProviderHandoffEvent,
	type ProviderHandoffPolicy,
	type ProviderHandoffRejection,
	type ProviderHandoffState,
} from "../providerHandoff"

describe("provider handoff contract", () => {
	it("creates a no-target, non-publishing production plan", () => {
		expect(createProviderHandoffPlan("child-mode")).toEqual({
			requestedMode: "child-mode",
			policy: {
				targetTask: null,
				mutateExposedTask: false,
				publishWhilePending: false,
				applyProviderSettingsToContext: true,
			},
		})
	})

	it("derives an explicit projection intent: named profiles set, locked profiles preserve, unnamed clear", () => {
		expect(deriveProviderHandoffProfileIntent({ source: "saved", name: "saved-profile" })).toEqual({
			kind: "set",
			name: "saved-profile",
		})
		expect(deriveProviderHandoffProfileIntent({ source: "unsaved-current", name: "current" })).toEqual({
			kind: "set",
			name: "current",
		})
		// Locked handoffs must never rewrite the pinned identity.
		expect(deriveProviderHandoffProfileIntent({ source: "locked-current", name: "pinned" })).toEqual({
			kind: "preserve",
		})
		// No profile at all is an explicit clear, not a skipped write.
		expect(deriveProviderHandoffProfileIntent({ source: "unsaved-current", name: undefined })).toEqual({
			kind: "clear",
		})
		expect(deriveProviderHandoffProfileIntent({ source: "locked-current", name: undefined })).toEqual({
			kind: "clear",
		})
	})

	it("carries the derived intent on the prepared context", () => {
		const prepared = createPreparedProviderHandoffContext({
			requestedMode: "code",
			profile: { source: "locked-current", name: "pinned", id: "pinned-id" },
			apiConfiguration: { apiProvider: providerIdentifiers.openai },
		})
		expect(prepared.profile.intent).toEqual({ kind: "preserve" })
	})

	it("selects the current profile while workspace profile locking is enabled", () => {
		expect(
			decideProviderHandoffProfile({
				locked: true,
				currentProfile: { name: "current", id: "current-id" },
				savedProfile: { name: "saved", id: "saved-id" },
			}),
		).toEqual({ source: "locked-current", profile: { name: "current", id: "current-id" } })
		expect(decideProviderHandoffProfile({ locked: true })).toEqual({
			source: "locked-current",
			profile: undefined,
		})
	})

	it("selects a saved mode profile when profile locking is disabled", () => {
		expect(
			decideProviderHandoffProfile({
				locked: false,
				currentProfile: { name: "current", id: "current-id" },
				savedProfile: { name: "saved", id: "saved-id" },
			}),
		).toEqual({ source: "saved", profile: { name: "saved", id: "saved-id" } })
	})

	it("inherits and persists the current profile for an unsaved mode", () => {
		expect(
			decideProviderHandoffProfile({
				locked: false,
				currentProfile: { name: "current", id: "current-id" },
			}),
		).toEqual({
			source: "unsaved-current",
			profile: { name: "current", id: "current-id" },
			persistModeProfileId: "current-id",
		})
		expect(decideProviderHandoffProfile({ locked: false })).toEqual({
			source: "unsaved-current",
			profile: undefined,
			persistModeProfileId: undefined,
		})
	})

	it("projects production and injected policies into activation options", () => {
		expect(getProviderHandoffActivationOptions(PRODUCTION_PROVIDER_HANDOFF_POLICY)).toEqual({
			skipCurrentTaskRebuild: true,
			applyProviderSettingsToContext: true,
			suppressStatePost: true,
		})

		const unsafePolicy: ProviderHandoffPolicy = {
			targetTask: null,
			mutateExposedTask: true,
			publishWhilePending: true,
			applyProviderSettingsToContext: false,
		}
		expect(getProviderHandoffActivationOptions(unsafePolicy)).toEqual({
			skipCurrentTaskRebuild: false,
			applyProviderSettingsToContext: false,
			suppressStatePost: false,
		})
	})

	it("publishes only when a target exists and the handoff policy permits it", () => {
		expect(shouldPublishProviderHandoffState(true)).toBe(true)
		expect(shouldPublishProviderHandoffState(false)).toBe(false)
		expect(shouldPublishProviderHandoffState(true, PRODUCTION_PROVIDER_HANDOFF_POLICY)).toBe(false)
		expect(
			shouldPublishProviderHandoffState(true, {
				targetTask: null,
				mutateExposedTask: true,
				publishWhilePending: true,
				applyProviderSettingsToContext: false,
			}),
		).toBe(true)
	})

	it("invokes publication only when the production decision allows it", async () => {
		const publish = vi.fn().mockResolvedValue(undefined)
		await publishProviderHandoffState(false, undefined, publish)
		await publishProviderHandoffState(true, PRODUCTION_PROVIDER_HANDOFF_POLICY, publish)
		expect(publish).not.toHaveBeenCalled()

		await publishProviderHandoffState(true, undefined, publish)
		expect(publish).toHaveBeenCalledOnce()
	})

	it("deep-clones the api configuration so the prepared context aliases nothing", () => {
		const source = {
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
			openRouterApiKey: "sk-sentinel-123456",
			openAiHeaders: { "x-unit": "abc" },
		}
		const profile = { source: "saved" as const, name: "saved-profile", id: "saved-id" }

		const prepared = createPreparedProviderHandoffContext({
			requestedMode: "ask",
			profile,
			apiConfiguration: source,
			persistModeProfileId: "saved-id",
		})

		expect(prepared.requestedMode).toBe("ask")
		// The prepared profile carries the explicitly derived projection intent.
		expect(prepared.profile).toEqual({ ...profile, intent: { kind: "set", name: "saved-profile" } })
		expect(prepared.persistModeProfileId).toBe("saved-id")
		// Full profile data is preserved, including provider secret fields.
		expect(prepared.apiConfiguration).toEqual(source)

		// Mutating the source after preparation cannot affect the context.
		source.openRouterApiKey = "sk-rotated"
		source.openAiHeaders["x-unit"] = "mutated"
		expect(prepared.apiConfiguration.openRouterApiKey).toBe("sk-sentinel-123456")
		expect(prepared.apiConfiguration.openAiHeaders?.["x-unit"]).toBe("abc")

		// The context shell is frozen: in-place mutation is a no-op in tests.
		expect(Object.isFrozen(prepared)).toBe(true)
		expect(Object.isFrozen(prepared.profile)).toBe(true)
		expect(() => {
			;(prepared as { requestedMode?: string }).requestedMode = "code"
		}).toThrow()
	})

	it("classifies named projection results by store, not by result index", () => {
		// A profile-store write failure stays profile-store even when it is not
		// the last entry, and a ContextProxy failure stays context-proxy even
		// when it is.
		expect(
			classifyProviderHandoffProjectionResults([
				{ operation: "global-mode", ok: true },
				{ operation: "profile-store", ok: false, error: new Error("durable store rejected") },
				{ operation: "provider-settings", ok: true },
			]),
		).toEqual({ ok: false, boundary: "profile-store", failedOperation: "profile-store" })
		expect(
			classifyProviderHandoffProjectionResults([
				{ operation: "global-mode", ok: true },
				{ operation: "provider-settings", ok: false, error: new Error("context write failed") },
				{ operation: "profile-store", ok: true },
			]),
		).toEqual({ ok: false, boundary: "context-proxy", failedOperation: "provider-settings" })
		// The durable profile metadata read belongs to the profile store.
		expect(classifyProviderHandoffProjectionResults([{ operation: "profile-meta-read", ok: false }])).toEqual({
			ok: false,
			boundary: "profile-store",
			failedOperation: "profile-meta-read",
		})
		// A clean batch synchronizes.
		expect(
			classifyProviderHandoffProjectionResults([
				{ operation: "global-mode", ok: true },
				{ operation: "profile-meta-read", ok: true },
				{ operation: "global-config-meta", ok: true },
				{ operation: "global-profile-name", ok: true },
				{ operation: "provider-settings", ok: true },
				{ operation: "profile-store", ok: true },
			]),
		).toEqual({ ok: true })
	})

	it("redacts provider secret values from error messages without touching other text", () => {
		const apiConfiguration = {
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
			openRouterApiKey: "sk-super-secret-value",
			rateLimitSeconds: 5,
		}
		const message =
			'Failed to project provider handoff state for openai/gpt-4: Error: invalid key "sk-super-secret-value"'

		const redacted = redactProviderHandoffSecrets(message, apiConfiguration)

		expect(redacted).not.toContain("sk-super-secret-value")
		expect(redacted).toContain("[redacted]")
		expect(redacted).toContain("openai/gpt-4")
		// Non-secret configuration values are not treated as secrets.
		expect(redactProviderHandoffSecrets("plain failure", apiConfiguration)).toBe("plain failure")
	})
})

describe("provider handoff transaction protocol", () => {
	const GENERATION = "prepared-generation-label"

	function drive(
		from: ProviderHandoffState,
		events: ProviderHandoffEvent[],
	): { states: ProviderHandoffState[]; rejections: ProviderHandoffRejection[] } {
		const states = [from]
		const rejections: ProviderHandoffRejection[] = []
		for (const event of events) {
			const transition = applyProviderHandoffEvent(states[states.length - 1]!, event)
			if (transition.ok) {
				states.push(transition.state)
			} else {
				rejections.push(transition.reason)
				states.push(transition.state)
			}
		}
		return { states, rejections }
	}

	const happyPath: ProviderHandoffEvent[] = [
		{ type: "prepare", generation: GENERATION },
		{ type: "remove-parent" },
		{ type: "create-child", generation: GENERATION },
		{ type: "commit-delegation" },
		{ type: "activate-context", generation: GENERATION },
		{ type: "project-legacy", boundary: "profile-store", ok: true },
		{ type: "start-child" },
		{ type: "publish" },
	]

	it("walks the legal happy path from initial to settled with one prepared generation", () => {
		const { states, rejections } = drive(initialProviderHandoffState(), happyPath)

		expect(rejections).toEqual([])
		// Projection bookkeeping happens inside the context-active phase.
		expect(states.map((state) => state.phase)).toEqual([
			"initial",
			"prepared",
			"parent-removed",
			"child-created",
			"delegation-committed",
			"context-active",
			"context-active",
			"child-running",
			"settled",
		])
		const settled = states[states.length - 1]!
		expect(settled).toMatchObject({
			delegation: "committed",
			contextAuthority: "child",
			childPresence: "running",
			publication: "child",
			projection: "synchronized",
			generation: GENERATION,
			commitAttempts: 1,
		})
	})

	it("rejects every documented illegal ordering", () => {
		const initial = initialProviderHandoffState()

		// remove-before-prepare
		expect(applyProviderHandoffEvent(initial, { type: "remove-parent" })).toMatchObject({
			ok: false,
			reason: "preparation-required",
		})
		const prepared = applyProviderHandoffEvent(initial, { type: "prepare", generation: GENERATION })
		expect(prepared.ok).toBe(true)
		if (!prepared.ok) throw new Error("unreachable")

		// create-before-remove
		expect(
			applyProviderHandoffEvent(prepared.state, { type: "create-child", generation: GENERATION }),
		).toMatchObject({
			ok: false,
			reason: "parent-not-removed",
		})
		const removed = applyProviderHandoffEvent(prepared.state, { type: "remove-parent" })
		expect(removed.ok).toBe(true)
		if (!removed.ok) throw new Error("unreachable")

		// commit-before-child
		expect(applyProviderHandoffEvent(removed.state, { type: "commit-delegation" })).toMatchObject({
			ok: false,
			reason: "child-required",
		})
		const created = applyProviderHandoffEvent(removed.state, { type: "create-child", generation: GENERATION })
		expect(created.ok).toBe(true)
		if (!created.ok) throw new Error("unreachable")

		// context authority before commit
		expect(
			applyProviderHandoffEvent(created.state, { type: "activate-context", generation: GENERATION }),
		).toMatchObject({
			ok: false,
			reason: "commit-required",
		})
		const committed = applyProviderHandoffEvent(created.state, { type: "commit-delegation" })
		expect(committed.ok).toBe(true)
		if (!committed.ok) throw new Error("unreachable")

		// start/publish before durable commit + context authority
		expect(applyProviderHandoffEvent(committed.state, { type: "start-child" })).toMatchObject({
			ok: false,
			reason: "context-activation-required",
		})
		expect(applyProviderHandoffEvent(committed.state, { type: "publish" })).toMatchObject({
			ok: false,
			reason: "child-not-running",
		})

		// clean abort rollback after a committed delegation
		expect(applyProviderHandoffEvent(committed.state, { type: "rollback-restore", ok: true })).toMatchObject({
			ok: false,
			reason: "rollback-not-active",
		})
		expect(applyProviderHandoffEvent(committed.state, { type: "rollback-cleanup", ok: true })).toMatchObject({
			ok: false,
			reason: "rollback-not-active",
		})

		// exactly one lifecycle commit
		expect(applyProviderHandoffEvent(committed.state, { type: "commit-delegation" })).toMatchObject({
			ok: false,
			reason: "commit-already-attempted",
		})
		expect(applyProviderHandoffEvent(committed.state, { type: "commit-failed" })).toMatchObject({
			ok: false,
			reason: "commit-already-attempted",
		})
	})

	it("binds child creation and context authority to the single prepared generation", () => {
		const initial = initialProviderHandoffState()
		const prepared = applyProviderHandoffEvent(initial, { type: "prepare", generation: GENERATION })
		if (!prepared.ok) throw new Error("unreachable")
		const removed = applyProviderHandoffEvent(prepared.state, { type: "remove-parent" })
		if (!removed.ok) throw new Error("unreachable")

		expect(
			applyProviderHandoffEvent(removed.state, { type: "create-child", generation: "other-generation" }),
		).toMatchObject({
			ok: false,
			reason: "generation-mismatch",
		})
		const created = applyProviderHandoffEvent(removed.state, { type: "create-child", generation: GENERATION })
		if (!created.ok) throw new Error("unreachable")
		const committed = applyProviderHandoffEvent(created.state, { type: "commit-delegation" })
		if (!committed.ok) throw new Error("unreachable")
		expect(
			applyProviderHandoffEvent(committed.state, { type: "activate-context", generation: "other-generation" }),
		).toMatchObject({
			ok: false,
			reason: "generation-mismatch",
		})
		const activated = applyProviderHandoffEvent(committed.state, {
			type: "activate-context",
			generation: GENERATION,
		})
		expect(activated.ok).toBe(true)
		expect(activated.ok && activated.state.generation).toBe(GENERATION)
	})

	it("fails closed on preparation with a clean abort and no residue", () => {
		const aborted = applyProviderHandoffEvent(initialProviderHandoffState(), { type: "prepare-failed" })
		expect(aborted.ok).toBe(true)
		if (!aborted.ok) throw new Error("unreachable")
		expect(aborted.state).toMatchObject({
			phase: "aborted",
			parentPresence: "current",
			childPresence: "absent",
			delegation: "none",
			publication: "none",
			projection: "original",
			failure: { boundary: "preparation" },
			rollbackFailures: [],
		})
		expect(applyProviderHandoffEvent(aborted.state, { type: "start-child" })).toMatchObject({
			ok: false,
			reason: "terminal-state",
		})
	})

	it("restores the parent after a child-creation failure, degrading visibly when restoration fails", () => {
		const initial = initialProviderHandoffState()
		const prepared = applyProviderHandoffEvent(initial, { type: "prepare", generation: GENERATION })
		if (!prepared.ok) throw new Error("unreachable")
		const removed = applyProviderHandoffEvent(prepared.state, { type: "remove-parent" })
		if (!removed.ok) throw new Error("unreachable")

		// Clean: restoration succeeds.
		const failing = applyProviderHandoffEvent(removed.state, { type: "create-child-failed" })
		if (!failing.ok) throw new Error("unreachable")
		expect(failing.state).toMatchObject({ phase: "aborting", failure: { boundary: "child-creation" } })
		expect(applyProviderHandoffEvent(failing.state, { type: "rollback-cleanup", ok: true })).toMatchObject({
			ok: false,
			reason: "rollback-not-active",
		})
		const restored = applyProviderHandoffEvent(failing.state, { type: "rollback-restore", ok: true })
		expect(restored.ok && restored.state.phase).toBe("aborted")

		// Degraded: restoration fails and stays labeled.
		const failedRestore = applyProviderHandoffEvent(failing.state, { type: "rollback-restore", ok: false })
		expect(failedRestore.ok && failedRestore.state.phase).toBe("degraded-abort")
		if (!failedRestore.ok) throw new Error("unreachable")
		expect(failedRestore.state).toMatchObject({
			failure: { boundary: "child-creation" },
			rollbackFailures: ["parent-restoration"],
		})
		// Each rollback step runs at most once.
		expect(applyProviderHandoffEvent(failedRestore.state, { type: "rollback-restore", ok: true })).toMatchObject({
			ok: false,
			reason: "terminal-state",
		})
	})

	it("forbids rollback while a failed commit's durability is unresolved", () => {
		const initial = initialProviderHandoffState()
		const prepared = applyProviderHandoffEvent(initial, { type: "prepare", generation: GENERATION })
		if (!prepared.ok) throw new Error("unreachable")
		const removed = applyProviderHandoffEvent(prepared.state, { type: "remove-parent" })
		if (!removed.ok) throw new Error("unreachable")
		const created = applyProviderHandoffEvent(removed.state, { type: "create-child", generation: GENERATION })
		if (!created.ok) throw new Error("unreachable")
		const failed = applyProviderHandoffEvent(created.state, { type: "commit-failed" })
		if (!failed.ok) throw new Error("unreachable")

		// Production reconciles the durability before any destructive step.
		expect(applyProviderHandoffEvent(failed.state, { type: "rollback-cleanup", ok: true })).toMatchObject({
			ok: false,
			reason: "commit-durability-unresolved",
		})
		expect(applyProviderHandoffEvent(failed.state, { type: "rollback-restore", ok: true })).toMatchObject({
			ok: false,
			reason: "commit-durability-unresolved",
		})
	})

	it("observes commit durability: uncommitted aborts cleanly, committed returns to the success path, incoherent degrades without rollback", () => {
		const initial = initialProviderHandoffState()
		const prepared = applyProviderHandoffEvent(initial, { type: "prepare", generation: GENERATION })
		if (!prepared.ok) throw new Error("unreachable")
		const removed = applyProviderHandoffEvent(prepared.state, { type: "remove-parent" })
		if (!removed.ok) throw new Error("unreachable")
		const created = applyProviderHandoffEvent(removed.state, { type: "create-child", generation: GENERATION })
		if (!created.ok) throw new Error("unreachable")
		const failed = applyProviderHandoffEvent(created.state, { type: "commit-failed" })
		if (!failed.ok) throw new Error("unreachable")
		expect(failed.state).toMatchObject({
			phase: "aborting",
			commitAttempts: 1,
			failure: { boundary: "delegation-commit", commitDurability: "unresolved" },
		})

		// Observation 1: the write never persisted. Cleanup + restore -> clean abort.
		const uncommitted = applyProviderHandoffEvent(failed.state, {
			type: "observe-commit-durability",
			durability: "uncommitted",
		})
		if (!uncommitted.ok) throw new Error("unreachable")
		const cleaned = applyProviderHandoffEvent(uncommitted.state, { type: "rollback-cleanup", ok: true })
		if (!cleaned.ok) throw new Error("unreachable")
		const aborted = applyProviderHandoffEvent(cleaned.state, { type: "rollback-restore", ok: true })
		expect(aborted.ok && aborted.state.phase).toBe("aborted")
		expect(aborted.ok && aborted.state.failure).toMatchObject({
			boundary: "delegation-commit",
			commitDurability: "uncommitted",
		})

		// Observation 2: the write persisted despite the observed failure.
		// Authoritative reconciliation keeps the durable delegation and returns
		// to the committed success path (context activation onwards); no
		// rollback may run against the committed lineage.
		const committed = applyProviderHandoffEvent(failed.state, {
			type: "observe-commit-durability",
			durability: "committed",
		})
		if (!committed.ok) throw new Error("unreachable")
		expect(committed.state).toMatchObject({
			phase: "delegation-committed",
			delegation: "committed",
			parentPresence: "removed",
			childPresence: "paused",
			failure: { boundary: "delegation-commit", commitDurability: "committed" },
		})
		expect(applyProviderHandoffEvent(committed.state, { type: "rollback-cleanup", ok: true })).toMatchObject({
			ok: false,
			reason: "rollback-not-active",
		})
		const activated = applyProviderHandoffEvent(committed.state, {
			type: "activate-context",
			generation: GENERATION,
		})
		if (!activated.ok) throw new Error("unreachable")
		expect(activated.ok && activated.state.phase).toBe("context-active")

		// Observation 3: the re-read failed or the lineage is incoherent. The
		// terminal degrades without any destructive step: the child stays
		// paused and the parent record untouched.
		const incoherent = applyProviderHandoffEvent(failed.state, {
			type: "observe-commit-durability",
			durability: "incoherent",
		})
		if (!incoherent.ok) throw new Error("unreachable")
		expect(incoherent.state).toMatchObject({
			phase: "degraded-abort",
			childPresence: "paused",
			parentPresence: "removed",
			rollbackFailures: [],
			failure: { boundary: "delegation-commit", commitDurability: "incoherent" },
		})
		expect(applyProviderHandoffEvent(incoherent.state, { type: "rollback-cleanup", ok: true })).toMatchObject({
			ok: false,
			reason: "terminal-state",
		})
	})

	it("labels cleanup failure on the degraded abort terminal", () => {
		const initial = initialProviderHandoffState()
		const prepared = applyProviderHandoffEvent(initial, { type: "prepare", generation: GENERATION })
		if (!prepared.ok) throw new Error("unreachable")
		const removed = applyProviderHandoffEvent(prepared.state, { type: "remove-parent" })
		if (!removed.ok) throw new Error("unreachable")
		const created = applyProviderHandoffEvent(removed.state, { type: "create-child", generation: GENERATION })
		if (!created.ok) throw new Error("unreachable")
		const failed = applyProviderHandoffEvent(created.state, { type: "commit-failed" })
		if (!failed.ok) throw new Error("unreachable")
		const resolved = applyProviderHandoffEvent(failed.state, {
			type: "observe-commit-durability",
			durability: "uncommitted",
		})
		if (!resolved.ok) throw new Error("unreachable")
		const cleanupFailed = applyProviderHandoffEvent(resolved.state, { type: "rollback-cleanup", ok: false })
		if (!cleanupFailed.ok) throw new Error("unreachable")
		expect(cleanupFailed.state).toMatchObject({ childPresence: "paused", rollbackFailures: ["child-cleanup"] })
		const restored = applyProviderHandoffEvent(cleanupFailed.state, { type: "rollback-restore", ok: true })
		expect(restored.ok && restored.state.phase).toBe("degraded-abort")
		expect(restored.ok && restored.state.rollbackFailures).toEqual(["child-cleanup"])
		// Restore may not run before cleanup was attempted.
		const fresh = applyProviderHandoffEvent(resolved.state, { type: "rollback-restore", ok: true })
		expect(fresh).toMatchObject({ ok: false, reason: "cleanup-not-attempted" })
	})

	it("permits a projection failure after the commit without invalidating child authority", () => {
		const initial = initialProviderHandoffState()
		const activated = drive(initial, happyPath.slice(0, 5)).states[5]!
		expect(activated.phase).toBe("context-active")
		expect(activated.contextAuthority).toBe("child")

		const failed = applyProviderHandoffEvent(activated, {
			type: "project-legacy",
			boundary: "context-proxy",
			ok: false,
		})
		if (!failed.ok) throw new Error("unreachable")
		expect(failed.state).toMatchObject({
			projection: "stale",
			projectionFailure: "context-proxy",
			contextAuthority: "child",
			delegation: "committed",
		})
		// Projection is best-effort and single-shot.
		expect(
			applyProviderHandoffEvent(failed.state, { type: "project-legacy", boundary: "profile-store", ok: true }),
		).toMatchObject({
			ok: false,
			reason: "projection-already-attempted",
		})
		// A stale projection still settles with the child running.
		const started = applyProviderHandoffEvent(failed.state, { type: "start-child" })
		if (!started.ok) throw new Error("unreachable")
		const published = applyProviderHandoffEvent(started.state, { type: "publish" })
		expect(published.ok && published.state.phase).toBe("settled")
		expect(published.ok && published.state.publication).toBe("child")
	})

	it("starts the child without awaiting the legacy projection, which may settle afterwards", () => {
		const initial = initialProviderHandoffState()
		const activated = drive(initial, happyPath.slice(0, 5)).states[5]!

		// Start with the projection still original: the child never waits for
		// background legacy projection work.
		const started = applyProviderHandoffEvent(activated, { type: "start-child" })
		if (!started.ok) throw new Error("unreachable")
		expect(started.state).toMatchObject({
			phase: "child-running",
			childPresence: "running",
			projection: "original",
			contextAuthority: "child",
		})

		// The unresolved projection may settle while the child runs.
		const projected = applyProviderHandoffEvent(started.state, {
			type: "project-legacy",
			boundary: "profile-store",
			ok: true,
		})
		if (!projected.ok) throw new Error("unreachable")
		expect(projected.state).toMatchObject({ phase: "child-running", projection: "synchronized" })

		// Publication still settles from child-running.
		const published = applyProviderHandoffEvent(projected.state, { type: "publish" })
		expect(published.ok && published.state.phase).toBe("settled")

		// A projection that never recorded before settlement is dropped as
		// inert bookkeeping, never replayed on a terminal state.
		const settledOriginal = applyProviderHandoffEvent(started.state, { type: "publish" })
		if (!settledOriginal.ok) throw new Error("unreachable")
		expect(
			applyProviderHandoffEvent(settledOriginal.state, {
				type: "project-legacy",
				boundary: "context-proxy",
				ok: true,
			}),
		).toMatchObject({ ok: false, reason: "terminal-state" })
	})

	it("records the fresh parent observation on the failure without changing durability semantics", () => {
		const initial = initialProviderHandoffState()
		const prepared = applyProviderHandoffEvent(initial, { type: "prepare", generation: GENERATION })
		if (!prepared.ok) throw new Error("unreachable")
		const removed = applyProviderHandoffEvent(prepared.state, { type: "remove-parent" })
		if (!removed.ok) throw new Error("unreachable")
		const created = applyProviderHandoffEvent(removed.state, { type: "create-child", generation: GENERATION })
		if (!created.ok) throw new Error("unreachable")
		const failed = applyProviderHandoffEvent(created.state, { type: "commit-failed" })
		if (!failed.ok) throw new Error("unreachable")

		const observed = applyProviderHandoffEvent(failed.state, {
			type: "observe-commit-durability",
			durability: "incoherent",
			observation: "unreadable",
		})
		if (!observed.ok) throw new Error("unreachable")
		expect(observed.state.failure).toMatchObject({
			boundary: "delegation-commit",
			commitDurability: "incoherent",
			commitObservation: "unreadable",
		})
	})

	it("records the diagnostic contradictory-child and drifted observations without changing safety", () => {
		const driveToFailedCommit = () => {
			const initial = initialProviderHandoffState()
			const prepared = applyProviderHandoffEvent(initial, { type: "prepare", generation: GENERATION })
			if (!prepared.ok) throw new Error("unreachable")
			const removed = applyProviderHandoffEvent(prepared.state, { type: "remove-parent" })
			if (!removed.ok) throw new Error("unreachable")
			const created = applyProviderHandoffEvent(removed.state, { type: "create-child", generation: GENERATION })
			if (!created.ok) throw new Error("unreachable")
			const failed = applyProviderHandoffEvent(created.state, { type: "commit-failed" })
			if (!failed.ok) throw new Error("unreachable")
			return failed.state
		}

		// A present child record contradicting the exact parent delegation is
		// its own diagnostic label — incoherent, never committed.
		const contradictory = applyProviderHandoffEvent(driveToFailedCommit(), {
			type: "observe-commit-durability",
			durability: "incoherent",
			observation: "contradictory-child",
		})
		if (!contradictory.ok) throw new Error("unreachable")
		expect(contradictory.state.phase).toBe("degraded-abort")
		expect(contradictory.state.failure).toMatchObject({
			commitDurability: "incoherent",
			commitObservation: "contradictory-child",
		})

		// A preimage drift is likewise its own label with unchanged semantics:
		// degraded, non-destructive, no rollback.
		const drifted = applyProviderHandoffEvent(driveToFailedCommit(), {
			type: "observe-commit-durability",
			durability: "incoherent",
			observation: "drifted",
		})
		if (!drifted.ok) throw new Error("unreachable")
		expect(drifted.state.phase).toBe("degraded-abort")
		expect(drifted.state.failure).toMatchObject({
			commitDurability: "incoherent",
			commitObservation: "drifted",
		})
		expect(drifted.state.rollbackFailures).toEqual([])
	})

	it("carries no secrets or configuration in protocol state", () => {
		const { states } = drive(initialProviderHandoffState(), [
			...happyPath.slice(0, 5),
			{ type: "project-legacy", boundary: "profile-store", ok: false },
			...happyPath.slice(6),
		])
		const expectedKeys = [
			"phase",
			"parentPresence",
			"childPresence",
			"delegation",
			"generation",
			"contextAuthority",
			"projection",
			"projectionFailure",
			"publication",
			"failure",
			"rollbackFailures",
			"commitAttempts",
		]
		for (const state of states) {
			expect(Object.keys(state).sort()).toEqual([...expectedKeys].sort())
		}
		// Every primitive string in protocol state belongs to the fixed
		// vocabulary: phase/presence/boundary labels plus the caller's opaque
		// generation label. No configuration or secret-shaped value can appear.
		const allowed = new Set([
			// phases
			"initial",
			"prepared",
			"parent-removed",
			"child-created",
			"delegation-committed",
			"context-active",
			"child-running",
			"settled",
			"aborting",
			"aborted",
			"degraded-abort",
			// presence, durability, authority, projection, publication
			"current",
			"removed",
			"restored",
			"absent",
			"paused",
			"running",
			"none",
			"committed",
			"parent",
			"child",
			"original",
			"synchronized",
			"stale",
			// failure and projection boundaries, durability observations
			"preparation",
			"child-creation",
			"delegation-commit",
			"child-cleanup",
			"parent-restoration",
			"profile-store",
			"context-proxy",
			"queue",
			"unresolved",
			"uncommitted",
			"incoherent",
			// the single caller-supplied opaque label
			GENERATION,
		])
		for (const state of states) {
			const stack: unknown[] = [state]
			while (stack.length > 0) {
				const value = stack.pop()
				if (typeof value === "string") {
					expect(allowed.has(value)).toBe(true)
				} else if (value !== null && typeof value === "object") {
					stack.push(...Object.values(value))
				}
			}
		}
		expect(JSON.stringify(states)).not.toContain("sk-")
		expect(JSON.stringify(states)).not.toContain("apiKey")
	})
})

describe("provider handoff transaction wrapper", () => {
	it("binds one generation, advances landmarks, and never throws on rejected advances", () => {
		const transaction = createProviderHandoffTransaction()
		expect(transaction.generation).toMatch(/^handoff-generation-/)

		expect(transaction.advance({ type: "prepare" }).ok).toBe(true)
		// Rejected advances never throw and never change the snapshot.
		expect(transaction.advance({ type: "create-child" })).toMatchObject({ ok: false, reason: "parent-not-removed" })
		expect(transaction.snapshot().phase).toBe("prepared")
		expect(transaction.advance({ type: "remove-parent" }).ok).toBe(true)
		expect(transaction.advance({ type: "commit-delegation" })).toMatchObject({
			ok: false,
			reason: "child-required",
		})
		expect(transaction.snapshot().phase).toBe("parent-removed")
		expect(transaction.advance({ type: "create-child" }).ok).toBe(true)
		expect(transaction.snapshot()).toMatchObject({
			phase: "child-created",
			generation: transaction.generation,
		})
	})

	it("generates distinct opaque generations per transaction", () => {
		const first = createProviderHandoffTransaction()
		const second = createProviderHandoffTransaction()
		expect(first.generation).not.toBe(second.generation)
	})
})
