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

	test("emits lifecycle event and restarts after unexpected exit", async () => {
		const fake = fakeSpawn()
		const events: unknown[] = []
		await createZooServer({
			ipcPath: "/tmp/zoo-sdk.sock",
			spawn: fake.spawn,
			timeout: 100,
			restartLimit: 1,
			onLifecycleEvent: (event) => events.push(event),
		})

		fake.procs[0].exitCode = 1
		fake.procs[0].emit("exit", 1, null)

		expect(fake.calls.length).toBe(2)
		expect(events).toEqual([{ type: "restarting", code: 1, signal: null, attempt: 1, limit: 1 }])
	})

	test("emits lifecycle event when restart limit is exhausted", async () => {
		const fake = fakeSpawn()
		const events: unknown[] = []
		await createZooServer({
			ipcPath: "/tmp/zoo-sdk.sock",
			spawn: fake.spawn,
			timeout: 100,
			restartLimit: 0,
			onLifecycleEvent: (event) => events.push(event),
		})

		fake.procs[0].exitCode = 1
		fake.procs[0].emit("exit", 1, null)

		expect(fake.calls.length).toBe(1)
		expect(events).toEqual([{ type: "restartLimitExceeded", code: 1, signal: null, limit: 0 }])
	})
})
