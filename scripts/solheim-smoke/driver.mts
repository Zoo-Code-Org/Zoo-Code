import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { IpcClient } from "@roo-code/ipc"
import { IpcMessageType } from "@roo-code/types"
import { buildChildEnvironment, buildLaunchArgs } from "./config.ts"
import { runSmoke, smokeExitCode, type SmokeRuntime } from "./run.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const out = process.env.SOLHEIM_SMOKE_OUT_DIR
if (!out) throw new Error("Set SOLHEIM_SMOKE_OUT_DIR to a scratch directory")
await fs.mkdir(out, { recursive: true })
let temp: string | undefined
let socket = ""
const runtime: SmokeRuntime = {
	async launch() {
		const extension = path.join(root, "src")
		await fs.access(path.join(extension, "package.json"))
		temp = await fs.mkdtemp(path.join(os.tmpdir(), "solheim-smoke-"))
		const workspace = path.join(temp, "workspace")
		const isolatedHome = path.join(temp, "home")
		await Promise.all([workspace, isolatedHome].map((folder) => fs.mkdir(folder)))
		socket = path.join(temp, "ipc.sock")
		const pkg = JSON.parse(await fs.readFile(path.join(root, "apps/vscode-e2e/package.json"), "utf8")) as {
			devDependencies: Record<string, string>
		}
		const executable = await downloadAndUnzipVSCode({
			version: pkg.devDependencies["@types/vscode"] ?? "1.100.0",
			cachePath: path.join(root, "apps/vscode-e2e/.vscode-test"),
		})
		const args = buildLaunchArgs(workspace, path.join(temp, "userdata"), path.join(temp, "extensions"), extension)
		const child = spawn(
			process.env.DISPLAY ? executable : "xvfb-run",
			process.env.DISPLAY ? args : ["-a", executable, ...args],
			{
				detached: true,
				env: buildChildEnvironment(process.env, isolatedHome, socket),
				stdio: "ignore",
			},
		)
		let exited = false
		let onExit = () => {}
		const closed = () => {
			exited = true
			onExit()
		}
		child.once("error", () => {
			// Spawn failure has no live PID; a failed kill must not claim exit.
			if (!child.pid) closed()
			else onExit()
		})
		child.once("close", closed)
		return {
			get exited() {
				return exited
			},
			onExit(listener) {
				onExit = listener
				if (exited) listener()
			},
			signal(signal) {
				if (!child.pid || exited) return
				try {
					process.kill(-child.pid, signal)
				} catch {
					child.kill(signal)
				}
			},
		}
	},
	connect() {
		const client = new IpcClient(socket, () => {})
		return {
			get isReady() {
				return client.isReady
			},
			onTaskEvent(listener) {
				client.on(IpcMessageType.TaskEvent, listener)
			},
			onDisconnect(listener) {
				client.on(IpcMessageType.Disconnect, listener)
			},
			sendCommand(command) {
				client.sendCommand(command)
			},
			disconnect() {
				client.disconnect()
			},
		}
	},
	async cleanup() {
		if (temp) await fs.rm(temp, { recursive: true, force: true })
	},
	async writeVerdict(verdict) {
		// Atomic, whitelisted metadata only; no provider text or host logs.
		const pending = path.join(out, `verdict.json.${process.pid}.tmp`)
		await fs.writeFile(pending, JSON.stringify(verdict, null, 2))
		await fs.rename(pending, path.join(out, "verdict.json"))
	},
	onInterrupt(listener) {
		process.once("SIGINT", listener)
		process.once("SIGTERM", listener)
		return () => {
			process.removeListener("SIGINT", listener)
			process.removeListener("SIGTERM", listener)
		}
	},
	now: Date.now,
	pause: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}
try {
	const verdict = await runSmoke(runtime, process.env.SOLHEIM_API_KEY ?? "")
	console.log(`Solheim provider smoke: ${verdict.code}`)
	process.exit(smokeExitCode(verdict))
} catch {
	console.log("Solheim provider smoke: SETUP_FAILED")
	process.exit(1)
}
