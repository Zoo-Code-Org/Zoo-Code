import { randomUUID } from "node:crypto"
import { RooCodeEventName, TaskCommandName, taskEventSchema, type TaskCommand, type TaskEvent } from "@roo-code/types"
import { configurationMatchesToolPolicy, type AgentFixtureWorkspaceFile } from "./contract.ts"
import { getFixture } from "./registry.ts"
import { createTaskStartWaiter, type TaskStartWaiter } from "./task-start.ts"
import {
	TRACE_KIND,
	TRACE_NOTES,
	TRACE_SCHEMA_VERSION,
	createAccountant,
	digestProjection,
	eventTaskId,
	identityUnavailable,
	type Accountant,
	type AgentEventFlow,
	type AgentExecutionCode,
	type AgentStopReason,
	type AgentTeardown,
	type AgentTrace,
	type TraceRunIdentity,
} from "./trace.ts"

export interface AgentHost {
	readonly exited: boolean
	onExit(listener: () => void): void
	signal(signal: NodeJS.Signals): void
}

export interface AgentClient {
	readonly isReady: boolean
	onTaskEvent(listener: (event: unknown) => void): void
	onDisconnect(listener: () => void): void
	sendCommand(command: TaskCommand): void
	disconnect(): void
}

// The adapter owns processes, sockets, files and credentials. The controller
// only sees these operations, so tests can drive it with synthetic IPC and a
// deterministic clock.
export interface AgentRuntime {
	launch(workspaceFiles: readonly AgentFixtureWorkspaceFile[]): Promise<AgentHost>
	connect(): AgentClient
	cleanup(): Promise<void>
	writeArtifact(fileName: string, value: unknown): Promise<void>
	onInterrupt(listener: () => void): () => void
	now(): number
	pause(ms: number): Promise<void>
	readIdentity?(): Promise<TraceRunIdentity>
}

export interface AgentRunObservers {
	onAcceptedEvent?(event: TaskEvent, taskId: string): void
	shouldStop?(): boolean
}

export interface AgentRunOptions {
	fixtureName: string
	credential: string
	observers?: AgentRunObservers
}

export interface AgentRunResult {
	execution: {
		code: AgentExecutionCode
		stopReason: AgentStopReason
		activated: boolean
		taskAccepted: boolean
		sessionLost: boolean
		completionMessageSeen: boolean
	}
	teardown: AgentTeardown
	trace: AgentTrace
}

const EVENT_BUFFER_LIMIT = 256

type BufferedEvent = { kind: "parsed"; event: TaskEvent }

const traceSettings = (fixtureProjection: Record<string, unknown>, credential: string): AgentTrace["settings"] => {
	try {
		const projectionJson = JSON.stringify(fixtureProjection)
		if (projectionJson === undefined) return { available: false, reason: "projectionNotSerializable" }
		if (credential.length > 0 && projectionJson.includes(credential))
			return { available: false, reason: "credentialInProjection" }
		return {
			available: true,
			projection: JSON.parse(projectionJson) as Record<string, unknown>,
			digest: digestProjection(fixtureProjection),
		}
	} catch {
		return { available: false, reason: "projectionNotSerializable" }
	}
}

export async function runAgentFixture(runtime: AgentRuntime, options: AgentRunOptions): Promise<AgentRunResult> {
	const fixture = getFixture(options.fixtureName)
	const started = runtime.now()
	let code: AgentExecutionCode = "SETUP_FAILED"
	let stopReason: AgentStopReason = "setupError"
	let activated = false
	let accepted = false
	let sessionLost = false
	// Frozen at the end of the task run phase, before teardown can terminate
	// the host. Teardown exits are reported in the teardown section only.
	let runSessionLost = false
	// Set when the session dies inside the post-completion usage drain.
	let lostDuringDrain = false
	let acceptedTaskId: string | undefined
	let completedSeen = false
	// True once the final completion_result say message for the accepted task
	// arrived. This is model output, not the accepted-completion event. It
	// never produces COMPLETED; it only refines how a stop is reported.
	let completionMessageSeen = false
	// The reason must name what actually stopped evaluation. "notEvaluated"
	// means the projection was never inspected; it is replaced below.
	let settings: AgentTrace["settings"] = { available: false, reason: "notEvaluated" }
	let host: AgentHost | undefined
	let client: AgentClient | undefined
	let waiter: TaskStartWaiter | undefined
	let teardown: AgentTeardown = {
		status: "ok",
		hostExited: true,
		closeTaskSent: false,
		escalatedSignals: [],
		cleanup: "notNeeded",
		failures: [],
	}
	const timings: AgentTrace["execution"]["timings"] = { totalMs: 0 }
	const flow: AgentEventFlow = {
		observed: 0,
		malformed: 0,
		foreignTaskEvents: 0,
		bufferedBeforeAck: 0,
		replayedAfterAck: 0,
		eventBufferLimit: EVENT_BUFFER_LIMIT,
		bufferOverflow: false,
		droppedByOverflow: 0,
	}
	const buffer: BufferedEvent[] = []
	let buffering = false
	const accountant: Accountant = createAccountant(() => runtime.now() - started)

	async function until(check: () => boolean, timeoutMs: number, stopOnLoss = true): Promise<void> {
		const deadline = runtime.now() + timeoutMs
		while (!check() && (!stopOnLoss || !sessionLost) && runtime.now() < deadline) await runtime.pause(100)
	}

	const markLost = () => {
		sessionLost = true
		waiter?.onExit()
	}

	const unsubscribe = runtime.onInterrupt(() => {
		markLost()
		try {
			host?.signal("SIGTERM")
		} catch {
			/* Teardown retries independently. */
		}
	})

	const dispatch = (event: TaskEvent): void => {
		const taskId = eventTaskId(event)
		if (acceptedTaskId === undefined || taskId !== acceptedTaskId) {
			flow.foreignTaskEvents++
			return
		}
		accountant.observe(event)
		if (event.eventName === RooCodeEventName.Message) {
			const message = event.payload[0].message
			if (
				message.type === "say" &&
				message.say === "completion_result" &&
				message.partial !== true &&
				typeof message.text === "string" &&
				message.text.trim().length > 0
			)
				completionMessageSeen = true
		}
		if (event.eventName === RooCodeEventName.TaskCompleted) completedSeen = true
		options.observers?.onAcceptedEvent?.(event, acceptedTaskId)
	}

	const pushBuffer = (item: BufferedEvent): void => {
		if (buffer.length >= EVENT_BUFFER_LIMIT) {
			flow.bufferOverflow = true
			flow.droppedByOverflow++
			return
		}
		buffer.push(item)
		flow.bufferedBeforeAck++
	}

	const handleEvent = (raw: unknown): void => {
		flow.observed++
		if (
			typeof raw === "object" &&
			raw !== null &&
			(raw as { eventName?: unknown }).eventName === RooCodeEventName.TaskStartResponse
		) {
			waiter?.onTaskEvent(raw)
			return
		}
		const parsed = taskEventSchema.safeParse(raw)
		if (!parsed.success) {
			flow.malformed++
			return
		}
		if (buffering) {
			pushBuffer({ kind: "parsed", event: parsed.data })
			return
		}
		dispatch(parsed.data)
	}

	const replay = (): void => {
		buffering = false
		for (const item of buffer.splice(0)) {
			flow.replayedAfterAck++
			dispatch(item.event)
		}
	}

	try {
		const credential = options.credential
		if (!credential) {
			stopReason = "credentialMissing"
			settings = { available: false, reason: "credentialMissing" }
		} else {
			settings = traceSettings(fixture.settingsProjection, credential)
			const configuration = fixture.buildConfiguration(credential)
			if (settings.available && !configurationMatchesToolPolicy(configuration, fixture.toolPolicy))
				settings = { available: false, reason: "configurationViolatesToolPolicy" }
			if (!settings.available) {
				stopReason = "fixtureRejected"
			} else {
				host = await runtime.launch(fixture.workspace.files)
				host.onExit(markLost)
				// An interrupt during launch must not connect or send a task.
				if (sessionLost) throw new Error("startup interrupted")
				client = runtime.connect()
				client.onDisconnect(() => {
					sessionLost = true
					waiter?.onDisconnect()
				})
				client.onTaskEvent(handleEvent)
				buffering = true
				const activationStart = runtime.now()
				await until(() => client?.isReady === true, fixture.limits.activationTimeoutMs)
				activated = client.isReady
				timings.activationMs = runtime.now() - activationStart
				if (!activated) {
					code = "ACTIVATION_FAILED"
					stopReason = "activationFailed"
				} else {
					if (sessionLost) throw new Error("startup interrupted")
					const requestId = randomUUID()
					waiter = createTaskStartWaiter({ requestId, timeoutMs: fixture.limits.taskStartTimeoutMs })
					// A synchronous send failure must not leave a rejected timer promise.
					void waiter.result.catch(() => {})
					const sentAt = runtime.now()
					client.sendCommand({
						commandName: TaskCommandName.StartNewTask,
						data: {
							requestId,
							text: fixture.prompt,
							newTab: false,
							configuration,
						},
					})
					try {
						acceptedTaskId = await waiter.result
						accepted = true
					} catch {
						code = "TASK_START_FAILED"
						stopReason = "startNotAccepted"
					}
					if (accepted) {
						timings.taskStartMs = runtime.now() - sentAt
						replay()
						const runStart = runtime.now()
						await until(
							() => sessionLost || completedSeen || options.observers?.shouldStop?.() === true,
							fixture.limits.taskRunTimeoutMs,
						)
						runSessionLost = sessionLost
						timings.taskRunMs = runtime.now() - runStart
						if (completedSeen && !runSessionLost) {
							// Fixed bound; ends early only on session loss.
							const drainStart = runtime.now()
							await until(() => false, fixture.limits.usageDrainMs)
							timings.usageDrainMs = runtime.now() - drainStart
							// A loss inside the drain window can truncate late
							// usage events. The run code stays COMPLETED, but the
							// accounting must carry the caveat.
							lostDuringDrain = sessionLost
						}
						const stopped = !runSessionLost && !completedSeen && options.observers?.shouldStop?.() === true
						if (completedSeen) {
							// A confirmed accepted completion outranks a stop
							// request or a loss observed in the same window.
							code = "COMPLETED"
							stopReason = "taskCompleted"
						} else if (runSessionLost) {
							code = "SESSION_LOST"
							stopReason = "sessionLost"
						} else if (stopped && completionMessageSeen) {
							// The observer stopped after the model's final
							// completion message. The accepted-completion event
							// never fired, so this is not COMPLETED.
							code = "STOPPED"
							stopReason = "adapterStopAfterCompletionMessage"
						} else if (stopped) {
							code = "STOPPED"
							stopReason = "adapterStop"
						} else {
							code = "TASK_RUN_TIMEOUT"
							stopReason = "runTimeout"
						}
					}
				}
			}
		}
	} catch {
		// Never expose thrown provider, filesystem or host messages.
	} finally {
		waiter?.onExit()
		const teardownStart = runtime.now()
		const attempt = async (step: string, operation: () => unknown) => {
			try {
				await operation()
			} catch {
				teardown.failures.push(step)
			}
		}
		if (client?.isReady) {
			teardown.closeTaskSent = true
			await attempt("closeTask", () => client?.sendCommand({ commandName: TaskCommandName.CloseTask }))
		}
		if (host && !host.exited) {
			await attempt("hostTermination", () =>
				until(() => host?.exited === true, fixture.limits.teardownStepMs, false),
			)
			for (const signal of ["SIGTERM", "SIGKILL"] as const) {
				if (host.exited) break
				await attempt("hostTermination", () => host?.signal(signal))
				teardown.escalatedSignals.push(signal)
				await attempt("hostTermination", () =>
					until(() => host?.exited === true, fixture.limits.teardownStepMs, false),
				)
			}
		}
		teardown.hostExited = host ? host.exited : true
		await attempt("disconnect", () => client?.disconnect())
		if (!host || host.exited) {
			teardown.cleanup = "done"
			await attempt("cleanup", () => runtime.cleanup())
		} else {
			teardown.cleanup = "skippedLiveHost"
		}
		await attempt("unsubscribe", () => unsubscribe())
		if (teardown.failures.length > 0 || (host !== undefined && !host.exited)) teardown.status = "failed"
		timings.teardownMs = runtime.now() - teardownStart
	}

	const finishedAt = runtime.now()
	timings.totalMs = finishedAt - started
	let identity: TraceRunIdentity
	try {
		identity = (await runtime.readIdentity?.()) ?? identityUnavailable()
	} catch {
		identity = identityUnavailable()
	}
	const accounting = accountant.snapshot({
		accepted,
		sessionLost: runSessionLost,
		sessionLostDuringDrain: lostDuringDrain,
		bufferOverflow: flow.bufferOverflow,
		malformedEvents: flow.malformed,
		foreignTaskEvents: flow.foreignTaskEvents,
	})
	const trace: AgentTrace = {
		traceSchemaVersion: TRACE_SCHEMA_VERSION,
		kind: TRACE_KIND,
		run: {
			runId: randomUUID(),
			fixture: { name: fixture.identity.name, version: fixture.identity.version },
			startedAt: new Date(started).toISOString(),
			finishedAt: new Date(finishedAt).toISOString(),
			durationMs: timings.totalMs,
			identity,
		},
		settings,
		execution: {
			code,
			stopReason,
			activated,
			taskAccepted: accepted,
			sessionLost: runSessionLost,
			completionMessageSeen,
			timings,
		},
		eventFlow: flow,
		accounting,
		teardown,
		notes: TRACE_NOTES,
	}
	await runtime.writeArtifact("trace.json", trace)
	return {
		execution: {
			code,
			stopReason,
			activated,
			taskAccepted: accepted,
			sessionLost: runSessionLost,
			completionMessageSeen,
		},
		teardown,
		trace,
	}
}
