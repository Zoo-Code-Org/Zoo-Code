import type { ZooRemoteCommand } from "./types.js"
import type { ZooRemoteControlClient } from "./ZooRemoteControlClient.js"

export type ZooRemoteCommandHostTask = {
	taskId: string
	hasPendingAsk: () => boolean
	/** Timestamp of the ask currently blocking the task, when one is pending. */
	pendingAskTs: () => number | undefined
	approveAsk: (payload?: { text?: string; images?: string[] }) => void
	denyAsk: (payload?: { text?: string; images?: string[] }) => void
	/** Deliver text on this task. Call it on the object returned by the same getCurrentTask read. */
	submitMessage: (text: string, images?: string[]) => Promise<void>
}

export type ZooRemoteCommandHost = {
	isLifecycleCurrent: (epoch: number) => boolean
	isEligible: () => boolean
	handleModeSwitch: (mode: string) => Promise<void>
	getCurrentTask: () => ZooRemoteCommandHostTask | undefined
	cancelCurrentTask: () => Promise<void>
	resumeTask: (taskId: string) => Promise<void>
	startNewTask: (payload: { text?: string; images?: string[] }) => Promise<void>
	/** Leave remote session without cancelling the task. */
	endRemoteSession: () => Promise<void>
}

async function failCommand(
	client: Pick<ZooRemoteControlClient, "ackCommand">,
	host: ZooRemoteCommandHost,
	epoch: number,
	commandId: string,
	errorCode: string,
	message?: string,
): Promise<void> {
	if (!host.isLifecycleCurrent(epoch)) {
		return
	}
	await client.ackCommand({
		commandId,
		status: "failed",
		errorCode,
		...(message ? { message } : {}),
	})
}

type TaskBind = { task: ZooRemoteCommandHostTask } | { errorCode: string }

/** One synchronous read. Callers mutate `task` before their next await. */
function bindTask(host: ZooRemoteCommandHost, command: ZooRemoteCommand): TaskBind {
	if (!command.taskId) {
		return { errorCode: "missing_task_id" }
	}
	const task = host.getCurrentTask()
	if (task?.taskId !== command.taskId) {
		return { errorCode: "task_mismatch" }
	}
	return { task }
}

/** A message that can answer an ask must name that ask, so a late delivery cannot hit a newer one. */
function messageAskError(task: ZooRemoteCommandHostTask, command: ZooRemoteCommand): string | undefined {
	const pending = task.hasPendingAsk()
	if (!pending) {
		return command.type === "answer_followup" ? "no_pending_ask" : undefined
	}
	const askTs = command.payload?.askTs
	if (typeof askTs !== "number") {
		return "missing_ask_id"
	}
	if (task.pendingAskTs() !== askTs) {
		return "ask_mismatch"
	}
	return undefined
}

function approvalAskError(task: ZooRemoteCommandHostTask, command: ZooRemoteCommand): string | undefined {
	if (!task.hasPendingAsk()) {
		return "no_pending_ask"
	}
	const askTs = command.payload?.askTs
	if (askTs === undefined) {
		return "missing_ask_id"
	}
	if (task.pendingAskTs() !== askTs) {
		return "ask_mismatch"
	}
	return undefined
}

/** Apply one remote command through host callbacks, respecting lifecycle epoch checks. */
export async function executeRemoteCommand(options: {
	command: ZooRemoteCommand
	epoch: number
	client: Pick<ZooRemoteControlClient, "ackCommand">
	host: ZooRemoteCommandHost
	/** Session-scoped at-most-once set (especially for start_task). */
	handledCommandIds?: Set<string>
}): Promise<void> {
	const { command, epoch, client, host, handledCommandIds } = options

	if (!host.isLifecycleCurrent(epoch)) {
		return
	}

	if (handledCommandIds?.has(command.commandId)) {
		await client.ackCommand({ commandId: command.commandId, status: "acked" })
		return
	}
	// Claim for the in-flight window so concurrent polls cannot double-apply.
	// Release on every non-applied path so the server can redeliver after a real failure.
	handledCommandIds?.add(command.commandId)
	let applied = false

	try {
		if (!host.isEligible()) {
			await failCommand(client, host, epoch, command.commandId, "not_eligible")
			return
		}

		try {
			switch (command.type) {
				case "message":
				case "answer_followup": {
					const bound = bindTask(host, command)
					if ("errorCode" in bound) {
						await failCommand(client, host, epoch, command.commandId, bound.errorCode)
						return
					}
					const askError = messageAskError(bound.task, command)
					if (askError) {
						await failCommand(client, host, epoch, command.commandId, askError)
						return
					}
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					await bound.task.submitMessage(command.payload?.text ?? "", command.payload?.images)
					// The message has landed. Keep the claim if the follow-up mode switch fails.
					applied = true
					if (command.payload?.mode) {
						if (!host.isLifecycleCurrent(epoch)) {
							return
						}
						try {
							await host.handleModeSwitch(command.payload.mode)
						} catch (error) {
							await failCommand(
								client,
								host,
								epoch,
								command.commandId,
								"mode_switch_failed",
								error instanceof Error ? error.message : String(error),
							)
							return
						}
					}
					break
				}
				case "approve_ask":
				case "deny_ask": {
					const bound = bindTask(host, command)
					if ("errorCode" in bound) {
						await failCommand(client, host, epoch, command.commandId, bound.errorCode)
						return
					}
					const askError = approvalAskError(bound.task, command)
					if (askError) {
						await failCommand(client, host, epoch, command.commandId, askError)
						return
					}
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					const answer = { text: command.payload?.text, images: command.payload?.images }
					if (command.type === "approve_ask") {
						bound.task.approveAsk(answer)
					} else {
						bound.task.denyAsk(answer)
					}
					applied = true
					break
				}
				case "cancel_task": {
					const bound = bindTask(host, command)
					if ("errorCode" in bound) {
						await failCommand(client, host, epoch, command.commandId, bound.errorCode)
						return
					}
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					await host.cancelCurrentTask()
					applied = true
					break
				}
				case "resume_task":
					if (!command.taskId) {
						await failCommand(client, host, epoch, command.commandId, "missing_task_id")
						return
					}
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					await host.resumeTask(command.taskId)
					applied = true
					break
				case "start_task":
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					await host.startNewTask({
						text: command.payload?.text,
						images: command.payload?.images,
					})
					applied = true
					break
				case "switch_mode": {
					const mode = command.payload?.mode
					if (!mode) {
						await failCommand(client, host, epoch, command.commandId, "missing_mode")
						return
					}
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					await host.handleModeSwitch(mode)
					applied = true
					break
				}
				case "end_remote_session":
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					await host.endRemoteSession()
					// Ending the session invalidates this epoch, so the shared ack below would be skipped.
					await client.ackCommand({ commandId: command.commandId, status: "acked" })
					applied = true
					return
				default: {
					const _exhaustive: never = command.type
					await failCommand(client, host, epoch, command.commandId, "unknown_command", String(_exhaustive))
					return
				}
			}

			if (!host.isLifecycleCurrent(epoch)) {
				return
			}
			// Ack 404 (command_not_found) must not mark the bridge unavailable.
			await client.ackCommand({ commandId: command.commandId, status: "acked" })
		} catch (error) {
			// Keep the claim if the host action already landed; only failed attempts are retriable.
			if (!applied) {
				await failCommand(
					client,
					host,
					epoch,
					command.commandId,
					"execution_failed",
					error instanceof Error ? error.message : String(error),
				)
			}
		}
	} finally {
		if (!applied) {
			handledCommandIds?.delete(command.commandId)
		}
	}
}
