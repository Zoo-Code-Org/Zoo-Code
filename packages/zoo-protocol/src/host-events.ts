import { z } from "zod"

import { zooErrorSchema } from "./outcomes.js"
import {
	createZooStreamRedactor,
	rawZooStreamEventSchema,
	zooStreamEventSchema,
	type RawZooStreamEvent,
} from "./public-events.js"
import { redactText } from "./redaction.js"
import { ZOO_HOST_PROTOCOL_VERSION } from "./version.js"

const base = {
	v: z.literal(ZOO_HOST_PROTOCOL_VERSION),
	seq: z.number().int().safe().positive(),
	hostId: z.string().min(1),
}

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()

const taskReferenceSchema = strictObject({
	rootTaskId: z.string().min(1),
	taskId: z.string().min(1),
})

const taskSummarySchema = strictObject({
	rootTaskId: z.string().min(1),
	currentTaskId: z.string().min(1),
	workspace: z.string().min(1),
	state: z.enum(["running", "waiting", "interrupted", "completed", "failed"]),
})

export const commandDoneDataSchema = z.discriminatedUnion("commandType", [
	strictObject({ commandType: z.literal("task.start"), task: taskReferenceSchema }),
	strictObject({ commandType: z.literal("task.resume"), task: taskReferenceSchema }),
	strictObject({ commandType: z.literal("task.input"), taskId: z.string().min(1) }),
	strictObject({ commandType: z.literal("ask.respond"), taskId: z.string().min(1), askId: z.string().min(1) }),
	strictObject({ commandType: z.literal("task.cancel"), rootTaskId: z.string().min(1) }),
	strictObject({
		commandType: z.literal("history.list"),
		workspace: z.string().min(1),
		tasks: z.array(taskSummarySchema),
	}),
	strictObject({
		commandType: z.literal("host.snapshot"),
		lastSeq: z.number().int().safe().nonnegative(),
		activeRootTaskId: z.string().min(1).optional(),
	}),
	strictObject({ commandType: z.literal("host.shutdown") }),
])

const commandAckSchema = strictObject({ ...base, type: z.literal("command.ack"), commandId: z.string().min(1) })
const commandDoneSchema = strictObject({
	...base,
	type: z.literal("command.done"),
	commandId: z.string().min(1),
	data: commandDoneDataSchema,
})
const commandErrorSchema = strictObject({
	...base,
	type: z.literal("command.error"),
	commandId: z.string().min(1),
	error: zooErrorSchema,
})
const heartbeatSchema = strictObject({
	...base,
	type: z.literal("host.heartbeat"),
	monotonicMs: z.number().finite().nonnegative(),
})
const snapshotSchema = strictObject({
	...base,
	type: z.literal("host.snapshot"),
	lastSeq: z.number().int().safe().nonnegative(),
	activeRootTaskId: z.string().min(1).optional(),
})
const normalizedEventSchema = strictObject({ ...base, type: z.literal("event"), event: zooStreamEventSchema })
const rawNormalizedEventSchema = strictObject({ ...base, type: z.literal("event"), event: rawZooStreamEventSchema })

const hostEventDiscriminatedSchema = z.discriminatedUnion("type", [
	commandAckSchema,
	commandDoneSchema,
	commandErrorSchema,
	heartbeatSchema,
	snapshotSchema,
	normalizedEventSchema,
])

const rawHostEventDiscriminatedSchema = z.discriminatedUnion("type", [
	commandAckSchema,
	commandDoneSchema,
	commandErrorSchema,
	heartbeatSchema,
	snapshotSchema,
	rawNormalizedEventSchema,
])

export const hostEventSchema = hostEventDiscriminatedSchema
	.superRefine((event, context) => {
		if (event.type === "event" && event.event.hostId !== event.hostId) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Normalized event hostId must match its host envelope" })
		}
	})
	.transform((event) =>
		event.type === "command.error"
			? {
					...event,
					error: {
						...event.error,
						message: redactText(event.error.message),
						phase: event.error.phase === undefined ? undefined : redactText(event.error.phase),
					},
				}
			: event,
	)

export type HostEvent = z.infer<typeof hostEventSchema>

export type HostEventStreamParser = {
	push: (event: unknown) => HostEvent[]
	tick: () => HostEvent[]
	flush: () => HostEvent[]
}

export function createHostEventStreamParser(
	options: {
		hostId: string
		maxPendingBytes?: number
		maxPendingEvents?: number
		maxPendingStreams?: number
		maxQueuedEvents?: number
		maxQueuedBytes?: number
		maxInputBytes?: number
		maxPendingMs?: number
		now?: () => number
	},
): HostEventStreamParser {
	const redactor = createZooStreamRedactor(options)
	const maxQueuedEvents = options.maxQueuedEvents ?? 512
	const maxQueuedBytes = options.maxQueuedBytes ?? 1024 * 1024
	const maxInputBytes = options.maxInputBytes ?? 1024 * 1024
	const maxPendingMs = options.maxPendingMs ?? 1_000
	const now = options.now ?? Date.now
	type QueueEntry = {
		envelope?: z.infer<typeof rawNormalizedEventSchema>
		output?: HostEvent
		enqueuedAt: number
		bytes: number
	}
	const queue: QueueEntry[] = []
	let queuedBytes = 0
	const envelopes = new Map<string, QueueEntry[]>()
	const pinnedHostId = options.hostId
	let lastSeq: number | undefined
	const encoder = new TextEncoder()
	const inputSize = (value: unknown): number => {
		const seen = new WeakSet<object>()
		const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
		let bytes = 0
		while (stack.length > 0) {
			const current = stack.pop()!
			if (current.depth > 64) return maxInputBytes + 1
			if (current.value === null || typeof current.value !== "object") {
				let serialized: string | undefined
				try {
					serialized = JSON.stringify(current.value)
				} catch {
					return maxInputBytes + 1
				}
				if (serialized === undefined) return maxInputBytes + 1
				bytes += encoder.encode(serialized).byteLength
			} else {
				if (seen.has(current.value)) return maxInputBytes + 1
				seen.add(current.value)
				if (Array.isArray(current.value)) {
					bytes += 2 + Math.max(0, current.value.length - 1)
					for (let index = current.value.length - 1; index >= 0; index -= 1) {
						stack.push({ value: current.value[index], depth: current.depth + 1 })
					}
				} else {
					const entries = Object.entries(current.value)
					bytes += 2 + Math.max(0, entries.length - 1)
					for (let index = entries.length - 1; index >= 0; index -= 1) {
						const [key, entry] = entries[index]!
						bytes += encoder.encode(JSON.stringify(key)).byteLength + 1
						stack.push({ value: entry, depth: current.depth + 1 })
					}
				}
			}
			if (bytes > maxInputBytes) return bytes
		}
		return bytes
	}
	const eventKey = (event: RawZooStreamEvent) =>
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
	const assign = (events: ReturnType<typeof redactor.flush>) => {
		for (const event of events) {
			const key = eventKey(event)
			const entries = envelopes.get(key)
			const entry = entries?.shift()
			if (entry === undefined) throw new Error("Missing host envelope for buffered Zoo stream event")
			if (entries?.length === 0) envelopes.delete(key)
			const envelope = entry.envelope
			if (envelope === undefined) {
				throw new Error("Missing host envelope for buffered Zoo stream event")
			}
			entry.output = { ...envelope, event }
		}
	}
	const drain = (): HostEvent[] => {
		const ready: HostEvent[] = []
		while (queue[0]?.output !== undefined) {
			const entry = queue.shift()!
			queuedBytes -= entry.bytes
			ready.push(entry.output!)
		}
		return ready
	}
	const releaseBlockedQueue = (): HostEvent[] => {
		const ready: HostEvent[] = []
		while (true) {
			ready.push(...drain())
			const oldest = queue[0]
			if (
				oldest === undefined ||
				oldest.output !== undefined ||
				(queue.length < maxQueuedEvents &&
					queuedBytes < maxQueuedBytes &&
					now() - oldest.enqueuedAt < maxPendingMs)
			) {
				return ready
			}
			assign(redactor.failClosed(oldest.envelope?.event))
		}
	}
	const sanitizeNonEvent = (event: z.infer<typeof rawHostEventDiscriminatedSchema>): HostEvent =>
		event.type === "command.error"
			? {
					...event,
					error: {
						...event.error,
						message: redactText(event.error.message),
						phase: event.error.phase === undefined ? undefined : redactText(event.error.phase),
					},
				}
			: event as HostEvent

	return {
		push(input) {
			if (inputSize(input) > maxInputBytes) throw new Error("Host event exceeds the input limit")
			const event = rawHostEventDiscriminatedSchema.parse(input)
			if (event.hostId !== pinnedHostId) {
				throw new Error("Host event stream cannot span multiple hosts")
			}
			if (lastSeq !== undefined && !validateMonotonicSequence(lastSeq, event.seq).ok) {
				throw new Error(`Expected host sequence ${lastSeq + 1}`)
			}
			if (event.type === "event" && event.event.hostId !== event.hostId) {
				throw new Error("Normalized event hostId must match its host envelope")
			}
			let bytes: number
			try {
				bytes = encoder.encode(JSON.stringify(event)).byteLength
			} catch {
				bytes = maxQueuedBytes
			}
			lastSeq = event.seq
			const released = releaseBlockedQueue()
			const entry: QueueEntry = { enqueuedAt: now(), bytes }
			queue.push(entry)
			queuedBytes += bytes
			if (event.type !== "event") {
				entry.output = sanitizeNonEvent(event)
				return [...released, ...releaseBlockedQueue()]
			}
			entry.envelope = event
			const key = eventKey(event.event)
			const entries = envelopes.get(key) ?? []
			entries.push(entry)
			envelopes.set(key, entries)
			assign(redactor.push(event.event))
			return [...released, ...releaseBlockedQueue()]
		},
		tick: releaseBlockedQueue,
		flush() {
			assign(redactor.flush())
			const output = drain()
			if (queue.length > 0 || envelopes.size > 0) throw new Error("Host event stream contains unflushed events")
			return output
		},
	}
}

export function validateMonotonicSequence(
	previous: number,
	next: number,
): { ok: true } | { ok: false; expected: number } {
	const expected = previous + 1
	return Number.isSafeInteger(previous) && Number.isSafeInteger(next) && next === expected
		? { ok: true }
		: { ok: false, expected }
}

export { validateCommandLifecycle } from "./command-lifecycle.js"
