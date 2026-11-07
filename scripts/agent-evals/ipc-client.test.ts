import assert from "node:assert/strict"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { IpcMessageType, IpcOrigin, RooCodeEventName, TaskCommandName, type TaskEvent } from "@roo-code/types"
import { EvalIpcClient, MAX_FRAME_BYTES, resolveSocketPath } from "./ipc-client.ts"

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
		// The client frames with one write, but TCP does not preserve write
		// boundaries, so a frame can arrive split. Buffer the tail of an
		// incomplete frame and dispatch only delimiter-terminated segments.
		let pending = ""
		socket.on("data", (chunk: string) => {
			pending += chunk
			const frames = pending.split(DELIMITER)
			pending = frames.pop() ?? ""
			for (const frame of frames) {
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

const ACK_FRAME =
	JSON.stringify({
		type: "message",
		data: {
			type: IpcMessageType.Ack,
			origin: IpcOrigin.Server,
			data: { clientId: "client-1", pid: process.pid, ppid: process.ppid },
		},
	}) + DELIMITER

// A schema-valid TaskEvent frame padded to an exact UTF-8 byte length by growing
// the payload string, so a test can sit precisely on the ceiling boundary. The
// padding is ASCII, so byte length and code-unit length coincide.
const taskEventFrameOfBytes = (bytes: number): string => {
	const base = JSON.stringify({
		type: "message",
		data: {
			type: IpcMessageType.TaskEvent,
			origin: IpcOrigin.Server,
			data: { eventName: RooCodeEventName.TaskStarted, payload: [""], taskId: 1 } satisfies TaskEvent,
		},
	})
	const paddingBytes = bytes - Buffer.byteLength(base, "utf8")

	if (paddingBytes < 0)
		throw new Error(`frame base is ${Buffer.byteLength(base, "utf8")} bytes, cannot shrink to ${bytes}`)

	return base.replace('[""]', () => JSON.stringify(["A".repeat(paddingBytes)]))
}

// Completes the handshake and then writes `payload` in a single call, so the test
// controls exactly which bytes share a chunk.
const startOneShotPeer = async (socketPath: string, payload: string): Promise<() => Promise<void>> => {
	const server = net.createServer((socket) => {
		socket.on("error", () => {})
		socket.write(ACK_FRAME)
		socket.write(payload)
	})

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(resolveSocketPath(socketPath), resolve)
	})

	return () => new Promise<void>((resolve) => server.close(() => resolve()))
}

const ceilingLogs = (logs: unknown[][]): unknown[][] =>
	logs.filter((entry) => String(entry[0]).includes("MAX_FRAME_BYTES"))

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

	it("assembles a peer frame that arrives split across two chunks", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "peer-split")
		const peer = await startPeer(socketPath)
		const raw = net.connect(resolveSocketPath(socketPath))
		raw.setEncoding("utf8")
		const frame =
			JSON.stringify({
				type: "message",
				data: {
					type: IpcMessageType.TaskCommand,
					origin: IpcOrigin.Client,
					clientId: "client-1",
					data: { commandName: TaskCommandName.CloseTask },
				},
			}) + DELIMITER

		try {
			await new Promise<void>((resolve) => raw.once("connect", () => resolve()))
			// Two separate writes with a pause, so the peer sees two data events.
			const cut = Math.floor(frame.length / 2)
			raw.write(frame.slice(0, cut))
			await new Promise((resolve) => setTimeout(resolve, 60))
			raw.write(frame.slice(cut))

			await waitFor(() => peer.received.length > 0)
			assert.equal(peer.received.length, 1, "the peer must assemble the frame from both chunks")
			assert.deepEqual(peer.received[0], {
				type: IpcMessageType.TaskCommand,
				origin: IpcOrigin.Client,
				clientId: "client-1",
				data: { commandName: TaskCommandName.CloseTask },
			})
		} finally {
			raw.destroy()
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

	it("drops a partial frame when the socket closes so it cannot corrupt the next session", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "carryover")
		const events: TaskEvent[] = []
		const encoder = (data: unknown) => JSON.stringify({ type: "message", data }) + DELIMITER
		const ack = encoder({
			type: IpcMessageType.Ack,
			origin: IpcOrigin.Server,
			data: { clientId: "client-1", pid: process.pid, ppid: process.ppid },
		})
		const taskEvent = encoder({
			type: IpcMessageType.TaskEvent,
			origin: IpcOrigin.Server,
			data: { eventName: RooCodeEventName.TaskStarted, payload: ["task-1"], taskId: 1 } satisfies TaskEvent,
		})

		let connections = 0
		const server = net.createServer((socket) => {
			socket.on("error", () => {})
			connections++

			if (connections === 1) {
				// Only half a frame, no ack, then the peer dies. The rest can
				// never arrive, so these bytes are unrecoverable garbage.
				socket.write(taskEvent.slice(0, 34), () => socket.destroy())
				return
			}

			// A clean session. If the stale 34 bytes survived, they prepend to
			// this ack, the ack frame fails to parse, no clientId is ever set,
			// and the client can never become ready.
			socket.write(ack + taskEvent)
		})

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(resolveSocketPath(socketPath), resolve)
		})

		const client = new EvalIpcClient(socketPath, () => {})
		client.on(IpcMessageType.TaskEvent, (event) => events.push(event as TaskEvent))

		try {
			await waitFor(() => connections >= 2 && client.isReady, 10_000)
			assert.equal(connections, 2, "client must reconnect after the peer closes")
			assert.equal(client.isReady, true, "the ack of the new session must parse")
			assert.equal(client.clientId, "client-1")
			assert.equal(events.length, 1, "the task event of the new session must parse")
			assert.equal(events[0]?.eventName, RooCodeEventName.TaskStarted)
		} finally {
			client.disconnect()
			await new Promise<void>((resolve) => server.close(() => resolve()))
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("waits for the delimiter when one frame arrives split across chunks", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "split")
		const events: TaskEvent[] = []
		// The second half of the frame is held here until the test has asserted
		// that the first half alone dispatches nothing.
		let releaseSecondHalf = () => {}
		const secondHalfGate = new Promise<void>((resolve) => {
			releaseSecondHalf = resolve
		})
		const encoded =
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
			}) + DELIMITER

		const server = net.createServer((socket) => {
			socket.on("error", () => {})
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

			// Split mid-frame, well before the delimiter. The second half waits on
			// a gate the test releases after the zero-event assertion, so the
			// assertion cannot race a timer: no amount of scheduling delay can
			// complete the frame before the test allows it.
			const cut = Math.floor(encoded.length / 2)
			socket.write(encoded.slice(0, cut))
			void secondHalfGate.then(() => socket.write(encoded.slice(cut)))
		})

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(resolveSocketPath(socketPath), resolve)
		})

		const client = new EvalIpcClient(socketPath, () => {})
		client.on(IpcMessageType.TaskEvent, (event) => events.push(event as TaskEvent))

		try {
			await waitFor(() => client.isReady)
			// The first half alone must not produce a frame.
			await new Promise((resolve) => setTimeout(resolve, 60))
			assert.equal(events.length, 0, "a frame without its delimiter must not be dispatched")

			releaseSecondHalf()
			await waitFor(() => events.length > 0)
			assert.equal(events.length, 1)
			assert.equal(events[0]?.eventName, RooCodeEventName.TaskStarted)
		} finally {
			releaseSecondHalf()
			client.disconnect()
			await new Promise<void>((resolve) => server.close(() => resolve()))
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("stays alive through a delimiter-free flood and still parses the frame that follows", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "flood")
		const events: TaskEvent[] = []
		const logs: unknown[][] = []
		const encoded =
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
			}) + DELIMITER

		const server = net.createServer((socket) => {
			socket.on("error", () => {})
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
			// 4 MB of garbage terminated as its own frame, then a valid frame.
			// The garbage frame is dropped; the client must stay alive and parse
			// the frame that follows.
			socket.write("A".repeat(4 * 1024 * 1024) + DELIMITER)
			socket.write(encoded)
		})

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(resolveSocketPath(socketPath), resolve)
		})

		const client = new EvalIpcClient(socketPath, (...args) => logs.push(args))
		client.on(IpcMessageType.TaskEvent, (event) => events.push(event as TaskEvent))

		try {
			await waitFor(() => events.length > 0, 10_000)
			assert.equal(events.length, 1, "the process must survive the flood and parse the next frame")
			assert.equal(events[0]?.eventName, RooCodeEventName.TaskStarted)
			// The flood is below the ceiling, so the connection is not dropped.
			assert.equal(
				logs.some((entry) => String(entry[0]).includes("MAX_FRAME_BYTES")),
				false,
			)
			assert.equal(client.isConnected, true)
		} finally {
			client.disconnect()
			await new Promise<void>((resolve) => server.close(() => resolve()))
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("drops the connection with one bounded log line past the frame ceiling", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "oversized")
		const logs: unknown[][] = []
		const events: TaskEvent[] = []
		const secret = "sk-should-never-be-logged"
		const ceiling = 4096

		const server = net.createServer((socket) => {
			socket.on("error", () => {})
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
			// Past the ceiling with no delimiter, credential-shaped content included.
			socket.write(secret + "A".repeat(ceiling + 1024))
		})

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(resolveSocketPath(socketPath), resolve)
		})

		// A small ceiling keeps this test fast; the production default is pinned
		// by the assertion below and by the constant's own test.
		const client = new EvalIpcClient(socketPath, (...args) => logs.push(args), { maxFrameBytes: ceiling })
		client.on(IpcMessageType.TaskEvent, (event) => events.push(event as TaskEvent))

		try {
			// The handler logs and then destroys the socket, but `isConnected` is only
			// cleared in the close callback, which runs after a timer tick. Waiting on
			// the log alone would race that callback, so the predicate covers both.
			await waitFor(
				() => !client.isConnected && logs.some((entry) => String(entry[0]).includes("MAX_FRAME_BYTES")),
				10_000,
			)

			const oversized = logs.filter((entry) => String(entry[0]).includes("MAX_FRAME_BYTES"))
			assert.equal(oversized.length, 1, "exactly one bounded log line")
			assert.equal(oversized[0]?.length, 1, "no payload or size detail accompanies the line")
			assert.ok(!JSON.stringify(logs).includes(secret), "buffer content must never be logged")
			assert.equal(events.length, 0)
			assert.equal(client.isConnected, false, "the connection is dropped")
		} finally {
			client.disconnect()
			await new Promise<void>((resolve) => server.close(() => resolve()))
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("measures the frame ceiling in UTF-8 bytes, not UTF-16 code units", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "multibyte")
		const logs: unknown[][] = []
		const ceiling = 4096
		// 3-byte UTF-8 characters: 2000 of them are 2000 code units (under the
		// ceiling) but 6000 wire bytes (over it), so only a byte ceiling drops.
		const frame = "가".repeat(2000)

		const server = net.createServer((socket) => {
			socket.on("error", () => {})
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
			socket.write(frame)
		})

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(resolveSocketPath(socketPath), resolve)
		})

		const client = new EvalIpcClient(socketPath, (...args) => logs.push(args), { maxFrameBytes: ceiling })

		try {
			// Same close-callback race as the oversized-frame test above: wait for the
			// disconnect, not just for the log line.
			await waitFor(
				() => !client.isConnected && logs.some((entry) => String(entry[0]).includes("MAX_FRAME_BYTES")),
				10_000,
			)

			assert.equal(
				logs.filter((entry) => String(entry[0]).includes("MAX_FRAME_BYTES")).length,
				1,
				"the byte ceiling must drop a frame whose code-unit count is under the limit",
			)
			assert.equal(client.isConnected, false, "the connection is dropped")
		} finally {
			client.disconnect()
			await new Promise<void>((resolve) => server.close(() => resolve()))
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("drops an oversized frame whose delimiter arrives in the same chunk", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "oversized-inline")
		const logs: unknown[][] = []
		const events: TaskEvent[] = []
		const ceiling = 1024
		// A well-formed frame that is one byte past the ceiling. Without a check
		// inside the delimiter loop it parses and dispatches instead of dropping.
		const oversized = taskEventFrameOfBytes(ceiling + 1) + DELIMITER
		const closePeer = await startOneShotPeer(socketPath, oversized)

		const client = new EvalIpcClient(socketPath, (...args) => logs.push(args), { maxFrameBytes: ceiling })
		client.on(IpcMessageType.TaskEvent, (event) => events.push(event as TaskEvent))

		try {
			await waitFor(() => !client.isConnected && ceilingLogs(logs).length > 0, 10_000)

			assert.equal(ceilingLogs(logs).length, 1, "exactly one bounded log line")
			assert.equal(events.length, 0, "a frame past the ceiling must never be dispatched")
			assert.equal(client.isConnected, false, "the connection is dropped")
		} finally {
			client.disconnect()
			await closePeer()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("stops scanning the chunk after an oversized frame instead of parsing what follows", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "oversized-then-valid")
		const logs: unknown[][] = []
		const events: TaskEvent[] = []
		const ceiling = 1024
		// The oversized frame and a valid frame share one chunk. The handler must
		// return, not break: a break leaves the offset unmoved, so the rest of the
		// chunk becomes the tail, re-populates the buffer and logs a second time.
		const chunk = taskEventFrameOfBytes(ceiling + 1) + DELIMITER + taskEventFrameOfBytes(256) + DELIMITER
		const closePeer = await startOneShotPeer(socketPath, chunk)

		const client = new EvalIpcClient(socketPath, (...args) => logs.push(args), { maxFrameBytes: ceiling })
		client.on(IpcMessageType.TaskEvent, (event) => events.push(event as TaskEvent))

		try {
			await waitFor(() => !client.isConnected && ceilingLogs(logs).length > 0, 10_000)
			// Give any stray second frame a chance to surface before asserting.
			await new Promise((resolve) => setTimeout(resolve, 60))

			assert.equal(ceilingLogs(logs).length, 1, "the tail must not re-trip the ceiling")
			assert.equal(events.length, 0, "the frame after the oversized one must not be processed")
			assert.equal(client.isConnected, false, "the connection is dropped")
		} finally {
			client.disconnect()
			await closePeer()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("passes a frame at exactly the ceiling and drops one byte past it", async () => {
		const ceiling = 512
		const run = async (name: string, bytes: number) => {
			const dir = await socketDir()
			const socketPath = socketPathIn(dir, name)
			const logs: unknown[][] = []
			const events: TaskEvent[] = []
			const closePeer = await startOneShotPeer(socketPath, taskEventFrameOfBytes(bytes) + DELIMITER)
			const client = new EvalIpcClient(socketPath, (...args) => logs.push(args), { maxFrameBytes: ceiling })

			client.on(IpcMessageType.TaskEvent, (event) => events.push(event as TaskEvent))

			try {
				await waitFor(() => events.length > 0 || ceilingLogs(logs).length > 0, 10_000)
				return { events: events.length, drops: ceilingLogs(logs).length, connected: client.isConnected }
			} finally {
				client.disconnect()
				await closePeer()
				await fs.rm(dir, { recursive: true, force: true })
			}
		}

		const atCeiling = await run("ceiling-exact", ceiling)
		assert.equal(atCeiling.drops, 0, "a frame at exactly the ceiling is legal")
		assert.equal(atCeiling.events, 1, "the frame at the ceiling is dispatched")
		assert.equal(atCeiling.connected, true, "the connection survives a frame at the ceiling")

		const pastCeiling = await run("ceiling-plus-one", ceiling + 1)
		assert.equal(pastCeiling.drops, 1, "one byte past the ceiling drops the connection")
		assert.equal(pastCeiling.events, 0, "the frame past the ceiling is never dispatched")
		assert.equal(pastCeiling.connected, false, "the connection is dropped")
	})

	it("counts a delimited frame's multibyte content in bytes, not characters", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "multibyte-inline")
		const logs: unknown[][] = []
		const events: TaskEvent[] = []
		const ceiling = 2048
		// 1000 three-byte characters: 1000 code units (under the ceiling) but 3000
		// wire bytes (over it), and the delimiter shares the chunk with them.
		const frame =
			JSON.stringify({
				type: "message",
				data: {
					type: IpcMessageType.TaskEvent,
					origin: IpcOrigin.Server,
					data: {
						eventName: RooCodeEventName.TaskStarted,
						payload: ["가".repeat(1000)],
						taskId: 1,
					} satisfies TaskEvent,
				},
			}) + DELIMITER
		const closePeer = await startOneShotPeer(socketPath, frame)

		const client = new EvalIpcClient(socketPath, (...args) => logs.push(args), { maxFrameBytes: ceiling })
		client.on(IpcMessageType.TaskEvent, (event) => events.push(event as TaskEvent))

		try {
			await waitFor(() => !client.isConnected && ceilingLogs(logs).length > 0, 10_000)

			assert.equal(
				ceilingLogs(logs).length,
				1,
				"the byte ceiling must drop a frame whose code-unit count is under it",
			)
			assert.equal(events.length, 0, "the multibyte frame past the byte ceiling is never dispatched")
			assert.equal(client.isConnected, false, "the connection is dropped")
		} finally {
			client.disconnect()
			await closePeer()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("keeps the production frame ceiling far above any legitimate task event", () => {
		assert.equal(MAX_FRAME_BYTES, 64 * 1024 * 1024)
	})
})
