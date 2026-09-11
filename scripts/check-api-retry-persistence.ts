type StopReason = "none" | "max_tokens"
type Phase = "requesting" | "waiting" | "confirming" | "terminal"

interface State {
	attempt: number
	phase: Phase
	visibleRetries: number
	messageId: string
	timestamp: number
	stopReason: StopReason
}

interface Transition {
	name: string
	next: State
}

const MAX_RETRIES = 3
const initial: State = {
	attempt: 0,
	phase: "requesting",
	visibleRetries: 0,
	messageId: "logical-user-turn",
	timestamp: 1,
	stopReason: "none",
}

function transitions(state: State): Transition[] {
	if (state.phase === "terminal") return []
	if (state.phase === "waiting") {
		return [{ name: "finish-visible-delay", next: { ...state, phase: "requesting" } }]
	}
	if (state.phase === "confirming") {
		return [
			{ name: "decline-retry", next: { ...state, phase: "terminal" } },
			{ name: "confirm-retry", next: { ...state, attempt: 0, phase: "requesting" } },
		]
	}
	if (state.stopReason === "max_tokens") {
		return [{ name: "surface-terminal-stop", next: { ...state, phase: "terminal" } }]
	}
	if (state.attempt >= MAX_RETRIES) {
		return [{ name: "exhaust-automatic-retries", next: { ...state, phase: "confirming" } }]
	}
	return [
		{
			name: "retry-visible",
			next: {
				...state,
				attempt: state.attempt + 1,
				visibleRetries: state.visibleRetries + 1,
				phase: "waiting",
			},
		},
		{
			name: "receive-max-tokens-empty",
			next: { ...state, stopReason: "max_tokens" },
		},
	]
}

const queue: Array<{ state: State; depth: number }> = [{ state: initial, depth: 0 }]
const seen = new Set<string>()
const landmarks = new Set<string>()

while (queue.length > 0) {
	const current = queue.shift()!
	const key = JSON.stringify(current.state)
	if (seen.has(key)) continue
	seen.add(key)

	const state = current.state
	if (state.attempt > MAX_RETRIES) throw new Error("automatic retry bound exceeded")
	if (state.visibleRetries < state.attempt) throw new Error("retry occurred without a visible announcement")
	if (state.messageId !== initial.messageId || state.timestamp !== initial.timestamp) {
		throw new Error("logical user-turn identity changed across retry/restoration")
	}
	if (state.stopReason === "max_tokens" && state.phase === "waiting") {
		throw new Error("terminal max_tokens response silently re-entered retry")
	}

	if (state.phase === "confirming" && state.attempt === MAX_RETRIES) landmarks.add("bounded-exhaustion")
	if (state.stopReason === "max_tokens" && state.phase === "terminal") landmarks.add("terminal-max-tokens")
	if (state.visibleRetries === MAX_RETRIES) landmarks.add("all-retries-visible")
	if (current.depth >= 10) continue
	for (const transition of transitions(state)) queue.push({ state: transition.next, depth: current.depth + 1 })
}

for (const landmark of ["bounded-exhaustion", "terminal-max-tokens", "all-retries-visible"]) {
	if (!landmarks.has(landmark)) throw new Error(`semantic landmark unreachable: ${landmark}`)
}

console.log(`API retry/persistence model check passed (${seen.size} states)`)
