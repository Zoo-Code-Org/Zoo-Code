import type { ZooRemoteCommand } from "./types.js"
import type { ZooRemoteControlClient } from "./ZooRemoteControlClient.js"

export type ZooRemoteCommandHostTask = {
	taskId: string
	hasPendingAsk: () => boolean
	approveAsk: (payload?: { text?: string; images?: string[] }) => void
	denyAsk: (payload?: { text?: string; images?: string[] }) => void
}

export type ZooRemoteCommandHost = {
	isLifecycleCurrent: (epoch: number) => boolean
	isEligible: () => boolean
	sendMessage: (text?: string, images?: string[]) => Promise<void>
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

/** When a command targets a task id, require it to match the live task. */
async function ensureTaskTarget(options: {
	command: ZooRemoteCommand
	epoch: number
	client: Pick<ZooRemoteControlClient, "ackCommand">
	host: ZooRemoteCommandHost
}): Promise<boolean> {
	const { command, epoch, client, host } = options
	if (!command.taskId) {
		return true
	}
	const currentId = host.getCurrentTask()?.taskId
	if (currentId === command.taskId) {
		return true
	}
	await failCommand(client, host, epoch, command.commandId, "task_mismatch")
	return false
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
				case "answer_followup":
					if (!(await ensureTaskTarget({ command, epoch, client, host }))) {
						return
					}
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					await host.sendMessage(command.payload?.text, command.payload?.images)
					if (command.payload?.mode) {
						if (!host.isLifecycleCurrent(epoch)) {
							// Message already landed — keep the claim.
							applied = true
							return
						}
						await host.handleModeSwitch(command.payload.mode)
					}
					applied = true
					break
				case "approve_ask":
				case "deny_ask": {
					if (!(await ensureTaskTarget({ command, epoch, client, host }))) {
						return
					}
					const task = host.getCurrentTask()
					if (!task) {
						await failCommand(client, host, epoch, command.commandId, "no_current_task")
						return
					}
					if (!task.hasPendingAsk()) {
						await failCommand(client, host, epoch, command.commandId, "no_pending_ask")
						return
					}
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					if (command.type === "approve_ask") {
						task.approveAsk({ text: command.payload?.text, images: command.payload?.images })
					} else {
						task.denyAsk({ text: command.payload?.text, images: command.payload?.images })
					}
					applied = true
					break
				}
				case "cancel_task":
					if (!(await ensureTaskTarget({ command, epoch, client, host }))) {
						return
					}
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					await host.cancelCurrentTask()
					applied = true
					break
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
					applied = true
					break
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
