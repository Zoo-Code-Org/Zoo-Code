import {
	EXIT_CODES,
	ZOO_HOST_PROTOCOL_VERSION,
	assertAuthoritativeRootResult,
	createHostEventStreamParser,
	compareSemanticTraces,
	exitContextSchema,
	exitCodeFor,
	hostCommandSchema,
	hostEventSchema,
	hostHelloSchema,
	negotiateProtocol,
	parentHelloSchema,
	parityScenarios,
	redactText,
	redactValue,
	runDeterministicFakeProvider,
	validateCommandLifecycle,
	validateMonotonicSequence,
	validateNegotiatedStreamSession,
	validateParentHello,
	validateStreamLifecycle as validateStreamLifecycleContract,
	zooRunResultSchema,
	zooStreamEventSchema,
	zooStreamSchema,
} from "../index.js"

const timestamp = "2026-08-05T12:00:00.000Z"
const startCommand = hostCommandSchema.parse({
	v: 1,
	id: "start",
	type: "task.start",
	workspace: "/workspace",
	prompt: "Start",
})

function validateStreamLifecycle(
	events: Parameters<typeof validateStreamLifecycleContract>[0],
	commands: Parameters<typeof validateStreamLifecycleContract>[1] = [],
	commandEvents: Parameters<typeof validateStreamLifecycleContract>[2] = [],
	scope?: Parameters<typeof validateStreamLifecycleContract>[3],
) {
	const lastHostSeq = commandEvents.reduce((maximum, event) => Math.max(maximum, event.seq), 0)
	const eventEnvelopes = events.map((event, index) =>
		hostEventSchema.parse({
			v: 1,
			seq: lastHostSeq + index + 1,
			hostId: event.hostId,
			type: "event",
			event,
		}),
	)
	return validateStreamLifecycleContract(events, commands, [...commandEvents, ...eventEnvelopes], scope)
}

const initEvent = zooStreamEventSchema.parse({
	v: 1,
	seq: 1,
	timestamp,
	hostId: "host",
	type: "system.init",
	protocol: "zoo-stream",
	hostProtocolVersion: 1,
	capabilities: ["task:start"],
	clientVersion: "1.0.0",
	hostVersion: "1.0.0",
})
if (initEvent.type !== "system.init") throw new Error("Expected system.init fixture")

function taskEvent(seq: number, type: string, fields: Record<string, unknown> = {}) {
	return zooStreamEventSchema.parse({
		v: 1,
		seq,
		timestamp,
		hostId: "host",
		type,
		rootTaskId: "root",
		taskId: "root",
		...(type === "task.created" ? { requestId: "start" } : {}),
		...fields,
	})
}

function resultEvent(seq: number, result: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
	const outcome = result.outcome ?? "completed"
	const parsed = taskEvent(seq, "task.result", {
		requestId: "start",
		result: {
			schemaVersion: 1,
			protocol: "zoo-run-result",
			success: outcome === "completed",
			outcome,
			rootTaskId: "root",
			workspace: "/workspace",
			resumable: false,
			elapsedMs: 10,
			...result,
		},
		...event,
	})
	if (parsed.type !== "task.result") throw new Error("Expected task.result fixture")
	return parsed
}

function startDone(commandId = "start", rootTaskId = "root", startSeq = 1) {
	return [
		hostEventSchema.parse({ v: 1, seq: startSeq, hostId: "host", type: "command.ack", commandId }),
		hostEventSchema.parse({
			v: 1,
			seq: startSeq + 1,
			hostId: "host",
			type: "command.done",
			commandId,
			data: { commandType: "task.start", task: { rootTaskId, taskId: rootTaskId } },
		}),
	]
}

function resumeDone(commandId = "resume", taskId = "root", startSeq = 1) {
	return [
		hostEventSchema.parse({ v: 1, seq: startSeq, hostId: "host", type: "command.ack", commandId }),
		hostEventSchema.parse({
			v: 1,
			seq: startSeq + 1,
			hostId: "host",
			type: "command.done",
			commandId,
			data: { commandType: "task.resume", task: { rootTaskId: "root", taskId } },
		}),
	]
}

function cancellationDone(commandId = "cancel", hostId = "host", startSeq = 1) {
	return [
		hostEventSchema.parse({ v: 1, seq: startSeq, hostId, type: "command.ack", commandId }),
		hostEventSchema.parse({
			v: 1,
			seq: startSeq + 1,
			hostId,
			type: "command.done",
			commandId,
			data: { commandType: "task.cancel", rootTaskId: "root" },
		}),
	]
}

function cancellationError(commandId = "cancel", startSeq = 1) {
	return [
		hostEventSchema.parse({ v: 1, seq: startSeq, hostId: "host", type: "command.ack", commandId }),
		hostEventSchema.parse({
			v: 1,
			seq: startSeq + 1,
			hostId: "host",
			type: "command.error",
			commandId,
			error: { code: "cancel_failed", message: "Task already completed" },
		}),
	]
}

function askResponseDone(commandId = "respond", hostId = "host", startSeq = 1) {
	return [
		hostEventSchema.parse({ v: 1, seq: startSeq, hostId, type: "command.ack", commandId }),
		hostEventSchema.parse({
			v: 1,
			seq: startSeq + 1,
			hostId,
			type: "command.done",
			commandId,
			data: { commandType: "ask.respond", taskId: "root", askId: "ask" },
		}),
	]
}

function askResponseError(commandId = "respond", startSeq = 1) {
	return [
		hostEventSchema.parse({ v: 1, seq: startSeq, hostId: "host", type: "command.ack", commandId }),
		hostEventSchema.parse({
			v: 1,
			seq: startSeq + 1,
			hostId: "host",
			type: "command.error",
			commandId,
			error: { code: "task_failed", message: "Response was not accepted" },
		}),
	]
}

describe("strict host contracts", () => {
	it("accepts a valid start and rejects unknown fields", () => {
		const command = {
			v: ZOO_HOST_PROTOCOL_VERSION,
			id: "command-1",
			type: "task.start",
			workspace: "/workspace",
			prompt: "Fix the test",
			overrides: { approval: "safe" },
		}
		expect(hostCommandSchema.parse(command)).toEqual(command)
		expect(hostCommandSchema.safeParse({ ...command, unexpected: true }).success).toBe(false)
		expect(hostCommandSchema.safeParse({ ...command, overrides: { reasoningEffort: "max" } }).success).toBe(true)
		expect(hostCommandSchema.safeParse({ ...command, overrides: { reasoningEffort: "disabled" } }).success).toBe(
			true,
		)
		const formattedPrompt = hostCommandSchema.parse({ ...command, prompt: "  formatted prompt\n" })
		expect(formattedPrompt.type === "task.start" && formattedPrompt.prompt).toBe("  formatted prompt\n")
		expect(hostCommandSchema.safeParse({ ...command, prompt: " \n\t" }).success).toBe(false)
	})

	it("enforces input and approval payload invariants", () => {
		expect(hostCommandSchema.safeParse({ v: 1, id: "1", type: "task.input", taskId: "task" }).success).toBe(false)
		expect(
			hostCommandSchema.safeParse({ v: 1, id: "1", type: "task.input", taskId: "task", text: " \n" }).success,
		).toBe(false)
		expect(
			hostCommandSchema.safeParse({
				v: 1,
				id: "1",
				type: "ask.respond",
				taskId: "task",
				askId: "ask",
				response: "message",
			}).success,
		).toBe(false)
		expect(
			hostCommandSchema.safeParse({
				v: 1,
				id: "1",
				type: "ask.respond",
				taskId: "task",
				askId: "ask",
				response: "message",
				text: " \t",
			}).success,
		).toBe(false)
	})

	it("negotiates versions and required capabilities", () => {
		const hello = hostHelloSchema.parse({
			type: "hello",
			hostId: "host-1",
			supportedVersions: [1],
			capabilities: { 1: ["task:start", "host:shutdown", "future:additive-capability"] },
			buildVersion: "1.0.0",
		})
		expect(negotiateProtocol(hello, [1], ["task:start"])).toEqual({ ok: true, version: 1 })
		expect(negotiateProtocol(hello, [2], ["task:start"])).toMatchObject({ ok: false })
		expect(negotiateProtocol(hello, [1], ["task:resume"])).toMatchObject({ ok: false })
		const multiVersionHello = hostHelloSchema.parse({
			...hello,
			supportedVersions: [1, 2],
			capabilities: { 1: ["task:start"], 2: ["task:start", "task:resume"] },
		})
		expect(negotiateProtocol(multiVersionHello, [1], ["task:resume"])).toMatchObject({ ok: false })
		expect(negotiateProtocol(multiVersionHello, [2, 1], ["task:resume"])).toMatchObject({ ok: false })
		const lowerVersionCapabilities = hostHelloSchema.parse({
			...hello,
			supportedVersions: [1, 2],
			capabilities: { 1: ["task:start", "task:resume"], 2: ["task:start"] },
		})
		expect(negotiateProtocol(lowerVersionCapabilities, [2, 1], ["task:resume"])).toEqual({ ok: true, version: 1 })
	})

	it("binds parent selection to the host advertisement", () => {
		const host = hostHelloSchema.parse({
			type: "hello",
			hostId: "host-1",
			supportedVersions: [1, 2],
			capabilities: { 1: ["task:start"], 2: ["task:start", "task:resume"] },
			buildVersion: "1.0.0",
		})
		const selected = parentHelloSchema.parse({
			type: "hello.select",
			version: 2,
			clientVersion: "1.0.0",
			requiredCapabilities: ["task:resume"],
		})
		expect(validateParentHello(host, selected)).toMatchObject({ ok: false })
		expect(validateParentHello(host, { ...selected, version: 3 })).toMatchObject({ ok: false })
		expect(validateParentHello(host, { ...selected, version: 1 })).toMatchObject({ ok: false })
		expect(validateParentHello(host, { ...selected, version: 1, requiredCapabilities: ["task:start"] })).toEqual({
			ok: true,
			version: 1,
		})
	})

	it("requires contiguous host sequence numbers", () => {
		expect(validateMonotonicSequence(8, 9)).toEqual({ ok: true })
		expect(validateMonotonicSequence(8, 10)).toEqual({ ok: false, expected: 9 })
		expect(validateMonotonicSequence(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toMatchObject({ ok: false })
		expect(
			hostEventSchema.safeParse({
				v: 1,
				seq: Number.MAX_SAFE_INTEGER + 1,
				hostId: "host",
				type: "command.ack",
				commandId: "cmd",
			}).success,
		).toBe(false)
	})

	it("binds stream initialization to the negotiated session", () => {
		const host = hostHelloSchema.parse({
			type: "hello",
			hostId: "host",
			supportedVersions: [1],
			capabilities: { 1: ["task:start", "future:additive-capability"] },
			buildVersion: "1.0.0",
		})
		const parent = parentHelloSchema.parse({
			type: "hello.select",
			version: 1,
			clientVersion: "1.0.0",
			requiredCapabilities: ["task:start"],
		})
		expect(
			validateNegotiatedStreamSession(host, parent, [
				{ ...initEvent, capabilities: ["task:start", "future:additive-capability"] },
			]),
		).toEqual({ ok: true })
		expect(validateNegotiatedStreamSession(host, parent, [{ ...initEvent, hostId: "other" }])).toMatchObject({
			ok: false,
		})
		expect(validateNegotiatedStreamSession(host, parent, [{ ...initEvent, capabilities: [] }])).toMatchObject({
			ok: false,
		})
	})

	it("pins host identity and sequence in the streaming parser", () => {
		const parser = createHostEventStreamParser({ hostId: "host" })
		expect(() =>
			createHostEventStreamParser({ hostId: "negotiated-host" }).push({
				v: 1,
				seq: 1,
				hostId: "other",
				type: "host.heartbeat",
				monotonicMs: 1,
			}),
		).toThrow("cannot span multiple hosts")
		parser.push({ v: 1, seq: 4, hostId: "host", type: "host.heartbeat", monotonicMs: 1 })
		expect(() => parser.push({ v: 1, seq: 6, hostId: "host", type: "host.heartbeat", monotonicMs: 2 })).toThrow(
			"Expected host sequence 5",
		)
		const otherHost = createHostEventStreamParser({ hostId: "host" })
		otherHost.push({ v: 1, seq: 1, hostId: "host", type: "host.heartbeat", monotonicMs: 1 })
		expect(() => otherHost.push({ v: 1, seq: 2, hostId: "other", type: "host.heartbeat", monotonicMs: 2 })).toThrow(
			"cannot span multiple hosts",
		)
		expect(
			hostEventSchema.safeParse({ v: 1, seq: 1, hostId: "host", type: "host.heartbeat", monotonicMs: Infinity })
				.success,
		).toBe(false)
	})

	it("rejects oversized terminal output before stream parsing", () => {
		const parser = createHostEventStreamParser({ hostId: "host", maxInputBytes: 4 })
		expect(() =>
			parser.push({
				v: 1,
				seq: 1,
				hostId: "host",
				type: "event",
				event: {
					v: 1,
					seq: 1,
					timestamp,
					hostId: "host",
					rootTaskId: "root",
					taskId: "root",
					type: "terminal.output",
					toolCallId: "terminal",
					stream: "stdout",
					delta: "12345",
				},
			}),
		).toThrow("input limit")
		const escaped = createHostEventStreamParser({ hostId: "host", maxInputBytes: 100 })
		expect(() =>
			escaped.push({
				v: 1,
				seq: 1,
				hostId: "host",
				type: "host.heartbeat",
				monotonicMs: 1,
				padding: "\u0000".repeat(30),
			}),
		).toThrow("input limit")
	})

	it("does not mutate parser state for an invalid nested event", () => {
		const parser = createHostEventStreamParser({ hostId: "host" })
		const invalid = {
			v: 1,
			seq: 1,
			hostId: "host",
			type: "event",
			event: {
				v: 1,
				seq: 1,
				timestamp,
				hostId: "other",
				rootTaskId: "root",
				taskId: "root",
				type: "terminal.output",
				toolCallId: "terminal",
				stream: "stdout",
				delta: "safe\n",
			},
		}
		expect(() => parser.push(invalid)).toThrow("hostId must match")
		expect(parser.push({ ...invalid, event: { ...invalid.event, hostId: "host" } })).toMatchObject([
			{ seq: 1, event: { delta: "safe\n" } },
		])
		expect(parser.flush()).toEqual([])
	})

	it("models one ACK and terminal command response independently", () => {
		const command = hostCommandSchema.parse({ v: 1, id: "cmd", type: "host.shutdown" })
		const events = [
			hostEventSchema.parse({ v: 1, seq: 1, hostId: "host", type: "command.ack", commandId: "cmd" }),
			hostEventSchema.parse({
				v: 1,
				seq: 2,
				hostId: "host",
				type: "command.done",
				commandId: "cmd",
				data: { commandType: "host.shutdown" },
			}),
		]
		expect(validateCommandLifecycle([command], events, "host")).toEqual({ ok: true })
		expect(validateCommandLifecycle([command], [...events, events[1]!], "host")).toMatchObject({ ok: false })
		expect(validateCommandLifecycle([command], [events[1]!, events[0]!], "host")).toMatchObject({ ok: false })
		expect(validateCommandLifecycle([command], [events[0]!, { ...events[1]!, seq: 3 }], "host")).toMatchObject({
			ok: false,
		})
	})

	it("correlates terminal responses with commands and hosts", () => {
		const command = hostCommandSchema.parse({
			v: 1,
			id: "cmd",
			type: "ask.respond",
			taskId: "task",
			askId: "ask",
			response: "approve",
		})
		const acknowledgement = hostEventSchema.parse({
			v: 1,
			seq: 1,
			hostId: "host-a",
			type: "command.ack",
			commandId: "cmd",
		})
		const completion = hostEventSchema.parse({
			v: 1,
			seq: 2,
			hostId: "host-a",
			type: "command.done",
			commandId: "cmd",
			data: { commandType: "ask.respond", taskId: "task", askId: "ask" },
		})
		const mismatchedIdentity = hostEventSchema.parse({
			v: 1,
			seq: 2,
			hostId: "host-a",
			type: "command.done",
			commandId: "cmd",
			data: { commandType: "ask.respond", taskId: "task", askId: "other" },
		})
		const mismatchedType = hostEventSchema.parse({
			v: 1,
			seq: 2,
			hostId: "host-a",
			type: "command.done",
			commandId: "cmd",
			data: { commandType: "host.shutdown" },
		})
		expect(validateCommandLifecycle([command], [acknowledgement, completion], "host-a")).toEqual({ ok: true })
		expect(validateCommandLifecycle([command], [acknowledgement, mismatchedIdentity], "host-a")).toMatchObject({
			ok: false,
		})
		expect(validateCommandLifecycle([command], [acknowledgement, mismatchedType], "host-a")).toMatchObject({
			ok: false,
		})
		expect(
			validateCommandLifecycle([command], [acknowledgement, { ...completion, hostId: "host-b" }], "host-a"),
		).toMatchObject({
			ok: false,
		})
	})

	it("rejects missing and mismatched command completion payloads", () => {
		const done = { v: 1, seq: 1, hostId: "host", type: "command.done", commandId: "cmd" }
		expect(hostEventSchema.safeParse(done).success).toBe(false)
		expect(
			hostEventSchema.safeParse({
				...done,
				data: { commandType: "task.start", task: { rootTaskId: "root" } },
			}).success,
		).toBe(false)
		const start = hostCommandSchema.parse({
			v: 1,
			id: "cmd",
			type: "task.start",
			workspace: "/workspace",
			prompt: "start",
		})
		const acknowledgement = hostEventSchema.parse({
			v: 1,
			seq: 1,
			hostId: "host",
			type: "command.ack",
			commandId: "cmd",
		})
		const childCompletion = hostEventSchema.parse({
			...done,
			seq: 2,
			data: { commandType: "task.start", task: { rootTaskId: "root", taskId: "child" } },
		})
		expect(validateCommandLifecycle([start], [acknowledgement, childCompletion], "host")).toMatchObject({
			ok: false,
		})
	})

	it("does not reuse root identities across successful starts", () => {
		const commands = ["first", "second"].map((id) =>
			hostCommandSchema.parse({ v: 1, id, type: "task.start", workspace: "/workspace", prompt: id }),
		)
		const events = commands.flatMap((command, index) => [
			hostEventSchema.parse({
				v: 1,
				seq: index * 2 + 1,
				hostId: "host",
				type: "command.ack",
				commandId: command.id,
			}),
			hostEventSchema.parse({
				v: 1,
				seq: index * 2 + 2,
				hostId: "host",
				type: "command.done",
				commandId: command.id,
				data: { commandType: "task.start", task: { rootTaskId: "root", taskId: "root" } },
			}),
		])
		expect(validateCommandLifecycle(commands, events, "host")).toMatchObject({ ok: false })
	})

	it("redacts command errors before they cross the host boundary", () => {
		const parsed = hostEventSchema.parse({
			v: 1,
			seq: 1,
			hostId: "host",
			type: "command.error",
			commandId: "command",
			error: { code: "provider_failed", message: "password=hunter2", phase: "token=secret" },
		})
		expect(parsed.type === "command.error" && parsed.error.message).toBe("[REDACTED]")
		expect(parsed.type === "command.error" && parsed.error.phase).toBe("[REDACTED]")
	})

	it("statefully redacts normalized terminal output at the host boundary", () => {
		const parser = createHostEventStreamParser({ hostId: "host" })
		const envelope = (seq: number, delta: string) => ({
			v: 1,
			seq,
			hostId: "host",
			type: "event",
			event: {
				v: 1,
				seq,
				timestamp,
				hostId: "host",
				rootTaskId: "root",
				taskId: "root",
				type: "terminal.output",
				toolCallId: "terminal",
				stream: "stdout",
				delta,
			},
		})
		const events = [
			...parser.push(envelope(1, "Build succeeded\n")),
			...parser.push(envelope(2, "API_TOKEN=")),
			...parser.push(envelope(3, "abcdefgh")),
			...parser.flush(),
		]
		expect(
			events
				.map((event) =>
					event.type === "event" && event.event.type === "terminal.output" ? event.event.delta : "",
				)
				.join(""),
		).toBe("Build succeeded\n[REDACTED]")

		const interleavedParser = createHostEventStreamParser({ hostId: "host" })
		const interleaved = [
			...interleavedParser.push(envelope(1, "API_TOKEN=")),
			...interleavedParser.push({ v: 1, seq: 2, hostId: "host", type: "host.heartbeat", monotonicMs: 1 }),
			...interleavedParser.push(envelope(3, "abcdefgh")),
			...interleavedParser.flush(),
		]
		expect(interleaved.map((event) => event.seq)).toEqual([1, 2, 3])
		expect(
			interleaved
				.filter((event) => event.type === "event" && event.event.type === "terminal.output")
				.map((event) =>
					event.type === "event" && event.event.type === "terminal.output" ? event.event.delta : "",
				)
				.join(""),
		).toBe("[REDACTED]")
	})

	it("releases blocked envelopes on deadline and byte pressure", () => {
		let now = 0
		const terminalEnvelope = (seq: number, delta: string) => ({
			v: 1,
			seq,
			hostId: "host",
			type: "event",
			event: {
				v: 1,
				seq,
				timestamp,
				hostId: "host",
				rootTaskId: "root",
				taskId: "root",
				type: "terminal.output",
				toolCallId: "terminal",
				stream: "stdout",
				delta,
			},
		})
		const deadlineParser = createHostEventStreamParser({ hostId: "host", maxPendingMs: 10, now: () => now })
		expect(deadlineParser.push(terminalEnvelope(1, "unterminated"))).toEqual([])
		now = 10
		expect(deadlineParser.tick()).toMatchObject([{ seq: 1, event: { delta: "[REDACTED]" } }])

		const byteParser = createHostEventStreamParser({ hostId: "host", maxQueuedBytes: 1 })
		expect(byteParser.push(terminalEnvelope(1, "unterminated"))).toMatchObject([
			{ seq: 1, event: { delta: "[REDACTED]" } },
		])

		const scopedParser = createHostEventStreamParser({ hostId: "host", maxPendingMs: 10, now: () => now })
		now = 0
		expect(scopedParser.push(terminalEnvelope(1, "unterminated"))).toEqual([])
		now = 10
		expect(scopedParser.tick()).toMatchObject([{ seq: 1, event: { delta: "[REDACTED]" } }])
		expect(
			scopedParser.push({
				...terminalEnvelope(2, "harmless\n"),
				event: { ...terminalEnvelope(2, "harmless\n").event, toolCallId: "other-terminal" },
			}),
		).toMatchObject([{ seq: 2, event: { delta: "harmless\n" } }])

		now = 0
		const multipleParser = createHostEventStreamParser({ hostId: "host", maxPendingMs: 10, now: () => now })
		expect(multipleParser.push(terminalEnvelope(1, "first"))).toEqual([])
		expect(
			multipleParser.push({
				...terminalEnvelope(2, "second"),
				event: { ...terminalEnvelope(2, "second").event, toolCallId: "other-terminal" },
			}),
		).toEqual([])
		now = 10
		expect(multipleParser.tick()).toMatchObject([
			{ seq: 1, event: { delta: "[REDACTED]" } },
			{ seq: 2, event: { delta: "[REDACTED]" } },
		])
	})

	it("preserves host envelopes across concurrent root streams", () => {
		const parser = createHostEventStreamParser({ hostId: "host" })
		const envelope = (hostSeq: number, rootTaskId: string, delta: string) => ({
			v: 1,
			seq: hostSeq,
			hostId: "host",
			type: "event",
			event: {
				v: 1,
				seq: 1,
				timestamp,
				hostId: "host",
				rootTaskId,
				taskId: rootTaskId,
				type: "terminal.output",
				toolCallId: "terminal",
				stream: "stdout",
				delta,
			},
		})
		const events = [
			...parser.push(envelope(1, "root-a", "first\n")),
			...parser.push(envelope(2, "root-b", "second\n")),
			...parser.flush(),
		]
		expect(
			events.map((event) => [
				event.seq,
				event.type === "event" && "rootTaskId" in event.event ? event.event.rootTaskId : undefined,
			]),
		).toEqual([
			[1, "root-a"],
			[2, "root-b"],
		])
	})

	it("binds history completion data to its requested workspace", () => {
		const command = hostCommandSchema.parse({
			v: 1,
			id: "history",
			type: "history.list",
			workspace: "/workspace",
		})
		const acknowledgement = hostEventSchema.parse({
			v: 1,
			seq: 1,
			hostId: "host",
			type: "command.ack",
			commandId: "history",
		})
		const completion = hostEventSchema.parse({
			v: 1,
			seq: 2,
			hostId: "host",
			type: "command.done",
			commandId: "history",
			data: { commandType: "history.list", workspace: "/workspace", tasks: [] },
		})
		const mismatchedCompletion = hostEventSchema.parse({
			v: 1,
			seq: 2,
			hostId: "host",
			type: "command.done",
			commandId: "history",
			data: { commandType: "history.list", workspace: "/other", tasks: [] },
		})
		expect(validateCommandLifecycle([command], [acknowledgement, completion], "host")).toEqual({ ok: true })
		expect(validateCommandLifecycle([command], [acknowledgement, mismatchedCompletion], "host")).toMatchObject({
			ok: false,
		})
	})
})

describe("public automation contracts", () => {
	it("validates one-object results and semantic success", () => {
		const result = {
			schemaVersion: 1,
			protocol: "zoo-run-result",
			success: true,
			outcome: "completed",
			rootTaskId: "root",
			workspace: "/workspace",
			resumable: false,
			content: "Finished",
			elapsedMs: 25,
		}
		expect(zooRunResultSchema.parse(result)).toEqual(result)
		expect(zooRunResultSchema.safeParse({ ...result, success: false }).success).toBe(false)
		expect(
			zooRunResultSchema.safeParse({
				...result,
				error: { code: "task_failed", message: "contradiction" },
			}).success,
		).toBe(false)
		expect(zooRunResultSchema.safeParse({ ...result, resumable: true }).success).toBe(false)
		expect(
			zooRunResultSchema.safeParse({
				...result,
				success: false,
				outcome: "needs_input",
				resumable: true,
			}).success,
		).toBe(true)
		expect(
			zooRunResultSchema.safeParse({
				...result,
				success: false,
				outcome: "needs_input",
				resumable: false,
			}).success,
		).toBe(false)
		expect(
			zooRunResultSchema.safeParse({
				...result,
				success: false,
				outcome: "needs_input",
				error: { code: "provider_failed", message: "contradiction" },
			}).success,
		).toBe(false)
		expect(
			zooRunResultSchema.safeParse({
				...result,
				success: false,
				outcome: "failed",
				error: { code: "task_timed_out", message: "contradiction" },
			}).success,
		).toBe(false)
	})

	it("validates strict, ordered stream records", () => {
		const event = {
			v: 1,
			seq: 1,
			timestamp,
			hostId: "host",
			type: "message.upsert",
			rootTaskId: "root",
			taskId: "root",
			messageId: "message-1",
			role: "assistant",
			content: "hello",
			complete: false,
		}
		expect(zooStreamEventSchema.parse(event)).toEqual(event)
		expect(zooStreamEventSchema.safeParse({ ...event, seq: 0 }).success).toBe(false)
		expect(zooStreamEventSchema.safeParse({ ...event, seq: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false)
		expect(zooStreamEventSchema.safeParse({ ...event, rawSecret: "no" }).success).toBe(false)
		expect(zooStreamEventSchema.safeParse({ ...event, taskId: undefined }).success).toBe(false)
		const tool = {
			v: 1,
			seq: 1,
			timestamp,
			hostId: "host",
			type: "tool.started",
			rootTaskId: "root",
			taskId: "root",
			toolCallId: "tool",
			name: "read",
			arguments: { nested: [null, true, 1, "value"] },
		}
		expect(zooStreamEventSchema.safeParse(tool).success).toBe(true)
		for (const invalid of [Infinity, BigInt(1), undefined, () => undefined]) {
			expect(zooStreamEventSchema.safeParse({ ...tool, arguments: { invalid } }).success).toBe(false)
		}
		expect(
			zooStreamEventSchema.safeParse({ ...initEvent, capabilities: ["task:start", "future:additive"] }).success,
		).toBe(true)
	})

	it("requires init, contiguous sequence, and a settled authoritative root", () => {
		const created = taskEvent(2, "task.created")
		const started = taskEvent(3, "task.started")
		const completed = taskEvent(4, "task.lifecycle", { state: "completed" })
		const result = resultEvent(5)
		expect(
			validateStreamLifecycle([initEvent, created, started, completed, result], [startCommand], startDone()),
		).toEqual({
			ok: true,
		})
		const history = hostCommandSchema.parse({
			v: 1,
			id: "history",
			type: "history.list",
			workspace: "/workspace",
		})
		expect(
			validateStreamLifecycle(
				[initEvent, created, started, completed, result],
				[startCommand, history],
				startDone(),
			),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle(
				[initEvent, created, started, completed, result],
				[startCommand],
				[
					...startDone(),
					hostEventSchema.parse({ v: 1, seq: 3, hostId: "host", type: "command.ack", commandId: "unknown" }),
				],
			),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle(
				[initEvent, created, started, completed, resultEvent(5, { workspace: "/other" })],
				[startCommand],
			),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle(
				[initEvent, created, started, completed, resultEvent(5, {}, { requestId: "other" })],
				[startCommand],
			),
		).toMatchObject({ ok: false })
		expect(validateStreamLifecycle([initEvent, resultEvent(2)])).toMatchObject({ ok: false })
		expect(validateStreamLifecycle([initEvent, created, resultEvent(3)])).toMatchObject({ ok: false })
		expect(validateStreamLifecycle([initEvent, created, started, completed, result], [startCommand])).toMatchObject(
			{
				ok: false,
			},
		)
		expect(
			validateStreamLifecycle(
				[initEvent, created, started, completed, result],
				[startCommand],
				startDone("start", "other-root"),
			),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([initEvent, created, completed, { ...result, hostId: "other-host" }]),
		).toMatchObject({
			ok: false,
		})
		expect(validateStreamLifecycle([{ ...initEvent, seq: 2 }, created, completed, result])).toMatchObject({
			ok: false,
		})
		expect(validateStreamLifecycle([initEvent])).toMatchObject({ ok: false })
		expect(validateStreamLifecycle([initEvent, created, completed, { ...result, taskId: "child" }])).toMatchObject({
			ok: false,
		})
		expect(
			validateStreamLifecycle([initEvent, created, taskEvent(3, "task.lifecycle", { state: "failed" }), result]),
		).toMatchObject({ ok: false })
		expect(validateStreamLifecycle([initEvent, { ...initEvent, seq: 2 }, resultEvent(3)])).toMatchObject({
			ok: false,
		})
	})

	it("scopes interleaved host commands and requires ACK before public effects", () => {
		const stream = [
			initEvent,
			taskEvent(2, "task.created"),
			taskEvent(3, "task.started"),
			taskEvent(4, "task.lifecycle", { state: "completed" }),
			resultEvent(5),
		]
		const otherStart = hostCommandSchema.parse({
			v: 1,
			id: "other-start",
			type: "task.start",
			workspace: "/other",
			prompt: "Other",
		})
		const interleaved = [
			hostEventSchema.parse({ v: 1, seq: 1, hostId: "host", type: "command.ack", commandId: "start" }),
			hostEventSchema.parse({ v: 1, seq: 2, hostId: "host", type: "command.ack", commandId: "other-start" }),
			hostEventSchema.parse({
				v: 1,
				seq: 3,
				hostId: "host",
				type: "command.done",
				commandId: "other-start",
				data: { commandType: "task.start", task: { rootTaskId: "other-root", taskId: "other-root" } },
			}),
			hostEventSchema.parse({
				v: 1,
				seq: 4,
				hostId: "host",
				type: "command.done",
				commandId: "start",
				data: { commandType: "task.start", task: { rootTaskId: "root", taskId: "root" } },
			}),
		]
		expect(
			validateStreamLifecycle(stream, [startCommand, otherStart], interleaved, {
				initiatingCommandId: "start",
				commandIds: ["start"],
			}),
		).toEqual({ ok: true })
		const unrelatedResponse = hostCommandSchema.parse({
			v: 1,
			id: "other-response",
			type: "ask.respond",
			taskId: "other-root",
			askId: "other",
			response: "approve",
		})
		const unrelatedResponseEvents = [
			hostEventSchema.parse({ v: 1, seq: 5, hostId: "host", type: "command.ack", commandId: "other-response" }),
			hostEventSchema.parse({
				v: 1,
				seq: 6,
				hostId: "host",
				type: "command.done",
				commandId: "other-response",
				data: { commandType: "ask.respond", taskId: "other-root", askId: "other" },
			}),
		]
		expect(
			validateStreamLifecycle(
				stream,
				[startCommand, otherStart, unrelatedResponse],
				[...interleaved, ...unrelatedResponseEvents],
				{
					initiatingCommandId: "start",
					commandIds: ["start"],
				},
			),
		).toEqual({ ok: true })

		const eventEnvelopes = stream.map((event, index) =>
			hostEventSchema.parse({ v: 1, seq: index + 1, hostId: "host", type: "event", event }),
		)
		const lateAckWindow = [
			eventEnvelopes[0]!,
			eventEnvelopes[1]!,
			...startDone("start", "root", 3),
			...eventEnvelopes.slice(2).map((event, index) => ({ ...event, seq: index + 5 })),
		]
		expect(validateStreamLifecycleContract(stream, [startCommand], lateAckWindow)).toMatchObject({ ok: false })
		const mismatchedEnvelope = eventEnvelopes.map((event, index) =>
			index === 1 && event.type === "event"
				? { ...event, seq: event.seq + 2, event: { ...event.event, requestId: "different-request" } }
				: { ...event, seq: event.seq + 2 },
		)
		expect(
			validateStreamLifecycleContract(stream, [startCommand], [...startDone(), ...mismatchedEnvelope]),
		).toMatchObject({
			ok: false,
		})
	})

	it("validates task-tree settlement and approval command causation", () => {
		const rootCreated = taskEvent(2, "task.created")
		const rootStarted = taskEvent(3, "task.started")
		const childCreated = taskEvent(4, "task.created", { taskId: "child", parentTaskId: "root" })
		const delegated = taskEvent(5, "task.delegated", {
			taskId: "child",
			parentTaskId: "root",
			childTaskId: "child",
		})
		const childStarted = taskEvent(6, "task.started", { taskId: "child" })
		const childCompleted = taskEvent(7, "task.lifecycle", { taskId: "child", state: "completed" })
		const rootCompleted = taskEvent(8, "task.lifecycle", { state: "completed" })
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					rootCreated,
					rootStarted,
					childCreated,
					delegated,
					childStarted,
					childCompleted,
					rootCompleted,
					resultEvent(9),
				],
				[startCommand],
				startDone(),
			),
		).toEqual({ ok: true })

		expect(
			validateStreamLifecycle(
				[
					initEvent,
					rootCreated,
					rootStarted,
					childCreated,
					delegated,
					childStarted,
					{ ...rootCompleted, seq: 7 },
					{ ...childCompleted, seq: 8 },
					resultEvent(9),
				],
				[startCommand],
				startDone(),
			),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([initEvent, rootCreated, childCreated, delegated, rootCompleted, resultEvent(6)]),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([
				initEvent,
				rootCreated,
				childCreated,
				taskEvent(4, "task.lifecycle", { taskId: "child", state: "completed" }),
				taskEvent(5, "task.lifecycle", { state: "completed" }),
				resultEvent(6),
			]),
		).toMatchObject({ ok: false })
		const mismatchedDelegation = taskEvent(4, "task.delegated", {
			taskId: "root",
			parentTaskId: "root",
			childTaskId: "child",
		})
		expect(
			validateStreamLifecycle([
				initEvent,
				rootCreated,
				childCreated,
				mismatchedDelegation,
				rootCompleted,
				resultEvent(6),
			]),
		).toMatchObject({ ok: false })

		const required = taskEvent(4, "ask.required", {
			askId: "ask",
			category: "tool",
			subject: "Run command",
		})
		const waitingForApproval = taskEvent(5, "task.lifecycle", { state: "waiting" })
		const resolved = taskEvent(6, "ask.resolved", {
			requestId: "respond",
			askId: "ask",
			decision: "approve",
			source: "user",
		})
		const response = hostCommandSchema.parse({
			v: 1,
			id: "respond",
			type: "ask.respond",
			taskId: "root",
			askId: "ask",
			response: "approve",
		})
		const runningAfterApproval = taskEvent(7, "task.lifecycle", { state: "running", requestId: "respond" })
		const completed = taskEvent(8, "task.lifecycle", { state: "completed" })
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					rootCreated,
					rootStarted,
					required,
					waitingForApproval,
					resolved,
					runningAfterApproval,
					completed,
					resultEvent(9),
				],
				[startCommand, response],
				[...startDone(), ...askResponseDone("respond", "host", 3)],
			),
		).toEqual({
			ok: true,
		})
		expect(
			validateStreamLifecycle(
				[initEvent, rootCreated, rootStarted, required, resolved, completed, resultEvent(7)],
				[startCommand, response],
				[...startDone(), ...askResponseDone("respond", "host", 3)],
			),
		).toMatchObject({ ok: false })
		const mismatchedResolution = zooStreamEventSchema.parse({ ...resolved, decision: "reject" })
		expect(
			validateStreamLifecycle(
				[initEvent, rootCreated, required, mismatchedResolution, completed, resultEvent(6)],
				[response],
			),
		).toMatchObject({ ok: false })
		const deniedApproval = zooStreamEventSchema.parse({ ...resolved, source: "deny" })
		expect(
			validateStreamLifecycle([initEvent, rootCreated, required, deniedApproval, completed, resultEvent(6)]),
		).toMatchObject({ ok: false })
		const policyOverride = zooStreamEventSchema.parse({ ...resolved, source: "policy", decision: "reject" })
		expect(
			validateStreamLifecycle(
				[initEvent, rootCreated, rootStarted, required, policyOverride, completed, resultEvent(7)],
				[startCommand, response],
				[...startDone(), ...askResponseDone("respond", "host", 3)],
			),
		).toMatchObject({ ok: false })
		const policyReportedResponse = zooStreamEventSchema.parse({ ...resolved, source: "policy" })
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					rootCreated,
					rootStarted,
					required,
					waitingForApproval,
					policyReportedResponse,
					runningAfterApproval,
					completed,
					resultEvent(9),
				],
				[startCommand, response],
				[...startDone(), ...askResponseDone("respond", "host", 3)],
			),
		).toEqual({ ok: true })
		expect(
			validateStreamLifecycle(
				[initEvent, rootCreated, rootStarted, required, resolved, completed, resultEvent(7)],
				[startCommand, response],
			),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle(
				[initEvent, rootCreated, rootStarted, required, resolved, completed, resultEvent(7)],
				[startCommand, response],
				askResponseDone().slice(1),
			),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle(
				[initEvent, rootCreated, rootStarted, required, resolved, completed, resultEvent(7)],
				[startCommand, response],
				askResponseDone("respond", "other"),
			),
		).toMatchObject({ ok: false })
		const waiting = taskEvent(5, "task.lifecycle", { state: "waiting" })
		const needsInput = resultEvent(6, { outcome: "needs_input", resumable: true })
		expect(
			validateStreamLifecycle(
				[initEvent, rootCreated, rootStarted, required, waiting, needsInput],
				[startCommand, response],
				[...startDone(), ...askResponseError("respond", 3)],
			),
		).toEqual({ ok: true })
		expect(
			validateStreamLifecycle(
				[initEvent, rootCreated, rootStarted, required, waiting, needsInput],
				[startCommand, response],
			),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle(
				[initEvent, rootCreated, rootStarted, required, resolved, completed, resultEvent(7)],
				[startCommand, { ...response, id: startCommand.id }],
				askResponseDone(startCommand.id),
			),
		).toMatchObject({ ok: false })
	})

	it("correlates cancellation and settles operation lifecycles", () => {
		const created = taskEvent(2, "task.created")
		const started = taskEvent(3, "task.started")
		const toolStarted = taskEvent(4, "tool.started", { toolCallId: "tool", name: "read" })
		const toolCompleted = taskEvent(5, "tool.completed", { toolCallId: "tool", name: "read" })
		const terminalStarted = taskEvent(6, "terminal.status", { toolCallId: "terminal", state: "running" })
		const terminalExited = taskEvent(7, "terminal.status", { toolCallId: "terminal", state: "exited", exitCode: 0 })
		const mcpStarted = taskEvent(8, "mcp.started", { operationId: "mcp", server: "test", operation: "read" })
		const mcpCompleted = taskEvent(9, "mcp.completed", { operationId: "mcp", server: "test", operation: "read" })
		const interrupted = taskEvent(10, "task.lifecycle", { state: "interrupted", cause: "cancelled" })
		const cancelled = resultEvent(11, { outcome: "cancelled", cancellationReason: "user" }, { requestId: "cancel" })
		const command = hostCommandSchema.parse({
			v: 1,
			id: "cancel",
			type: "task.cancel",
			rootTaskId: "root",
			reason: "user",
		})
		if (command.type !== "task.cancel") throw new Error("Expected task.cancel fixture")
		const stream = [
			initEvent,
			created,
			started,
			toolStarted,
			toolCompleted,
			terminalStarted,
			terminalExited,
			mcpStarted,
			mcpCompleted,
			interrupted,
			cancelled,
		]
		expect(
			validateStreamLifecycle(
				stream,
				[startCommand, command],
				[...startDone(), ...cancellationDone("cancel", "host", 3)],
			),
		).toEqual({ ok: true })
		const completedDespiteCancellation = [
			initEvent,
			created,
			started,
			taskEvent(4, "task.lifecycle", { state: "completed" }),
			resultEvent(5),
		]
		expect(
			validateStreamLifecycle(
				completedDespiteCancellation,
				[startCommand, command],
				[...startDone(), ...cancellationDone("cancel", "host", 3)],
				{ initiatingCommandId: "start", commandIds: ["start"] },
			),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle(
				stream.map((event) =>
					event.type === "task.lifecycle" && event.state === "interrupted"
						? { ...event, cause: "timed_out" as const }
						: event,
				),
				[startCommand, command],
				[...startDone(), ...cancellationDone("cancel", "host", 3)],
			),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle(stream, [startCommand, command], cancellationDone("cancel", "other")),
		).toMatchObject({ ok: false })
		expect(validateStreamLifecycle(stream)).toMatchObject({ ok: false })
		expect(validateStreamLifecycle(stream, [{ ...command, reason: "signal" }])).toMatchObject({ ok: false })
		expect(
			zooStreamEventSchema.safeParse({
				...terminalStarted,
				exitCode: 0,
			}).success,
		).toBe(false)
		expect(zooStreamEventSchema.safeParse({ ...terminalExited, exitCode: undefined }).success).toBe(false)
		expect(
			validateStreamLifecycle([
				initEvent,
				created,
				toolStarted,
				taskEvent(4, "tool.completed", { toolCallId: "tool", name: "write" }),
				taskEvent(5, "task.lifecycle", { state: "completed" }),
				resultEvent(6),
			]),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([
				initEvent,
				created,
				mcpStarted,
				taskEvent(4, "mcp.completed", { operationId: "mcp", server: "other", operation: "read" }),
				taskEvent(5, "task.lifecycle", { state: "completed" }),
				resultEvent(6),
			]),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([
				initEvent,
				created,
				toolCompleted,
				taskEvent(4, "task.lifecycle", { state: "completed" }),
				resultEvent(5),
			]),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([
				initEvent,
				created,
				toolStarted,
				taskEvent(4, "task.lifecycle", { state: "completed" }),
				resultEvent(5),
			]),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([
				initEvent,
				created,
				taskEvent(3, "terminal.status", { toolCallId: "terminal", state: "exited", exitCode: 0 }),
				taskEvent(4, "task.lifecycle", { state: "completed" }),
				resultEvent(5),
			]),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([
				initEvent,
				created,
				mcpCompleted,
				taskEvent(4, "task.lifecycle", { state: "completed" }),
				resultEvent(5),
			]),
		).toMatchObject({ ok: false })
	})

	it("abandons pending asks for terminal interruption or failure", () => {
		const created = taskEvent(2, "task.created")
		const started = taskEvent(3, "task.started")
		const required = taskEvent(4, "ask.required", { askId: "ask", category: "tool", subject: "Run" })
		const waiting = taskEvent(5, "task.lifecycle", { state: "waiting" })
		const abandoned = taskEvent(6, "ask.abandoned", { askId: "ask", reason: "cancelled" })
		if (abandoned.type !== "ask.abandoned") throw new Error("Expected ask.abandoned fixture")
		const interrupted = taskEvent(7, "task.lifecycle", { state: "interrupted", cause: "cancelled" })
		const cancelled = resultEvent(8, { outcome: "cancelled", cancellationReason: "user" }, { requestId: "cancel" })
		const command = hostCommandSchema.parse({
			v: 1,
			id: "cancel",
			type: "task.cancel",
			rootTaskId: "root",
			reason: "user",
		})
		expect(
			validateStreamLifecycle(
				[initEvent, created, started, required, waiting, abandoned, interrupted, cancelled],
				[startCommand, command],
				[...startDone(), ...cancellationDone("cancel", "host", 3)],
			),
		).toEqual({ ok: true })
		expect(
			validateStreamLifecycle(
				[initEvent, created, required, { ...abandoned, reason: "timed_out" }, interrupted, cancelled],
				[command],
			),
		).toMatchObject({ ok: false })
		const failedAbandonment = taskEvent(6, "ask.abandoned", { askId: "ask", reason: "failed" })
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					created,
					started,
					required,
					waiting,
					failedAbandonment,
					taskEvent(7, "task.lifecycle", { state: "failed", cause: "failed" }),
					resultEvent(8, {
						outcome: "failed",
						error: { code: "provider_failed", message: "failed" },
					}),
				],
				[startCommand],
				startDone(),
			),
		).toEqual({ ok: true })

		const childFailureThenCancellation = [
			initEvent,
			created,
			started,
			taskEvent(4, "task.created", { taskId: "child", parentTaskId: "root" }),
			taskEvent(5, "task.delegated", { taskId: "child", parentTaskId: "root", childTaskId: "child" }),
			taskEvent(6, "task.started", { taskId: "child" }),
			taskEvent(7, "ask.required", {
				taskId: "child",
				askId: "child-ask",
				category: "tool",
				subject: "Run",
			}),
			taskEvent(8, "task.lifecycle", { taskId: "child", state: "waiting" }),
			taskEvent(9, "ask.abandoned", { taskId: "child", askId: "child-ask", reason: "failed" }),
			taskEvent(10, "task.lifecycle", { taskId: "child", state: "failed", cause: "failed" }),
			taskEvent(11, "task.lifecycle", { state: "interrupted", cause: "cancelled" }),
			resultEvent(12, { outcome: "cancelled", cancellationReason: "user" }, { requestId: "cancel" }),
		]
		expect(
			validateStreamLifecycle(
				childFailureThenCancellation,
				[startCommand, command],
				[...startDone(), ...cancellationDone("cancel", "host", 3)],
			),
		).toEqual({ ok: true })
	})

	it("requires currentTaskId to belong to the authoritative tree", () => {
		expect(
			validateStreamLifecycle([
				initEvent,
				taskEvent(2, "task.created"),
				taskEvent(3, "task.lifecycle", { state: "completed" }),
				resultEvent(4, { currentTaskId: "ghost" }),
			]),
		).toMatchObject({ ok: false })
	})

	it("requires a cause for waiting tasks to return to running", () => {
		const created = taskEvent(2, "task.created")
		const started = taskEvent(3, "task.started")
		const required = taskEvent(4, "ask.required", { askId: "ask", category: "tool", subject: "Run" })
		const waiting = taskEvent(5, "task.lifecycle", { state: "waiting" })
		const running = taskEvent(6, "task.lifecycle", { state: "running" })
		const completed = taskEvent(7, "task.lifecycle", { state: "completed" })
		expect(
			validateStreamLifecycle(
				[initEvent, created, started, required, waiting, running, completed, resultEvent(8)],
				[startCommand],
			),
		).toMatchObject({ ok: false })

		const response = hostCommandSchema.parse({
			v: 1,
			id: "respond",
			type: "ask.respond",
			taskId: "root",
			askId: "ask",
			response: "approve",
		})
		const resolved = taskEvent(6, "ask.resolved", {
			requestId: "respond",
			askId: "ask",
			decision: "approve",
			source: "user",
		})
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					created,
					started,
					required,
					waiting,
					resolved,
					{ ...running, seq: 7, requestId: "respond" },
					{ ...completed, seq: 8 },
					resultEvent(9),
				],
				[startCommand, response],
				[...startDone(), ...askResponseDone("respond", "host", 3)],
			),
		).toEqual({ ok: true })

		const rejection = hostCommandSchema.parse({ ...response, id: "reject", response: "reject" })
		const rejected = taskEvent(6, "ask.resolved", {
			requestId: "reject",
			askId: "ask",
			decision: "reject",
			source: "user",
		})
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					created,
					started,
					required,
					waiting,
					rejected,
					{ ...running, seq: 7, requestId: "reject" },
					{ ...completed, seq: 8 },
					resultEvent(9),
				],
				[startCommand, rejection],
				[...startDone(), ...askResponseDone("reject", "host", 3)],
			),
		).toEqual({ ok: true })

		const secondRequired = taskEvent(5, "ask.required", { askId: "other", category: "tool", subject: "Other" })
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					created,
					started,
					required,
					secondRequired,
					{ ...waiting, seq: 6 },
					{ ...resolved, seq: 7 },
					{ ...running, seq: 8, requestId: "respond" },
					resultEvent(9, { outcome: "needs_input", resumable: true }),
				],
				[startCommand, response],
				[...startDone(), ...askResponseDone("respond", "host", 3)],
			),
		).toMatchObject({ ok: false })
	})

	it("consumes each task input resume cause once", () => {
		const input = hostCommandSchema.parse({
			v: 1,
			id: "input",
			type: "task.input",
			taskId: "root",
			text: "continue",
		})
		const inputEvents = [
			hostEventSchema.parse({ v: 1, seq: 3, hostId: "host", type: "command.ack", commandId: "input" }),
			hostEventSchema.parse({
				v: 1,
				seq: 4,
				hostId: "host",
				type: "command.done",
				commandId: "input",
				data: { commandType: "task.input", taskId: "root" },
			}),
		]
		const stream = [
			initEvent,
			taskEvent(2, "task.created"),
			taskEvent(3, "task.started"),
			taskEvent(4, "task.lifecycle", { state: "waiting" }),
			taskEvent(5, "task.lifecycle", { state: "running", requestId: "input" }),
			taskEvent(6, "task.lifecycle", { state: "waiting" }),
			taskEvent(7, "task.lifecycle", { state: "running", requestId: "input" }),
			taskEvent(8, "task.lifecycle", { state: "completed" }),
			resultEvent(9),
		]
		expect(validateStreamLifecycle(stream, [startCommand, input], [...startDone(), ...inputEvents])).toMatchObject({
			ok: false,
		})
		const messageEffect = [
			initEvent,
			taskEvent(2, "task.created"),
			taskEvent(3, "task.started"),
			taskEvent(4, "message.upsert", {
				requestId: "input",
				messageId: "input-message",
				role: "user",
				content: "continue",
				complete: true,
			}),
			taskEvent(5, "task.lifecycle", { state: "completed" }),
			resultEvent(6),
		]
		expect(validateStreamLifecycle(messageEffect, [startCommand, input], [...startDone(), ...inputEvents])).toEqual(
			{
				ok: true,
			},
		)
		const ghostInput = hostCommandSchema.parse({
			v: 1,
			id: "ghost-input",
			type: "task.input",
			taskId: "ghost",
			text: "continue",
		})
		const ghostInputEvents = [
			hostEventSchema.parse({ v: 1, seq: 3, hostId: "host", type: "command.ack", commandId: "ghost-input" }),
			hostEventSchema.parse({
				v: 1,
				seq: 4,
				hostId: "host",
				type: "command.done",
				commandId: "ghost-input",
				data: { commandType: "task.input", taskId: "ghost" },
			}),
		]
		expect(
			validateStreamLifecycle(
				messageEffect
					.filter((event) => event.type !== "message.upsert")
					.map((event, index) => ({ ...event, seq: index + 1 })),
				[startCommand, ghostInput],
				[...startDone(), ...ghostInputEvents],
				{
					initiatingCommandId: "start",
					commandIds: ["start", "ghost-input"],
				},
			),
		).toMatchObject({ ok: false })
	})

	it("reconstructs resume streams from a matching command", () => {
		const command = hostCommandSchema.parse({
			v: 1,
			id: "resume",
			type: "task.resume",
			rootTaskId: "root",
			taskId: "root",
		})
		const predecessor = taskEvent(3, "task.lifecycle", { state: "interrupted" })
		const resumed = taskEvent(4, "task.resumed", { requestId: "resume", previousState: "interrupted" })
		const started = taskEvent(5, "task.started")
		const completed = taskEvent(6, "task.lifecycle", { state: "completed" })
		const stream = [
			initEvent,
			taskEvent(2, "task.created"),
			predecessor,
			resumed,
			started,
			completed,
			resultEvent(7, {}, { requestId: "resume" }),
		]
		expect(validateStreamLifecycle(stream, [command], resumeDone())).toEqual({ ok: true })
		expect(validateStreamLifecycle(stream)).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle(
				[...stream.slice(0, 3), { ...resumed, seq: 4 }, { ...completed, seq: 5 }, resultEvent(6)],
				[command],
			),
		).toMatchObject({ ok: false })
		expect(zooStreamEventSchema.safeParse({ ...resumed, previousState: "completed" }).success).toBe(false)
	})

	it("allows a resumed run to be cancelled by a distinct command", () => {
		const resume = hostCommandSchema.parse({
			v: 1,
			id: "resume",
			type: "task.resume",
			rootTaskId: "root",
			taskId: "root",
		})
		const cancel = hostCommandSchema.parse({
			v: 1,
			id: "cancel",
			type: "task.cancel",
			rootTaskId: "root",
			reason: "user",
		})
		const stream = [
			initEvent,
			taskEvent(2, "task.created"),
			taskEvent(3, "task.lifecycle", { state: "interrupted" }),
			taskEvent(4, "task.resumed", { requestId: "resume", previousState: "interrupted" }),
			taskEvent(5, "task.started"),
			taskEvent(6, "task.lifecycle", { state: "interrupted", cause: "cancelled" }),
			resultEvent(7, { outcome: "cancelled", cancellationReason: "user" }, { requestId: "cancel" }),
		]
		expect(
			validateStreamLifecycle(
				stream,
				[resume, cancel],
				[...resumeDone(), ...cancellationDone("cancel", "host", 3)],
			),
		).toEqual({ ok: true })
	})

	it("requires accepted cancellations to own cancelled results", () => {
		const cancel = hostCommandSchema.parse({
			v: 1,
			id: "cancel",
			type: "task.cancel",
			rootTaskId: "root",
			reason: "user",
		})
		const completed = [
			initEvent,
			taskEvent(2, "task.created"),
			taskEvent(3, "task.started"),
			taskEvent(4, "task.lifecycle", { state: "completed" }),
			resultEvent(5),
		]
		expect(validateStreamLifecycle(completed, [startCommand, cancel], cancellationDone())).toMatchObject({
			ok: false,
		})
		expect(
			validateStreamLifecycle(
				completed,
				[startCommand, cancel],
				[...startDone(), ...cancellationError("cancel", 3)],
			),
		).toEqual({ ok: true })
		expect(validateStreamLifecycle(completed, [startCommand, cancel])).toMatchObject({ ok: false })
	})

	it("resumes a correlated descendant from its reconstructed predecessor", () => {
		const command = hostCommandSchema.parse({
			v: 1,
			id: "resume-child",
			type: "task.resume",
			rootTaskId: "root",
			taskId: "child",
		})
		const stream = [
			initEvent,
			taskEvent(2, "task.created"),
			taskEvent(3, "task.created", { taskId: "child", parentTaskId: "root" }),
			taskEvent(4, "task.delegated", { taskId: "child", parentTaskId: "root", childTaskId: "child" }),
			taskEvent(5, "task.lifecycle", { taskId: "child", state: "waiting" }),
			taskEvent(6, "task.resumed", {
				taskId: "child",
				requestId: "resume-child",
				previousState: "waiting",
			}),
			taskEvent(7, "task.started", { taskId: "child" }),
			taskEvent(8, "task.lifecycle", { taskId: "child", state: "completed" }),
			taskEvent(9, "task.started"),
			taskEvent(10, "task.lifecycle", { state: "completed" }),
			resultEvent(11, {}, { requestId: "resume-child" }),
		]
		expect(validateStreamLifecycle(stream, [command], resumeDone("resume-child", "child"))).toEqual({ ok: true })
		expect(
			validateStreamLifecycle(
				stream.map((event) =>
					event.type === "task.resumed" ? { ...event, previousState: "interrupted" as const } : event,
				),
				[command],
			),
		).toMatchObject({ ok: false })
	})

	it("keeps operation identities separate for delimiter-bearing IDs", () => {
		const stream = [
			initEvent,
			taskEvent(2, "task.created"),
			taskEvent(3, "task.started"),
			taskEvent(4, "task.created", { taskId: "root\u0000x", parentTaskId: "root" }),
			taskEvent(5, "task.delegated", {
				taskId: "root\u0000x",
				parentTaskId: "root",
				childTaskId: "root\u0000x",
			}),
			taskEvent(6, "task.started", { taskId: "root\u0000x" }),
			taskEvent(7, "tool.started", { toolCallId: "x\u0000y", name: "read" }),
			taskEvent(8, "tool.started", { taskId: "root\u0000x", toolCallId: "y", name: "read" }),
			taskEvent(9, "tool.completed", { toolCallId: "x\u0000y", name: "read" }),
			taskEvent(10, "tool.completed", { taskId: "root\u0000x", toolCallId: "y", name: "read" }),
			taskEvent(11, "task.lifecycle", { taskId: "root\u0000x", state: "completed" }),
			taskEvent(12, "task.lifecycle", { state: "completed" }),
			resultEvent(13),
		]
		expect(validateStreamLifecycle(stream, [startCommand], startDone())).toEqual({ ok: true })
	})

	it("keeps pending asks on waiting tasks", () => {
		const childCreated = taskEvent(3, "task.created", { taskId: "child", parentTaskId: "root" })
		const delegated = taskEvent(4, "task.delegated", {
			taskId: "child",
			parentTaskId: "root",
			childTaskId: "child",
		})
		const required = taskEvent(5, "ask.required", {
			taskId: "child",
			askId: "ask",
			category: "tool",
			subject: "Run",
		})
		const childCompleted = taskEvent(6, "task.lifecycle", { taskId: "child", state: "completed" })
		const rootWaiting = taskEvent(7, "task.lifecycle", { state: "waiting" })
		expect(
			validateStreamLifecycle([
				initEvent,
				taskEvent(2, "task.created"),
				childCreated,
				delegated,
				required,
				childCompleted,
				rootWaiting,
				resultEvent(8, { outcome: "needs_input", resumable: true }),
			]),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					taskEvent(2, "task.created"),
					taskEvent(3, "task.started"),
					taskEvent(4, "task.lifecycle", { state: "waiting" }),
					resultEvent(5, { outcome: "needs_input", resumable: true }),
				],
				[startCommand],
				startDone(),
			),
		).toMatchObject({ ok: false })
	})

	it("enforces operation, ask, message, and parent execution state", () => {
		const created = taskEvent(2, "task.created")
		const started = taskEvent(3, "task.started")
		const required = taskEvent(4, "ask.required", { askId: "ask", category: "tool", subject: "Run" })
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					created,
					started,
					required,
					taskEvent(5, "tool.started", { toolCallId: "tool", name: "shell" }),
					taskEvent(6, "task.lifecycle", { state: "completed" }),
					resultEvent(7),
				],
				[startCommand],
				startDone(),
			),
		).toMatchObject({ ok: false })

		const response = hostCommandSchema.parse({
			v: 1,
			id: "respond",
			type: "ask.respond",
			taskId: "root",
			askId: "ask",
			response: "approve",
		})
		const resolved = taskEvent(5, "ask.resolved", {
			requestId: "respond",
			askId: "ask",
			decision: "approve",
			source: "user",
		})
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					created,
					started,
					required,
					resolved,
					taskEvent(6, "ask.required", { askId: "ask", category: "tool", subject: "Again" }),
					taskEvent(7, "task.lifecycle", { state: "completed" }),
					resultEvent(8),
				],
				[startCommand, response],
				askResponseDone(),
			),
		).toMatchObject({ ok: false })

		const message = taskEvent(4, "message.upsert", {
			messageId: "message",
			role: "assistant",
			content: "done",
			complete: true,
		})
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					created,
					started,
					message,
					taskEvent(5, "message.upsert", {
						messageId: "message",
						role: "user",
						content: "changed",
						complete: false,
					}),
					taskEvent(6, "task.lifecycle", { state: "completed" }),
					resultEvent(7),
				],
				[startCommand],
			),
		).toMatchObject({ ok: false })

		expect(
			validateStreamLifecycle(
				[
					initEvent,
					created,
					taskEvent(3, "task.created", { taskId: "child", parentTaskId: "root" }),
					taskEvent(4, "task.delegated", { taskId: "child", parentTaskId: "root", childTaskId: "child" }),
					taskEvent(5, "task.started", { taskId: "child" }),
					taskEvent(6, "task.lifecycle", { taskId: "child", state: "completed" }),
					taskEvent(7, "task.started"),
					taskEvent(8, "task.lifecycle", { state: "completed" }),
					resultEvent(9),
				],
				[startCommand],
			),
		).toMatchObject({ ok: false })
	})

	it("requires completed streams to settle partial messages", () => {
		const partial = taskEvent(4, "message.upsert", {
			messageId: "message",
			role: "assistant",
			content: "partial",
			complete: false,
		})
		const stream = [
			initEvent,
			taskEvent(2, "task.created"),
			taskEvent(3, "task.started"),
			partial,
			taskEvent(5, "task.lifecycle", { state: "completed" }),
			resultEvent(6),
		]
		expect(validateStreamLifecycle(stream, [startCommand])).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle(
				[
					...stream.slice(0, -2),
					taskEvent(5, "task.lifecycle", { state: "failed" }),
					resultEvent(6, {
						outcome: "failed",
						error: { code: "task_failed", message: "failed" },
					}),
				],
				[startCommand],
				startDone(),
			),
		).toEqual({ ok: true })
	})

	it("maps every terminal outcome deterministically", () => {
		expect(exitCodeFor({ outcome: "completed" })).toBe(EXIT_CODES.completed)
		expect(exitCodeFor({ outcome: "needs_input" })).toBe(EXIT_CODES.needsInput)
		expect(exitCodeFor({ outcome: "cancelled" })).toBe(EXIT_CODES.cancelled)
		expect(exitCodeFor({ outcome: "timed_out" })).toBe(EXIT_CODES.timedOut)
		expect(exitCodeFor({ outcome: "failed", errorCode: "invalid_mode" })).toBe(EXIT_CODES.usage)
		expect(exitCodeFor({ outcome: "failed", errorCode: "provider_failed" })).toBe(EXIT_CODES.providerFailure)
		expect(exitCodeFor({ outcome: "failed", errorCode: "host_crashed" })).toBe(EXIT_CODES.runtimeFailure)
		expect(exitCodeFor({ outcome: "cancelled", signal: "SIGINT" })).toBe(EXIT_CODES.sigint)
		expect(exitCodeFor({ outcome: "cancelled", signal: "SIGTERM" })).toBe(EXIT_CODES.sigterm)
		expect(exitContextSchema.safeParse({ outcome: "cancelled", errorCode: "invalid_mode" }).success).toBe(false)
		expect(exitContextSchema.safeParse({ outcome: "completed", signal: "SIGINT" }).success).toBe(false)
		expect(exitContextSchema.safeParse({ outcome: "failed", errorCode: "task_timed_out" }).success).toBe(false)
	})
})

describe("redaction contracts", () => {
	it("redacts secret-shaped keys and text before buffering", () => {
		const input = {
			provider: "openrouter",
			apiKey: "sk-secret-value",
			nested: { authorization: "Bearer abcdefgh", command: "API_TOKEN=abcdefgh run" },
		}
		expect(redactValue(input)).toEqual({
			provider: "openrouter",
			apiKey: "[REDACTED]",
			nested: { authorization: "[REDACTED]", command: "[REDACTED] run" },
		})
		expect(redactText("Authorization: Bearer abcdefgh")).not.toContain("abcdefgh")
		expect(redactText("Authorization: abc123\nCookie: session=abc")).not.toMatch(/abc123|session=abc/)
		expect(redactText('{"password":"hunter2"}')).toBe('{"password":"[REDACTED]"}')
		expect(redactText('{"password": hunter2}')).toBe('{"password": [REDACTED]}')
		expect(redactText("{'api_key': abc123}")).toBe("{'api_key': [REDACTED]}")
		expect(redactText('{"client_secret":"secret-value","access_token":"token-value"}')).toBe(
			'{"client_secret":"[REDACTED]","access_token":"[REDACTED]"}',
		)
		expect(redactText("--api-key abc123 run")).toBe("[REDACTED] run")
		expect(redactText("API Key: abc123")).toBe("[REDACTED]")
		expect(redactText("Private Key: abc123")).toBe("[REDACTED]")
		expect(redactText('{"auth.token":"secret"}')).toBe('{"auth.token":"[REDACTED]"}')
		expect(redactText("https://alice:hunter2@example.com/path")).toBe("https://[REDACTED]@example.com/path")
		expect(redactText("https://alice:p@ss@example.com/path")).toBe("https://[REDACTED]@example.com/path")
		expect(redactText("--password abc,def run")).toBe("[REDACTED] run")
		expect(redactText('API_TOKEN="abc def" run')).toBe("[REDACTED] run")
		expect(redactText('{"access token":"hunter2","client secret":"secret-value"}')).toBe(
			'{"access token":"[REDACTED]","client secret":"[REDACTED]"}',
		)
		expect(redactValue({ max_tokens: 4096, tokenCount: 12, tokenizer: "bpe", accessToken: "secret" })).toEqual({
			max_tokens: 4096,
			tokenCount: 12,
			tokenizer: "bpe",
			accessToken: "[REDACTED]",
		})
		expect(redactValue({ databasePassword: "pw", signingSecret: "sig", secretAccessKey: "key" })).toEqual({
			databasePassword: "[REDACTED]",
			signingSecret: "[REDACTED]",
			secretAccessKey: "[REDACTED]",
		})
		expect(redactText("https://opaque-token@example.com/path")).toBe("https://[REDACTED]@example.com/path")
		expect(redactText("postgres://alice:hunter2@db/prod")).toBe("postgres://[REDACTED]@db/prod")
		expect(redactText("redis://:secret@cache/0")).toBe("redis://[REDACTED]@cache/0")
		expect(redactText("API_TOKEN=abc,def")).toBe("[REDACTED]")
		expect(redactText("OPENAI_API_KEY: value")).toBe("[REDACTED]")
		expect(redactText("SENTRY_AUTH_TOKEN: value")).toBe("[REDACTED]")
		expect(redactText("openaiApiKey: value")).toBe("[REDACTED]")
		expect(redactValue({ credentials: "value", passphrase: "value", passwd: "value", pwd: "value" })).toEqual({
			credentials: "[REDACTED]",
			passphrase: "[REDACTED]",
			passwd: "[REDACTED]",
			pwd: "[REDACTED]",
		})
		expect(redactText('{"max_tokens":4096} tokenizer=bpe --max-tokens 4096')).toBe(
			'{"max_tokens":4096} tokenizer=bpe --max-tokens 4096',
		)
		expect(
			redactValue({ "set-cookie": "session=abc", setCookie: "session=def", proxyAuthorization: "Basic abc" }),
		).toEqual({
			"set-cookie": "[REDACTED]",
			setCookie: "[REDACTED]",
			proxyAuthorization: "[REDACTED]",
		})
		expect(redactText("password: abc,def")).toBe("[REDACTED]")
		expect(redactText('{"password": abc,def}')).toBe('{"password": [REDACTED]}')
		expect(redactText("accessTokenValue=hunter2 cookieJar=session123")).not.toMatch(/hunter2|session123/)
		expect(redactText(`\u001b]0;password=hunter2\u0007safe`)).toBe("[REDACTED]")
		expect(redactText('{"api\\u005fkey":"hunter2"}')).toBe("[REDACTED]")
		expect(redactText("API_\u001b[31mTOKEN=abcdefgh")).toBe("[REDACTED]")
		expect(redactText('{"literal":"\\u0061"}')).toBe('{"literal":"\\u0061"}')
		expect(redactText("safe\u001b[31m text")).toBe("safe\u001b[31m text")
		expect(redactText("github_pat_1234567890abcdef")).toBe("[REDACTED]")
		expect(redactValue({ sessionCookie: "abc", cookieJar: "def", privateKeyPem: "ghi" })).toEqual({
			sessionCookie: "[REDACTED]",
			cookieJar: "[REDACTED]",
			privateKeyPem: "[REDACTED]",
		})
		expect(redactValue({ dbpassword: "pw", appsecret: "secret" })).toEqual({
			dbpassword: "[REDACTED]",
			appsecret: "[REDACTED]",
		})
		expect(redactText('{"my token":"[REDACTED]hunter2"}')).toBe('{"my token":"[REDACTED]"}')
		expect(redactText("pass\\u001b[31mword=hunter2")).toBe("[REDACTED]")
	})

	it("redacts public event and result payloads during parsing", () => {
		const message = taskEvent(1, "message.upsert", {
			messageId: "message",
			role: "assistant",
			content: "Authorization: Bearer abcdefgh",
			complete: true,
		})
		expect(message.type === "message.upsert" && message.content).toBe("[REDACTED]")
		const result = zooRunResultSchema.parse({
			schemaVersion: 1,
			protocol: "zoo-run-result",
			success: true,
			outcome: "completed",
			rootTaskId: "root",
			workspace: "/workspace",
			resumable: false,
			content: "password=hunter2",
			elapsedMs: 1,
		})
		expect(result.content).toBe("[REDACTED]")
		expect(zooStreamEventSchema.safeParse({ ...message, taskId: Symbol("secret") }).success).toBe(false)
		const structuralIdentity = taskEvent(2, "message.upsert", {
			taskId: "password=hunter2",
			messageId: "token=identity",
			role: "assistant",
			content: "safe",
			complete: true,
		})
		if (structuralIdentity.type !== "message.upsert") throw new Error("Expected message.upsert fixture")
		expect(structuralIdentity.taskId).toBe("password=hunter2")
		expect(structuralIdentity.messageId).toBe("token=identity")
		const terminalOutput = taskEvent(3, "terminal.output", {
			toolCallId: "terminal",
			stream: "stdout",
			delta: "abcdefgh",
		})
		expect(terminalOutput.type === "terminal.output" && terminalOutput.delta).toBe("[REDACTED]")
		const terminalPrefix = taskEvent(4, "terminal.output", {
			toolCallId: "terminal",
			stream: "stdout",
			delta: "API_TOKEN=",
		})
		expect(terminalPrefix.type === "terminal.output" && terminalPrefix.delta).toBe("[REDACTED]")
		const failed = zooRunResultSchema.parse({
			schemaVersion: 1,
			protocol: "zoo-run-result",
			success: false,
			outcome: "failed",
			rootTaskId: "root",
			workspace: "/workspace",
			resumable: false,
			error: { code: "provider_failed", message: "safe", phase: "password=hunter2" },
			elapsedMs: 1,
		})
		expect(failed.error?.phase).toBe("[REDACTED]")
	})

	it("buffers terminal output across delta boundaries without destroying harmless output", () => {
		const terminal = {
			v: 1,
			timestamp,
			hostId: "host",
			rootTaskId: "root",
			taskId: "root",
			type: "terminal.output",
			toolCallId: "terminal",
			stream: "stdout",
		} as const
		const output = zooStreamSchema.parse([
			{ ...terminal, seq: 1, delta: "Build succeeded\n" },
			{ ...terminal, seq: 2, delta: "API_TOKEN=" },
			{ ...terminal, seq: 3, delta: "abcdefgh" },
		])
		expect(output.map((event) => (event.type === "terminal.output" ? event.delta : "")).join("")).toBe(
			"Build succeeded\n[REDACTED]",
		)
		const mixed = zooStreamSchema.parse([
			{ ...terminal, seq: 1, delta: "Build succeeded\nAPI_TOKEN=" },
			{ ...terminal, seq: 2, delta: "abcdefgh\n" },
		])
		expect(mixed.map((event) => (event.type === "terminal.output" ? event.delta : "")).join("")).toBe(
			"Build succeeded\n[REDACTED]\n",
		)
		const empty = zooStreamSchema.parse([{ ...terminal, seq: 1, delta: "" }])
		expect(empty).toMatchObject([{ type: "terminal.output", delta: "" }])
	})

	it("buffers multiline secrets and fails closed when bounded memory is exceeded", () => {
		const terminal = {
			v: 1,
			timestamp,
			hostId: "host",
			rootTaskId: "root",
			taskId: "root",
			type: "terminal.output",
			toolCallId: "terminal",
			stream: "stdout",
		} as const
		const output = zooStreamSchema.parse([
			{ ...terminal, seq: 1, delta: "-----BEGIN PRIVATE KEY-----\n" },
			{ ...terminal, seq: 2, delta: "super-secret-body\n" },
			{ ...terminal, seq: 3, delta: "-----END PRIVATE KEY-----\n" },
		])
		expect(output.map((event) => (event.type === "terminal.output" ? event.delta : "")).join("")).toBe(
			"[REDACTED]\n",
		)
		const repeated = zooStreamSchema.parse([
			{
				...terminal,
				seq: 1,
				delta: "-----BEGIN PRIVATE KEY-----\nfirst\n-----END PRIVATE KEY-----\n-----BEGIN PRIVATE KEY-----\nsecond",
			},
		])
		expect(repeated.map((event) => (event.type === "terminal.output" ? event.delta : "")).join("")).toBe(
			"[REDACTED]",
		)
		const pgp = zooStreamSchema.parse([
			{ ...terminal, seq: 1, delta: "-----BEGIN PGP PRIVATE KEY BLOCK-----\n" },
			{ ...terminal, seq: 2, delta: "private-body\n" },
			{ ...terminal, seq: 3, delta: "-----END PGP PRIVATE KEY BLOCK-----\n" },
		])
		expect(pgp.map((event) => (event.type === "terminal.output" ? event.delta : "")).join("")).toBe("[REDACTED]\n")

		const parser = createHostEventStreamParser({ hostId: "host", maxPendingBytes: 4 })
		const overflow = parser.push({
			v: 1,
			seq: 1,
			hostId: "host",
			type: "event",
			event: { ...terminal, seq: 1, delta: "secret" },
		})
		expect(
			overflow[0]?.type === "event" && overflow[0].event.type === "terminal.output" && overflow[0].event.delta,
		).toBe("[REDACTED]")
		const cappedParser = createHostEventStreamParser({ hostId: "host", maxPendingStreams: 1 })
		const pending = (seq: number, toolCallId: string) => ({
			v: 1,
			seq,
			hostId: "host",
			type: "event",
			event: { ...terminal, seq, toolCallId, delta: "unterminated" },
		})
		const capped = [
			...cappedParser.push(pending(1, "first")),
			...cappedParser.push(pending(2, "second")),
			...cappedParser.push(pending(3, "third")),
			...cappedParser.flush(),
		]
		expect(
			capped.every(
				(event) =>
					event.type === "event" &&
					event.event.type === "terminal.output" &&
					event.event.delta === "[REDACTED]",
			),
		).toBe(true)
		let now = 0
		const deadlineParser = createHostEventStreamParser({ hostId: "host", maxPendingMs: 10, now: () => now })
		expect(deadlineParser.push(pending(1, "deadline"))).toEqual([])
		now = 10
		const released = deadlineParser.push({
			v: 1,
			seq: 2,
			hostId: "host",
			type: "host.heartbeat",
			monotonicMs: 1,
		})
		expect(released.map((event) => event.seq)).toEqual([1, 2])
		expect(
			released[0]?.type === "event" && released[0].event.type === "terminal.output" && released[0].event.delta,
		).toBe("[REDACTED]")

		const unterminated = zooStreamSchema.parse([
			{ ...terminal, seq: 1, delta: "-----BEGIN PRIVATE KEY-----\n" },
			{ ...terminal, seq: 2, delta: "super-secret-body" },
		])
		expect(unterminated.map((event) => (event.type === "terminal.output" ? event.delta : "")).join("")).toBe(
			"[REDACTED]",
		)
		const unterminatedQuoted = zooStreamSchema.parse([{ ...terminal, seq: 1, delta: '{"api_key":"hunter2' }])
		expect(unterminatedQuoted[0]?.type === "terminal.output" && unterminatedQuoted[0].delta).toBe("[REDACTED]")
		const escapedUnterminatedQuoted = zooStreamSchema.parse([
			{ ...terminal, seq: 1, delta: '{"api\\u005fkey":"hunter2' },
		])
		expect(escapedUnterminatedQuoted[0]?.type === "terminal.output" && escapedUnterminatedQuoted[0].delta).toBe(
			"[REDACTED]",
		)
		const multilineQuoted = zooStreamSchema.parse([
			{ ...terminal, seq: 1, delta: 'password="first\n' },
			{ ...terminal, seq: 2, delta: 'second"\n' },
			{ ...terminal, seq: 3, delta: "harmless\n" },
		])
		expect(multilineQuoted.map((event) => (event.type === "terminal.output" ? event.delta : "")).join("")).toBe(
			"[REDACTED][REDACTED]harmless\n",
		)
		const multilineCookie = zooStreamSchema.parse([
			{ ...terminal, seq: 1, delta: 'cookie="first\n' },
			{ ...terminal, seq: 2, delta: 'second"\n' },
			{ ...terminal, seq: 3, delta: "harmless\n" },
		])
		expect(multilineCookie.map((event) => (event.type === "terminal.output" ? event.delta : "")).join("")).toBe(
			"[REDACTED][REDACTED]harmless\n",
		)
		const multilineAssignment = zooStreamSchema.parse([
			{ ...terminal, seq: 1, delta: "API_TOKEN=\n" },
			{ ...terminal, seq: 2, delta: "hunter2\n" },
			{ ...terminal, seq: 3, delta: "harmless\n" },
		])
		expect(multilineAssignment.map((event) => (event.type === "terminal.output" ? event.delta : "")).join("")).toBe(
			"[REDACTED][REDACTED]harmless\n",
		)
		const ansiPem = zooStreamSchema.parse([
			{ ...terminal, seq: 1, delta: "-----BEGIN\u001b[31m PRIVATE KEY-----\n" },
			{ ...terminal, seq: 2, delta: "private-body\n" },
		])
		expect(ansiPem.map((event) => (event.type === "terminal.output" ? event.delta : "")).join("")).toBe(
			"[REDACTED]",
		)

		const interleaved = zooStreamSchema.parse([
			{ ...terminal, seq: 1, delta: "API_TOKEN=" },
			{ ...terminal, seq: 2, stream: "stderr", delta: "harmless\n" },
			{ ...terminal, seq: 3, delta: "abcdefgh\n" },
		])
		expect(interleaved.map((event) => (event.type === "terminal.output" ? event.delta : "")).join("")).toBe(
			"[REDACTED][REDACTED]",
		)
		const crossStream = zooStreamSchema.parse([
			{ ...terminal, seq: 1, delta: "API_TOKEN=" },
			{ ...terminal, seq: 2, stream: "stderr", delta: "hunter2\n" },
		])
		expect(crossStream.map((event) => (event.type === "terminal.output" ? event.delta : "")).join("")).toBe(
			"[REDACTED]",
		)
		expect(crossStream.map((event) => (event.type === "terminal.output" ? event.stream : ""))).toEqual([
			"stdout",
			"stderr",
		])
		const crossStreamQuote = zooStreamSchema.parse([
			{ ...terminal, seq: 1, delta: 'password="first\n' },
			{ ...terminal, seq: 2, stream: "stderr", delta: 'diagnostic "\n' },
			{ ...terminal, seq: 3, delta: "hunter2\n" },
		])
		expect(crossStreamQuote.map((event) => (event.type === "terminal.output" ? event.delta : "")).join("")).toBe(
			"[REDACTED][REDACTED][REDACTED]",
		)
	})

	it("preserves prototype-like keys as redacted record data", () => {
		const input = JSON.parse('{"__proto__":{"polluted":true},"safe":"value"}') as Record<string, unknown>
		const output = redactValue(input)
		expect(output).toEqual(input)
		expect(Object.prototype.hasOwnProperty.call(output, "__proto__")).toBe(true)
		expect(({} as Record<string, unknown>).polluted).toBeUndefined()
	})

	it("handles cycles without throwing", () => {
		const input: Record<string, unknown> = {}
		input.self = input
		expect(redactValue(input)).toEqual({ self: "[CIRCULAR]" })
	})

	it("preserves repeated non-cyclic references", () => {
		const shared = { value: "safe" }
		expect(redactValue({ left: shared, right: shared })).toEqual({
			left: { value: "safe" },
			right: { value: "safe" },
		})
	})

	it("canonicalizes terminal controls and credential value suffixes", () => {
		expect(redactText(`API_\u001b]0;title\u0007TOKEN=hunter2`)).toBe("[REDACTED]")
		expect(redactText(`API_\u009dtitle\u009cTOKEN=hunter2`)).toBe("[REDACTED]")
		expect(redactText("passX\bword=hunter2")).toBe("[REDACTED]")
		expect(redactText("passX\u001b[1Dword=hunter2")).toBe("[REDACTED]")
		expect(redactText("word=hunter2\rpass")).toBe("[REDACTED]")
		expect(redactValue({ apikey: "one", apitoken: "two", authtoken: "three", accesstoken: "four" })).toEqual({
			apikey: "[REDACTED]",
			apitoken: "[REDACTED]",
			authtoken: "[REDACTED]",
			accesstoken: "[REDACTED]",
		})
		expect(redactValue({ accessTokenValue: "hunter2", apiKeyValue: "secret", maxTokenValue: 10 })).toEqual({
			accessTokenValue: "[REDACTED]",
			apiKeyValue: "[REDACTED]",
			maxTokenValue: 10,
		})
	})
})

describe("deterministic parity oracle", () => {
	it.each(parityScenarios)("accepts the $id golden semantic trace", (scenario) => {
		expect(compareSemanticTraces(scenario.expected, runDeterministicFakeProvider(scenario))).toEqual({ ok: true })
	})

	it("includes the prompt in fake-provider semantics", () => {
		const scenario = { ...parityScenarios[0]!, prompt: "Changed prompt" }
		expect(
			compareSemanticTraces(parityScenarios[0]!.expected, runDeterministicFakeProvider(scenario)),
		).toMatchObject({
			ok: false,
		})
	})

	it("includes tool identity and arguments in fake-provider semantics", () => {
		const trace = runDeterministicFakeProvider(parityScenarios[1]!)
		expect(trace.find((entry) => entry.type === "tool.started")).toMatchObject({
			toolName: "read_file",
			toolArguments: { path: "README.md" },
		})
	})

	it("detects child completion incorrectly settling the root", () => {
		const trace = [
			{ type: "task.created", taskId: "root" },
			{ type: "task.result", taskId: "child", outcome: "completed" as const },
		]
		expect(assertAuthoritativeRootResult(trace, "root")).toBe(false)
		expect(assertAuthoritativeRootResult(parityScenarios[2]!.expected, "root")).toBe(true)
		expect(
			assertAuthoritativeRootResult([{ type: "task.result", taskId: "root", rootTaskId: "root" }], "root"),
		).toBe(false)
		expect(
			assertAuthoritativeRootResult(
				[{ type: "task.result", taskId: "root", rootTaskId: "root", outcome: "failed" }],
				"root",
			),
		).toBe(false)
		expect(
			assertAuthoritativeRootResult(
				[
					{
						type: "task.result",
						taskId: "root",
						rootTaskId: "root",
						outcome: "cancelled",
						cancellationReason: "invalid" as "user",
					},
				],
				"root",
			),
		).toBe(false)
		expect(
			assertAuthoritativeRootResult(
				[{ type: "task.result", taskId: "root", rootTaskId: "root", outcome: "timed_out" }],
				"root",
			),
		).toBe(true)
		expect(
			assertAuthoritativeRootResult(
				[
					{
						type: "task.result",
						taskId: "root",
						rootTaskId: "root",
						outcome: "completed",
						resumable: true,
					},
				],
				"root",
			),
		).toBe(false)
		expect(
			assertAuthoritativeRootResult(
				[{ type: "task.result", taskId: "root", rootTaskId: "root", outcome: "needs_input" }],
				"root",
			),
		).toBe(false)
	})

	it("reports semantic drift without timestamps", () => {
		const expected = parityScenarios[0]!.expected
		const result = compareSemanticTraces(expected, expected.slice(0, -1))
		expect(result).toMatchObject({ ok: false })
	})

	it("models timeout separately and rejects trailing terminal turns", () => {
		const timeout = runDeterministicFakeProvider({
			id: "timeout",
			prompt: "Timeout",
			providerTurns: ["timeout:task_timed_out"],
			expected: [],
		})
		expect(timeout.at(-1)).toMatchObject({ outcome: "timed_out", errorCode: "task_timed_out" })
		expect(timeout.find((entry) => entry.type === "task.lifecycle")).toMatchObject({
			state: "interrupted",
			cause: "timed_out",
		})
		expect(
			assertAuthoritativeRootResult(
				[{ type: "task.result", taskId: "root", rootTaskId: "root", outcome: "timed_out" }],
				"root",
			),
		).toBe(true)
		const colonArgument = runDeterministicFakeProvider({
			id: "colon-argument",
			prompt: "Read URL",
			providerTurns: ["tool:read_file:call:https://example.com/a:b"],
			expected: [],
		})
		expect(colonArgument.find((entry) => entry.type === "tool.started")?.toolArguments).toEqual({
			path: "https://example.com/a:b",
		})
		expect(() =>
			runDeterministicFakeProvider({
				id: "malformed-tool",
				prompt: "Read",
				providerTurns: ["tool:read_file:call"],
				expected: [],
			}),
		).toThrow("Invalid tool fixture")
		expect(() =>
			runDeterministicFakeProvider({
				id: "invalid-failure",
				prompt: "Fail",
				providerTurns: ["fail:task_timed_out"],
				expected: [],
			}),
		).toThrow()
		expect(() =>
			runDeterministicFakeProvider({
				id: "trailing",
				prompt: "Cancel",
				providerTurns: ["cancel:cancel-1:user", "trailing"],
				expected: [],
			}),
		).toThrow()
	})

	it("rejects unresolved fake-provider state and events after the authoritative result", () => {
		for (const providerTurns of [
			["delegate:child"],
			["ask:ask-1"],
			["delegate:child", "fail:provider_failed"],
			["ask:ask-1", "cancel:cancel-1:user"],
			["delegate:child", "timeout:task_timed_out"],
		]) {
			expect(() =>
				runDeterministicFakeProvider({ id: "unresolved", prompt: "Unresolved", providerTurns, expected: [] }),
			).toThrow()
		}
		expect(
			assertAuthoritativeRootResult(
				[
					{ type: "task.result", taskId: "root", rootTaskId: "root", outcome: "completed" },
					{ type: "message.upsert", taskId: "root", content: "late" },
				],
				"root",
			),
		).toBe(false)
		expect(() =>
			runDeterministicFakeProvider({
				id: "ghost",
				prompt: "Ghost",
				providerTurns: ["ghost:done"],
				expected: [],
			}),
		).toThrow()
		expect(() =>
			runDeterministicFakeProvider({
				id: "duplicate",
				prompt: "Duplicate",
				providerTurns: ["delegate:child", "delegate:child"],
				expected: [],
			}),
		).toThrow()
		for (const providerTurns of [
			["delegate:root"],
			["tool:read_file:call-1:a", "tool:read_file:call-1:b"],
			["ask:ask-1", "approve:ask-1:user:request-1", "ask:ask-1"],
			["ask:ask-1", "approve:ask-1:user:request-1", "ask:ask-2", "approve:ask-2:user:request-1"],
		]) {
			expect(() =>
				runDeterministicFakeProvider({ id: "reused", prompt: "Reuse", providerTurns, expected: [] }),
			).toThrow()
		}
	})

	it("rejects extra approval and cancellation fixture fields", () => {
		for (const providerTurns of [
			["ask:ask-1", "approve:ask-1:user:request-1:extra"],
			["cancel:request-1:user:extra"],
		]) {
			expect(() =>
				runDeterministicFakeProvider({
					id: "extra-fields",
					prompt: "Reject extras",
					providerTurns,
					expected: [],
				}),
			).toThrow()
		}
	})

	it("ignores object property insertion order without ignoring event order", () => {
		const expected = [{ type: "message.upsert", taskId: "root", content: "hello" }]
		const reordered = [{ content: "hello", taskId: "root", type: "message.upsert" }]
		expect(compareSemanticTraces(expected, reordered)).toEqual({ ok: true })
		expect(compareSemanticTraces(expected, [...reordered, ...reordered])).toMatchObject({ ok: false })
	})
})
