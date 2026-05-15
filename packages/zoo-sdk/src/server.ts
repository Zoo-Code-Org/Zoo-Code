import { spawn as launch } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ChildProcess } from "node:child_process"
import { bindAbort, stopProcess } from "./process.js"
import { ZooClient } from "./client.js"

export type ZooServerOptions = {
	/** CLI command to spawn. Defaults to `zoo`. */
	command?: string
	/** Unix socket path. Defaults to `/tmp/zoo-<pid>.sock`. */
	ipcPath?: string
	/** Startup timeout in milliseconds. */
	timeout?: number
	/** Abort signal that stops the spawned process. */
	signal?: AbortSignal
	/** Environment overrides for the CLI process. */
	env?: NodeJS.ProcessEnv
	/** Restart attempts after unexpected exits. */
	restartLimit?: number
	/** Lifecycle callback for host integrations that need restart/error visibility. */
	onLifecycleEvent?: (event: ZooServerLifecycleEvent) => void
	/** Spawn implementation for tests. */
	spawn?: (command: string, args: string[], options: Parameters<typeof launch>[2]) => ChildProcess
}

export type ZooServerLifecycleEvent =
	| { type: "restarting"; code: number | null; signal: NodeJS.Signals | null; attempt: number; limit: number }
	| { type: "restartLimitExceeded"; code: number | null; signal: NodeJS.Signals | null; limit: number }
	| { type: "processError"; error: Error }

export type ZooServerHandle = {
	/** IPC path clients should connect to. */
	ipcPath: string
	/** Spawned process if this SDK started one. */
	process?: ChildProcess
	/** Whether the handle reused an existing server. */
	reused: boolean
	/** Create a client connected to this server. */
	connect(): Promise<ZooClient>
	/** Stop a spawned server. Reused external servers are left running. */
	close(): Promise<void>
}

async function canConnect(ipcPath: string) {
	try {
		const client = await ZooClient.connect({ ipcPath })
		await client.listSessions()
		await client.close()
		return true
	} catch {
		return false
	}
}

/** Spawn or reuse a local `zoo server --ipc` process. */
export async function createZooServer(options: ZooServerOptions = {}): Promise<ZooServerHandle> {
	const ipcPath = options.ipcPath ?? path.join(tmpdir(), `zoo-${process.pid}.sock`)
	if (await canConnect(ipcPath)) {
		return {
			ipcPath,
			reused: true,
			connect: () => ZooClient.connect({ ipcPath }),
			close: async () => {},
		}
	}

	const spawn = options.spawn ?? launch
	const timeout = options.timeout ?? 5000
	const command = options.command ?? "zoo"
	const args = ["server", `--ipc=${ipcPath}`]
	let proc: ChildProcess
	let clearAbort = () => {}
	let restarts = 0
	const restartLimit = options.restartLimit ?? 3

	const start = () => {
		proc = spawn(command, args, {
			env: { ...process.env, ...options.env },
			windowsHide: true,
		})
		clearAbort = bindAbort(proc, options.signal)
		proc.on("error", (error) => {
			options.onLifecycleEvent?.({ type: "processError", error })
		})
		proc.on("exit", (code, signal) => {
			if (closing || proc.exitCode === 0 || proc.signalCode) return
			if (restarts++ >= restartLimit) {
				options.onLifecycleEvent?.({ type: "restartLimitExceeded", code, signal, limit: restartLimit })
				return
			}
			options.onLifecycleEvent?.({ type: "restarting", code, signal, attempt: restarts, limit: restartLimit })
			start()
		})
		return proc
	}

	let closing = false
	const first = start()

	await new Promise<void>((resolve, reject) => {
		const id = setTimeout(() => {
			stopProcess(first)
			reject(new Error(`Timeout waiting for Zoo CLI server to start after ${timeout}ms`))
		}, timeout)
		let output = ""
		first.stdout?.on("data", (chunk) => {
			output += chunk.toString()
			if (!output.includes(`zoo server listening on ipc ${ipcPath}`)) return
			clearTimeout(id)
			resolve()
		})
		first.stderr?.on("data", (chunk) => {
			output += chunk.toString()
		})
		first.once("error", (error) => {
			clearTimeout(id)
			reject(error)
		})
		first.once("exit", (code) => {
			clearTimeout(id)
			reject(new Error(`Zoo CLI server exited before startup with code ${code}\n${output}`))
		})
	})

	return {
		ipcPath,
		get process() {
			return proc
		},
		reused: false,
		connect: () => ZooClient.connect({ ipcPath }),
		async close() {
			closing = true
			clearAbort()
			stopProcess(proc)
		},
	}
}
