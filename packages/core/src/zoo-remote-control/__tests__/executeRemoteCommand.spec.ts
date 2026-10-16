import { describe, expect, it, vi } from "vitest"

import { executeRemoteCommand } from "../executeRemoteCommand.js"
import type { ZooRemoteCommandHost } from "../executeRemoteCommand.js"

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
			command: { commandId: "c1", type: "message", payload: { text: "hi" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ sendMessage }),
		})

		expect(sendMessage).toHaveBeenCalledWith("hi", undefined)
		expect(ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
	})

	it("switches mode after sending a message when payload.mode is set", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)

		await executeRemoteCommand({
			command: { commandId: "c1", type: "message", payload: { text: "hi", mode: "code" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({ handleModeSwitch }),
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

	it("acks no_current_task when approve_ask has no task", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })

		await executeRemoteCommand({
			command: { commandId: "c1", type: "approve_ask" },
			epoch: 1,
			client: { ackCommand },
			host: makeHost(),
		})

		expect(ackCommand).toHaveBeenCalledWith({
			commandId: "c1",
			status: "failed",
			errorCode: "no_current_task",
		})
	})

	it("acks no_pending_ask when approve_ask has no pending ask", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const approveAsk = vi.fn()

		await executeRemoteCommand({
			command: { commandId: "c1", type: "approve_ask" },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({
				getCurrentTask: () => ({
					taskId: "t1",
					hasPendingAsk: () => false,
					approveAsk,
					denyAsk: vi.fn(),
				}),
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
				getCurrentTask: () => ({
					taskId: "t1",
					hasPendingAsk: () => false,
					approveAsk: vi.fn(),
					denyAsk: vi.fn(),
				}),
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
			command: { commandId: "c1", type: "message", payload: { text: "hi" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({
				sendMessage: vi.fn().mockRejectedValue(new Error("boom")),
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
			command: { commandId: "c1", type: "approve_ask", payload: { text: "ok" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({
				getCurrentTask: () => ({
					taskId: "t1",
					hasPendingAsk: () => true,
					approveAsk,
					denyAsk: vi.fn(),
				}),
			}),
		})

		expect(approveAsk).toHaveBeenCalledWith({ text: "ok", images: undefined })
		expect(ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
	})

	it("denies a pending ask and acks", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const denyAsk = vi.fn()

		await executeRemoteCommand({
			command: { commandId: "c1", type: "deny_ask", payload: { text: "no" } },
			epoch: 1,
			client: { ackCommand },
			host: makeHost({
				getCurrentTask: () => ({
					taskId: "t1",
					hasPendingAsk: () => true,
					approveAsk: vi.fn(),
					denyAsk,
				}),
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
				getCurrentTask: () => ({
					taskId: "t1",
					hasPendingAsk: () => false,
					approveAsk: vi.fn(),
					denyAsk: vi.fn(),
				}),
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
})
