import { isDeepStrictEqual } from "node:util"

import { z } from "zod"

import { validateCommandLifecycle } from "./command-lifecycle.js"
import type { HostCommand } from "./host-commands.js"
import type { HostEvent } from "./host-events.js"
import { failedErrorCodeSchema, zooErrorSchema, zooOutcomeSchema } from "./outcomes.js"
import {
	canonicalizeRedactionText,
	isSensitiveKey,
	requiresFailClosedRedaction,
	REDACTED,
	redactValue,
	type JsonValue,
} from "./redaction.js"
import {
	ZOO_HOST_PROTOCOL_VERSION,
	ZOO_PUBLIC_SCHEMA_VERSION,
	validateParentHello,
	type HostHello,
	type ParentHello,
} from "./version.js"

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()

export const usageSchema = strictObject({
	inputTokens: z.number().int().safe().nonnegative().optional(),
	outputTokens: z.number().int().safe().nonnegative().optional(),
	cacheReads: z.number().int().safe().nonnegative().optional(),
	cacheWrites: z.number().int().safe().nonnegative().optional(),
})

export const changedFileSchema = strictObject({ path: z.string().min(1), status: z.string().min(1) })

const rawZooRunResultSchema = strictObject({
	schemaVersion: z.literal(ZOO_PUBLIC_SCHEMA_VERSION),
	protocol: z.literal("zoo-run-result"),
	success: z.boolean(),
	outcome: zooOutcomeSchema,
	rootTaskId: z.string().min(1),
	currentTaskId: z.string().min(1).optional(),
	workspace: z.string().min(1),
	resumable: z.boolean(),
	content: z.string().optional(),
	error: zooErrorSchema.optional(),
	usage: usageSchema.optional(),
	cost: z.number().finite().nonnegative().optional(),
	elapsedMs: z.number().int().safe().nonnegative(),
	changedFiles: z.array(changedFileSchema).optional(),
	cancellationReason: z.enum(["user", "signal", "timeout"]).optional(),
}).superRefine((result, context) => {
	if (result.success !== (result.outcome === "completed")) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "success must match completed outcome" })
	}
	if (result.outcome === "failed" && result.error === undefined) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "failed results require an error" })
	}
	if (
		result.outcome === "failed" &&
		result.error !== undefined &&
		!failedErrorCodeSchema.safeParse(result.error.code).success
	) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "failed results require a non-timeout error code" })
	}
	if (
		result.outcome === "timed_out" &&
		result.error !== undefined &&
		!["task_timed_out", "cleanup_timed_out"].includes(result.error.code)
	) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "timed_out results require a timeout error code" })
	}
	if (!["failed", "timed_out"].includes(result.outcome) && result.error !== undefined) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: `${result.outcome} results cannot include an error` })
	}
	if ((result.outcome === "cancelled") !== (result.cancellationReason !== undefined)) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "cancelled results require a cancellation reason" })
	}
	if (result.resumable && !["needs_input", "cancelled", "timed_out"].includes(result.outcome)) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: `${result.outcome} results cannot be resumed` })
	}
	if (result.outcome === "needs_input" && !result.resumable) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "needs_input results must be resumable" })
	}
})

const redactError = <T extends { message: string; phase?: string }>(error: T): T => ({
	...error,
	message: String(redactValue(error.message)),
	...(error.phase === undefined ? {} : { phase: String(redactValue(error.phase)) }),
})
const redactRecord = (value: Record<string, JsonValue>): Record<string, JsonValue> => redactValue(value)

export const zooRunResultSchema = rawZooRunResultSchema.transform((result) => ({
	...result,
	content: result.content === undefined ? undefined : String(redactValue(result.content)),
	error: result.error === undefined ? undefined : redactError(result.error),
}))

export type ZooRunResult = z.infer<typeof zooRunResultSchema>

const eventBase = {
	v: z.literal(ZOO_PUBLIC_SCHEMA_VERSION),
	seq: z.number().int().safe().positive(),
	timestamp: z.string().datetime({ offset: true }),
	hostId: z.string().min(1),
	requestId: z.string().min(1).optional(),
}

const event = <const Type extends string, T extends z.ZodRawShape>(type: Type, shape: T) =>
	strictObject({ ...eventBase, type: z.literal(type), ...shape })

const taskEvent = <const Type extends string, T extends z.ZodRawShape>(type: Type, shape: T) =>
	strictObject({
		...eventBase,
		type: z.literal(type),
		rootTaskId: z.string().min(1),
		taskId: z.string().min(1),
		...shape,
	})

const systemInitEventSchema = event("system.init", {
	protocol: z.literal("zoo-stream"),
	hostProtocolVersion: z.literal(ZOO_HOST_PROTOCOL_VERSION),
	capabilities: z.array(z.string().min(1)),
	clientVersion: z.string().min(1),
	hostVersion: z.string().min(1),
})
const systemWarningEventSchema = event("system.warning", { code: z.string().min(1), message: z.string().min(1) })
const taskCreatedEventSchema = taskEvent("task.created", { parentTaskId: z.string().min(1).optional() })
const taskStartedEventSchema = taskEvent("task.started", {})
const taskLifecycleEventSchema = taskEvent("task.lifecycle", {
	state: z.enum(["running", "waiting", "interrupted", "completed", "failed"]),
	cause: z.enum(["cancelled", "timed_out", "failed"]).optional(),
})
const taskResumedEventSchema = taskEvent("task.resumed", {
	previousState: z.enum(["waiting", "interrupted"]),
})
const taskDelegatedEventSchema = taskEvent("task.delegated", {
	parentTaskId: z.string().min(1),
	childTaskId: z.string().min(1),
})
const messageUpsertEventSchema = taskEvent("message.upsert", {
	messageId: z.string().min(1),
	role: z.enum(["assistant", "user", "reasoning"]),
	content: z.string(),
	complete: z.boolean(),
})
const askRequiredEventSchema = taskEvent("ask.required", {
	askId: z.string().min(1),
	category: z.string().min(1),
	subject: z.string().min(1),
})
const askResolvedEventSchema = taskEvent("ask.resolved", {
	askId: z.string().min(1),
	decision: z.enum(["approve", "reject", "needs_input"]),
	source: z.enum(["policy", "user", "auto", "deny"]),
})
const askAbandonedEventSchema = taskEvent("ask.abandoned", {
	askId: z.string().min(1),
	reason: z.enum(["cancelled", "timed_out", "failed"]),
})
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		z.array(jsonValueSchema),
		z.record(jsonValueSchema),
	]),
)
const toolEventState = {
	toolCallId: z.string().min(1),
	name: z.string().min(1),
	arguments: z.record(jsonValueSchema).optional(),
	output: z.string().optional(),
}
const toolStartedEventSchema = taskEvent("tool.started", toolEventState)
const toolUpdatedEventSchema = taskEvent("tool.updated", toolEventState)
const toolCompletedEventSchema = taskEvent("tool.completed", toolEventState)
const toolFailedEventSchema = taskEvent("tool.failed", { ...toolEventState, error: zooErrorSchema })
const terminalOutputEventSchema = taskEvent("terminal.output", {
	toolCallId: z.string().min(1),
	stream: z.enum(["stdout", "stderr"]),
	delta: z.string(),
})
const terminalStatusEventSchema = taskEvent("terminal.status", {
	toolCallId: z.string().min(1),
	state: z.enum(["running", "background", "exited", "killed"]),
	exitCode: z.number().int().safe().nullable().optional(),
})
const mcpEventState = {
	operationId: z.string().min(1),
	server: z.string().min(1),
	operation: z.string().min(1),
	output: z.string().optional(),
}
const mcpStartedEventSchema = taskEvent("mcp.started", mcpEventState)
const mcpCompletedEventSchema = taskEvent("mcp.completed", mcpEventState)
const mcpFailedEventSchema = taskEvent("mcp.failed", { ...mcpEventState, error: zooErrorSchema })
const usageUpdatedEventSchema = taskEvent("usage.updated", {
	usage: usageSchema,
	cost: z.number().finite().nonnegative().optional(),
})
const taskResultEventSchema = taskEvent("task.result", { result: zooRunResultSchema })

export const rawZooStreamEventSchema = z
	.discriminatedUnion("type", [
		systemInitEventSchema,
		systemWarningEventSchema,
		taskCreatedEventSchema,
		taskStartedEventSchema,
		taskLifecycleEventSchema,
		taskResumedEventSchema,
		taskDelegatedEventSchema,
		messageUpsertEventSchema,
		askRequiredEventSchema,
		askResolvedEventSchema,
		askAbandonedEventSchema,
		toolStartedEventSchema,
		toolUpdatedEventSchema,
		toolCompletedEventSchema,
		toolFailedEventSchema,
		terminalOutputEventSchema,
		terminalStatusEventSchema,
		mcpStartedEventSchema,
		mcpCompletedEventSchema,
		mcpFailedEventSchema,
		usageUpdatedEventSchema,
		taskResultEventSchema,
	])
	.superRefine((streamEvent, context) => {
		if (streamEvent.type !== "terminal.status") return
		const terminal = streamEvent.state === "exited" || streamEvent.state === "killed"
		if (terminal === (streamEvent.exitCode === undefined)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: terminal
					? "Terminal states require an exit code or null"
					: "Nonterminal states cannot include an exit code",
			})
		}
	})

const redactStreamEvent = (streamEvent: z.infer<typeof rawZooStreamEventSchema>) => {
	switch (streamEvent.type) {
		case "system.warning":
			return { ...streamEvent, message: String(redactValue(streamEvent.message)) }
		case "message.upsert":
			return { ...streamEvent, content: String(redactValue(streamEvent.content)) }
		case "ask.required":
			return { ...streamEvent, subject: String(redactValue(streamEvent.subject)) }
		case "tool.started":
		case "tool.updated":
		case "tool.completed":
			return {
				...streamEvent,
				arguments: streamEvent.arguments === undefined ? undefined : redactRecord(streamEvent.arguments),
				output: streamEvent.output === undefined ? undefined : String(redactValue(streamEvent.output)),
			}
		case "tool.failed":
			return {
				...streamEvent,
				arguments: streamEvent.arguments === undefined ? undefined : redactRecord(streamEvent.arguments),
				output: streamEvent.output === undefined ? undefined : String(redactValue(streamEvent.output)),
				error: redactError(streamEvent.error),
			}
		case "terminal.output":
			return { ...streamEvent, delta: streamEvent.delta.length === 0 ? "" : REDACTED }
		case "mcp.started":
		case "mcp.completed":
			return {
				...streamEvent,
				output: streamEvent.output === undefined ? undefined : String(redactValue(streamEvent.output)),
			}
		case "mcp.failed":
			return {
				...streamEvent,
				output: streamEvent.output === undefined ? undefined : String(redactValue(streamEvent.output)),
				error: redactError(streamEvent.error),
			}
		default:
			return streamEvent
	}
}

export const zooStreamEventSchema = rawZooStreamEventSchema.transform(redactStreamEvent)

export type ZooStreamEvent = z.infer<typeof zooStreamEventSchema>
export type RawZooStreamEvent = z.infer<typeof rawZooStreamEventSchema>

const streamEventKey = (event: RawZooStreamEvent) =>
	JSON.stringify([
		event.hostId,
		event.seq,
		event.timestamp,
		event.type,
		event.requestId,
		"rootTaskId" in event ? event.rootTaskId : undefined,
		"taskId" in event ? event.taskId : undefined,
		"messageId" in event ? event.messageId : undefined,
		"askId" in event ? event.askId : undefined,
		"toolCallId" in event ? event.toolCallId : undefined,
		"operationId" in event ? event.operationId : undefined,
		"stream" in event ? event.stream : undefined,
	])

export type ZooStreamRedactor = {
	push: (event: RawZooStreamEvent) => ZooStreamEvent[]
	flush: () => ZooStreamEvent[]
	failClosed: (event?: RawZooStreamEvent) => ZooStreamEvent[]
}

export function createZooStreamRedactor(
	options: { maxPendingBytes?: number; maxPendingEvents?: number; maxPendingStreams?: number } = {},
): ZooStreamRedactor {
	const maxPendingBytes = options.maxPendingBytes ?? 64 * 1024
	const maxPendingEvents = options.maxPendingEvents ?? 256
	const maxPendingStreams = options.maxPendingStreams ?? 256
	type PendingOutput = {
		events: Array<z.infer<typeof terminalOutputEventSchema>>
		text: string
		textByStream: Partial<Record<z.infer<typeof terminalOutputEventSchema>["stream"], string>>
		pem: boolean
		overflowed: boolean
		secretQuotes: Partial<Record<z.infer<typeof terminalOutputEventSchema>["stream"], '"' | "'">>
		secretValueContinuations: Partial<Record<z.infer<typeof terminalOutputEventSchema>["stream"], true>>
	}
	const pendingOutputs = new Map<string, PendingOutput>()
	let failClosedAll = false
	const outputKey = (event: z.infer<typeof terminalOutputEventSchema>) =>
		JSON.stringify([event.hostId, event.rootTaskId, event.taskId, event.toolCallId])
	const hasUnmatchedPem = (text: string): boolean => {
		const openLabels: string[] = []
		for (const match of text.matchAll(/-----(BEGIN|END) ((?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK))-----/g)) {
			const [, boundary, label] = match
			if (boundary === "BEGIN" && label !== undefined) openLabels.push(label)
			else if (boundary === "END" && label !== undefined && openLabels.at(-1) === label) openLabels.pop()
		}
		return openLabels.length > 0
	}
	const incompleteSecretQuote = (text: string): '"' | "'" | undefined => {
		const match = text.match(/(?:^|[,{;\s])["']?([A-Za-z0-9_. -]+)["']?\s*[:=]\s*(["'])(?:\\.|[^\\])*$/i)
		if (match === null || !isSensitiveKey(match[1] ?? "") || (match[2] !== '"' && match[2] !== "'"))
			return undefined
		const opening = /[:=]\s*(["'])/.exec(match[0])
		if (opening === null) return undefined
		const value = match[0].slice(opening.index + opening[0].length)
		return new RegExp(`(?:^|[^\\\\])${match[2]}`).test(value) ? undefined : match[2]
	}
	const closesSecretQuote = (text: string, quote: '"' | "'"): boolean =>
		new RegExp(`(?:^|[^\\\\])${quote}`).test(text)
	const incompleteSecretValue = (text: string): boolean => {
		const line =
			text
				.replace(/\r?\n$/, "")
				.split(/\r?\n/)
				.at(-1) ?? ""
		const match = line.match(/(?:^|[,{;\s])["']?([A-Za-z0-9_. -]+)["']?\s*[:=]\s*$/i)
		return match !== null && isSensitiveKey(match[1] ?? "")
	}

	const emit = (key: string, replacement?: string): ZooStreamEvent[] => {
		const pending = pendingOutputs.get(key)
		if (pending === undefined) return []
		if (pending.events.length === 0) {
			pendingOutputs.delete(key)
			return []
		}
		const [first, ...rest] = pending.events
		const continuedSecret = Object.keys(pending.secretQuotes).length > 0
		const continuedValue = Object.keys(pending.secretValueContinuations).length > 0
		const secretQuotes = { ...pending.secretQuotes }
		const secretValueContinuations = { ...pending.secretValueContinuations }
		for (const [stream, text] of Object.entries(pending.textByStream) as Array<
			[z.infer<typeof terminalOutputEventSchema>["stream"], string]
		>) {
			const streamText = canonicalizeRedactionText(text)
			const activeQuote = secretQuotes[stream]
			if (activeQuote !== undefined) {
				if (closesSecretQuote(streamText, activeQuote)) delete secretQuotes[stream]
			} else {
				const quote = incompleteSecretQuote(streamText)
				if (quote !== undefined) secretQuotes[stream] = quote
			}
			if (secretValueContinuations[stream] === true) {
				if (!incompleteSecretValue(streamText)) delete secretValueContinuations[stream]
			} else if (incompleteSecretValue(streamText)) {
				secretValueContinuations[stream] = true
			}
		}
		const unterminatedSecret =
			pending.pem ||
			Object.keys(secretQuotes).length > 0 ||
			Object.keys(secretValueContinuations).length > 0 ||
			requiresFailClosedRedaction(pending.text)
		const delta = replacement ?? (unterminatedSecret ? REDACTED : String(redactValue(pending.text)))
		pendingOutputs.delete(key)
		if (Object.keys(secretQuotes).length > 0 || Object.keys(secretValueContinuations).length > 0) {
			pendingOutputs.set(key, {
				events: [],
				text: "",
				textByStream: {},
				pem: false,
				overflowed: false,
				secretQuotes,
				secretValueContinuations,
			})
		}
		return first === undefined
			? []
			: [
					{ ...first, delta: continuedSecret || continuedValue ? REDACTED : delta },
					...rest.map((event) => ({ ...event, delta: "" })),
				]
	}
	const emitOperation = (event: z.infer<typeof terminalStatusEventSchema>): ZooStreamEvent[] =>
		[...pendingOutputs.keys()]
			.filter((key) => {
				const [hostId, rootTaskId, taskId, toolCallId] = JSON.parse(key) as string[]
				return (
					hostId === event.hostId &&
					rootTaskId === event.rootTaskId &&
					taskId === event.taskId &&
					toolCallId === event.toolCallId
				)
			})
			.flatMap((key) => emit(key))

	return {
		push(event) {
			if (event.type !== "terminal.output") {
				const finalized =
					event.type === "terminal.status" && (event.state === "exited" || event.state === "killed")
						? emitOperation(event)
						: []
				return [...finalized, redactStreamEvent(event)]
			}
			if (event.delta.length === 0) return [{ ...event, delta: "" }]
			const key = outputKey(event)
			if (failClosedAll) return [{ ...event, delta: REDACTED }]
			let pending = pendingOutputs.get(key)
			if (pending === undefined) {
				if (pendingOutputs.size >= maxPendingStreams) {
					failClosedAll = true
					const buffered = [...pendingOutputs.keys()].flatMap((pendingKey) => emit(pendingKey, REDACTED))
					return [...buffered, { ...event, delta: event.delta.length === 0 ? "" : REDACTED }]
				}
				pending = {
					events: [],
					text: "",
					textByStream: {},
					pem: false,
					overflowed: false,
					secretQuotes: {},
					secretValueContinuations: {},
				}
				pendingOutputs.set(key, pending)
			}
			if (pending.overflowed) return [{ ...event, delta: event.delta.length === 0 ? "" : REDACTED }]
			pending.events.push(event)
			pending.text += event.delta
			pending.textByStream[event.stream] = (pending.textByStream[event.stream] ?? "") + event.delta
			pending.pem = hasUnmatchedPem(canonicalizeRedactionText(pending.text))
			if (
				new TextEncoder().encode(pending.text).byteLength > maxPendingBytes ||
				pending.events.length > maxPendingEvents
			) {
				pending.overflowed = true
				const redacted = emit(key, REDACTED)
				pendingOutputs.set(key, {
					events: [],
					text: "",
					textByStream: {},
					pem: false,
					overflowed: true,
					secretQuotes: {},
					secretValueContinuations: {},
				})
				return redacted
			}
			if (pending.pem) return []
			const boundary = pending.text.lastIndexOf("\n")
			const allEventsEndAtBoundary = boundary === pending.text.length - 1
			return allEventsEndAtBoundary ? emit(key) : []
		},
		flush: () => [...pendingOutputs.keys()].flatMap((key) => emit(key)),
		failClosed: (event) => {
			if (event === undefined) failClosedAll = true
			const keys = event?.type === "terminal.output" ? [outputKey(event)] : [...pendingOutputs.keys()]
			return keys.flatMap((key) => {
				const redacted = emit(key, REDACTED)
				pendingOutputs.set(key, {
					events: [],
					text: "",
					textByStream: {},
					pem: false,
					overflowed: true,
					secretQuotes: {},
					secretValueContinuations: {},
				})
				return redacted
			})
		},
	}
}

export const zooStreamSchema = z.array(rawZooStreamEventSchema).transform((events): ZooStreamEvent[] => {
	const redactor = createZooStreamRedactor()
	const positions = new Map<string, number[]>()
	for (const [index, event] of events.entries()) {
		const key = streamEventKey(event)
		const indices = positions.get(key) ?? []
		indices.push(index)
		positions.set(key, indices)
	}
	return [...events.flatMap((streamEvent) => redactor.push(streamEvent)), ...redactor.flush()]
		.map((event) => ({ event, index: positions.get(streamEventKey(event))?.shift() ?? Number.MAX_SAFE_INTEGER }))
		.sort((left, right) => left.index - right.index)
		.map(({ event }) => event)
})

export function validateNegotiatedStreamSession(
	host: HostHello,
	parent: ParentHello,
	events: readonly ZooStreamEvent[],
): { ok: true } | { ok: false; code: "protocol_incompatible"; message: string } {
	const negotiation = validateParentHello(host, parent)
	if (!negotiation.ok) return negotiation
	const init = events[0]
	const advertised = host.capabilities[String(parent.version)] ?? []
	if (
		init?.type !== "system.init" ||
		init.hostId !== host.hostId ||
		init.hostProtocolVersion !== parent.version ||
		init.clientVersion !== parent.clientVersion ||
		init.hostVersion !== host.buildVersion ||
		parent.requiredCapabilities.some((capability) => !init.capabilities.includes(capability)) ||
		init.capabilities.some((capability) => !advertised.includes(capability))
	) {
		return {
			ok: false,
			code: "protocol_incompatible",
			message: "system.init does not match the negotiated host session",
		}
	}
	return { ok: true }
}

export function validateStreamLifecycle(
	events: readonly ZooStreamEvent[],
	commands: readonly HostCommand[] = [],
	commandEvents: readonly HostEvent[] = [],
	lifecycleScope?: { initiatingCommandId: string; commandIds?: readonly string[] },
): { ok: true } | { ok: false; code: "protocol_gap" | "task_failed"; message: string } {
	if (events[0]?.type !== "system.init") {
		return { ok: false, code: "task_failed", message: "Stream must start with system.init" }
	}
	if (events[0].seq !== 1 || events.slice(1).some((streamEvent) => streamEvent.type === "system.init")) {
		return { ok: false, code: "protocol_gap", message: "Stream must contain one sequence-1 system.init" }
	}
	const hostId = events[0].hostId
	if (events.some((streamEvent) => streamEvent.hostId !== hostId)) {
		return { ok: false, code: "protocol_gap", message: "Stream cannot span multiple hosts" }
	}
	if (commandEvents.some((event) => event.hostId !== hostId)) {
		return { ok: false, code: "protocol_gap", message: "Command lifecycle cannot span multiple hosts" }
	}
	for (let index = 1; index < commandEvents.length; index += 1) {
		const expected = commandEvents[index - 1]!.seq + 1
		if (commandEvents[index]!.seq !== expected) {
			return { ok: false, code: "protocol_gap", message: `Expected host sequence ${expected}` }
		}
	}
	for (let index = 1; index < events.length; index += 1) {
		const expected = events[index - 1]!.seq + 1
		if (events[index]!.seq !== expected) {
			return { ok: false, code: "protocol_gap", message: `Expected sequence ${expected}` }
		}
	}
	const commandLifecycle = validateCommandLifecycle(commands, commandEvents, hostId)
	if (!commandLifecycle.ok) {
		return { ok: false, code: "protocol_gap", message: commandLifecycle.message }
	}
	const eventEnvelopes = commandEvents.filter((event) => event.type === "event")
	if (
		eventEnvelopes.length !== events.length ||
		events.some((streamEvent, index) => !isDeepStrictEqual(eventEnvelopes[index]?.event, streamEvent))
	) {
		return {
			ok: false,
			code: "protocol_gap",
			message: "Public events must exactly match their ordered host envelopes",
		}
	}
	const results = events.filter((event) => event.type === "task.result")
	if (results.length !== 1 || events.at(-1)?.type !== "task.result") {
		return { ok: false, code: "task_failed", message: "Accepted stream must end with exactly one task.result" }
	}
	const resultEvent = results[0]!
	const rootTaskId = resultEvent.result.rootTaskId
	if (resultEvent.rootTaskId !== rootTaskId || resultEvent.taskId !== rootTaskId) {
		return { ok: false, code: "task_failed", message: "task.result must identify the authoritative root task" }
	}
	const resumedEvents = events.filter((streamEvent) => streamEvent.type === "task.resumed")
	const initiatingCandidates = commands.filter(
		(command) => command.type === "task.start" || command.type === "task.resume",
	)
	const initiatingCommand = lifecycleScope
		? initiatingCandidates.find((command) => command.id === lifecycleScope.initiatingCommandId)
		: initiatingCandidates.length === 1
			? initiatingCandidates[0]
			: undefined
	const treeTaskIds = new Set(
		events
			.filter((event): event is ZooStreamEvent & { type: "task.created" } => event.type === "task.created")
			.map((event) => event.taskId),
	)
	const explicitlyScopedCommandIds =
		lifecycleScope?.commandIds === undefined ? undefined : new Set(lifecycleScope.commandIds)
	const targetsRunTree = (command: HostCommand): boolean => {
		if (command.id === initiatingCommand?.id) return true
		if (command.type === "task.resume" || command.type === "task.cancel") return command.rootTaskId === rootTaskId
		if (command.type === "task.input" || command.type === "ask.respond") return treeTaskIds.has(command.taskId)
		return false
	}
	const runCommands =
		explicitlyScopedCommandIds === undefined
			? commands
			: commands.filter((command) => explicitlyScopedCommandIds.has(command.id) || targetsRunTree(command))
	const startCommands = initiatingCommand?.type === "task.start" ? [initiatingCommand] : []
	const resumeCommands = initiatingCommand?.type === "task.resume" ? [initiatingCommand] : []
	if (initiatingCommand === undefined) {
		return { ok: false, code: "protocol_gap", message: "Run scope must identify exactly one initiating command" }
	}
	if (new Set(commands.map((command) => command.id)).size !== commands.length) {
		return { ok: false, code: "protocol_gap", message: "Command IDs must be globally unique" }
	}
	if (resumedEvents.length === 0) {
		const start = startCommands[0]
		if (
			startCommands.length !== 1 ||
			resumeCommands.length !== 0 ||
			start === undefined ||
			resultEvent.result.workspace !== start.workspace ||
			(resultEvent.result.outcome !== "cancelled" && resultEvent.requestId !== start.id)
		) {
			return {
				ok: false,
				code: "task_failed",
				message: "Fresh streams must match exactly one task.start command",
			}
		}
	} else if (resumedEvents.length !== 1 || startCommands.length !== 0 || resumeCommands.length !== 1) {
		return { ok: false, code: "task_failed", message: "Resume streams must match exactly one task.resume command" }
	}

	const pendingAsks = new Map<string, Set<string>>()
	const settledAsks = new Map<string, Set<string>>()
	const consumedResponseCommands = new Set<string>()
	const consumedInputCommands = new Set<string>()
	const abandonedAsks = new Map<string, Map<string, "cancelled" | "timed_out" | "failed">>()
	const taskTerminalCauses = new Map<string, "cancelled" | "timed_out" | "failed">()
	const taskStates = new Map<string, "running" | "waiting" | "interrupted" | "completed" | "failed">()
	const endedStates = new Set(["completed", "failed"])
	const settledStates = new Set(["interrupted", "completed", "failed"])
	const taskParents = new Map<string, string | null>()
	const createdTasks = new Set<string>()
	const delegatedTasks = new Set<string>()
	const resumedTasks = new Set<string>()
	const startedTasks = new Set<string>()
	type MessageState = { role: "assistant" | "user" | "reasoning"; complete: boolean }
	type ToolState = { state: "active" | "terminal"; name: string }
	type McpState = { state: "active" | "terminal"; server: string; operation: string }
	const toolStates = new Map<string, Map<string, ToolState>>()
	const terminalOperationStates = new Map<string, Map<string, "active" | "terminal">>()
	const mcpStates = new Map<string, Map<string, McpState>>()
	const messageStates = new Map<string, Map<string, MessageState>>()
	const approvalResumeCauses = new Map<string, string | undefined>()
	const scope = <T>(map: Map<string, Map<string, T>>, taskId: string): Map<string, T> => {
		const existing = map.get(taskId)
		if (existing !== undefined) return existing
		const created = new Map<string, T>()
		map.set(taskId, created)
		return created
	}
	const askScope = (taskId: string): Set<string> => {
		const existing = pendingAsks.get(taskId)
		if (existing !== undefined) return existing
		const created = new Set<string>()
		pendingAsks.set(taskId, created)
		return created
	}
	const setScope = (map: Map<string, Set<string>>, taskId: string): Set<string> => {
		const existing = map.get(taskId)
		if (existing !== undefined) return existing
		const created = new Set<string>()
		map.set(taskId, created)
		return created
	}
	const values = <T>(map: Map<string, Map<string, T>>): T[] =>
		[...map.values()].flatMap((entries) => [...entries.values()])
	const isDescendantOf = (taskId: string, parentTaskId: string): boolean => {
		let current = taskParents.get(taskId)
		while (current !== undefined && current !== null) {
			if (current === parentTaskId) return true
			current = taskParents.get(current)
		}
		return false
	}
	const hasPendingAskInAncestry = (taskId: string): boolean => {
		let current: string | null | undefined = taskId
		while (current !== undefined && current !== null) {
			if ((pendingAsks.get(current)?.size ?? 0) > 0) return true
			current = taskParents.get(current)
		}
		return false
	}
	const hostSequenceFor = (streamEvent: ZooStreamEvent): number | undefined => {
		const index = events.indexOf(streamEvent)
		return index < 0 ? undefined : eventEnvelopes[index]?.seq
	}
	const causalTerminal = (commandId: string, effect?: ZooStreamEvent): HostEvent | undefined => {
		const lifecycle = commandEvents.filter(
			(event) =>
				(event.type === "command.ack" || event.type === "command.done" || event.type === "command.error") &&
				event.commandId === commandId,
		)
		const acknowledgements = lifecycle.filter((event) => event.type === "command.ack")
		const terminals = lifecycle.filter((event) => event.type === "command.done" || event.type === "command.error")
		if (
			acknowledgements.length !== 1 ||
			terminals.length !== 1 ||
			acknowledgements[0]!.seq >= terminals[0]!.seq ||
			(effect !== undefined && (hostSequenceFor(effect) ?? 0) <= acknowledgements[0]!.seq)
		) {
			return undefined
		}
		return terminals[0]
	}
	const inputResumeCause = (streamEvent: ZooStreamEvent & { taskId: string }): boolean => {
		const { taskId, requestId } = streamEvent
		if (requestId === undefined || consumedInputCommands.has(requestId)) return false
		const input = runCommands.find(
			(command) => command.type === "task.input" && command.id === requestId && command.taskId === taskId,
		)
		const terminal = causalTerminal(requestId, streamEvent)
		const valid =
			input !== undefined &&
			terminal?.type === "command.done" &&
			terminal.data.commandType === "task.input" &&
			terminal.data.taskId === taskId
		if (valid) consumedInputCommands.add(requestId)
		return valid
	}
	const approvalResumeCause = (taskId: string, requestId: string | undefined): boolean => {
		if (!approvalResumeCauses.has(taskId) || approvalResumeCauses.get(taskId) !== requestId) return false
		approvalResumeCauses.delete(taskId)
		return true
	}
	for (const response of runCommands.filter((command) => command.type === "ask.respond")) {
		if (causalTerminal(response.id) === undefined) {
			return {
				ok: false,
				code: "protocol_gap",
				message: "Every ask response requires ACK and one terminal response",
			}
		}
	}
	const initiatingTerminal = initiatingCommand === undefined ? undefined : causalTerminal(initiatingCommand.id)
	if (initiatingTerminal?.type !== "command.done") {
		return { ok: false, code: "protocol_gap", message: "Task stream requires a successful initiating command" }
	}
	if (
		initiatingCommand?.type === "task.start" &&
		(initiatingTerminal.data.commandType !== "task.start" ||
			initiatingTerminal.data.task.rootTaskId !== rootTaskId ||
			initiatingTerminal.data.task.taskId !== rootTaskId)
	) {
		return { ok: false, code: "task_failed", message: "task.start completion does not match the stream root" }
	}
	if (
		initiatingCommand?.type === "task.resume" &&
		(initiatingTerminal.data.commandType !== "task.resume" ||
			initiatingTerminal.data.task.rootTaskId !== rootTaskId ||
			initiatingTerminal.data.task.taskId !== initiatingCommand.taskId)
	) {
		return { ok: false, code: "task_failed", message: "task.resume completion does not match the resumed task" }
	}
	for (const streamEvent of events) {
		if ("rootTaskId" in streamEvent && streamEvent.rootTaskId !== rootTaskId) {
			return {
				ok: false,
				code: "task_failed",
				message: "All task events must identify the authoritative root task",
			}
		}
		if (!("taskId" in streamEvent) || streamEvent.type === "task.result") continue

		if (streamEvent.type === "task.created") {
			const parentTaskId = streamEvent.parentTaskId ?? null
			if (
				(streamEvent.taskId === rootTaskId) !== (parentTaskId === null) ||
				(parentTaskId !== null && !taskParents.has(parentTaskId)) ||
				(parentTaskId !== null && settledStates.has(taskStates.get(parentTaskId) ?? "")) ||
				createdTasks.has(streamEvent.taskId)
			) {
				return {
					ok: false,
					code: "task_failed",
					message: `Invalid creation edge for task ${streamEvent.taskId}`,
				}
			}
			if (taskParents.has(streamEvent.taskId) && taskParents.get(streamEvent.taskId) !== parentTaskId) {
				return { ok: false, code: "task_failed", message: `Conflicting parent for task ${streamEvent.taskId}` }
			}
			taskParents.set(streamEvent.taskId, parentTaskId)
			createdTasks.add(streamEvent.taskId)
			if (
				streamEvent.taskId === rootTaskId &&
				resumedEvents.length === 0 &&
				streamEvent.requestId !== startCommands[0]?.id
			) {
				return { ok: false, code: "task_failed", message: "Root creation must match its task.start request" }
			}
			if (streamEvent.taskId === rootTaskId && causalTerminal(initiatingCommand.id, streamEvent) === undefined) {
				return { ok: false, code: "protocol_gap", message: "Task creation must follow its command ACK" }
			}
		} else if (streamEvent.type === "task.delegated") {
			const reconstructingResumeTree = resumedEvents.length === 1 && resumedTasks.size === 0
			if (
				streamEvent.taskId !== streamEvent.childTaskId ||
				streamEvent.childTaskId === rootTaskId ||
				streamEvent.childTaskId === streamEvent.parentTaskId ||
				!createdTasks.has(streamEvent.parentTaskId) ||
				!createdTasks.has(streamEvent.childTaskId) ||
				settledStates.has(taskStates.get(streamEvent.parentTaskId) ?? "") ||
				(taskStates.get(streamEvent.parentTaskId) !== "running" && !reconstructingResumeTree) ||
				delegatedTasks.has(streamEvent.childTaskId)
			) {
				return {
					ok: false,
					code: "task_failed",
					message: `Invalid delegation edge for task ${streamEvent.childTaskId}`,
				}
			}
			if (
				taskParents.has(streamEvent.childTaskId) &&
				taskParents.get(streamEvent.childTaskId) !== streamEvent.parentTaskId
			) {
				return {
					ok: false,
					code: "task_failed",
					message: `Conflicting parent for task ${streamEvent.childTaskId}`,
				}
			}
			taskParents.set(streamEvent.childTaskId, streamEvent.parentTaskId)
			delegatedTasks.add(streamEvent.childTaskId)
		} else if (!taskParents.has(streamEvent.taskId)) {
			return { ok: false, code: "task_failed", message: `Event references unknown task ${streamEvent.taskId}` }
		}
		if (
			streamEvent.taskId !== rootTaskId &&
			streamEvent.type !== "task.created" &&
			streamEvent.type !== "task.delegated" &&
			!delegatedTasks.has(streamEvent.taskId)
		) {
			return {
				ok: false,
				code: "task_failed",
				message: `Task ${streamEvent.taskId} emitted an event before delegation`,
			}
		}

		const previousState = taskStates.get(streamEvent.taskId)
		if (
			previousState === "running" &&
			(pendingAsks.get(streamEvent.taskId)?.size ?? 0) > 0 &&
			!(streamEvent.type === "task.lifecycle" && streamEvent.state === "waiting")
		) {
			return { ok: false, code: "task_failed", message: "A pending approval must transition its task to waiting" }
		}
		if (
			approvalResumeCauses.has(streamEvent.taskId) &&
			!(streamEvent.type === "task.lifecycle" && streamEvent.state === "running")
		) {
			approvalResumeCauses.delete(streamEvent.taskId)
		}
		if (
			(previousState !== undefined && endedStates.has(previousState)) ||
			(previousState === "interrupted" && streamEvent.type !== "task.resumed")
		) {
			return {
				ok: false,
				code: "task_failed",
				message: `Task ${streamEvent.taskId} emitted an event after termination`,
			}
		}
		if (streamEvent.type === "task.started") {
			const parentTaskId = taskParents.get(streamEvent.taskId)
			const reconstructingResumedDescendant =
				resumedEvents.length === 1 &&
				resumeCommands[0]?.taskId === streamEvent.taskId &&
				resumedTasks.has(streamEvent.taskId)
			if (
				startedTasks.has(streamEvent.taskId) ||
				(previousState !== undefined && previousState !== "running") ||
				(resumeCommands[0]?.taskId === streamEvent.taskId && !resumedTasks.has(streamEvent.taskId)) ||
				(parentTaskId !== null &&
					parentTaskId !== undefined &&
					taskStates.get(parentTaskId) !== "running" &&
					!reconstructingResumedDescendant)
			) {
				return {
					ok: false,
					code: "task_failed",
					message: `Invalid start transition for task ${streamEvent.taskId}`,
				}
			}
			startedTasks.add(streamEvent.taskId)
			taskStates.set(streamEvent.taskId, "running")
		}
		if (streamEvent.type === "task.lifecycle") {
			const resume = resumeCommands[0]
			const reconstructingPredecessor =
				!startedTasks.has(streamEvent.taskId) &&
				resume?.taskId === streamEvent.taskId &&
				!resumedTasks.has(streamEvent.taskId) &&
				(streamEvent.state === "waiting" || streamEvent.state === "interrupted")
			if (!startedTasks.has(streamEvent.taskId) && !reconstructingPredecessor) {
				return {
					ok: false,
					code: "task_failed",
					message: "Task lifecycle requires an ordered task.started event",
				}
			}
			const transitionAllowed =
				reconstructingPredecessor ||
				(previousState === "running" &&
					["waiting", "interrupted", "completed", "failed"].includes(streamEvent.state)) ||
				(previousState === "waiting" &&
					(["interrupted", "failed"].includes(streamEvent.state) ||
						(streamEvent.state === "running" &&
							!hasPendingAskInAncestry(streamEvent.taskId) &&
							(approvalResumeCause(streamEvent.taskId, streamEvent.requestId) ||
								inputResumeCause(streamEvent)))))
			if (!transitionAllowed) {
				return {
					ok: false,
					code: "task_failed",
					message: `Invalid lifecycle transition for task ${streamEvent.taskId}`,
				}
			}
			if (
				(streamEvent.state === "running" ||
					streamEvent.state === "waiting" ||
					streamEvent.state === "completed") &&
				streamEvent.cause !== undefined
			) {
				return { ok: false, code: "task_failed", message: "Lifecycle cause contradicts task state" }
			}
			if (streamEvent.state === "failed" && streamEvent.cause !== undefined && streamEvent.cause !== "failed") {
				return { ok: false, code: "task_failed", message: "Lifecycle cause contradicts task state" }
			}
			if (streamEvent.state === "interrupted" && streamEvent.cause === "failed") {
				return { ok: false, code: "task_failed", message: "Lifecycle cause contradicts task state" }
			}
			if ((pendingAsks.get(streamEvent.taskId)?.size ?? 0) > 0 && settledStates.has(streamEvent.state)) {
				return { ok: false, code: "task_failed", message: "A task with a pending ask cannot terminate" }
			}
			if (
				settledStates.has(streamEvent.state) &&
				[...createdTasks].some(
					(taskId) =>
						isDescendantOf(taskId, streamEvent.taskId) && !settledStates.has(taskStates.get(taskId) ?? ""),
				)
			) {
				return { ok: false, code: "task_failed", message: "A task cannot terminate before its descendants" }
			}
			taskStates.set(streamEvent.taskId, streamEvent.state)
			if (streamEvent.cause !== undefined) taskTerminalCauses.set(streamEvent.taskId, streamEvent.cause)
		}
		if (streamEvent.type === "task.resumed") {
			const resume = resumeCommands[0]
			if (
				resume === undefined ||
				resume.id !== streamEvent.requestId ||
				resume.taskId !== streamEvent.taskId ||
				resume.rootTaskId !== streamEvent.rootTaskId ||
				(resultEvent.result.outcome !== "cancelled" && resultEvent.requestId !== resume.id) ||
				resumedTasks.size > 0 ||
				previousState !== streamEvent.previousState
			) {
				return {
					ok: false,
					code: "task_failed",
					message: "task.resumed must match reconstructed persisted state",
				}
			}
			if (causalTerminal(resume!.id, streamEvent) === undefined) {
				return { ok: false, code: "protocol_gap", message: "Task resume must follow its command ACK" }
			}
			resumedTasks.add(streamEvent.taskId)
			taskStates.set(streamEvent.taskId, "running")
		}
		if (
			[
				"message.upsert",
				"ask.required",
				"ask.resolved",
				"ask.abandoned",
				"tool.started",
				"tool.updated",
				"tool.completed",
				"tool.failed",
				"terminal.output",
				"terminal.status",
				"mcp.started",
				"mcp.completed",
				"mcp.failed",
				"usage.updated",
			].includes(streamEvent.type) &&
			!startedTasks.has(streamEvent.taskId)
		) {
			return { ok: false, code: "task_failed", message: "Task operation requires an ordered task.started event" }
		}
		if (
			[
				"tool.started",
				"tool.updated",
				"tool.completed",
				"tool.failed",
				"terminal.output",
				"terminal.status",
				"mcp.started",
				"mcp.completed",
				"mcp.failed",
			].includes(streamEvent.type) &&
			(taskStates.get(streamEvent.taskId) !== "running" || hasPendingAskInAncestry(streamEvent.taskId))
		) {
			return { ok: false, code: "task_failed", message: "Task operations require an unblocked running task" }
		}
		if (streamEvent.type === "message.upsert") {
			const matchingInput = runCommands.find(
				(command) => command.type === "task.input" && command.id === streamEvent.requestId,
			)
			if (streamEvent.role === "user" && matchingInput !== undefined && !inputResumeCause(streamEvent)) {
				return {
					ok: false,
					code: "task_failed",
					message: "Task input must cause exactly one matching user message",
				}
			}
			const messages = scope(messageStates, streamEvent.taskId)
			const previous = messages.get(streamEvent.messageId)
			if (previous?.complete === true || (previous !== undefined && previous.role !== streamEvent.role)) {
				return {
					ok: false,
					code: "task_failed",
					message: `Invalid update for message ${streamEvent.messageId}`,
				}
			}
			messages.set(streamEvent.messageId, { role: streamEvent.role, complete: streamEvent.complete })
		}
		if (streamEvent.type === "ask.required") {
			const asks = askScope(streamEvent.taskId)
			if (
				taskStates.get(streamEvent.taskId) !== "running" ||
				asks.has(streamEvent.askId) ||
				settledAsks.get(streamEvent.taskId)?.has(streamEvent.askId) === true
			) {
				return { ok: false, code: "task_failed", message: `Ask ${streamEvent.askId} was already used` }
			}
			asks.add(streamEvent.askId)
		}
		if (streamEvent.type === "ask.resolved") {
			if (taskStates.get(streamEvent.taskId) !== "waiting") {
				return { ok: false, code: "task_failed", message: "Ask resolution requires a waiting task" }
			}
			if (!pendingAsks.get(streamEvent.taskId)?.delete(streamEvent.askId)) {
				return { ok: false, code: "task_failed", message: `Ask ${streamEvent.askId} was not pending` }
			}
			if (
				(streamEvent.source === "deny" && streamEvent.decision !== "reject") ||
				(streamEvent.source === "auto" && streamEvent.decision !== "approve")
			) {
				return { ok: false, code: "task_failed", message: "Ask decision contradicts its resolution source" }
			}
			const responseCommands = runCommands.filter(
				(command) =>
					command.type === "ask.respond" &&
					command.taskId === streamEvent.taskId &&
					command.askId === streamEvent.askId,
			)
			if (streamEvent.source === "user" || responseCommands.length > 0) {
				const response = responseCommands.find(
					(command) => !consumedResponseCommands.has(command.id) && command.id === streamEvent.requestId,
				)
				const expectedDecision =
					response?.type === "ask.respond"
						? { approve: "approve", reject: "reject", message: "needs_input" }[response.response]
						: undefined
				const completion = response === undefined ? undefined : causalTerminal(response.id, streamEvent)
				if (
					expectedDecision !== streamEvent.decision ||
					completion?.type !== "command.done" ||
					completion.data.commandType !== "ask.respond" ||
					completion.data.taskId !== streamEvent.taskId ||
					completion.data.askId !== streamEvent.askId
				) {
					return {
						ok: false,
						code: "task_failed",
						message: "Ask resolution requires its successful response command",
					}
				}
				if (response !== undefined) consumedResponseCommands.add(response.id)
			}
			setScope(settledAsks, streamEvent.taskId).add(streamEvent.askId)
			approvalResumeCauses.set(streamEvent.taskId, streamEvent.requestId)
		}
		if (streamEvent.type === "ask.abandoned") {
			if (!pendingAsks.get(streamEvent.taskId)?.delete(streamEvent.askId)) {
				return { ok: false, code: "task_failed", message: `Ask ${streamEvent.askId} was not pending` }
			}
			scope(abandonedAsks, streamEvent.taskId).set(streamEvent.askId, streamEvent.reason)
			setScope(settledAsks, streamEvent.taskId).add(streamEvent.askId)
		}

		if (streamEvent.type === "tool.started") {
			const tools = scope(toolStates, streamEvent.taskId)
			if (tools.has(streamEvent.toolCallId))
				return { ok: false, code: "task_failed", message: "Tool operation started twice" }
			tools.set(streamEvent.toolCallId, { state: "active", name: streamEvent.name })
		} else if (
			streamEvent.type === "tool.updated" ||
			streamEvent.type === "tool.completed" ||
			streamEvent.type === "tool.failed"
		) {
			const tools = scope(toolStates, streamEvent.taskId)
			const tool = tools.get(streamEvent.toolCallId)
			if (tool?.state !== "active" || tool.name !== streamEvent.name) {
				return { ok: false, code: "task_failed", message: "Tool event requires an active operation" }
			}
			if (streamEvent.type === "tool.completed" || streamEvent.type === "tool.failed")
				tools.set(streamEvent.toolCallId, { ...tool, state: "terminal" })
		}

		if (streamEvent.type === "terminal.status") {
			const operations = scope(terminalOperationStates, streamEvent.taskId)
			const state = operations.get(streamEvent.toolCallId)
			if (streamEvent.state === "running") {
				if (state !== undefined)
					return { ok: false, code: "task_failed", message: "Terminal operation started twice" }
				operations.set(streamEvent.toolCallId, "active")
			} else if (state !== "active") {
				return { ok: false, code: "task_failed", message: "Terminal status requires an active operation" }
			} else if (streamEvent.state === "exited" || streamEvent.state === "killed") {
				operations.set(streamEvent.toolCallId, "terminal")
			}
		} else if (
			streamEvent.type === "terminal.output" &&
			terminalOperationStates.get(streamEvent.taskId)?.get(streamEvent.toolCallId) !== "active"
		) {
			return { ok: false, code: "task_failed", message: "Terminal output requires an active operation" }
		}

		if (streamEvent.type === "mcp.started") {
			const operations = scope(mcpStates, streamEvent.taskId)
			if (operations.has(streamEvent.operationId))
				return { ok: false, code: "task_failed", message: "MCP operation started twice" }
			operations.set(streamEvent.operationId, {
				state: "active",
				server: streamEvent.server,
				operation: streamEvent.operation,
			})
		} else if (streamEvent.type === "mcp.completed" || streamEvent.type === "mcp.failed") {
			const operations = scope(mcpStates, streamEvent.taskId)
			const operation = operations.get(streamEvent.operationId)
			if (
				operation?.state !== "active" ||
				operation.server !== streamEvent.server ||
				operation.operation !== streamEvent.operation
			) {
				return { ok: false, code: "task_failed", message: "MCP result requires an active operation" }
			}
			operations.set(streamEvent.operationId, { ...operation, state: "terminal" })
		}
	}
	const pendingAskCount = [...pendingAsks.values()].reduce((count, asks) => count + asks.size, 0)
	if (pendingAskCount > 0 && resultEvent.result.outcome !== "needs_input") {
		return { ok: false, code: "task_failed", message: "Terminal stream contains unresolved asks" }
	}
	if (resultEvent.result.outcome === "needs_input" && pendingAskCount === 0) {
		return { ok: false, code: "task_failed", message: "needs_input requires an unresolved actionable ask" }
	}
	if (
		resultEvent.result.outcome === "needs_input" &&
		[...pendingAsks].some(([taskId, asks]) => asks.size > 0 && taskStates.get(taskId) !== "waiting")
	) {
		return { ok: false, code: "task_failed", message: "Pending asks must belong to waiting tasks" }
	}
	if (resumeCommands.length !== resumedTasks.size) {
		return { ok: false, code: "task_failed", message: "Every resume command must reconstruct one resumed task" }
	}
	if (
		[...abandonedAsks].some(([taskId, asks]) =>
			[...asks.values()].some((reason) => taskTerminalCauses.get(taskId) !== reason),
		)
	) {
		return { ok: false, code: "task_failed", message: "Ask abandonment contradicts its task lifecycle" }
	}
	const expectedState = {
		completed: "completed",
		needs_input: "waiting",
		cancelled: "interrupted",
		timed_out: "interrupted",
		failed: "failed",
	} as const
	if (
		!createdTasks.has(rootTaskId) ||
		[...taskParents.keys()].some((taskId) => !createdTasks.has(taskId)) ||
		[...createdTasks].some((taskId) => taskId !== rootTaskId && !delegatedTasks.has(taskId))
	) {
		return {
			ok: false,
			code: "task_failed",
			message: "Every task in the authoritative tree must be created and every descendant delegated",
		}
	}
	if (resultEvent.result.currentTaskId !== undefined && !createdTasks.has(resultEvent.result.currentTaskId)) {
		return {
			ok: false,
			code: "task_failed",
			message: "currentTaskId must identify a task in the authoritative tree",
		}
	}
	const rootState = taskStates.get(rootTaskId)
	if (rootState !== expectedState[resultEvent.result.outcome]) {
		return { ok: false, code: "task_failed", message: "Root lifecycle state contradicts task.result" }
	}
	const expectedInterruptedCause =
		resultEvent.result.outcome === "cancelled"
			? "cancelled"
			: resultEvent.result.outcome === "timed_out"
				? "timed_out"
				: undefined
	if (expectedInterruptedCause !== undefined && taskTerminalCauses.get(rootTaskId) !== expectedInterruptedCause) {
		return { ok: false, code: "task_failed", message: "Root lifecycle cause contradicts task.result" }
	}
	const allowedDescendantStates = {
		completed: new Set(["completed"]),
		needs_input: new Set(["waiting", "interrupted", "completed", "failed"]),
		cancelled: new Set(["interrupted", "completed", "failed"]),
		timed_out: new Set(["interrupted", "completed", "failed"]),
		failed: new Set(["interrupted", "completed", "failed"]),
	}[resultEvent.result.outcome]
	if (
		[...createdTasks].some(
			(taskId) => taskId !== rootTaskId && !allowedDescendantStates.has(taskStates.get(taskId) ?? "running"),
		)
	) {
		return {
			ok: false,
			code: "task_failed",
			message: "Every descendant task must reach a compatible settled state",
		}
	}
	if (
		[...values(toolStates), ...values(mcpStates)].some((operation) => operation.state === "active") ||
		values(terminalOperationStates).includes("active")
	) {
		return { ok: false, code: "task_failed", message: "Terminal stream contains active operations" }
	}
	if (resultEvent.result.outcome === "completed" && values(messageStates).some((message) => !message.complete)) {
		return { ok: false, code: "task_failed", message: "Completed streams cannot contain partial messages" }
	}
	const unconsumedResponses = runCommands.some((command) => {
		if (command.type !== "ask.respond" || consumedResponseCommands.has(command.id)) return false
		return causalTerminal(command.id)?.type === "command.done"
	})
	if (unconsumedResponses) {
		return { ok: false, code: "task_failed", message: "Every ask response command must settle its matching ask" }
	}
	const invalidInputs = runCommands.some((command) => {
		if (command.type !== "task.input") return false
		const terminal = causalTerminal(command.id)
		if (terminal?.type !== "command.done") return false
		return (
			!createdTasks.has(command.taskId) ||
			terminal.data.commandType !== "task.input" ||
			terminal.data.taskId !== command.taskId ||
			!consumedInputCommands.has(command.id)
		)
	})
	if (invalidInputs) {
		return {
			ok: false,
			code: "task_failed",
			message: "Every successful task input must have one matching tree effect",
		}
	}
	const cancelCommands = runCommands.filter(
		(command) => command.type === "task.cancel" && command.rootTaskId === rootTaskId,
	)
	const cancellationTerminals = cancelCommands.map((command) => causalTerminal(command.id))
	if (cancellationTerminals.some((terminal) => terminal === undefined)) {
		return {
			ok: false,
			code: "task_failed",
			message: "Every cancellation command requires ACK and one terminal response",
		}
	}
	if (
		cancellationTerminals.some(
			(terminal) =>
				terminal?.type === "command.done" &&
				(terminal.data.commandType !== "task.cancel" || terminal.data.rootTaskId !== rootTaskId),
		)
	) {
		return { ok: false, code: "task_failed", message: "Cancellation completion does not match its command" }
	}
	const acceptedCancellations = cancelCommands.filter(
		(_command, index) => cancellationTerminals[index]?.type === "command.done",
	)
	if (acceptedCancellations.length > 0 && resultEvent.result.outcome !== "cancelled") {
		return { ok: false, code: "task_failed", message: "An accepted cancellation must interrupt the result" }
	}
	if (acceptedCancellations.length > 1) {
		return { ok: false, code: "task_failed", message: "A task can accept only one cancellation command" }
	}
	if (resultEvent.result.outcome === "cancelled") {
		const cancellation = acceptedCancellations.find(
			(command) =>
				command.type === "task.cancel" &&
				command.id === resultEvent.requestId &&
				command.rootTaskId === rootTaskId &&
				command.reason === resultEvent.result.cancellationReason,
		)
		if (cancellation === undefined) {
			return {
				ok: false,
				code: "task_failed",
				message: "Cancelled result does not match its cancellation command",
			}
		}
		if (causalTerminal(cancellation.id, resultEvent) === undefined) {
			return { ok: false, code: "protocol_gap", message: "Cancelled result must follow its command ACK" }
		}
	}
	return { ok: true }
}
