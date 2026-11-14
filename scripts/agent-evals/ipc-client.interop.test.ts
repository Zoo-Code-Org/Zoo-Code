import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import { IpcMessageType, IpcOrigin, RooCodeEventName, TaskCommandName, type TaskEvent } from "@roo-code/types"
import { IpcServer } from "@roo-code/ipc"
import { EvalIpcClient } from "./ipc-client.ts"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

// IpcServer keeps node-ipc's listening handle open and exposes no stop(), so the
// suite has to close it or the runner never exits. scripts/ cannot resolve
// node-ipc itself, and the ESM entry is the singleton IpcServer actually uses,
// so resolve it through packages/ipc and import that exact module URL.
const stopListening = async (): Promise<void> => {
	const requireFromIpc = createRequire(path.join(repoRoot, "packages/ipc/package.json"))
	const esmEntry = requireFromIpc.resolve("node-ipc").replace(/node-ipc\.cjs$/, "node-ipc.js")
	const ipc = (await import(pathToFileURL(esmEntry).href)).default as { server: { stop?: () => void } | false }
	ipc.server && ipc.server.stop?.()
}

const socketDir = async (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), "agent-evals-interop-"))

const socketPathIn = (dir: string, name: string): string =>
	process.platform === "win32" ? `agent-evals-interop-${process.pid}-${name}` : path.join(dir, `${name}.sock`)

const waitFor = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
}

// The extension runs the real IpcServer, so the launcher client has to speak its
// exact framing. This suite is the interop gate between the two halves.
describe("eval ipc client against the real extension server", () => {
	it("handshakes with IpcServer and round-trips a command and a task event", async () => {
		const dir = await socketDir()
		const socketPath = socketPathIn(dir, "interop")
		const server = new IpcServer(socketPath, () => {})
		const commands: string[] = []
		const events: TaskEvent[] = []

		server.on(IpcMessageType.TaskCommand, (clientId, command) => {
			commands.push(command.commandName)
			server.send(clientId, {
				type: IpcMessageType.TaskEvent,
				origin: IpcOrigin.Server,
				data: { eventName: RooCodeEventName.TaskStarted, payload: ["task-1"], taskId: 1 } satisfies TaskEvent,
			})
		})
		server.listen()

		const client = new EvalIpcClient(socketPath, () => {})
		client.on(IpcMessageType.TaskEvent, (event) => events.push(event as TaskEvent))

		try {
			await waitFor(() => client.isReady)
			assert.equal(client.isReady, true, "client must receive the server ack")

			client.sendCommand({ commandName: TaskCommandName.CloseTask })
			await waitFor(() => events.length > 0)

			assert.deepEqual(commands, [TaskCommandName.CloseTask])
			assert.equal(events.length, 1)
			assert.equal(events[0]?.eventName, RooCodeEventName.TaskStarted)
		} finally {
			client.disconnect()
			await stopListening()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
