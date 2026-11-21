import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { McpToolSelection } from "../src/core/task/mcpToolSelection"
import type { ToolDoc } from "../src/services/tools/types"
import { buildMcpToolName } from "../src/utils/mcp-name"

// Replays every bounded schedule against the production async selection class.
// Ranking is a controlled oracle with one match per nonempty scope. Persistence
// completes on an explicit event. Task's storage-error adapter is tested separately.
// PR 2323: discussion_r4520330057 (live scope and waiting callers).
const tools: ToolDoc[] = ["a", "b"].map((toolName) => ({ serverName: "catalog", toolName, description: "search" }))
const names = tools.map((tool) => buildMcpToolName(tool.serverName, tool.toolName))
const scopes = [[], [tools[0]], [tools[1]], tools]
const savedSelections = [undefined, [], [names[0]], [names[1]], names]
const MAX_DEPTH = 6 // two calls, each with at most one rank and one save
const MAX_STATES = 500

type Caller = 0 | 1
type Action = { kind: "call" | "rank" | "save"; caller: Caller }
type Fault = "none" | "stale-scope" | "shared-promise" | "trim-saved" | "unawaited-save"
type Invariant = "live-scope" | "keep-attached" | "saved-empty" | "persist-before-return"
interface Scenario {
	saved?: string[]
	scopes: ToolDoc[][]
}
interface Snapshot {
	names: string[]
	initialized: boolean
	phases: string[]
	ranking: Caller[]
	saving: Caller[]
	admitted: string[]
}
interface Replay {
	state: Snapshot
	actions: Action[]
	violation?: Invariant
	history: Snapshot[]
}

async function replay(scenario: Scenario, trace: Action[], fault: Fault): Promise<Replay> {
	const phases = ["new", "new"]
	const promises: Array<Promise<void> | undefined> = []
	const ranks = new Map<Caller, () => void>()
	const saves = new Map<Caller, () => void>()
	const admitted = new Set(scenario.saved)
	let failure: unknown
	const selection = new McpToolSelection(
		scenario.saved,
		(_query, scope) =>
			new Promise((resolve) => {
				assert.ok(scenario.scopes.includes(scope), "rank must use a caller's scope")
				const caller = scope === scenario.scopes[0] ? 0 : 1
				ranks.set(caller, () => {
					const result = scope.slice(0, 1).map((tool) => buildMcpToolName(tool.serverName, tool.toolName))
					if (fault === "trim-saved") selection.names.clear()
					for (const name of result) admitted.add(name)
					resolve(result)
				})
			}),
	)
	const snapshot = (): Snapshot => ({
		names: [...selection.names].sort(),
		initialized: selection.initialized,
		phases: [...phases],
		ranking: [...ranks.keys()].sort(),
		saving: [...saves.keys()].sort(),
		admitted: [...admitted].sort(),
	})
	const history: Snapshot[] = [snapshot()]

	for (const action of trace) {
		const caller = action.caller
		if (action.kind === "call") {
			assert.equal(phases[caller], "new")
			const preceding = promises.find((_promise, index) => phases[index] === "pending")
			phases[caller] = "pending"
			const promise =
				fault === "stale-scope" && selection.initialized
					? Promise.resolve()
					: fault === "shared-promise" && preceding
						? preceding
						: selection.initialize(scenario.scopes[caller], 1, "search", [], () => {
								const completion = new Promise<void>((resolve) => {
									saves.set(caller, resolve)
								})
								return fault === "unawaited-save" ? Promise.resolve() : completion
							})
			promises[caller] = promise
			void promise.then(
				() => {
					phases[caller] = "done"
				},
				(error: unknown) => {
					failure = error
				},
			)
		} else {
			const pending = action.kind === "rank" ? ranks : saves
			const resolve = pending.get(caller)
			assert.ok(resolve, `no pending ${action.kind} for caller ${caller}`)
			pending.delete(caller)
			resolve()
		}
		// One event-loop turn drains all production promise continuations, including
		// waiting callers. No arbitrary count of microtask ticks is assumed.
		await setImmediate()
		if (failure) throw failure
		history.push(snapshot())
	}
	const state = snapshot()
	let violation: Invariant | undefined
	if ([...saves.keys()].some((caller) => phases[caller] === "done")) violation = "persist-before-return"
	if (scenario.saved?.length === 0 && (selection.names.size > 0 || ranks.size > 0)) violation = "saved-empty"
	if ([...admitted].some((name) => !selection.names.has(name))) violation = "keep-attached"
	if (
		scenario.saved?.length !== 0 &&
		phases.some(
			(phase, caller) =>
				phase === "done" &&
				scenario.scopes[caller].length > 0 &&
				!scenario.scopes[caller].some((tool) =>
					selection.names.has(buildMcpToolName(tool.serverName, tool.toolName)),
				),
		)
	)
		violation ??= "live-scope"
	const actions: Action[] = []
	for (const caller of [0, 1] as const) {
		if (phases[caller] === "new") actions.push({ kind: "call", caller })
		if (ranks.has(caller)) actions.push({ kind: "rank", caller })
		if (saves.has(caller)) actions.push({ kind: "save", caller })
	}
	return { state, actions, violation, history }
}

function formatTrace(scenario: Scenario, trace: Action[], result: Replay): string {
	return JSON.stringify(
		{
			bounds: { depth: MAX_DEPTH, states: MAX_STATES },
			scenario,
			steps: result.history.map((state, index) => ({
				action: index === 0 ? "initial" : trace[index - 1],
				state,
			})),
		},
		null,
		2,
	)
}

const reached = new Set<string>()
async function explore(
	scenario: Scenario,
	fault: Fault,
): Promise<{ states: number; violation?: Invariant; trace?: Action[] }> {
	const queue: Action[][] = [[]]
	const visited = new Set<string>()
	for (let index = 0; index < queue.length; index++) {
		const trace = queue[index]
		const result = await replay(scenario, trace, fault)
		if (result.violation) {
			if (fault === "none") throw new Error(`${result.violation}\n${formatTrace(scenario, trace, result)}`)
			return { states: visited.size, violation: result.violation, trace }
		}
		const key = JSON.stringify(result.state)
		if (visited.has(key)) continue
		visited.add(key)
		assert.ok(visited.size <= MAX_STATES, "MCP selection state budget exceeded")
		if (fault === "none") {
			const state = result.state
			if (
				state.phases.every((phase) => phase === "pending") &&
				JSON.stringify(scenario.scopes[0]) !== JSON.stringify(scenario.scopes[1])
			)
				reached.add("waiting-different-scope")
			if (state.phases.every((phase) => phase === "done") && state.names.length === 2)
				reached.add("both-scopes-retained")
			if (
				scenario.saved?.length === 0 &&
				state.phases.every((phase) => phase === "done") &&
				state.names.length === 0
			)
				reached.add("saved-empty-retained")
			if (!scenario.saved && !state.initialized && state.phases.some((phase) => phase === "done"))
				reached.add("cold-empty-deferred")
			if (
				scenario.saved?.length &&
				state.ranking.some((caller) =>
					scenario.scopes[caller].every(
						(tool) => !scenario.saved?.includes(buildMcpToolName(tool.serverName, tool.toolName)),
					),
				)
			)
				reached.add("stale-scope-reranked")
		}
		assert.ok(
			trace.length < MAX_DEPTH || result.actions.length === 0,
			`MCP selection depth truncated\n${formatTrace(scenario, trace, result)}`,
		)
		assert.ok(
			result.actions.length > 0 || result.state.phases.every((phase) => phase === "done"),
			`MCP selection stalled\n${formatTrace(scenario, trace, result)}`,
		)
		for (const action of result.actions) queue.push([...trace, action])
	}
	return { states: visited.size }
}

async function main(): Promise<void> {
	let states = 0
	let scenarios = 0
	for (const saved of savedSelections) {
		for (const first of scopes) {
			for (const second of scopes) {
				// Separate arrays preserve caller identity even for equivalent scopes.
				states += (await explore({ saved, scopes: [[...first], [...second]] }, "none")).states
				scenarios++
			}
		}
	}
	for (const landmark of [
		"waiting-different-scope",
		"both-scopes-retained",
		"saved-empty-retained",
		"cold-empty-deferred",
		"stale-scope-reranked",
	]) {
		assert.ok(reached.has(landmark), `Unreachable MCP selection landmark: ${landmark}`)
	}
	for (const fault of ["stale-scope", "shared-promise", "trim-saved", "unawaited-save"] as const) {
		const scenario = {
			saved: fault === "shared-promise" ? undefined : [names[0]],
			scopes: [[tools[0]], [tools[1]]],
		}
		const result = await explore(scenario, fault)
		assert.equal(
			result.violation,
			fault === "trim-saved"
				? "keep-attached"
				: fault === "unawaited-save"
					? "persist-before-return"
					: "live-scope",
			`${fault} injection was not detected`,
		)
		console.log(
			`MCP selection injection ${fault}: ${result.violation}; ${result.trace?.map((action) => `${action.kind}(${action.caller})`).join(" -> ")}`,
		)
	}
	console.log(
		`MCP selection model passed: ${states} states, ${scenarios} scenarios, ${reached.size}/5 landmarks, 4/4 fault injections`,
	)
}

void main().catch((error: unknown) => {
	console.error(error)
	process.exitCode = 1
})
