import { describe, expect, it, vi } from "vitest"

import { executeRemoteCommand } from "../executeRemoteCommand.js"
import type { ZooRemoteCommandHost, ZooRemoteCommandHostTask } from "../executeRemoteCommand.js"

function liveTask(overrides: Partial<ZooRemoteCommandHostTask> = {}): ZooRemoteCommandHostTask {
	return {
		taskId: "t1",
		hasPendingAsk: () => false,
		pendingAskTs: () => undefined,
		approveAsk: vi.fn(),
		denyAsk: vi.fn(),
		...overrides,
	}
}

function makeHost(overrides: Partial<ZooRemoteCommandHost> = {}): ZooRemoteCommandHost {
	return {
		isLifecycleCurrent: () => true,
		isEligible: () => true,
		sendMessage: vi.fn().mockResolvedValue(undefined),
		handleModeSwitch: vi.fn().mockResolvedValue(undefined),
		getCurrentTask: () => undefined,
		cancelCurrentTask: vi.fn().mockResolvedValue(undefined),
		resumeTask: vi.fn().mockResolvedValue(undefined),
		startNewTask: vi.fn().mockResolvedValue(undefined),
		endRemoteSession: vi.fn().mockResolvedValue(undefined),
		...overrides,
	}
}

describe("executeRemoteCommand", () => {
	it("acks and sends a message when eligible and lifecycle is current", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const sendMessage = vi.fn().mockResolvedValue(undefined)

		await executeRemoteCommand({
			command: { commandId: "c1", type: "message", taskId: "t1", payload: { text: "hi" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ sendMessage, getCurrentTask: () => liveTask() }),
		})

		expect(sendMessage).toHaveBeenCalledWith("hi", undefined)
		expect(ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
	})

	it("switches mode after sending a message when payload.mode is set", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)

		await executeRemoteCommand({
			command: { commandId: "c1", type: "message", taskId: "t1", payload: { text: "hi", mode: "code" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ handleModeSwitch, getCurrentTask: () => liveTask() }),
		})

		expect(handleModeSwitch).toHaveBeenCalledWith("code")
		expect(ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
	})

	it("skips host actions when lifecycle is stale", async () => {
		const ackCommand = vi.fn()
		const sendMessage = vi.fn()

		await executeRemoteCommand({
			command: { commandId: "c1", type: "message", payload: { text: "hi" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({
				isLifecycleCurrent: () => false,
				sendMessage,
			}),
		})

		expect(sendMessage).not.toHaveBeenCalled()
		expect(ackCommand).not.toHaveBeenCalled()
	})

	it("acks not_eligible when the host is ineligible", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })

		await executeRemoteCommand({
			command: { commandId: "c1", type: "message", payload: { text: "hi" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ isEligible: () => false }),
		})

		expect(ackCommand).toHaveBeenCalledWith({
			commandId: "c1",
			status: "failed",
			errorCode: "not_eligible",
		})
	})

	it("acks missing_task_id when approve_ask omits the task id", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const approveAsk = vi.fn()

		await executeRemoteCommand({
			command: { commandId: "c1", type: "approve_ask", payload: { askTs: 1 } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({
				getCurrentTask: () => liveTask({ hasPendingAsk: () => true, pendingAskTs: () => 1, approveAsk }),
			}),
		})

		expect(approveAsk).not.toHaveBeenCalled()
		expect(ackCommand).toHaveBeenCalledWith({
			commandId: "c1",
			status: "failed",
			errorCode: "missing_task_id",
		})
	})

	it("acks no_pending_ask when approve_ask has no pending ask", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const approveAsk = vi.fn()

		await executeRemoteCommand({
			command: { commandId: "c1", type: "approve_ask", taskId: "t1", payload: { askTs: 1 } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({
				getCurrentTask: () => liveTask({ approveAsk }),
			}),
		})

		expect(approveAsk).not.toHaveBeenCalled()
		expect(ackCommand).toHaveBeenCalledWith({
			commandId: "c1",
			status: "failed",
			errorCode: "no_pending_ask",
		})
	})

	it("acks task_mismatch when command.taskId does not match the live task", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const cancelCurrentTask = vi.fn()

		await executeRemoteCommand({
			command: { commandId: "c1", type: "cancel_task", taskId: "other" },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({
				getCurrentTask: () => liveTask(),
				cancelCurrentTask,
			}),
		})

		expect(cancelCurrentTask).not.toHaveBeenCalled()
		expect(ackCommand).toHaveBeenCalledWith({
			commandId: "c1",
			status: "failed",
			errorCode: "task_mismatch",
		})
	})

	it("acks missing_task_id for resume_task without a task id", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })

		await executeRemoteCommand({
			command: { commandId: "c1", type: "resume_task" },
			epoch: 1,
			client: { ackCommand },
			host: makeHost(),
		})

		expect(ackCommand).toHaveBeenCalledWith({
			commandId: "c1",
			status: "failed",
			errorCode: "missing_task_id",
		})
	})

	it("keeps the claim when a follow-up mode switch fails after the message lands", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const sendMessage = vi.fn().mockResolvedValue(undefined)
		const handleModeSwitch = vi.fn().mockRejectedValue(new Error("bad mode"))
		const handledCommandIds = new Set<string>()
		const command = {
			commandId: "c1",
			type: "message" as const,
			taskId: "t1",
			payload: { text: "hi", mode: "code" },
		}
		const host = makeHost({ sendMessage, handleModeSwitch, getCurrentTask: () => liveTask() })

		await executeRemoteCommand({ command, epoch: 1, client: { ackCommand }, host, handledCommandIds })
		await executeRemoteCommand({ command, epoch: 1, client: { ackCommand }, host, handledCommandIds })

		expect(sendMessage).toHaveBeenCalledTimes(1)
		expect(ackCommand).toHaveBeenNthCalledWith(1, {
			commandId: "c1",
			status: "failed",
			errorCode: "mode_switch_failed",
			message: "bad mode",
		})
		expect(ackCommand).toHaveBeenNthCalledWith(2, { commandId: "c1", status: "acked" })
	})

	it("acks end_remote_session and leaves the remote session", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const endRemoteSession = vi.fn().mockResolvedValue(undefined)

		await executeRemoteCommand({
			command: { commandId: "c1", type: "end_remote_session" },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ endRemoteSession }),
		})

		expect(endRemoteSession).toHaveBeenCalled()
		expect(ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
	})

	it("acks end_remote_session after the host invalidates the lifecycle", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		let current = true
		const endRemoteSession = vi.fn(async () => {
			current = false
		})

		await executeRemoteCommand({
			command: { commandId: "c1", type: "end_remote_session" },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ endRemoteSession, isLifecycleCurrent: () => current }),
		})

		expect(ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
	})

	it("does not ack end_remote_session when the host rejects", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })

		await executeRemoteCommand({
			command: { commandId: "c1", type: "end_remote_session" },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ endRemoteSession: vi.fn().mockRejectedValue(new Error("nope")) }),
		})

		expect(ackCommand).toHaveBeenCalledWith({
			commandId: "c1",
			status: "failed",
			errorCode: "execution_failed",
			message: "nope",
		})
	})

	it("acks missing_mode for switch_mode without a mode", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })

		await executeRemoteCommand({
			command: { commandId: "c1", type: "switch_mode", payload: {} },
			epoch: 1,
			client: { ackCommand },
			host: makeHost(),
		})

		expect(ackCommand).toHaveBeenCalledWith({
			commandId: "c1",
			status: "failed",
			errorCode: "missing_mode",
		})
	})

	it("acks execution_failed when the host throws", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })

		await executeRemoteCommand({
			command: { commandId: "c1", type: "message", taskId: "t1", payload: { text: "hi" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({
				sendMessage: vi.fn().mockRejectedValue(new Error("boom")),
				getCurrentTask: () => liveTask(),
			}),
		})

		expect(ackCommand).toHaveBeenCalledWith({
			commandId: "c1",
			status: "failed",
			errorCode: "execution_failed",
			message: "boom",
		})
	})

	it("approves a pending ask and acks", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const approveAsk = vi.fn()

		await executeRemoteCommand({
			command: { commandId: "c1", type: "approve_ask", taskId: "t1", payload: { text: "ok", askTs: 42 } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({
				getCurrentTask: () => liveTask({ hasPendingAsk: () => true, pendingAskTs: () => 42, approveAsk }),
			}),
		})

		expect(approveAsk).toHaveBeenCalledWith({ text: "ok", images: undefined })
		expect(ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
	})

	it("denies a pending ask and acks", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const denyAsk = vi.fn()

		await executeRemoteCommand({
			command: { commandId: "c1", type: "deny_ask", taskId: "t1", payload: { text: "no", askTs: 42 } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({
				getCurrentTask: () => liveTask({ hasPendingAsk: () => true, pendingAskTs: () => 42, denyAsk }),
			}),
		})

		expect(denyAsk).toHaveBeenCalledWith({ text: "no", images: undefined })
		expect(ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
	})

	it("cancels the current task when taskId matches", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const cancelCurrentTask = vi.fn().mockResolvedValue(undefined)

		await executeRemoteCommand({
			command: { commandId: "c1", type: "cancel_task", taskId: "t1" },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({
				getCurrentTask: () => liveTask(),
				cancelCurrentTask,
			}),
		})

		expect(cancelCurrentTask).toHaveBeenCalledOnce()
		expect(ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
	})

	it("resumes a task by id", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const resumeTask = vi.fn().mockResolvedValue(undefined)

		await executeRemoteCommand({
			command: { commandId: "c1", type: "resume_task", taskId: "t9" },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ resumeTask }),
		})

		expect(resumeTask).toHaveBeenCalledWith("t9")
		expect(ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
	})

	it("starts a new task", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const startNewTask = vi.fn().mockResolvedValue(undefined)

		await executeRemoteCommand({
			command: { commandId: "c1", type: "start_task", payload: { text: "go" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ startNewTask }),
		})

		expect(startNewTask).toHaveBeenCalledWith({ text: "go", images: undefined })
		expect(ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
	})

	it("switches mode", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)

		await executeRemoteCommand({
			command: { commandId: "c1", type: "switch_mode", payload: { mode: "architect" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ handleModeSwitch }),
		})

		expect(handleModeSwitch).toHaveBeenCalledWith("architect")
		expect(ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
	})

	it("acks duplicate commandIds without re-running the host action", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		let markStarted: () => void = () => {}
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let releaseStart: () => void = () => {}
		const canFinish = new Promise<void>((resolve) => {
			releaseStart = resolve
		})
		const startNewTask = vi.fn(async () => {
			markStarted()
			await canFinish
		})
		const handledCommandIds = new Set<string>()

		const firstExecution = executeRemoteCommand({
			command: { commandId: "dup", type: "start_task", payload: { text: "first" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ startNewTask }),
			handledCommandIds,
		})
		await started
		const secondExecution = executeRemoteCommand({
			command: { commandId: "dup", type: "start_task", payload: { text: "again" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ startNewTask }),
			handledCommandIds,
		})

		expect(startNewTask).toHaveBeenCalledTimes(1)
		releaseStart()
		await Promise.all([firstExecution, secondExecution])
		expect(ackCommand).toHaveBeenCalledTimes(2)
		expect(ackCommand).toHaveBeenLastCalledWith({ commandId: "dup", status: "acked" })
	})

	it("releases a failed commandId so redelivery can retry", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const startNewTask = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined)
		const handledCommandIds = new Set<string>()

		await executeRemoteCommand({
			command: { commandId: "retry-me", type: "start_task", payload: { text: "go" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ startNewTask }),
			handledCommandIds,
		})
		expect(handledCommandIds.has("retry-me")).toBe(false)
		expect(ackCommand).toHaveBeenLastCalledWith({
			commandId: "retry-me",
			status: "failed",
			errorCode: "execution_failed",
			message: "boom",
		})

		await executeRemoteCommand({
			command: { commandId: "retry-me", type: "start_task", payload: { text: "go" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ startNewTask }),
			handledCommandIds,
		})

		expect(startNewTask).toHaveBeenCalledTimes(2)
		expect(handledCommandIds.has("retry-me")).toBe(true)
		expect(ackCommand).toHaveBeenLastCalledWith({ commandId: "retry-me", status: "acked" })
	})

	it("acks missing_task_id for a message that does not name a task", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const sendMessage = vi.fn()

		await executeRemoteCommand({
			command: { commandId: "c1", type: "message", payload: { text: "hi" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ sendMessage, getCurrentTask: () => liveTask() }),
		})

		expect(sendMessage).not.toHaveBeenCalled()
		expect(ackCommand).toHaveBeenCalledWith({
			commandId: "c1",
			status: "failed",
			errorCode: "missing_task_id",
		})
	})

	it("acks missing_ask_id when approve_ask omits the ask timestamp", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const approveAsk = vi.fn()

		await executeRemoteCommand({
			command: { commandId: "c1", type: "approve_ask", taskId: "t1", payload: { text: "ok" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({
				getCurrentTask: () => liveTask({ hasPendingAsk: () => true, pendingAskTs: () => 42, approveAsk }),
			}),
		})

		expect(approveAsk).not.toHaveBeenCalled()
		expect(ackCommand).toHaveBeenCalledWith({
			commandId: "c1",
			status: "failed",
			errorCode: "missing_ask_id",
		})
	})

	it("acks ask_mismatch when approve_ask names a different ask", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const approveAsk = vi.fn()

		await executeRemoteCommand({
			command: { commandId: "c1", type: "approve_ask", taskId: "t1", payload: { askTs: 7 } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({
				getCurrentTask: () => liveTask({ hasPendingAsk: () => true, pendingAskTs: () => 42, approveAsk }),
			}),
		})

		expect(approveAsk).not.toHaveBeenCalled()
		expect(ackCommand).toHaveBeenCalledWith({
			commandId: "c1",
			status: "failed",
			errorCode: "ask_mismatch",
		})
	})
})
