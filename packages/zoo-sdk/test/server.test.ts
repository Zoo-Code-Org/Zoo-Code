import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, expect, test } from "bun:test"
import { createZooServer } from "../src/index.js"

function fakeSpawn() {
	const calls: string[][] = []
	const procs: any[] = []
	const spawn = ((command: string, args: string[]) => {
		calls.push([command, ...args])
		const proc = new EventEmitter() as any
		proc.stdout = new PassThrough()
		proc.stderr = new PassThrough()
		proc.exitCode = null
		proc.signalCode = null
		proc.kill = () => {
			proc.signalCode = "SIGTERM"
			proc.emit("exit", null, "SIGTERM")
		}
		procs.push(proc)
		queueMicrotask(() => proc.stdout.write(`zoo server listening on ipc /tmp/zoo-sdk.sock\n`))
		return proc
	}) as any
	return { spawn, calls, procs }
}

describe("createZooServer", () => {
	test("spawns zoo server over IPC and closes it", async () => {
		const fake = fakeSpawn()
		const server = await createZooServer({ ipcPath: "/tmp/zoo-sdk.sock", spawn: fake.spawn, timeout: 100 })

		expect(server.reused).toBe(false)
		expect(server.ipcPath).toBe("/tmp/zoo-sdk.sock")
		expect(fake.calls[0]).toEqual(["zoo", "server", "--ipc=/tmp/zoo-sdk.sock"])

		await server.close()
		expect(fake.procs[0].signalCode).toBe("SIGTERM")
	})
})
