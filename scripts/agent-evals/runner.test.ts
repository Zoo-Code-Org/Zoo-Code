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
		buildConfiguration: () => ({ apiProvider: "openai", openAiApiKey: CREDENTIAL }),
		...overrides,
	}
	registerFixture(fixture)
	return fixture
}

type Scenario = "success" | "setup" | "activation" | "start-failure" | "disconnect" | "no-events" | "foreign"

function harness(
	scenario: Scenario,
	options: { stuck?: boolean; closeThrows?: boolean; timeout?: () => void; onPause?: (count: number) => void } = {},
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
			return {
				isReady: scenario !== "activation",
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
			options.onPause?.(pauseCount)
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
})
