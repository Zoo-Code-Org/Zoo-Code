type StopReason = "none" | "max_tokens"
type Phase = "requesting" | "waiting" | "confirming" | "terminal"

interface State {
	attempt: number
	phase: Phase
	visibleRetries: number
	messageId: string
	timestamp: number
	stopReason: StopReason
	turnPresent: boolean
	autoApprovalEnabled: boolean
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
	turnPresent: true,
	autoApprovalEnabled: true,
}

function transitions(state: State): Transition[] {
	if (state.phase === "terminal") return []
	if (state.phase === "waiting") {
		return [{ name: "finish-visible-delay", next: { ...state, phase: "requesting" } }]
	}
	if (state.phase === "confirming") {
		return [
			{ name: "decline-retry", next: { ...state, phase: "terminal", turnPresent: true } },
			{
				name: "confirm-retry",
				next: {
					...state,
					attempt: state.attempt >= MAX_RETRIES ? 0 : state.attempt + 1,
					visibleRetries: state.visibleRetries + 1,
					phase: "waiting",
					turnPresent: true,
				},
			},
		]
	}
	if (state.stopReason === "max_tokens") {
		return [{ name: "surface-terminal-stop", next: { ...state, phase: "terminal" } }]
	}
	if (state.attempt >= MAX_RETRIES) {
		return [{ name: "exhaust-automatic-retries", next: { ...state, phase: "confirming", turnPresent: false } }]
	}
	if (!state.autoApprovalEnabled) {
		return [{ name: "require-explicit-approval", next: { ...state, phase: "confirming", turnPresent: false } }]
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

const queue: Array<{ state: State; depth: number }> = [
	{ state: initial, depth: 0 },
	{ state: { ...initial, autoApprovalEnabled: false }, depth: 0 },
]
const seen = new Set<string>()
const landmarks = new Set<string>()

function preservesLogicalTurnIdentity(restored: Pick<State, "messageId" | "timestamp">): boolean {
	return restored.messageId === initial.messageId && restored.timestamp === initial.timestamp
}

if (!preservesLogicalTurnIdentity({ messageId: initial.messageId, timestamp: initial.timestamp })) {
	throw new Error("original logical user-turn identity was rejected")
}
if (preservesLogicalTurnIdentity({ messageId: "reconstructed-turn", timestamp: initial.timestamp + 1 })) {
	throw new Error("accidentally reconstructed logical user turn was accepted")
}
landmarks.add("reconstruction-rejected")

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
	if (state.phase === "terminal" && !state.turnPresent) throw new Error("logical user turn was not restored")
	if (!state.autoApprovalEnabled && state.phase === "waiting" && state.visibleRetries === 0) {
		throw new Error("retry bypassed explicit approval")
	}
	if (state.stopReason === "max_tokens" && state.phase === "waiting") {
		throw new Error("terminal max_tokens response silently re-entered retry")
	}

	if (state.phase === "confirming" && state.attempt === MAX_RETRIES) landmarks.add("bounded-exhaustion")
	if (state.stopReason === "max_tokens" && state.phase === "terminal") landmarks.add("terminal-max-tokens")
	if (state.visibleRetries === MAX_RETRIES) landmarks.add("all-retries-visible")
	if (!state.autoApprovalEnabled && state.phase === "confirming" && state.attempt === 0) {
		landmarks.add("manual-approval-boundary")
	}
	if (current.depth >= 10) continue
	for (const transition of transitions(state)) queue.push({ state: transition.next, depth: current.depth + 1 })
}

for (const landmark of [
	"bounded-exhaustion",
	"terminal-max-tokens",
	"all-retries-visible",
	"manual-approval-boundary",
	"reconstruction-rejected",
]) {
	if (!landmarks.has(landmark)) throw new Error(`semantic landmark unreachable: ${landmark}`)
}

console.log(`API retry/persistence model check passed (${seen.size} states)`)
