import assert from "node:assert/strict"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { IpcMessageType, IpcOrigin, RooCodeEventName, TaskCommandName, type TaskEvent } from "@roo-code/types"
import { EvalIpcClient, resolveSocketPath } from "./ipc-client.ts"

const DELIMITER = "\f"

const socketDir = async (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), "agent-evals-ipc-"))

// node-ipc listens on a named pipe on Windows, not on a filesystem path.
const socketPathIn = (dir: string, name: string): string =>
	process.platform === "win32" ? `agent-evals-test-${process.pid}-${name}` : path.join(dir, `${name}.sock`)

const waitFor = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
}

// Stands in for the extension-side IpcServer with the same node-ipc framing but
// a closeable socket, so tests can end the connection deterministically.
const startPeer = async (socketPath: string) => {
	const received: unknown[] = []
	const sockets = new Set<net.Socket>()
	const server = net.createServer((socket) => {
		sockets.add(socket)
		socket.setEncoding("utf8")
		socket.on("close", () => sockets.delete(socket))
		socket.on("error", () => {})
		socket.on("data", (chunk: string) => {
			for (const frame of chunk.split(DELIMITER)) {
				if (frame.length === 0) continue
				const message = JSON.parse(frame) as { data: { clientId: string } }
				received.push(message.data)
				socket.write(
					JSON.stringify({
						type: "message",
						data: {
							type: IpcMessageType.TaskEvent,
							origin: IpcOrigin.Server,
							data: {
								eventName: RooCodeEventName.TaskStarted,
								payload: ["task-1"],
								taskId: 1,
							} satisfies TaskEvent,
						},
					}) + DELIMITER,
				)
			}
		})
		socket.write(
			JSON.stringify({
				type: "message",
				data: {
					type: IpcMessageType.Ack,
					origin: IpcOrigin.Server,
					data: { clientId: "client-1", pid: process.pid, ppid: process.ppid },
				},
			}) + DELIMITER,
		)
	})

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(resolveSocketPath(socketPath), resolve)
	})

	return {
		received,
		async close() {
			for (const socket of sockets) socket.destroy()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		},
	}
}

describe("eval ipc client", () => {
	it("completes the ack handshake and reports readiness", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "handshake")
		const peer = await startPeer(socketPath)
		const client = new EvalIpcClient(socketPath, () => {})

		try {
			await waitFor(() => client.isReady)
			assert.equal(client.isConnected, true)
			assert.equal(client.clientId, "client-1")
			assert.equal(client.isReady, true)
		} finally {
			client.disconnect()
			await peer.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("sends a command in the frame shape the extension parses and receives task events", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "roundtrip")
		const peer = await startPeer(socketPath)
		const events: TaskEvent[] = []
		const client = new EvalIpcClient(socketPath, () => {})
		client.on(IpcMessageType.TaskEvent, (event) => events.push(event as TaskEvent))

		try {
			await waitFor(() => client.isReady)
			client.sendCommand({ commandName: TaskCommandName.CloseTask })
			await waitFor(() => events.length > 0)

			assert.equal(peer.received.length, 1)
			assert.deepEqual(peer.received[0], {
				type: IpcMessageType.TaskCommand,
				origin: IpcOrigin.Client,
				clientId: "client-1",
				data: { commandName: TaskCommandName.CloseTask },
			})
			assert.equal(events.length, 1)
			assert.equal(events[0]?.eventName, RooCodeEventName.TaskStarted)
		} finally {
			client.disconnect()
			await peer.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("retries until the socket exists instead of failing when the host is not up yet", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "late")
		const client = new EvalIpcClient(socketPath, () => {})
		let peer: Awaited<ReturnType<typeof startPeer>> | undefined

		try {
			// The launcher connects before the extension host creates the socket.
			await new Promise((resolve) => setTimeout(resolve, 150))
			assert.equal(client.isReady, false)

			peer = await startPeer(socketPath)
			await waitFor(() => client.isReady)
			assert.equal(client.isReady, true)
		} finally {
			client.disconnect()
			await peer?.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("reports a disconnect when the peer goes away", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "drop")
		const peer = await startPeer(socketPath)
		const client = new EvalIpcClient(socketPath, () => {})
		let disconnected = false
		client.on(IpcMessageType.Disconnect, () => {
			disconnected = true
		})

		try {
			await waitFor(() => client.isReady)
			await peer.close()
			await waitFor(() => disconnected)
			assert.equal(client.isConnected, false)
		} finally {
			client.disconnect()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("ignores payloads that do not match the IPC message schema", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "invalid")
		const logs: unknown[][] = []
		const server = net.createServer((socket) => {
			socket.on("error", () => {})
			socket.write(JSON.stringify({ type: "message", data: { type: IpcMessageType.Ack } }) + DELIMITER)
			socket.write("not-json" + DELIMITER)
		})
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(resolveSocketPath(socketPath), resolve)
		})
		const client = new EvalIpcClient(socketPath, (...args) => logs.push(args))

		try {
			await waitFor(() => logs.length >= 2)
			assert.equal(client.isReady, false)
			assert.ok(!JSON.stringify(logs).includes(IpcMessageType.Ack))
		} finally {
			client.disconnect()
			await new Promise<void>((resolve) => server.close(() => resolve()))
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("maps a filesystem socket path onto the Windows named pipe node-ipc listens on", () => {
		const mapped = resolveSocketPath("/tmp/agent-evals/ipc.sock")
		if (process.platform === "win32") {
			assert.equal(mapped, "\\\\.\\pipe\\tmp-agent-evals-ipc.sock")
		} else {
			assert.equal(mapped, "/tmp/agent-evals/ipc.sock")
		}
	})
})
