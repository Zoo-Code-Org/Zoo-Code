import assert from "node:assert/strict"
import * as policy from "../src/core/webview/webviewRecoveryPolicy"

// This explores finite protocol abstractions using production decisions. Effects
// (VS Code calls, listener installation, timer delivery) are modeled explicitly;
// ClineProvider.spec.ts and Electron tests verify those effects in production.
type Policy = typeof policy
interface Step<S> {
	action: string
	state: S
}
interface Node<S> {
	state: S
	parent: number
	action: string
	depth: number
}
const MAX_STATES = 100_000
const MAX_DEPTH = 100

function explore<S>(
	name: string,
	initial: S,
	transitions: (state: S) => Step<S>[],
	inspect: (state: S) => string[],
): Set<string> {
	const queue: Node<S>[] = [{ state: initial, parent: -1, action: "initial", depth: 0 }]
	const seen = new Set([JSON.stringify(initial)])
	const reached = new Set<string>()
	for (let i = 0; i < queue.length; i++) {
		const node = queue[i]!
		try {
			for (const landmark of inspect(node.state)) reached.add(landmark)
			for (const step of transitions(node.state)) {
				reached.add(`action:${step.action}`)
				const key = JSON.stringify(step.state)
				if (seen.has(key)) continue
				assert(node.depth < MAX_DEPTH, `${name}: exploration truncated at depth ${MAX_DEPTH}`)
				assert(seen.size < MAX_STATES, `${name}: state budget exceeded`)
				seen.add(key)
				queue.push({ ...step, parent: i, depth: node.depth + 1 })
			}
		} catch (error) {
			const trace: string[] = []
			let cursor = i
			while (cursor >= 0) {
				const entry = queue[cursor]!
				trace.unshift(`${entry.action}: ${JSON.stringify(entry.state)}`)
				cursor = entry.parent
			}
			throw new Error(`${name}: ${String(error)}\nShortest BFS trace:\n${trace.join("\n")}`)
		}
	}
	console.log(`${name}: ${seen.size} states, fixed point reached, depth <= ${MAX_DEPTH}`)
	return reached
}

interface Ownership {
	disposed: boolean
	isCurrent: boolean
	epochMatches: boolean
	heartbeatMatches: boolean
	visible: boolean
	owner: number | undefined
	completed: boolean
	generation: number
	hostCompleted: boolean
	hostCompletedAfterRetry: boolean
	hostBusy: boolean
	completionCase: "pending" | "valid" | "disposed" | "replaced" | "epoch" | "heartbeat" | "hidden"
	fault?: string
}

function ownershipCheck(p: Policy): void {
	const reached = explore<Ownership>(
		"async ownership",
		{
			disposed: false,
			isCurrent: true,
			epochMatches: true,
			heartbeatMatches: true,
			visible: true,
			owner: 0,
			completed: false,
			generation: 0,
			hostCompleted: false,
			hostCompletedAfterRetry: false,
			hostBusy: true,
			completionCase: "pending",
		},
		(state) => {
			const steps: Step<Ownership>[] = []
			const add = (action: string, update: Partial<Ownership>) =>
				steps.push({ action, state: { ...state, ...update } })
			if (state.generation === 0)
				add("explicit-retry-invalidates-old-work", {
					generation: 1,
					epochMatches: false,
					owner: 1,
					hostBusy: true,
				})
			if (!state.hostCompleted) {
				const owns = p.isRecoveryGenerationCurrent(0, state.generation)
				add("complete-old-host-command", {
					hostCompleted: true,
					hostCompletedAfterRetry: state.generation === 1,
					hostBusy: owns ? false : state.hostBusy,
					fault:
						owns !== (state.generation === 0) ? "old host command changed a renewed incident" : undefined,
				})
			}
			if (!state.disposed) add("dispose", { disposed: true })
			if (state.isCurrent)
				add("replace-and-start-new-recovery", { isCurrent: false, epochMatches: false, owner: 1 })
			if (state.epochMatches) add("invalidate-epoch", { epochMatches: false })
			if (state.heartbeatMatches) add("heartbeat-or-grace", { heartbeatMatches: false })
			add(state.visible ? "hide" : "show", { visible: !state.visible })
			if (!state.completed) {
				const commit = p.canCommitRecovery(state)
				const expected =
					!state.disposed && state.isCurrent && state.epochMatches && state.heartbeatMatches && state.visible
				const owner = p.releaseRecoveryOwner(state.owner, 0)
				add("complete-old-html", {
					completed: true,
					completionCase: state.disposed
						? "disposed"
						: !state.isCurrent
							? "replaced"
							: !state.epochMatches
								? "epoch"
								: !state.heartbeatMatches
									? "heartbeat"
									: !state.visible
										? "hidden"
										: "valid",
					owner,
					fault:
						commit !== expected
							? "stale, hidden, or disposed HTML commit"
							: owner !== (state.owner === 0 ? undefined : state.owner)
								? "old completion released a replacement owner"
								: undefined,
				})
			}
			return steps
		},
		(s) => {
			assert(!s.fault, s.fault)
			const marks: string[] = []
			if (s.hostCompletedAfterRetry && s.hostBusy) marks.push("old-host-completion-preserves-new-owner")
			if (s.completionCase === "valid") marks.push("valid-html-commit")
			if (s.completionCase === "epoch") marks.push("epoch-invalidates-html")
			if (s.completionCase === "replaced" && s.owner === 1)
				marks.push("replacement-owner-survives-old-completion")
			if (s.completionCase === "disposed") marks.push("disposed-completion")
			if (s.completionCase === "heartbeat") marks.push("heartbeat-invalidates-html")
			if (s.completionCase === "hidden") marks.push("hidden-completion")
			return marks
		},
	)
	for (const mark of [
		"old-host-completion-preserves-new-owner",
		"valid-html-commit",
		"epoch-invalidates-html",
		"replacement-owner-survives-old-completion",
		"disposed-completion",
		"heartbeat-invalidates-html",
		"hidden-completion",
	])
		assert(reached.has(mark), `ownership landmark missing: ${mark}`)
}

type Phase = "idle" | "html" | "remove" | "focus" | "wait" | "initialize" | "stopped"
interface Host {
	phase: Phase
	attempts: number
	reported: boolean
	stopLogged: boolean
	terminalLogs: number
	retryWarned: boolean
	busy: boolean
	pending: boolean
	view: "old" | "none" | "replacement"
	watchdog: boolean
	initialized: boolean
	recoveringResolve: boolean
	waitExpired: boolean
	focusFailed: boolean
	manualOpened: boolean
	healthStarted: boolean
	healthReset: boolean
	generation: number
	explicitRetried: boolean
	retriedAfterAmbiguous: boolean
	ambiguousOpened: boolean
	fault?: string
}

function hostCheck(kind: "sidebar" | "tab", p: Policy): void {
	const initial: Host = {
		phase: "idle",
		attempts: 0,
		reported: false,
		stopLogged: false,
		terminalLogs: 0,
		retryWarned: false,
		busy: false,
		pending: false,
		view: "old",
		watchdog: true,
		initialized: true,
		recoveringResolve: false,
		waitExpired: false,
		focusFailed: false,
		manualOpened: false,
		healthStarted: false,
		healthReset: false,
		generation: 0,
		explicitRetried: false,
		retriedAfterAmbiguous: false,
		ambiguousOpened: false,
	}
	const reached = explore<Host>(
		`${kind} host`,
		initial,
		(s) => {
			const steps: Step<Host>[] = []
			const add = (action: string, update: Partial<Host>) => steps.push({ action, state: { ...s, ...update } })
			const failure = (stop: boolean): Partial<Host> => {
				const next = p.recordRecoveryFailure(
					{ attempts: s.attempts, reported: s.reported, stopLogged: s.stopLogged },
					stop,
				)
				return {
					attempts: next.attempts,
					reported: next.reported,
					stopLogged: next.stopLogged,
					terminalLogs: s.terminalLogs + (stop && next.log ? 1 : 0),
					retryWarned: s.retryWarned || (!stop && next.notify),
					fault:
						next.attempts !== (stop ? 3 : s.attempts) || next.notify === s.reported
							? "failure consumed retries or repeated a warning"
							: undefined,
				}
			}
			const publish = (manual = false) => {
				const recovering = p.preservesRecoveryIncident(s.busy, s.pending)
				add(manual ? "manual-open-with-pending-marker" : "publish-replacement", {
					phase: "initialize",
					view: "replacement",
					watchdog: false,
					initialized: false,
					recoveringResolve: recovering,
					ambiguousOpened: s.ambiguousOpened || manual,
					pending: false,
					attempts: recovering ? s.attempts : 0,
					fault: !recovering
						? "repair reset its incident budget or could evict the interrupted task"
						: undefined,
				})
			}
			if (s.phase === "idle" && s.watchdog && s.attempts < 3) {
				const attempt = p.nextRecoveryAttempt(s.attempts, false)
				add("stale-watchdog", {
					phase: "html",
					attempts: attempt ?? s.attempts,
					healthStarted: false,
					fault: attempt !== s.attempts + 1 ? "attempt accounting" : undefined,
				})
			}
			if (s.phase === "html") {
				add("duplicate-recovery", {
					fault:
						p.nextRecoveryAttempt(s.attempts, true) !== undefined
							? "duplicate in-flight recovery"
							: undefined,
				})
				add("html-failure", { phase: "idle" })
				if (kind === "sidebar")
					add("html-success", { phase: "remove", busy: true, pending: true, waitExpired: false })
				else
					add("html-success", {
						phase: "initialize",
						busy: true,
						view: "replacement",
						watchdog: false,
						initialized: false,
						recoveringResolve: true,
						waitExpired: false,
					})
			}
			if (s.phase === "remove" || s.phase === "focus") {
				const pending = p.pendingSidebarAfterCommandFailure({
					started: true,
					focusSucceeded: false,
					pending: s.pending,
				})
				add(`${s.phase}-failure`, {
					...failure(true),
					phase: "stopped",
					busy: false,
					pending,
					focusFailed: s.phase === "focus",
					fault: pending ? "command failure left a stale sidebar marker" : undefined,
				})
				if (s.phase === "remove")
					add("remove-success", { phase: "focus", view: "none", watchdog: false, initialized: false })
				else add("focus-success", { phase: "wait" })
			}
			if (s.phase === "wait") {
				publish()
				if (s.waitExpired && !s.ambiguousOpened) publish(true)
				if (!s.waitExpired)
					add("timeout-before-publication", { ...failure(true), busy: false, waitExpired: true })
			}
			if (s.phase === "initialize") {
				add("resolve-success", { phase: "idle", busy: false, watchdog: true, initialized: true })
				const action = p.resolutionFailureAction({
					recoveringHost: s.recoveringResolve,
					disposed: false,
					isCurrent: true,
				})
				add("resolve-failure", {
					...failure(false),
					phase: "idle",
					busy: false,
					watchdog: action === "retry",
					initialized: false,
					fault: action !== "retry" ? "published resolution failure lost recovery" : undefined,
				})
				if (kind === "sidebar" && !s.waitExpired)
					add("timeout-after-publication", { ...failure(false), busy: false, waitExpired: true })
			}
			if (!s.explicitRetried) {
				const fresh = p.beginExplicitRecovery(s.generation)
				add("explicit-user-retry", {
					generation: fresh.generation,
					explicitRetried: true,
					retriedAfterAmbiguous: s.ambiguousOpened,
					attempts: fresh.attempts,
					reported: fresh.reported,
					stopLogged: fresh.stopLogged,
					terminalLogs: 0,
					retryWarned: false,
					busy: true,
					pending: kind === "sidebar",
					healthStarted: false,
					waitExpired: false,
					phase: kind === "tab" ? "initialize" : s.view === "none" ? "focus" : "remove",
					view: kind === "tab" ? "replacement" : s.view,
					initialized: kind === "tab" ? false : s.initialized,
					watchdog: kind === "tab" ? false : s.watchdog,
					recoveringResolve: kind === "tab" || s.recoveringResolve,
					fault:
						fresh.generation !== s.generation + 1 ||
						fresh.attempts !== 1 ||
						fresh.reported ||
						fresh.stopLogged
							? "explicit retry failed to renew incident"
							: undefined,
				})
			}
			if (s.phase === "idle" && s.attempts === 3) add("exhaust-budget", { ...failure(true), phase: "stopped" })
			if (s.phase === "stopped" && !s.pending && !s.manualOpened) {
				const recovering = p.preservesRecoveryIncident(s.busy, s.pending)
				add("manual-open", {
					phase: "idle",
					view: "old",
					attempts: recovering ? s.attempts : 0,
					watchdog: true,
					initialized: true,
					reported: false,
					stopLogged: false,
					terminalLogs: 0,
					retryWarned: false,
					manualOpened: true,
					fault: recovering ? "manual open inherited a failed incident" : undefined,
				})
			}
			if ((s.phase === "idle" || s.phase === "stopped") && s.watchdog && !s.healthReset) {
				if (!s.healthStarted) {
					const health = p.recoveryHealth(
						{ attempts: s.attempts, lastHeartbeatAt: undefined, healthySince: undefined },
						0,
					)
					add("startup-heartbeat", {
						healthStarted: true,
						reported: false,
						stopLogged: false,
						terminalLogs: 0,
						retryWarned: false,
						attempts: health.attempts,
						fault: health.attempts !== s.attempts ? "one heartbeat refilled the budget" : undefined,
					})
				} else {
					const health = p.recoveryHealth(
						{ attempts: s.attempts, lastHeartbeatAt: 0, healthySince: 0 },
						60_000,
					)
					add("sustained-health", {
						phase: "idle",
						healthReset: true,
						attempts: health.attempts,
						reported: false,
						stopLogged: false,
						terminalLogs: 0,
						retryWarned: false,
						fault: health.attempts !== 0 ? "healthy window failed to replenish attempts" : undefined,
					})
				}
			}
			return steps
		},
		(s) => {
			assert(!s.fault, s.fault)
			assert(s.terminalLogs <= 1, "duplicate terminal stop log in one incident")
			assert.equal(s.stopLogged, s.terminalLogs === 1, "terminal stop log was suppressed")
			assert(Number.isInteger(s.attempts) && s.attempts >= 0 && s.attempts <= 3, "attempt budget")
			if (s.phase === "idle")
				assert(s.watchdog && !s.busy, "settled recovery lost watchdog or retained ownership")
			const marks: string[] = []
			if (s.ambiguousOpened && !s.explicitRetried && s.attempts === 3 && s.recoveringResolve)
				marks.push("ambiguous-reopen-preserves-incident")
			if (s.retriedAfterAmbiguous && s.attempts === 1 && s.generation === 1)
				marks.push("explicit-retry-after-ambiguous-reopen")
			if (s.retryWarned && s.stopLogged && s.terminalLogs === 1) marks.push("terminal-stop-after-retry-warning")
			if (s.phase === "idle" && !s.initialized && s.attempts === 1) marks.push("initialization-failure-retryable")
			if (s.phase === "stopped" && s.attempts === 3 && !s.initialized && s.view === "replacement")
				marks.push("failed-resolutions-bounded")
			if (s.phase === "initialize" && s.waitExpired && s.attempts === 1)
				marks.push("published-timeout-keeps-attempts")
			if (s.phase === "initialize" && s.waitExpired && s.attempts === 3 && s.recoveringResolve)
				marks.push("late-publication-preserves-cap")
			if (s.manualOpened && s.focusFailed && s.attempts === 0) marks.push("manual-open-after-focus-failure")
			if (s.healthReset && s.attempts === 0) marks.push("healthy-budget-refill")
			return marks
		},
	)
	const required = [
		"initialization-failure-retryable",
		"failed-resolutions-bounded",
		"healthy-budget-refill",
		"terminal-stop-after-retry-warning",
	]
	if (kind === "sidebar")
		required.push(
			"published-timeout-keeps-attempts",
			"late-publication-preserves-cap",
			"manual-open-after-focus-failure",
			"ambiguous-reopen-preserves-incident",
			"explicit-retry-after-ambiguous-reopen",
		)
	for (const mark of required) assert(reached.has(mark), `${kind} landmark missing: ${mark}`)
	for (const action of [
		"stale-watchdog",
		"explicit-user-retry",
		"duplicate-recovery",
		"html-failure",
		"resolve-success",
		"resolve-failure",
		"exhaust-budget",
		"sustained-health",
	])
		assert(reached.has(`action:${action}`), `${kind} action unreachable: ${action}`)
}

function policyContracts(p: Policy): void {
	for (const choice of [undefined, "Retry Interface Recovery", "Reload Window", "Show Logs", "dismiss"])
		for (const disposed of [false, true])
			for (const sameHeartbeat of [false, true])
				for (const sameGeneration of [false, true]) {
					assert.equal(
						p.recoveryWarningAction(choice, disposed, sameHeartbeat, sameGeneration),
						choice === "Show Logs"
							? "logs"
							: disposed || !sameHeartbeat || !sameGeneration
								? "none"
								: choice === "Retry Interface Recovery"
									? "retry"
									: choice === "Reload Window"
										? "reload"
										: "none",
						"notification action contract",
					)
				}
	for (const captured of [0, 1])
		for (const current of [0, 1]) {
			assert.equal(
				p.isRecoveryGenerationCurrent(captured, current),
				captured === current,
				"recovery generation ownership",
			)
			assert.deepEqual(
				p.beginExplicitRecovery(current),
				{ generation: current + 1, attempts: 1, reported: false, stopLogged: false },
				"explicit retry incident contract",
			)
		}

	for (const recoveringHost of [false, true])
		for (const disposed of [false, true])
			for (const isCurrent of [false, true]) {
				assert.equal(
					p.resolutionFailureAction({ recoveringHost, disposed, isCurrent }),
					!recoveringHost ? "propagate" : disposed || !isCurrent ? "ignore" : "retry",
					"resolve failure ownership",
				)
			}
	for (let attempts = 0; attempts <= 3; attempts++) {
		for (const inFlight of [false, true])
			assert.equal(
				p.nextRecoveryAttempt(attempts, inFlight),
				inFlight || attempts === 3 ? undefined : attempts + 1,
				"attempt cap and ownership",
			)
		for (const lastHeartbeatAt of [undefined, 0])
			for (const healthySince of [undefined, 0]) {
				for (const now of [0, 59_999, 60_000, 90_000, 90_001]) {
					const actual = p.recoveryHealth({ attempts, lastHeartbeatAt, healthySince }, now)
					const since = lastHeartbeatAt === undefined || now > 90_000 ? now : healthySince
					assert.deepEqual(
						actual,
						{ attempts: since !== undefined && now - since >= 60_000 ? 0 : attempts, healthySince: since },
						"health boundary",
					)
				}
			}
	}
	for (let attempts = 0; attempts <= 3; attempts++)
		for (const reported of [false, true])
			for (const stopLogged of [false, true])
				for (const stop of [false, true]) {
					assert.deepEqual(
						p.recordRecoveryFailure({ attempts, reported, stopLogged }, stop),
						{
							attempts: stop ? 3 : attempts,
							reported: true,
							notify: !reported,
							stopLogged: stopLogged || stop,
							log: stop ? !stopLogged : !reported && !stopLogged,
						},
						"failure accounting, notification deduplication, and terminal stop logging",
					)
				}

	for (const started of [false, true])
		for (const focusSucceeded of [false, true])
			for (const pending of [false, true]) {
				assert.equal(
					p.pendingSidebarAfterCommandFailure({ started, focusSucceeded, pending }),
					started && !focusSucceeded ? false : pending,
					"sidebar command failure marker",
				)
			}
}

function check(p: Policy): void {
	policyContracts(p)
	ownershipCheck(p)
	hostCheck("sidebar", p)
	hostCheck("tab", p)
}

check(policy)
// Representative policy regressions must be rejected, rather than merely
// leaving a self-consistent abstract model green. These do not mutate source.
const mutants: Array<[string, Policy, RegExp]> = [
	[
		"old work owns a new generation",
		{ ...policy, isRecoveryGenerationCurrent: () => true },
		/recovery generation ownership/,
	],
	[
		"explicit retry inherits exhausted incident",
		{
			...policy,
			beginExplicitRecovery: (generation) => ({ generation, attempts: 3, reported: true, stopLogged: true }),
		},
		/explicit retry incident contract/,
	],
	[
		"old warning resets a new generation",
		{
			...policy,
			recoveryWarningAction: (choice, disposed, sameHeartbeat) =>
				policy.recoveryWarningAction(choice, disposed, sameHeartbeat, true),
		},
		/notification action contract/,
	],
	[
		"terminal stop suppressed after retry warning",
		{
			...policy,
			recordRecoveryFailure: (state, stop) => ({
				...policy.recordRecoveryFailure(state, stop),
				log: !state.reported,
			}),
		},
		/terminal stop logging/,
	],
	[
		"terminal stop repeated on every tick",
		{
			...policy,
			recordRecoveryFailure: (state, stop) => ({
				...policy.recordRecoveryFailure(state, stop),
				log: stop || !state.reported,
			}),
		},
		/terminal stop logging/,
	],
	[
		"stale notification reloads window",
		{ ...policy, recoveryWarningAction: (choice) => (choice === "Reload Window" ? "reload" : "none") },
		/notification action contract/,
	],
	[
		"late Show Logs is suppressed",
		{
			...policy,
			recoveryWarningAction: (choice, disposed, sameHeartbeat) =>
				sameHeartbeat ? policy.recoveryWarningAction(choice, disposed, sameHeartbeat) : "none",
		},
		/notification action contract/,
	],
	["stale HTML commit", { ...policy, canCommitRecovery: () => true }, /stale, hidden, or disposed HTML commit/],
	[
		"old completion clears new owner",
		{ ...policy, releaseRecoveryOwner: () => undefined },
		/old completion released a replacement owner/,
	],
	[
		"late repair resets budget",
		{ ...policy, preservesRecoveryIncident: () => false },
		/repair reset its incident budget/,
	],
	[
		"failed resolution loses retry",
		{ ...policy, resolutionFailureAction: () => "propagate" },
		/resolve failure ownership/,
	],
	[
		"retry warning exhausts budget",
		{ ...policy, recordRecoveryFailure: (state) => policy.recordRecoveryFailure(state, true) },
		/failure accounting/,
	],
	[
		"failed focus retains marker",
		{ ...policy, pendingSidebarAfterCommandFailure: (state) => state.pending },
		/sidebar command failure marker/,
	],
	[
		"startup heartbeat refills budget",
		{ ...policy, recoveryHealth: (state, now) => ({ ...policy.recoveryHealth(state, now), attempts: 0 }) },
		/health boundary/,
	],
	["unbounded attempts", { ...policy, nextRecoveryAttempt: (attempts) => attempts + 1 }, /attempt cap and ownership/],
]
for (const [name, mutant, expectedViolation] of mutants) {
	assert.throws(() => check(mutant), expectedViolation, `checker missed regression: ${name}`)
	console.log(`Rejected regression: ${name}`)
}
console.log(`Webview recovery model check passed; ${mutants.length} representative regressions rejected.`)
