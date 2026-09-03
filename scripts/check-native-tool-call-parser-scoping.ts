import assert from "node:assert/strict"

import { NativeToolCallParser, type ToolCallStreamEvent } from "../src/core/assistant-message/NativeToolCallParser"

const scopeIds = ["A", "B"] as const
type ScopeId = (typeof scopeIds)[number]

const localActions = [
	"open",
	"start-raw-call",
	"add-fragments",
	"finalize-raw-call",
	"finalize-streaming-call-and-cleanup",
	"late-fragments",
] as const
type LocalAction = (typeof localActions)[number]

interface ScheduledAction {
	scopeId: ScopeId
	action: LocalAction
}

interface ScopeReplayState {
	scope?: object
	rawEndCount: number
	streamFinalizationCount: number
	lateFragmentsIgnored: boolean
}

interface ReplayState {
	scopes: Record<ScopeId, ScopeReplayState>
	events: Array<{ owner: ScopeId; event: ToolCallStreamEvent }>
}

const RAW_TOOL_INDEX = 0
const MAX_ACTIONS_PER_SCOPE = localActions.length
const MAX_TOTAL_ACTIONS = MAX_ACTIONS_PER_SCOPE * scopeIds.length
const EXPECTED_SCHEDULES = binomial(MAX_TOTAL_ACTIONS, MAX_ACTIONS_PER_SCOPE)
const MAX_SCHEDULES = EXPECTED_SCHEDULES

const callIds = { A: "call_scope_a", B: "call_scope_b" } satisfies Record<ScopeId, string>
const paths = { A: "scope-a.ts", B: "scope-b.ts" } satisfies Record<ScopeId, string>
const fragments = {
	A: ['{"path":"scope-', 'a.ts"}'],
	B: ['{"path":"scope-', 'b.ts"}'],
} satisfies Record<ScopeId, readonly [string, string]>

const expectedActions = new Set<LocalAction>(localActions)
const reachedActions = new Set<LocalAction>()
const reachedLandmarks = new Set<string>()

const landmarkNames = [
	"simultaneous-active-scopes",
	"B-opens-while-A-is-partial",
	"A-raw-finalizes-while-B-is-active",
	"B-raw-finalizes-while-A-is-active",
	"A-stream-finalizes-while-B-is-active",
	"B-stream-finalizes-while-A-is-active",
	"A-late-fragment-while-B-is-active",
	"B-late-fragment-while-A-is-active",
] as const

function binomial(n: number, k: number): number {
	let result = 1
	for (let index = 1; index <= k; index++) {
		result = (result * (n - k + index)) / index
	}
	return result
}

function initialReplayState(): ReplayState {
	return {
		scopes: {
			A: { rawEndCount: 0, streamFinalizationCount: 0, lateFragmentsIgnored: false },
			B: { rawEndCount: 0, streamFinalizationCount: 0, lateFragmentsIgnored: false },
		},
		events: [],
	}
}

function activeAtProgress(progress: number): boolean {
	return (
		progress >= localActions.indexOf("start-raw-call") + 1 &&
		progress < localActions.indexOf("finalize-streaming-call-and-cleanup") + 1
	)
}

function appendOwnedEvents(state: ReplayState, owner: ScopeId, events: ToolCallStreamEvent[]): void {
	for (const event of events) {
		state.events.push({ owner, event })
		assert.equal(event.id, callIds[owner], `${owner} emitted an event owned by the other request scope`)
	}
}

function requireScope(state: ReplayState, scopeId: ScopeId): object {
	const scope = state.scopes[scopeId].scope
	assert.ok(scope, `${scopeId} must be opened before ${scopeId}'s parser APIs are replayed`)
	return scope
}

function replayAction(state: ReplayState, scheduled: ScheduledAction): void {
	const { scopeId, action } = scheduled
	const scopeState = state.scopes[scopeId]
	reachedActions.add(action)

	switch (action) {
		case "open":
			scopeState.scope = NativeToolCallParser.createScope()
			break
		case "start-raw-call": {
			const scope = requireScope(state, scopeId)
			const events = NativeToolCallParser.processRawChunk(
				{ index: RAW_TOOL_INDEX, id: callIds[scopeId], name: "read_file" },
				scope,
			)
			assert.deepEqual(events, [{ type: "tool_call_start", id: callIds[scopeId], name: "read_file" }])
			appendOwnedEvents(state, scopeId, events)
			NativeToolCallParser.startStreamingToolCall(callIds[scopeId], "read_file", scope)
			break
		}
		case "add-fragments": {
			const scope = requireScope(state, scopeId)
			for (const fragment of fragments[scopeId]) {
				const events = NativeToolCallParser.processRawChunk(
					{ index: RAW_TOOL_INDEX, arguments: fragment },
					scope,
				)
				assert.deepEqual(events, [{ type: "tool_call_delta", id: callIds[scopeId], delta: fragment }])
				appendOwnedEvents(state, scopeId, events)
				assert.notEqual(
					NativeToolCallParser.processStreamingChunk(callIds[scopeId], fragment, scope),
					null,
					`${scopeId}'s fragment was not accepted by its streaming accumulator`,
				)
			}
			break
		}
		case "finalize-raw-call": {
			const scope = requireScope(state, scopeId)
			const events = NativeToolCallParser.finalizeRawChunks(scope)
			assert.deepEqual(events, [{ type: "tool_call_end", id: callIds[scopeId] }])
			appendOwnedEvents(state, scopeId, events)
			scopeState.rawEndCount += events.length
			assert.deepEqual(
				NativeToolCallParser.finalizeRawChunks(scope),
				[],
				`${scopeId} emitted a duplicate raw end`,
			)
			break
		}
		case "finalize-streaming-call-and-cleanup": {
			const scope = requireScope(state, scopeId)
			const result = NativeToolCallParser.finalizeStreamingToolCall(callIds[scopeId], scope)
			assert.equal(result?.type, "tool_use")
			if (result?.type !== "tool_use" || result.name !== "read_file") {
				throw new Error(`${scopeId}'s streaming result was not a read_file tool use`)
			}
			if (!result.nativeArgs || !("path" in result.nativeArgs)) {
				throw new Error(`${scopeId}'s streaming result did not use current read_file arguments`)
			}
			assert.equal(result.nativeArgs?.path, paths[scopeId], `${scopeId}'s arguments crossed request scopes`)
			scopeState.streamFinalizationCount += 1
			assert.equal(
				NativeToolCallParser.finalizeStreamingToolCall(callIds[scopeId], scope),
				null,
				`${scopeId} finalized its streaming call twice`,
			)
			NativeToolCallParser.clearRawChunkState(scope)
			NativeToolCallParser.clearAllStreamingToolCalls(scope)
			break
		}
		case "late-fragments": {
			const scope = requireScope(state, scopeId)
			const rawEvents = NativeToolCallParser.processRawChunk(
				{ index: RAW_TOOL_INDEX, arguments: `late-${scopeId}` },
				scope,
			)
			const streamingResult = NativeToolCallParser.processStreamingChunk(
				callIds[scopeId],
				`late-${scopeId}`,
				scope,
			)
			assert.deepEqual(rawEvents, [], `${scopeId} accepted a late raw fragment`)
			assert.equal(streamingResult, null, `${scopeId} accepted a late streaming fragment`)
			scopeState.lateFragmentsIgnored = true
			break
		}
	}
}

function checkInvariants(state: ReplayState, progress: Record<ScopeId, number>, trace: ScheduledAction[]): void {
	for (const scopeId of scopeIds) {
		const scopeState = state.scopes[scopeId]
		const scope = scopeState.scope
		const expectedActive = activeAtProgress(progress[scopeId])
		assert.equal(
			scope ? NativeToolCallParser.hasActiveStreamingToolCalls(scope) : false,
			expectedActive,
			`${scopeId}'s active streaming state was changed by the other request scope`,
		)
		assert.ok(scopeState.rawEndCount <= 1, `${scopeId} emitted duplicate raw finalization events`)
		assert.ok(scopeState.streamFinalizationCount <= 1, `${scopeId} finalized its streaming call more than once`)
	}

	for (const { owner, event } of state.events) {
		assert.equal(event.id, callIds[owner], `${owner}'s event log contains another scope's call ID`)
	}

	const last = trace.at(-1)
	if (!last) return
	if (activeAtProgress(progress.A) && activeAtProgress(progress.B)) reachedLandmarks.add("simultaneous-active-scopes")
	if (last.scopeId === "B" && last.action === "open" && progress.A === 3) {
		reachedLandmarks.add("B-opens-while-A-is-partial")
	}
	if (last.action === "finalize-raw-call" && activeAtProgress(progress[last.scopeId === "A" ? "B" : "A"])) {
		reachedLandmarks.add(`${last.scopeId}-raw-finalizes-while-${last.scopeId === "A" ? "B" : "A"}-is-active`)
	}
	if (
		last.action === "finalize-streaming-call-and-cleanup" &&
		activeAtProgress(progress[last.scopeId === "A" ? "B" : "A"])
	) {
		reachedLandmarks.add(`${last.scopeId}-stream-finalizes-while-${last.scopeId === "A" ? "B" : "A"}-is-active`)
	}
	if (last.action === "late-fragments" && activeAtProgress(progress[last.scopeId === "A" ? "B" : "A"])) {
		reachedLandmarks.add(`${last.scopeId}-late-fragment-while-${last.scopeId === "A" ? "B" : "A"}-is-active`)
	}
}

function cleanupReplay(state: ReplayState): void {
	for (const scopeId of scopeIds) {
		const scope = state.scopes[scopeId].scope
		if (!scope) continue
		NativeToolCallParser.clearRawChunkState(scope)
		NativeToolCallParser.clearAllStreamingToolCalls(scope)
	}
}

function replaySchedule(trace: ScheduledAction[]): void {
	const state = initialReplayState()
	const progress: Record<ScopeId, number> = { A: 0, B: 0 }
	try {
		for (const scheduled of trace) {
			replayAction(state, scheduled)
			progress[scheduled.scopeId] += 1
			checkInvariants(state, progress, trace.slice(0, progress.A + progress.B))
		}
		for (const scopeId of scopeIds) {
			assert.equal(state.scopes[scopeId].rawEndCount, 1, `${scopeId} did not emit exactly one raw end`)
			assert.equal(state.scopes[scopeId].streamFinalizationCount, 1, `${scopeId} did not finalize exactly once`)
			assert.equal(
				state.scopes[scopeId].lateFragmentsIgnored,
				true,
				`${scopeId}'s late fragments were not checked`,
			)
		}
	} catch (error) {
		const formattedTrace = trace
			.map(({ scopeId, action }, index) => `${index + 1}. ${scopeId}.${action}`)
			.join("\n")
		throw new Error(
			`Native tool-call parser scope invariant failed within bounds scopes=${scopeIds.length}, actions-per-scope=${MAX_ACTIONS_PER_SCOPE}, schedules=${MAX_SCHEDULES}\n${formattedTrace}`,
			{ cause: error },
		)
	} finally {
		cleanupReplay(state)
	}
}

function enumerateSchedules(): number {
	const trace: ScheduledAction[] = []
	const progress: Record<ScopeId, number> = { A: 0, B: 0 }
	let exploredSchedules = 0

	function visit(): void {
		if (trace.length === MAX_TOTAL_ACTIONS) {
			exploredSchedules += 1
			if (exploredSchedules > MAX_SCHEDULES) {
				throw new Error(`Parser-scope exploration exceeded its ${MAX_SCHEDULES}-schedule budget`)
			}
			replaySchedule(trace)
			return
		}

		for (const scopeId of scopeIds) {
			const localProgress = progress[scopeId]
			if (localProgress === MAX_ACTIONS_PER_SCOPE) continue
			const action = localActions[localProgress]
			if (!action) throw new Error(`${scopeId} has no modeled action at local progress ${localProgress}`)
			trace.push({ scopeId, action })
			progress[scopeId] += 1
			visit()
			progress[scopeId] -= 1
			trace.pop()
		}
	}

	visit()
	return exploredSchedules
}

const exploredSchedules = enumerateSchedules()
assert.equal(
	exploredSchedules,
	EXPECTED_SCHEDULES,
	`Parser-scope exploration truncated: expected ${EXPECTED_SCHEDULES} schedules, explored ${exploredSchedules}`,
)

const unreachableActions = [...expectedActions].filter((action) => !reachedActions.has(action))
assert.deepEqual(unreachableActions, [], `Parser-scope model has unreachable actions: ${unreachableActions.join(", ")}`)
const missingLandmarks = landmarkNames.filter((name) => !reachedLandmarks.has(name))
assert.deepEqual(missingLandmarks, [], `Parser-scope model has unreachable landmarks: ${missingLandmarks.join(", ")}`)

console.log(
	`Native tool-call parser scope model check passed: ${exploredSchedules}/${EXPECTED_SCHEDULES} valid local-order interleavings, ${localActions.length}/${localActions.length} actions reachable, ${landmarkNames.length}/${landmarkNames.length} landmarks reached, scopes=${scopeIds.length}, raw-index=${RAW_TOOL_INDEX}, actions-per-scope=${MAX_ACTIONS_PER_SCOPE}`,
)
