import {
	failedErrorCodeSchema,
	type ZooErrorCode,
	type ZooOutcome,
	zooErrorCodeSchema,
	zooOutcomeSchema,
} from "./outcomes.js"

export type SemanticTraceEntry = {
	type: string
	taskId?: string
	rootTaskId?: string
	parentTaskId?: string
	toolCallId?: string
	toolName?: string
	toolArguments?: Record<string, unknown>
	state?: "running" | "waiting" | "interrupted" | "completed" | "failed"
	cause?: "cancelled" | "timed_out" | "failed"
	askId?: string
	decision?: "approve" | "reject" | "needs_input"
	source?: "policy" | "user" | "auto" | "deny"
	requestId?: string
	cancellationReason?: "user" | "signal" | "timeout"
	content?: string
	prompt?: string
	outcome?: ZooOutcome
	errorCode?: ZooErrorCode
	resumable?: boolean
}

export type ParityScenario = {
	id: string
	prompt: string
	providerTurns: readonly string[]
	expected: readonly SemanticTraceEntry[]
}

export const parityScenarios: readonly ParityScenario[] = [
	{
		id: "text-completion",
		prompt: "Reply with the fixture greeting.",
		providerTurns: ["Hello from Zoo."],
		expected: [
			{ type: "task.created", rootTaskId: "root", taskId: "root", prompt: "Reply with the fixture greeting." },
			{ type: "task.started", rootTaskId: "root", taskId: "root" },
			{ type: "message.upsert", rootTaskId: "root", taskId: "root", content: "Hello from Zoo." },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "completed" },
			{ type: "task.result", rootTaskId: "root", taskId: "root", outcome: "completed" },
		],
	},
	{
		id: "tool-pairing",
		prompt: "Read README.md and report its title.",
		providerTurns: ["tool:read_file:call-1:README.md", "Zoo Code"],
		expected: [
			{
				type: "task.created",
				rootTaskId: "root",
				taskId: "root",
				prompt: "Read README.md and report its title.",
			},
			{ type: "task.started", rootTaskId: "root", taskId: "root" },
			{
				type: "tool.started",
				rootTaskId: "root",
				taskId: "root",
				toolCallId: "call-1",
				toolName: "read_file",
				toolArguments: { path: "README.md" },
			},
			{
				type: "tool.completed",
				rootTaskId: "root",
				taskId: "root",
				toolCallId: "call-1",
				toolName: "read_file",
				toolArguments: { path: "README.md" },
			},
			{ type: "message.upsert", rootTaskId: "root", taskId: "root", content: "Zoo Code" },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "completed" },
			{ type: "task.result", rootTaskId: "root", taskId: "root", outcome: "completed" },
		],
	},
	{
		id: "delegation-root-authority",
		prompt: "Delegate once, then finish the root task.",
		providerTurns: ["delegate:child", "child:done", "root:accepted"],
		expected: [
			{
				type: "task.created",
				rootTaskId: "root",
				taskId: "root",
				prompt: "Delegate once, then finish the root task.",
			},
			{ type: "task.started", rootTaskId: "root", taskId: "root" },
			{ type: "task.created", rootTaskId: "root", taskId: "child", parentTaskId: "root" },
			{ type: "task.delegated", rootTaskId: "root", taskId: "child", parentTaskId: "root" },
			{ type: "task.started", rootTaskId: "root", taskId: "child" },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "child", state: "completed" },
			{ type: "message.upsert", rootTaskId: "root", taskId: "root", content: "root:accepted" },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "completed" },
			{ type: "task.result", rootTaskId: "root", taskId: "root", outcome: "completed" },
		],
	},
	{
		id: "approval-causation",
		prompt: "Request approval.",
		providerTurns: ["ask:ask-1", "approve:ask-1:user:respond-1"],
		expected: [
			{ type: "task.created", rootTaskId: "root", taskId: "root", prompt: "Request approval." },
			{ type: "task.started", rootTaskId: "root", taskId: "root" },
			{ type: "ask.required", rootTaskId: "root", taskId: "root", askId: "ask-1" },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "waiting" },
			{
				type: "ask.resolved",
				rootTaskId: "root",
				taskId: "root",
				askId: "ask-1",
				decision: "approve",
				source: "user",
				requestId: "respond-1",
			},
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "running" },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "completed" },
			{ type: "task.result", rootTaskId: "root", taskId: "root", outcome: "completed" },
		],
	},
	{
		id: "cancelled",
		prompt: "Cancel deterministically.",
		providerTurns: ["cancel:cancel-1:user"],
		expected: [
			{ type: "task.created", rootTaskId: "root", taskId: "root", prompt: "Cancel deterministically." },
			{ type: "task.started", rootTaskId: "root", taskId: "root" },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "interrupted", cause: "cancelled" },
			{
				type: "task.result",
				rootTaskId: "root",
				taskId: "root",
				outcome: "cancelled",
				requestId: "cancel-1",
				cancellationReason: "user",
			},
		],
	},
	{
		id: "provider-failure",
		prompt: "Fail deterministically.",
		providerTurns: ["fail:provider_failed"],
		expected: [
			{ type: "task.created", rootTaskId: "root", taskId: "root", prompt: "Fail deterministically." },
			{ type: "task.started", rootTaskId: "root", taskId: "root" },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "failed" },
			{
				type: "task.result",
				rootTaskId: "root",
				taskId: "root",
				outcome: "failed",
				errorCode: "provider_failed",
			},
		],
	},
	{
		id: "needs-input",
		prompt: "Wait for deterministic input.",
		providerTurns: ["ask:ask-1", "needs_input"],
		expected: [
			{ type: "task.created", rootTaskId: "root", taskId: "root", prompt: "Wait for deterministic input." },
			{ type: "task.started", rootTaskId: "root", taskId: "root" },
			{ type: "ask.required", rootTaskId: "root", taskId: "root", askId: "ask-1" },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "waiting" },
			{ type: "task.result", rootTaskId: "root", taskId: "root", outcome: "needs_input", resumable: true },
		],
	},
]

export function compareSemanticTraces(
	expected: readonly SemanticTraceEntry[],
	actual: readonly SemanticTraceEntry[],
): { ok: true } | { ok: false; difference: string } {
	const canonicalize = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(canonicalize)
		if (value === null || typeof value !== "object") return value
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, entry]) => [key, canonicalize(entry)]),
		)
	}
	const expectedJson = JSON.stringify(canonicalize(expected))
	const actualJson = JSON.stringify(canonicalize(actual))
	return expectedJson === actualJson
		? { ok: true }
		: { ok: false, difference: `Expected ${expectedJson}\nReceived ${actualJson}` }
}

export function runDeterministicFakeProvider(scenario: ParityScenario): readonly SemanticTraceEntry[] {
	if (scenario.prompt.trim().length === 0) throw new Error("Fake-provider scenarios require a prompt")

	const trace: SemanticTraceEntry[] = [
		{ type: "task.created", rootTaskId: "root", taskId: "root", prompt: scenario.prompt },
		{ type: "task.started", rootTaskId: "root", taskId: "root" },
	]
	let result: SemanticTraceEntry = { type: "task.result", rootTaskId: "root", taskId: "root", outcome: "completed" }
	let terminalReached = false
	const activeChildren = new Set<string>()
	const usedTaskIds = new Set(["root"])
	const pendingAsks = new Set<string>()
	const usedAskIds = new Set<string>()
	const usedToolCallIds = new Set<string>()
	const usedRequestIds = new Set<string>()
	const requireSettledState = () => {
		if (activeChildren.size > 0 || pendingAsks.size > 0) {
			throw new Error("Fake-provider terminal outcomes require settled descendants and asks")
		}
	}
	for (const turn of scenario.providerTurns) {
		if (terminalReached) throw new Error("Fake-provider terminal directives must be the final turn")
		if (turn.startsWith("tool:")) {
			const separator1 = turn.indexOf(":")
			const separator2 = turn.indexOf(":", separator1 + 1)
			const separator3 = turn.indexOf(":", separator2 + 1)
			if (separator2 < 0 || separator3 < 0) throw new Error(`Invalid tool fixture: ${turn}`)
			const operation = turn.slice(separator1 + 1, separator2)
			const toolCallId = turn.slice(separator2 + 1, separator3)
			const argument = turn.slice(separator3 + 1)
			if (operation !== "read_file" || !toolCallId || !argument || usedToolCallIds.has(toolCallId)) {
				throw new Error(`Invalid tool fixture: ${turn}`)
			}
			usedToolCallIds.add(toolCallId)
			const tool = {
				rootTaskId: "root",
				taskId: "root",
				toolCallId,
				toolName: operation,
				toolArguments: { path: argument },
			}
			trace.push({ type: "tool.started", ...tool })
			trace.push({ type: "tool.completed", ...tool })
			continue
		}
		if (turn.startsWith("delegate:")) {
			const taskId = turn.slice("delegate:".length)
			if (!taskId || usedTaskIds.has(taskId)) throw new Error(`Invalid delegation fixture: ${turn}`)
			trace.push({ type: "task.created", rootTaskId: "root", taskId, parentTaskId: "root" })
			trace.push({ type: "task.delegated", rootTaskId: "root", taskId, parentTaskId: "root" })
			trace.push({ type: "task.started", rootTaskId: "root", taskId })
			activeChildren.add(taskId)
			usedTaskIds.add(taskId)
			continue
		}
		if (turn.endsWith(":done")) {
			const taskId = turn.slice(0, -":done".length)
			if (!taskId || !activeChildren.has(taskId)) throw new Error(`Invalid completion fixture: ${turn}`)
			trace.push({ type: "task.lifecycle", rootTaskId: "root", taskId, state: "completed" })
			activeChildren.delete(taskId)
			continue
		}
		if (turn.startsWith("ask:")) {
			const askId = turn.slice(4)
			if (!askId || usedAskIds.has(askId)) throw new Error(`Invalid ask fixture: ${turn}`)
			const wasUnblocked = pendingAsks.size === 0
			pendingAsks.add(askId)
			usedAskIds.add(askId)
			trace.push({ type: "ask.required", rootTaskId: "root", taskId: "root", askId })
			if (wasUnblocked) trace.push({ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "waiting" })
			continue
		}
		if (turn.startsWith("approve:")) {
			const fields = turn.split(":")
			const [, askId, source, requestId] = fields
			if (!askId || source !== "user" || !requestId || usedRequestIds.has(requestId)) {
				throw new Error(`Invalid approval fixture: ${turn}`)
			}
			if (fields.length !== 4) throw new Error(`Invalid approval fixture: ${turn}`)
			if (!pendingAsks.delete(askId)) throw new Error(`Approval references unknown ask: ${turn}`)
			usedRequestIds.add(requestId)
			trace.push({
				type: "ask.resolved",
				rootTaskId: "root",
				taskId: "root",
				askId,
				decision: "approve",
				source,
				requestId,
			})
			if (pendingAsks.size === 0) {
				trace.push({ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "running" })
			}
			continue
		}
		if (turn.startsWith("cancel:")) {
			requireSettledState()
			const fields = turn.split(":")
			const [, requestId, cancellationReason] = fields
			if (
				fields.length !== 3 ||
				!requestId ||
				usedRequestIds.has(requestId) ||
				!["user", "signal", "timeout"].includes(cancellationReason ?? "")
			)
				throw new Error(`Invalid cancellation fixture: ${turn}`)
			usedRequestIds.add(requestId)
			trace.push({ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "interrupted", cause: "cancelled" })
			result = {
				type: "task.result",
				rootTaskId: "root",
				taskId: "root",
				outcome: "cancelled",
				requestId,
				cancellationReason: cancellationReason as "user" | "signal" | "timeout",
			}
			terminalReached = true
			continue
		}
		if (turn.startsWith("fail:")) {
			requireSettledState()
			const errorCode = failedErrorCodeSchema.parse(turn.slice(5))
			trace.push({ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "failed" })
			result = { type: "task.result", rootTaskId: "root", taskId: "root", outcome: "failed", errorCode }
			terminalReached = true
			continue
		}
		if (turn.startsWith("timeout:")) {
			requireSettledState()
			const errorCode = zooErrorCodeSchema.parse(turn.slice(8))
			if (errorCode !== "task_timed_out" && errorCode !== "cleanup_timed_out") {
				throw new Error(`Invalid timeout fixture: ${turn}`)
			}
			trace.push({ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "interrupted", cause: "timed_out" })
			result = { type: "task.result", rootTaskId: "root", taskId: "root", outcome: "timed_out", errorCode }
			terminalReached = true
			continue
		}
		if (turn === "needs_input") {
			if (activeChildren.size > 0 || pendingAsks.size === 0) {
				throw new Error("needs_input requires a pending ask and settled descendants")
			}
			result = {
				type: "task.result",
				rootTaskId: "root",
				taskId: "root",
				outcome: "needs_input",
				resumable: true,
			}
			terminalReached = true
			continue
		}
		trace.push({ type: "message.upsert", rootTaskId: "root", taskId: "root", content: turn })
	}
	if (result.outcome === "completed") {
		requireSettledState()
		trace.push({ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "completed" })
	}
	trace.push(result)
	return trace
}

export function assertAuthoritativeRootResult(trace: readonly SemanticTraceEntry[], rootTaskId: string): boolean {
	const results = trace.filter((entry) => entry.type === "task.result")
	if (results.length !== 1) return false
	const result = results[0]!
	if (trace.at(-1) !== result) return false
	if (
		result.taskId !== rootTaskId ||
		result.rootTaskId !== rootTaskId ||
		!zooOutcomeSchema.safeParse(result.outcome).success ||
		(result.outcome === "needs_input" && result.resumable !== true) ||
		(result.resumable === true && !["needs_input", "cancelled", "timed_out"].includes(result.outcome ?? ""))
	) {
		return false
	}
	if (result.outcome === "failed") {
		return failedErrorCodeSchema.safeParse(result.errorCode).success && result.cancellationReason === undefined
	}
	if (result.outcome === "timed_out") {
		return (
			(result.errorCode === undefined || ["task_timed_out", "cleanup_timed_out"].includes(result.errorCode)) &&
			result.cancellationReason === undefined
		)
	}
	if (result.outcome === "cancelled") {
		return (
			result.errorCode === undefined &&
			result.cancellationReason !== undefined &&
			["user", "signal", "timeout"].includes(result.cancellationReason)
		)
	}
	return result.errorCode === undefined && result.cancellationReason === undefined
}
