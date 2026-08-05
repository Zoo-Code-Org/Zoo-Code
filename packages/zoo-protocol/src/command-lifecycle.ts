import type { HostCommand } from "./host-commands.js"
import type { HostEvent } from "./host-events.js"

export function validateCommandLifecycle(
	commands: readonly HostCommand[],
	events: readonly HostEvent[],
	hostId: string,
): { ok: true } | { ok: false; commandId: string; message: string } {
	const commandById = new Map<string, HostCommand>()
	const startedRoots = new Set<string>()
	for (const command of commands) {
		if (commandById.has(command.id)) {
			return { ok: false, commandId: command.id, message: "Command IDs must be unique" }
		}
		commandById.set(command.id, command)
	}

	for (const [index, event] of events.entries()) {
		if (event.hostId !== hostId) {
			const commandId = "commandId" in event ? event.commandId : commands[0]?.id ?? "unknown"
			return { ok: false, commandId, message: "Command lifecycle cannot span multiple hosts" }
		}
		if (
			(event.type === "command.ack" || event.type === "command.done" || event.type === "command.error") &&
			!commandById.has(event.commandId)
		) {
			return { ok: false, commandId: event.commandId, message: "Response references an unknown command" }
		}
		if (index > 0) {
			const expected = events[index - 1]!.seq + 1
			if (event.seq !== expected) {
				const commandId = "commandId" in event ? event.commandId : commands[0]?.id ?? "unknown"
				return { ok: false, commandId, message: `Expected host sequence ${expected}` }
			}
		}
	}

	for (const command of commands) {
		const commandId = command.id
		const commandEvents = events.filter(
			(event) =>
				(event.type === "command.ack" || event.type === "command.done" || event.type === "command.error") &&
				event.commandId === commandId,
		)
		const acknowledgements = commandEvents.filter((event) => event.type === "command.ack")
		const terminals = commandEvents.filter((event) => event.type === "command.done" || event.type === "command.error")
		if (acknowledgements.length !== 1) {
			return { ok: false, commandId, message: `Expected one ACK, received ${acknowledgements.length}` }
		}
		if (terminals.length !== 1) {
			return { ok: false, commandId, message: `Expected one DONE or ERROR, received ${terminals.length}` }
		}
		if (acknowledgements[0]!.seq >= terminals[0]!.seq) {
			return { ok: false, commandId, message: "ACK must precede DONE or ERROR" }
		}
		const terminal = terminals[0]!
		if (terminal.type === "command.done") {
			const data = terminal.data
			const matches = (() => {
				switch (command.type) {
					case "task.start":
						return data.commandType === command.type && data.task.taskId === data.task.rootTaskId
					case "task.resume":
						return (
							data.commandType === command.type &&
							data.task.taskId === command.taskId &&
							data.task.rootTaskId === command.rootTaskId
						)
					case "task.input":
						return data.commandType === command.type && data.taskId === command.taskId
					case "ask.respond":
						return data.commandType === command.type && data.taskId === command.taskId && data.askId === command.askId
					case "task.cancel":
						return data.commandType === command.type && data.rootTaskId === command.rootTaskId
					case "history.list":
						return (
							data.commandType === command.type &&
							data.workspace === command.workspace &&
							data.tasks.every((task) => task.workspace === command.workspace)
						)
					case "host.snapshot":
					case "host.shutdown":
						return data.commandType === command.type
				}
			})()
			if (!matches) {
				return { ok: false, commandId, message: "DONE payload does not match the originating command" }
			}
			if (command.type === "task.start" && data.commandType === "task.start") {
				if (startedRoots.has(data.task.rootTaskId)) {
					return { ok: false, commandId, message: "Successful task starts must return unique root task IDs" }
				}
				startedRoots.add(data.task.rootTaskId)
			}
		}
	}
	return { ok: true }
}
