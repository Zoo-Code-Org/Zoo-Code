import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { RooCodeEventName, TaskCommandName, type TaskCommand, type TaskEvent } from "@roo-code/types"
import { registerFixture } from "./registry.ts"
import { runAgentFixture, type AgentRuntime, type AgentRunResult } from "./runner.ts"
import { digestProjection, type AgentTrace } from "./trace.ts"
import type { AgentFixture } from "./contract.ts"

const CREDENTIAL = "sk-sentinel-credential-123"

const allow = {
	readOnly: false,
	readOnlyOutsideWorkspace: false,
	write: false,
	writeOutsideWorkspace: false,
	writeProtected: false,
	execute: false,
	mcp: false,
	modeSwitch: false,
	subtasks: false,
	followupQuestions: false,
}

function registerTestFixture(name: string, overrides: Partial<AgentFixture> = {}): AgentFixture {
	const fixture: AgentFixture = {
		identity: { name, version: "1.0.0", description: "Synthetic controller test fixture." },
		prompt: `synthetic prompt for ${name}`,
		workspace: { files: [] },
		toolPolicy: {
			mode: "test",
			roleDefinition: "Run one synthetic task.",
			groups: [],
			disabledTools: ["new_task"],
			allow,
		},
		limits: {
			activationTimeoutMs: 120_000,
			taskStartTimeoutMs: 35_000,
			taskRunTimeoutMs: 120_000,
			usageDrainMs: 5_000,
			teardownStepMs: 5_000,
		},
		settingsProjection: { provider: "test", model: `model-${name}` },
		buildConfiguration: () => ({
			apiProvider: "openai",
			openAiApiKey: CREDENTIAL,
			mode: "test",
			customModes: [{ slug: "test", name: "Test", roleDefinition: "Run one synthetic task.", groups: [] }],
			disabledTools: ["new_task"],
			alwaysAllowReadOnly: false,
			alwaysAllowReadOnlyOutsideWorkspace: false,
			alwaysAllowWrite: false,
			alwaysAllowWriteOutsideWorkspace: false,
			alwaysAllowWriteProtected: false,
			alwaysAllowExecute: false,
			alwaysAllowMcp: false,
			alwaysAllowModeSwitch: false,
			alwaysAllowSubtasks: false,
			alwaysAllowFollowupQuestions: false,
		}),
		...overrides,
	}
	registerFixture(fixture)
	return fixture
}

type Scenario = "success" | "setup" | "activation" | "start-failure" | "disconnect" | "no-events" | "foreign"

function harness(
	scenario: Scenario,
	options: {
		stuck?: boolean
		closeThrows?: boolean
		timeout?: () => void
		onPause?: (count: number) => void
		disconnectOnPause?: number
		onLaunch?: () => void
		onReady?: () => void
	} = {},
) {
	let now = 0
	let pauseCount = 0
	let exited = false
	let onExit = () => {}
	let onDisconnect = () => {}
	let onEvent: (event: unknown) => void = () => {}
	let interrupt = () => {}
	let cleaned = false
	let disconnected = false
	let unsubscribed = false
	let launched = false
	let connected = false
	let readyAnnounced = false
	let workspaceFiles: readonly { path: string; content: string }[] = []
	const commands: TaskCommand[] = []
	const signals: NodeJS.Signals[] = []
	const artifacts: { name: string; value: unknown }[] = []
	// Events emitted before the run registers its listener; they flush when
	// the task command is sent, matching real post-connect delivery.
	const pendingEvents: unknown[] = []
	const emit = (event: unknown) => {
		if (launched) onEvent(event)
		else pendingEvents.push(event)
	}
	const close = () => {
		exited = true
		onExit()
	}
	const runtime: AgentRuntime = {
		async launch(files) {
			launched = true
			workspaceFiles = files
			if (scenario === "setup") throw new Error("private setup detail")
			options.onLaunch?.()
			return {
				get exited() {
					return exited
				},
				onExit(listener) {
					onExit = listener
				},
				signal(signal) {
					signals.push(signal)
					if (!options.stuck) close()
				},
			}
		},
		connect() {
			connected = true
			return {
				get isReady() {
					if (!readyAnnounced && scenario !== "activation") {
						readyAnnounced = true
						options.onReady?.()
					}
					return scenario !== "activation"
				},
				onTaskEvent(listener) {
					onEvent = listener
				},
				onDisconnect(listener) {
					onDisconnect = listener
				},
				disconnect() {
					disconnected = true
				},
				sendCommand(command) {
					commands.push(command)
					if (command.commandName === TaskCommandName.CloseTask) {
						if (options.closeThrows) throw new Error("private close error")
						if (!options.stuck) close()
						return
					}
					if (command.commandName !== TaskCommandName.StartNewTask) return
					for (const event of pendingEvents.splice(0)) onEvent(event)
					if (options.timeout) {
						options.timeout()
						return
					}
					onEvent({
						eventName: RooCodeEventName.TaskStartResponse,
						payload: [
							scenario === "start-failure"
								? {
										requestId: command.data.requestId,
										success: false,
										errorCode: "task_start_failed",
										errorMessage: "Task start failed",
									}
								: { requestId: command.data.requestId, success: true, taskId: "root" },
						],
					})
					const taskId = scenario === "foreign" ? "other" : "root"
					if (scenario === "foreign") {
						onEvent({
							eventName: RooCodeEventName.TaskTokenUsageUpdated,
							payload: [
								taskId,
								{ totalTokensIn: 1, totalTokensOut: 1, totalCost: 0, contextTokens: 1 },
								{},
							],
						})
					}
					if (scenario === "success") {
						onEvent({
							eventName: RooCodeEventName.Message,
							payload: [
								{
									taskId,
									action: "created",
									message: {
										ts: 1,
										type: "say",
										say: "api_req_started",
										text: JSON.stringify({ apiProtocol: "openai" }),
									},
								},
							],
						})
						onEvent({
							eventName: RooCodeEventName.Message,
							payload: [
								{
									taskId,
									action: "updated",
									message: {
										ts: 1,
										type: "say",
										say: "api_req_started",
										text: JSON.stringify({ apiProtocol: "openai", tokensIn: 7, tokensOut: 3 }),
									},
								},
							],
						})
						onEvent({
							eventName: RooCodeEventName.TaskTokenUsageUpdated,
							payload: [
								taskId,
								{ totalTokensIn: 7, totalTokensOut: 3, totalCost: 0, contextTokens: 9 },
								{},
							],
						})
					}
					if (scenario === "disconnect") onDisconnect()
				},
			}
		},
		async cleanup() {
			cleaned = true
		},
		async writeArtifact(name, value) {
			artifacts.push({ name, value })
		},
		onInterrupt(listener) {
			interrupt = listener
			return () => {
				unsubscribed = true
			}
		},
		now: () => now,
		async pause(ms) {
			now += ms
			pauseCount++
			// The callback runs first so a test can emit before the loss lands.
			options.onPause?.(pauseCount)
			if (options.disconnectOnPause === pauseCount) onDisconnect()
		},
	}
	return {
		runtime,
		commands,
		signals,
		artifacts,
		emit,
		interrupt: () => interrupt(),
		get cleaned() {
			return cleaned
		},
		get disconnected() {
			return disconnected
		},
		get unsubscribed() {
			return unsubscribed
		},
		get launched() {
			return launched
		},
		get connected() {
			return connected
		},
		get workspaceFiles() {
			return workspaceFiles
		},
	}
}

const writtenTrace = (f: ReturnType<typeof harness>): AgentTrace => {
	const entry = f.artifacts.find((artifact) => artifact.name === "trace.json")
	assert.ok(entry)
	return entry.value as AgentTrace
}

describe("agent fixture controller", () => {
	it("runs a fixture, writes a metadata-only trace, and keeps credentials and prompts out", async () => {
		registerTestFixture("controller-success")
		const f = harness("success")
		const result = await runAgentFixture(f.runtime, {
			fixtureName: "controller-success",
			credential: CREDENTIAL,
			observers: { shouldStop: () => true },
		})
		assert.equal(result.execution.code, "STOPPED")
		assert.equal(result.execution.stopReason, "adapterStop")
		assert.equal(result.execution.completionMessageSeen, false)
		assert.equal(result.execution.activated, true)
		assert.equal(result.execution.taskAccepted, true)
		assert.equal(result.teardown.status, "ok")
		assert.equal(result.teardown.hostExited, true)
		assert.deepEqual(
			f.artifacts.map((artifact) => artifact.name),
			["trace.json"],
		)
		const trace = writtenTrace(f)
		assert.equal(trace.traceSchemaVersion, 1)
		assert.equal(trace.kind, "agent-evals-trace")
		assert.equal(trace.settings.available, true)
		assert.equal(trace.settings.digest, digestProjection({ provider: "test", model: "model-controller-success" }))
		assert.equal(trace.accounting.requestCount, 1)
		assert.deepEqual(trace.accounting.requests[0]?.tokensIn, { available: true, value: 7 })
		assert.equal(trace.accounting.requests[0]?.messageCount, 2)
		assert.equal(trace.accounting.usage.snapshotsObserved, 1)
		assert.equal(trace.accounting.completeness.status, "complete")
		assert.deepEqual(trace.accounting.completeness.reasons, [])
		const serialized = JSON.stringify(trace)
		assert.ok(!serialized.includes(CREDENTIAL))
		assert.ok(!serialized.includes("synthetic prompt"))
		assert.ok(!serialized.includes("root"))
		assert.ok(f.cleaned && f.disconnected && f.unsubscribed)
		assert.equal(f.commands.at(-1)?.commandName, TaskCommandName.CloseTask)
	})

	it("buffers events before the start ack, replays only accepted task events, and counts the rest", async () => {
		registerTestFixture("controller-buffer", {
			limits: {
				activationTimeoutMs: 100,
				taskStartTimeoutMs: 100,
				taskRunTimeoutMs: 200,
				usageDrainMs: 100,
				teardownStepMs: 100,
			},
		})
		const f = harness("foreign")
		const result = await runAgentFixture(f.runtime, { fixtureName: "controller-buffer", credential: CREDENTIAL })
		assert.equal(result.execution.code, "TASK_RUN_TIMEOUT")
		const trace = writtenTrace(f)
		assert.equal(trace.eventFlow.observed, 2)
		assert.equal(trace.eventFlow.foreignTaskEvents, 1)
		assert.equal(trace.eventFlow.replayedAfterAck, 1)
		assert.ok(trace.accounting.completeness.reasons.includes("foreignTaskEventsDropped"))
		assert.ok(trace.accounting.completeness.reasons.includes("noUsageEventsObserved"))

		const mixed = harness("success")
		mixed.emit({
			eventName: RooCodeEventName.TaskStartResponse,
			payload: [{ requestId: "nope", success: true, taskId: "x" }],
		})
		const accepted: TaskEvent[] = []
		const result2 = await runAgentFixture(mixed.runtime, {
			fixtureName: "controller-buffer",
			credential: CREDENTIAL,
			observers: {
				onAcceptedEvent: (event) => accepted.push(event),
				shouldStop: () => accepted.length >= 3,
			},
		})
		assert.equal(result2.execution.code, "STOPPED")
		assert.equal(writtenTrace(mixed).eventFlow.replayedAfterAck, 3)
		assert.equal(accepted.length, 3)
	})

	it("reports a rejected task start without replay, and still tears down cleanly", async () => {
		registerTestFixture("controller-start-failure")
		const f = harness("start-failure")
		f.emit({ eventName: RooCodeEventName.TaskStarted, payload: ["root"] })
		const result = await runAgentFixture(f.runtime, {
			fixtureName: "controller-start-failure",
			credential: CREDENTIAL,
		})
		assert.equal(result.execution.code, "TASK_START_FAILED")
		assert.equal(result.execution.stopReason, "startNotAccepted")
		assert.equal(result.execution.activated, true)
		assert.equal(result.execution.taskAccepted, false)
		const trace = writtenTrace(f)
		assert.equal(trace.eventFlow.bufferedBeforeAck, 1)
		assert.equal(trace.eventFlow.replayedAfterAck, 0)
		assert.ok(trace.accounting.completeness.reasons.includes("taskNotAccepted"))
		assert.equal(result.teardown.status, "ok")
		assert.equal(result.teardown.hostExited, true)
		assert.equal(result.teardown.cleanup, "done")
		assert.ok(f.cleaned && f.disconnected && f.unsubscribed)
	})

	it("never connects or starts a task when the interrupt lands during launch", async () => {
		registerTestFixture("controller-launch-interrupt")
		const f = harness("success", { onLaunch: () => f.interrupt() })
		const result = await runAgentFixture(f.runtime, {
			fixtureName: "controller-launch-interrupt",
			credential: CREDENTIAL,
		})
		assert.equal(f.launched, true)
		assert.equal(f.connected, false)
		assert.equal(f.commands.length, 0)
		assert.equal(result.execution.code, "SETUP_FAILED")
		assert.equal(result.execution.activated, false)
		assert.equal(result.execution.taskAccepted, false)
		assert.deepEqual(f.signals, ["SIGTERM"])
		assert.equal(result.teardown.status, "ok")
		assert.equal(result.teardown.hostExited, true)
		assert.equal(result.teardown.cleanup, "done")
		assert.ok(f.cleaned && f.unsubscribed)
	})

	it("stops before the start command when the interrupt lands after activation", async () => {
		registerTestFixture("controller-activation-interrupt")
		const f = harness("success", { onReady: () => f.interrupt() })
		const result = await runAgentFixture(f.runtime, {
			fixtureName: "controller-activation-interrupt",
			credential: CREDENTIAL,
		})
		assert.equal(result.execution.activated, true)
		assert.equal(result.execution.taskAccepted, false)
		assert.equal(result.execution.code, "SETUP_FAILED")
		assert.ok(!f.commands.some((command) => command.commandName === TaskCommandName.StartNewTask))
		assert.deepEqual(f.signals, ["SIGTERM"])
		assert.equal(result.teardown.status, "ok")
		assert.equal(result.teardown.hostExited, true)
		assert.ok(f.cleaned && f.disconnected && f.unsubscribed)
	})

	it("drops exactly one event past the pre-ack buffer limit and records the overflow caveat", async () => {
		registerTestFixture("controller-overflow")
		const f = harness("no-events")
		for (let index = 0; index < 257; index++) f.emit({ eventName: RooCodeEventName.TaskStarted, payload: ["root"] })
		const result = await runAgentFixture(f.runtime, {
			fixtureName: "controller-overflow",
			credential: CREDENTIAL,
			observers: { shouldStop: () => true },
		})
		assert.equal(result.execution.code, "STOPPED")
		assert.equal(result.execution.taskAccepted, true)
		const trace = writtenTrace(f)
		assert.equal(trace.eventFlow.observed, 258)
		assert.equal(trace.eventFlow.eventBufferLimit, 256)
		assert.equal(trace.eventFlow.bufferedBeforeAck, 256)
		assert.equal(trace.eventFlow.replayedAfterAck, 256)
		assert.equal(trace.eventFlow.bufferOverflow, true)
		assert.equal(trace.eventFlow.droppedByOverflow, 1)
		assert.ok(trace.accounting.completeness.reasons.includes("eventBufferOverflow"))
	})

	it("bounds the run timeout, the activation wait, and the usage drain", async () => {
		registerTestFixture("controller-fast", {
			limits: {
				activationTimeoutMs: 200,
				taskStartTimeoutMs: 200,
				taskRunTimeoutMs: 200,
				usageDrainMs: 500,
				teardownStepMs: 100,
			},
		})
		const timedOut = harness("no-events")
		const timeoutResult = await runAgentFixture(timedOut.runtime, {
			fixtureName: "controller-fast",
			credential: CREDENTIAL,
		})
		assert.equal(timeoutResult.execution.code, "TASK_RUN_TIMEOUT")
		assert.equal(timeoutResult.execution.stopReason, "runTimeout")
		assert.equal(writtenTrace(timedOut).execution.timings.taskRunMs, 200)
		assert.equal(writtenTrace(timedOut).accounting.usage.available, false)

		const neverReady = harness("activation")
		const activationResult = await runAgentFixture(neverReady.runtime, {
			fixtureName: "controller-fast",
			credential: CREDENTIAL,
		})
		assert.equal(activationResult.execution.code, "ACTIVATION_FAILED")
		assert.equal(writtenTrace(neverReady).execution.timings.activationMs, 200)
		assert.equal(neverReady.commands.length, 0)
		assert.ok(neverReady.cleaned)

		registerTestFixture("controller-drain", {
			limits: {
				activationTimeoutMs: 120_000,
				taskStartTimeoutMs: 35_000,
				taskRunTimeoutMs: 120_000,
				usageDrainMs: 500,
				teardownStepMs: 5_000,
			},
		})
		let drained = false
		const withCompletion = harness("success", {
			onPause: (count) => {
				if (count >= 2 && !drained) {
					drained = true
					withCompletion.emit({
						eventName: RooCodeEventName.TaskTokenUsageUpdated,
						payload: [
							"root",
							{ totalTokensIn: 40, totalTokensOut: 20, totalCost: 0, contextTokens: 30 },
							{ attempt_completion: { attempts: 1, failures: 0 } },
						],
					})
				}
			},
		})
		withCompletion.emit({
			eventName: RooCodeEventName.TaskCompleted,
			payload: [
				"root",
				{ totalTokensIn: 7, totalTokensOut: 3, totalCost: 0, contextTokens: 9 },
				{},
				{ isSubtask: false },
			],
		})
		const drainResult = await runAgentFixture(withCompletion.runtime, {
			fixtureName: "controller-drain",
			credential: CREDENTIAL,
		})
		assert.equal(drainResult.execution.code, "COMPLETED")
		assert.equal(drainResult.execution.stopReason, "taskCompleted")
		const drainTrace = writtenTrace(withCompletion)
		assert.equal(drainTrace.execution.timings.usageDrainMs, 500)
		assert.equal(drainTrace.accounting.usage.snapshotsObserved, 3)
		assert.equal(drainTrace.accounting.usage.lastSnapshot?.source, "taskTokenUsageUpdated")
		assert.equal(drainTrace.accounting.usage.lastSnapshot?.tokensIn, 40)
		assert.deepEqual(drainTrace.accounting.toolSnapshot.snapshot, {
			attempt_completion: { attempts: 1, failures: 0 },
		})
	})

	it("records teardown failure separately from execution, and keeps live-host storage out of cleanup", async () => {
		registerTestFixture("controller-stuck")
		const f = harness("success", { stuck: true })
		const result = await runAgentFixture(f.runtime, {
			fixtureName: "controller-stuck",
			credential: CREDENTIAL,
			observers: { shouldStop: () => true },
		})
		assert.equal(result.execution.code, "STOPPED")
		assert.equal(result.teardown.status, "failed")
		assert.equal(result.teardown.hostExited, false)
		assert.deepEqual(result.teardown.escalatedSignals, ["SIGTERM", "SIGKILL"])
		assert.equal(result.teardown.cleanup, "skippedLiveHost")
		assert.equal(f.cleaned, false)
		assert.equal(f.disconnected, true)
		const trace = writtenTrace(f)
		assert.equal(trace.teardown.status, "failed")
		assert.equal(trace.execution.timings.teardownMs, 15_000)
	})

	it("keeps teardown moving after a CloseTask exception", async () => {
		registerTestFixture("controller-closerror")
		const f = harness("success", { closeThrows: true })
		const result = await runAgentFixture(f.runtime, {
			fixtureName: "controller-closerror",
			credential: CREDENTIAL,
			observers: { shouldStop: () => true },
		})
		assert.equal(result.teardown.status, "failed")
		assert.deepEqual(result.teardown.failures, ["closeTask"])
		assert.deepEqual(f.signals, ["SIGTERM"])
		assert.ok(f.cleaned && f.disconnected)
	})

	it("fails closed on setup errors and still writes a trace", async () => {
		registerTestFixture("controller-setup")
		const f = harness("setup")
		const result = await runAgentFixture(f.runtime, { fixtureName: "controller-setup", credential: CREDENTIAL })
		assert.equal(result.execution.code, "SETUP_FAILED")
		assert.equal(result.execution.stopReason, "setupError")
		const trace = writtenTrace(f)
		assert.ok(trace.accounting.completeness.reasons.includes("taskNotAccepted"))
		assert.ok(f.cleaned && f.unsubscribed)
	})

	it("fails closed without a credential before launching", async () => {
		registerTestFixture("controller-nocred")
		const f = harness("success")
		const result = await runAgentFixture(f.runtime, { fixtureName: "controller-nocred", credential: "" })
		assert.equal(result.execution.code, "SETUP_FAILED")
		assert.equal(result.execution.stopReason, "credentialMissing")
		assert.equal(f.launched, false)
		const trace = writtenTrace(f)
		assert.ok(trace)
		// The settings section must name the real cause, not claim a
		// fixture rejection that never happened.
		assert.deepEqual(trace.settings, { available: false, reason: "credentialMissing" })
	})

	it("rejects a configuration that widens the declared tool policy, and never launches", async () => {
		const base = registerTestFixture("controller-policy-base")
		registerTestFixture("controller-policy", {
			buildConfiguration: (credential) => ({ ...base.buildConfiguration(credential), alwaysAllowExecute: true }),
		})
		const f = harness("success")
		const result = await runAgentFixture(f.runtime, { fixtureName: "controller-policy", credential: CREDENTIAL })
		assert.equal(result.execution.stopReason, "fixtureRejected")
		assert.equal(f.launched, false)
		assert.deepEqual(writtenTrace(f).settings, { available: false, reason: "configurationViolatesToolPolicy" })
	})

	it("rejects a fixture whose projection carries the credential, and never launches", async () => {
		registerTestFixture("controller-leak", { settingsProjection: { apiKey: CREDENTIAL } })
		const f = harness("success")
		const result = await runAgentFixture(f.runtime, { fixtureName: "controller-leak", credential: CREDENTIAL })
		assert.equal(result.execution.code, "SETUP_FAILED")
		assert.equal(result.execution.stopReason, "fixtureRejected")
		assert.equal(f.launched, false)
		const trace = writtenTrace(f)
		assert.equal(trace.settings.available, false)
		assert.equal(trace.settings.reason, "credentialInProjection")
		assert.ok(!JSON.stringify(trace).includes(CREDENTIAL))
	})

	it("counts malformed events and tool failures without storing payloads", async () => {
		registerTestFixture("controller-noise")
		const f = harness("success")
		f.emit("garbage")
		f.emit({
			eventName: RooCodeEventName.TaskToolFailed,
			payload: ["root", "read_file", "private failure payload"],
		})
		await runAgentFixture(f.runtime, {
			fixtureName: "controller-noise",
			credential: CREDENTIAL,
			observers: { shouldStop: () => true },
		})
		const trace = writtenTrace(f)
		assert.equal(trace.eventFlow.malformed, 1)
		assert.equal(trace.accounting.toolFailureEvents, 1)
		assert.equal(trace.accounting.toolFailuresByTool["read_file"], 1)
		assert.ok(!JSON.stringify(trace).includes("private failure payload"))
	})

	it("captures injected identity and reports unavailable identity with a reason", async () => {
		registerTestFixture("controller-identity")
		const withIdentity = harness("success")
		withIdentity.runtime.readIdentity = async () => ({
			commit: { available: true, value: "a".repeat(40) },
			extensionVersion: { available: true, value: "3.0.0" },
			vscodeTarget: { available: true, value: "1.100.0" },
			nodeVersion: "v22.0.0",
			platform: "linux",
			arch: "x64",
		})
		await runAgentFixture(withIdentity.runtime, {
			fixtureName: "controller-identity",
			credential: CREDENTIAL,
			observers: { shouldStop: () => true },
		})
		assert.deepEqual(writtenTrace(withIdentity).run.identity.commit, { available: true, value: "a".repeat(40) })

		const without = harness("success")
		const plain = await runAgentFixture(without.runtime, {
			fixtureName: "controller-identity",
			credential: CREDENTIAL,
			observers: { shouldStop: () => true },
		})
		assert.deepEqual(writtenTrace(without).run.identity.commit, { available: false, reason: "identityUnavailable" })
		assert.equal(plain.trace.run.identity.nodeVersion, process.version)
	})

	it("caveats accounting when the session dies inside the usage drain", async () => {
		registerTestFixture("controller-drainloss", {
			limits: {
				activationTimeoutMs: 120_000,
				taskStartTimeoutMs: 35_000,
				taskRunTimeoutMs: 120_000,
				usageDrainMs: 500,
				teardownStepMs: 5_000,
			},
		})
		let interruptCalled = false
		const withCompletion = harness("success", {
			onPause: (count) => {
				// The drain is the first pause: the run loop exits on the
				// pre-emitted completion without polling.
				if (count === 1 && !interruptCalled) {
					interruptCalled = true
					withCompletion.interrupt()
				}
			},
		})
		withCompletion.emit({
			eventName: RooCodeEventName.TaskCompleted,
			payload: [
				"root",
				{ totalTokensIn: 7, totalTokensOut: 3, totalCost: 0, contextTokens: 9 },
				{},
				{ isSubtask: false },
			],
		})
		const result = await runAgentFixture(withCompletion.runtime, {
			fixtureName: "controller-drainloss",
			credential: CREDENTIAL,
		})
		// Completion was observed, so the run code stays COMPLETED and the
		// run-phase session flag stays false.
		assert.equal(result.execution.code, "COMPLETED")
		assert.equal(result.execution.sessionLost, false)
		const trace = writtenTrace(withCompletion)
		assert.equal(trace.execution.timings.usageDrainMs, 100)
		assert.ok(trace.accounting.completeness.reasons.includes("sessionLostDuringUsageDrain"))
		assert.ok(!trace.accounting.completeness.reasons.includes("sessionLost"))
		assert.equal(trace.accounting.completeness.status, "partial")
	})

	it("passes fixture workspace files to the launcher and records session loss", async () => {
		registerTestFixture("controller-workspace", {
			workspace: { files: [{ path: "src/task.md", content: "fixture data" }] },
		})
		const f = harness("success")
		await runAgentFixture(f.runtime, {
			fixtureName: "controller-workspace",
			credential: CREDENTIAL,
			observers: { shouldStop: () => true },
		})
		assert.deepEqual([...f.workspaceFiles], [{ path: "src/task.md", content: "fixture data" }])

		const lost = harness("disconnect")
		const result = await runAgentFixture(lost.runtime, {
			fixtureName: "controller-workspace",
			credential: CREDENTIAL,
		})
		assert.equal(result.execution.code, "SESSION_LOST")
		assert.equal(result.execution.stopReason, "sessionLost")
		assert.equal(result.execution.sessionLost, true)
	})

	it("reproduces the synthetic PR 1909 topology: an observer stop after the completion message stays distinct", async () => {
		// SYNTHETIC FIXTURE. The event topology mirrors one user-reported
		// local live smoke run: two events before the start ack, one accounted
		// request, two cumulative usage snapshots, one final completion_result
		// message, then the observer stops. This is not a recorded provider
		// artifact. Token counts are the reported aggregates. Timings are not
		// reproduced.
		registerTestFixture("pr1909-smoke-topology-synthetic", {
			identity: {
				name: "pr1909-smoke-topology-synthetic",
				version: "0.1.0",
				description:
					"SYNTHETIC reproduction of one reported live smoke topology. Not a recorded provider artifact.",
			},
		})
		const f = harness("no-events", {
			onPause: (count) => {
				if (count !== 1) return
				f.emit({
					eventName: RooCodeEventName.Message,
					payload: [
						{
							taskId: "root",
							action: "created",
							message: {
								ts: 2,
								type: "say",
								say: "api_req_started",
								text: JSON.stringify({ apiProtocol: "openai" }),
							},
						},
					],
				})
				f.emit({
					eventName: RooCodeEventName.Message,
					payload: [
						{
							taskId: "root",
							action: "updated",
							message: {
								ts: 2,
								type: "say",
								say: "api_req_started",
								text: JSON.stringify({ apiProtocol: "openai", tokensIn: 2719, tokensOut: 29 }),
							},
						},
					],
				})
				f.emit({
					eventName: RooCodeEventName.TaskTokenUsageUpdated,
					payload: [
						"root",
						{ totalTokensIn: 2719, totalTokensOut: 12, totalCost: 0, contextTokens: 2719 },
						{},
					],
				})
				f.emit({
					eventName: RooCodeEventName.TaskTokenUsageUpdated,
					payload: [
						"root",
						{ totalTokensIn: 2719, totalTokensOut: 29, totalCost: 0, contextTokens: 2748 },
						{ attempt_completion: { attempts: 1, failures: 0 } },
					],
				})
				f.emit({
					eventName: RooCodeEventName.Message,
					payload: [
						{
							taskId: "root",
							action: "created",
							message: { ts: 3, type: "say", say: "completion_result", text: "synthetic final answer" },
						},
					],
				})
			},
		})
		f.emit({ eventName: RooCodeEventName.TaskStarted, payload: ["root"] })
		f.emit({
			eventName: RooCodeEventName.Message,
			payload: [
				{
					taskId: "root",
					action: "created",
					message: { ts: 1, type: "say", say: "text", text: "synthetic early event" },
				},
			],
		})
		let completionOutput = false
		const result = await runAgentFixture(f.runtime, {
			fixtureName: "pr1909-smoke-topology-synthetic",
			credential: CREDENTIAL,
			observers: {
				onAcceptedEvent: (event) => {
					if (
						event.eventName === RooCodeEventName.Message &&
						event.payload[0].message.say === "completion_result"
					)
						completionOutput = true
				},
				shouldStop: () => completionOutput,
			},
		})
		assert.equal(result.execution.code, "STOPPED")
		assert.equal(result.execution.stopReason, "adapterStopAfterCompletionMessage")
		assert.equal(result.execution.completionMessageSeen, true)
		assert.equal(result.execution.sessionLost, false)
		assert.equal(result.execution.taskAccepted, true)
		assert.equal(result.teardown.status, "ok")
		assert.equal(result.teardown.cleanup, "done")
		const trace = writtenTrace(f)
		// Seven task events plus the counted TaskStartResponse envelope.
		assert.equal(trace.eventFlow.observed, 8)
		assert.equal(trace.eventFlow.bufferedBeforeAck, 2)
		assert.equal(trace.eventFlow.replayedAfterAck, 2)
		assert.equal(trace.eventFlow.malformed, 0)
		assert.equal(trace.eventFlow.foreignTaskEvents, 0)
		assert.equal(trace.accounting.requestCount, 1)
		assert.deepEqual(trace.accounting.requests[0]?.tokensIn, { available: true, value: 2719 })
		assert.deepEqual(trace.accounting.requests[0]?.tokensOut, { available: true, value: 29 })
		assert.equal(trace.accounting.requests[0]?.messageCount, 2)
		assert.equal(trace.accounting.usage.snapshotsObserved, 2)
		assert.equal(trace.accounting.usage.lastSnapshot?.source, "taskTokenUsageUpdated")
		assert.equal(trace.accounting.usage.lastSnapshot?.tokensOut, 29)
		assert.deepEqual(trace.accounting.toolSnapshot.snapshot, {
			attempt_completion: { attempts: 1, failures: 0 },
		})
		assert.equal(trace.accounting.completeness.status, "complete")
		assert.deepEqual(trace.accounting.completeness.reasons, [])
		// The drain is bound to the accepted-completion event. Without it, no
		// drain window runs.
		assert.equal(trace.execution.timings.usageDrainMs, undefined)
		const serialized = JSON.stringify(trace)
		assert.ok(serialized.includes("pr1909-smoke-topology-synthetic"))
		assert.ok(!serialized.includes(CREDENTIAL))
		assert.ok(!serialized.includes("synthetic early event"))
		assert.ok(!serialized.includes("synthetic final answer"))
		assert.ok(!serialized.includes("root"))
	})

	it("keeps invalid completion_result variants observed but not marked as the completion message", async () => {
		registerTestFixture("controller-invalid-completion")
		const f = harness("no-events")
		// One message per rejection condition of the completion filter: a
		// partial stream, whitespace-only final text, and the ask-side
		// completion_result prompt.
		f.emit({
			eventName: RooCodeEventName.Message,
			payload: [
				{
					taskId: "root",
					action: "created",
					message: { ts: 1, type: "say", say: "completion_result", text: "partial output", partial: true },
				},
			],
		})
		f.emit({
			eventName: RooCodeEventName.Message,
			payload: [
				{
					taskId: "root",
					action: "created",
					message: { ts: 2, type: "say", say: "completion_result", text: "  \n\t " },
				},
			],
		})
		f.emit({
			eventName: RooCodeEventName.Message,
			payload: [
				{
					taskId: "root",
					action: "created",
					message: { ts: 3, type: "ask", ask: "completion_result", text: "awaiting feedback" },
				},
			],
		})
		const accepted: TaskEvent[] = []
		const result = await runAgentFixture(f.runtime, {
			fixtureName: "controller-invalid-completion",
			credential: CREDENTIAL,
			observers: {
				onAcceptedEvent: (event) => accepted.push(event),
				shouldStop: () => true,
			},
		})
		const trace = writtenTrace(f)
		// Three task events plus the counted TaskStartResponse envelope.
		assert.equal(accepted.length, 3)
		assert.equal(trace.eventFlow.observed, 4)
		assert.equal(trace.eventFlow.replayedAfterAck, 3)
		assert.equal(result.execution.code, "STOPPED")
		assert.equal(result.execution.stopReason, "adapterStop")
		assert.equal(result.execution.completionMessageSeen, false)
		assert.equal(trace.execution.stopReason, "adapterStop")
		assert.equal(trace.execution.completionMessageSeen, false)
		assert.ok(JSON.stringify(trace).includes('"completionMessageSeen":false'))
	})

	it("keeps completion output non-completing on a run timeout", async () => {
		registerTestFixture("controller-output-timeout", {
			limits: {
				activationTimeoutMs: 120_000,
				taskStartTimeoutMs: 35_000,
				taskRunTimeoutMs: 200,
				usageDrainMs: 100,
				teardownStepMs: 100,
			},
		})
		const f = harness("no-events", {
			onPause: (count) => {
				if (count !== 1) return
				f.emit({
					eventName: RooCodeEventName.Message,
					payload: [
						{
							taskId: "root",
							action: "created",
							message: { ts: 1, type: "say", say: "completion_result", text: "synthetic final answer" },
						},
					],
				})
			},
		})
		const result = await runAgentFixture(f.runtime, {
			fixtureName: "controller-output-timeout",
			credential: CREDENTIAL,
		})
		assert.equal(result.execution.code, "TASK_RUN_TIMEOUT")
		assert.equal(result.execution.stopReason, "runTimeout")
		assert.equal(result.execution.completionMessageSeen, true)
		assert.equal(writtenTrace(f).accounting.usage.snapshotsObserved, 0)
	})

	it("keeps a manual interrupt a session loss even after completion output", async () => {
		registerTestFixture("controller-manual-stop")
		const f = harness("no-events", {
			onPause: (count) => {
				if (count === 1)
					f.emit({
						eventName: RooCodeEventName.Message,
						payload: [
							{
								taskId: "root",
								action: "created",
								message: {
									ts: 1,
									type: "say",
									say: "completion_result",
									text: "synthetic final answer",
								},
							},
						],
					})
				if (count === 2) f.interrupt()
			},
		})
		const result = await runAgentFixture(f.runtime, {
			fixtureName: "controller-manual-stop",
			credential: CREDENTIAL,
		})
		assert.equal(result.execution.code, "SESSION_LOST")
		assert.equal(result.execution.stopReason, "sessionLost")
		assert.equal(result.execution.completionMessageSeen, true)
		assert.deepEqual(f.signals, ["SIGTERM"])
		assert.ok(f.cleaned && f.disconnected)
		const trace = writtenTrace(f)
		assert.ok(trace.accounting.completeness.reasons.includes("sessionLost"))
	})

	it("keeps a confirmed completion when the session dies in the same window", async () => {
		registerTestFixture("controller-completion-outranks-loss")
		const f = harness("success", {
			// The completion event lands, then the session dies, before the run
			// loop can poll again.
			onPause: (count) => {
				if (count === 1)
					f.emit({
						eventName: RooCodeEventName.TaskCompleted,
						payload: [
							"root",
							{ totalTokensIn: 7, totalTokensOut: 3, totalCost: 0, contextTokens: 9 },
							{},
							{ isSubtask: false },
						],
					})
			},
			disconnectOnPause: 1,
		})
		const result = await runAgentFixture(f.runtime, {
			fixtureName: "controller-completion-outranks-loss",
			credential: CREDENTIAL,
		})
		assert.equal(result.execution.code, "COMPLETED")
		assert.equal(result.execution.stopReason, "taskCompleted")
		assert.equal(result.execution.sessionLost, true)
		const trace = writtenTrace(f)
		assert.ok(trace.accounting.completeness.reasons.includes("sessionLost"))
		// A loss in the same window skips the drain and keeps the caveat.
		assert.equal(trace.execution.timings.usageDrainMs, undefined)
	})

	it("keeps a confirmed completion when the observer requests a stop", async () => {
		registerTestFixture("controller-completion-outranks-stop")
		const f = harness("no-events")
		f.emit({
			eventName: RooCodeEventName.Message,
			payload: [
				{
					taskId: "root",
					action: "created",
					message: { ts: 1, type: "say", say: "completion_result", text: "synthetic final answer" },
				},
			],
		})
		f.emit({
			eventName: RooCodeEventName.TaskCompleted,
			payload: [
				"root",
				{ totalTokensIn: 7, totalTokensOut: 3, totalCost: 0, contextTokens: 9 },
				{},
				{ isSubtask: false },
			],
		})
		const result = await runAgentFixture(f.runtime, {
			fixtureName: "controller-completion-outranks-stop",
			credential: CREDENTIAL,
			observers: { shouldStop: () => true },
		})
		assert.equal(result.execution.code, "COMPLETED")
		assert.equal(result.execution.stopReason, "taskCompleted")
		assert.equal(result.execution.completionMessageSeen, true)
		assert.equal(result.execution.sessionLost, false)
		assert.equal(result.teardown.status, "ok")
	})
})
