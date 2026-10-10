import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { RooCodeEventName, TaskCommandName, type TaskCommand } from "@roo-code/types"
import { runSmoke, smokeExitCode, type SmokeRuntime, type SmokeVerdict } from "./run.ts"

type Scenario =
	| "success"
	| "activation"
	| "start-failure"
	| "no-provider"
	| "no-completion"
	| "tool"
	| "disconnect"
	| "uncorrelated"
	| "aborted"
	| "setup"
function fixture(
	scenario: Scenario = "success",
	options: { stuck?: boolean; closeThrows?: boolean; timeout?: () => void } = {},
) {
	let now = 0
	let exited = false
	let onExit = () => {}
	let onDisconnect = () => {}
	let onEvent: (event: unknown) => void = () => {}
	let interrupt = () => {}
	let cleaned = false
	let disconnected = false
	let unsubscribed = false
	const commands: TaskCommand[] = []
	const signals: NodeJS.Signals[] = []
	const written: SmokeVerdict[] = []
	const close = () => {
		exited = true
		onExit()
	}
	const runtime: SmokeRuntime = {
		async launch() {
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
					const taskId = scenario === "uncorrelated" ? "other" : "root"
					if (scenario !== "no-provider")
						onEvent({
							eventName: RooCodeEventName.TaskTokenUsageUpdated,
							payload: [
								taskId,
								{ totalTokensIn: 1, totalTokensOut: 5, totalCost: 0, contextTokens: 1 },
								{},
							],
						})
					if (scenario !== "no-completion")
						onEvent({
							eventName: RooCodeEventName.Message,
							payload: [
								{
									taskId,
									action: "created",
									message: {
										ts: 1,
										type: "say",
										say: "completion_result",
										text: "private synthetic answer",
									},
								},
							],
						})
					if (scenario === "tool")
						onEvent({
							eventName: RooCodeEventName.TaskSpawned,
							payload: ["root", "child"],
						})
					if (scenario === "disconnect") onDisconnect()
					if (scenario === "aborted") onEvent({ eventName: RooCodeEventName.TaskAborted, payload: ["root"] })
				},
			}
		},
		async cleanup() {
			cleaned = true
		},
		async writeVerdict(verdict) {
			written.push(verdict)
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
		},
	}
	return {
		runtime,
		commands,
		signals,
		written,
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
	}
}

describe("provider smoke orchestration", () => {
	it("correlates startup and evidence, writes a metadata-only verdict, and exits zero", async () => {
		const f = fixture()
		const verdict = await runSmoke(f.runtime, "private-test-key")
		assert.equal(verdict.code, "OK")
		assert.equal(smokeExitCode(verdict), 0)
		assert.deepEqual(verdict.gates, {
			extensionActivated: true,
			ipcConnected: true,
			taskAccepted: true,
			providerResponseSeen: true,
			completionSeen: true,
			childExited: true,
		})
		assert.deepEqual(f.written, [verdict])
		assert.ok(f.cleaned && f.disconnected && f.unsubscribed)
		assert.equal(f.commands.at(-1)?.commandName, TaskCommandName.CloseTask)
		assert.ok(!JSON.stringify(verdict).includes("private"))
	})
	for (const [scenario, code] of [
		["activation", "ACTIVATION_FAILED"],
		["start-failure", "TASK_START_FAILED"],
		["no-provider", "PROVIDER_TIMEOUT"],
		["no-completion", "COMPLETION_MISSING"],
		["tool", "UNEXPECTED_TOOL"],
		["disconnect", "SESSION_LOST"],
		["uncorrelated", "PROVIDER_TIMEOUT"],
		["aborted", "SESSION_LOST"],
		["setup", "SETUP_FAILED"],
	] as const) {
		it(`fails closed for ${scenario} and still writes the verdict`, async () => {
			const f = fixture(scenario)
			const verdict = await runSmoke(f.runtime, "private-test-key")
			assert.equal(verdict.code, code)
			assert.equal(verdict.passed, false)
			assert.equal(smokeExitCode(verdict), 1)
			assert.deepEqual(f.written, [verdict])
			assert.ok(f.cleaned && f.unsubscribed)
		})
	}
	it("bounds startup at the controller and closes its host when no reply arrives", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] })
		const f = fixture("success", { timeout: () => t.mock.timers.tick(35_000) })
		const verdict = await runSmoke(f.runtime, "private-test-key")
		assert.equal(verdict.code, "TASK_START_FAILED")
		assert.equal(verdict.gates.taskAccepted, false)
		assert.ok(f.cleaned)
	})
	it("bounds TERM/KILL teardown and keeps live-host storage out of cleanup", async () => {
		const f = fixture("success", { stuck: true })
		const verdict = await runSmoke(f.runtime, "private-test-key")
		assert.equal(verdict.code, "TEARDOWN_FAILED")
		assert.equal(verdict.durationMs, 15_000)
		assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"])
		assert.equal(verdict.gates.childExited, false)
		assert.equal(f.cleaned, false)
		assert.equal(f.disconnected, true)
	})
	it("preserves the original failure but reports failed teardown separately", async () => {
		const f = fixture("start-failure", { stuck: true })
		const verdict = await runSmoke(f.runtime, "private-test-key")
		assert.equal(verdict.code, "TASK_START_FAILED")
		assert.equal(verdict.gates.childExited, false)
		assert.equal(f.cleaned, false)
	})
	it("interrupts an evidence wait, terminates only its host, and fails closed", async () => {
		const f = fixture("no-completion")
		const pause = f.runtime.pause
		f.runtime.pause = async (ms) => {
			f.interrupt()
			await pause(ms)
		}
		const verdict = await runSmoke(f.runtime, "private-test-key")
		assert.equal(verdict.code, "SESSION_LOST")
		assert.deepEqual(f.signals, ["SIGTERM"])
		assert.ok(f.cleaned && f.unsubscribed)
	})
	it("continues host termination and writes a failing verdict after a CloseTask exception", async () => {
		const f = fixture("success", { closeThrows: true })
		const verdict = await runSmoke(f.runtime, "private-test-key")
		assert.equal(verdict.code, "TEARDOWN_FAILED")
		assert.deepEqual(f.signals, ["SIGTERM"])
		assert.ok(f.cleaned && f.disconnected)
	})
})
