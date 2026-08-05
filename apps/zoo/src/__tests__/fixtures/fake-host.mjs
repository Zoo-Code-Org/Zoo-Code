import process from "node:process"
import { setImmediate } from "node:timers"

let hostSequence = 0
let publicSequence = 0
const hostId = "fake-host"
const scenario = process.env.ZOO_FAKE_SCENARIO ?? "completed"
const send = (event) => process.send({ v: 1, seq: ++hostSequence, hostId, ...event })
const stream = (event) =>
	send({
		type: "event",
		event: {
			v: 1,
			seq: ++publicSequence,
			timestamp: new Date().toISOString(),
			hostId,
			...event,
		},
	})

process.send({
	type: "hello",
	hostId,
	supportedVersions: [1],
	capabilities: {
		1: ["task:start", "task:resume", "task:cancel", "history:list", "host:shutdown", "checkpoint:unavailable"],
	},
	buildVersion: "test",
})

process.on("message", (message) => {
	if (message.type === "hello.select") {
		stream({
			type: "system.init",
			protocol: "zoo-stream",
			hostProtocolVersion: 1,
			capabilities: [
				"task:start",
				"task:resume",
				"task:cancel",
				"history:list",
				"host:shutdown",
				"checkpoint:unavailable",
			],
			clientVersion: message.clientVersion,
			hostVersion: "test",
		})
		return
	}
	send({ type: "command.ack", commandId: message.id })
	if (message.type === "task.start") {
		send({
			type: "command.done",
			commandId: message.id,
			data: { commandType: "task.start", task: { rootTaskId: "root-1", taskId: "root-1" } },
		})
		stream({ type: "task.created", requestId: message.id, rootTaskId: "root-1", taskId: "root-1" })
		stream({ type: "task.started", rootTaskId: "root-1", taskId: "root-1" })
		if (scenario === "crash") {
			setImmediate(() => process.exit(70))
			return
		}
		if (scenario === "hang") return
		if (scenario === "needs-input") {
			stream({
				type: "ask.required",
				rootTaskId: "root-1",
				taskId: "root-1",
				askId: "ask-1",
				category: "followup",
				subject: "Choose a target",
			})
			stream({ type: "task.lifecycle", rootTaskId: "root-1", taskId: "root-1", state: "waiting" })
			stream({
				type: "task.result",
				requestId: message.id,
				rootTaskId: "root-1",
				taskId: "root-1",
				result: {
					schemaVersion: 1,
					protocol: "zoo-run-result",
					success: false,
					outcome: "needs_input",
					rootTaskId: "root-1",
					currentTaskId: "root-1",
					workspace: message.workspace,
					resumable: true,
					content: "Choose a target",
					elapsedMs: 5,
				},
			})
			return
		}
		stream({ type: "task.lifecycle", rootTaskId: "root-1", taskId: "root-1", state: "completed" })
		stream({
			type: "task.result",
			requestId: message.id,
			rootTaskId: "root-1",
			taskId: "root-1",
			result: {
				schemaVersion: 1,
				protocol: "zoo-run-result",
				success: true,
				outcome: "completed",
				rootTaskId: "root-1",
				currentTaskId: "root-1",
				workspace: message.workspace,
				resumable: false,
				content: "finished",
				elapsedMs: 5,
			},
		})
	} else if (message.type === "task.cancel") {
		send({ type: "command.done", commandId: message.id, data: { commandType: "task.cancel", rootTaskId: message.rootTaskId } })
		if (scenario === "hang") {
			stream({
				type: "task.lifecycle",
				rootTaskId: message.rootTaskId,
				taskId: message.rootTaskId,
				state: "interrupted",
				cause: "cancelled",
			})
			stream({
				type: "task.result",
				requestId: message.id,
				rootTaskId: message.rootTaskId,
				taskId: message.rootTaskId,
				result: {
					schemaVersion: 1,
					protocol: "zoo-run-result",
					success: false,
					outcome: "cancelled",
					rootTaskId: message.rootTaskId,
					currentTaskId: message.rootTaskId,
					workspace: process.cwd(),
					resumable: true,
					cancellationReason: message.reason,
					elapsedMs: 5,
				},
			})
		}
	} else if (message.type === "history.list") {
		send({
			type: "command.done",
			commandId: message.id,
			data: {
				commandType: "history.list",
				workspace: message.workspace,
				tasks: [{ rootTaskId: "root-1", currentTaskId: "root-1", workspace: message.workspace, state: "interrupted" }],
			},
		})
	} else if (message.type === "task.resume") {
		send({
			type: "command.done",
			commandId: message.id,
			data: { commandType: "task.resume", task: { rootTaskId: message.rootTaskId, taskId: message.taskId } },
		})
		stream({ type: "task.created", rootTaskId: message.rootTaskId, taskId: message.taskId })
		stream({ type: "task.lifecycle", rootTaskId: message.rootTaskId, taskId: message.taskId, state: "interrupted" })
		stream({
			type: "task.resumed",
			requestId: message.id,
			rootTaskId: message.rootTaskId,
			taskId: message.taskId,
			previousState: "interrupted",
		})
		stream({ type: "task.started", rootTaskId: message.rootTaskId, taskId: message.taskId })
		stream({ type: "task.lifecycle", rootTaskId: message.rootTaskId, taskId: message.taskId, state: "completed" })
		stream({
			type: "task.result",
			requestId: message.id,
			rootTaskId: message.rootTaskId,
			taskId: message.rootTaskId,
			result: {
				schemaVersion: 1,
				protocol: "zoo-run-result",
				success: true,
				outcome: "completed",
				rootTaskId: message.rootTaskId,
				currentTaskId: message.taskId,
				workspace: process.cwd(),
				resumable: false,
				content: "resumed",
				elapsedMs: 5,
			},
		})
	} else if (message.type === "host.shutdown") {
		send({ type: "command.done", commandId: message.id, data: { commandType: "host.shutdown" } })
		setImmediate(() => process.disconnect())
	}
})
