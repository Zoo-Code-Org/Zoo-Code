import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { IpcClient } from "@roo-code/ipc"
import { IpcMessageType } from "@roo-code/types"
import { buildChildEnvironment, buildLaunchArgs } from "./isolation.ts"
import type { AgentClient, AgentHost, AgentRuntime } from "./runner.ts"
import { identityUnavailable, measured, type MeasuredString, type TraceRunIdentity } from "./trace.ts"

const execFileAsync = promisify(execFile)

export interface HostRuntimeOptions {
	root: string
	artifactsDir: string
	now?: () => number
	pause?: (ms: number) => Promise<void>
}

const readCommit = async (root: string): Promise<MeasuredString> => {
	try {
		const fromCi = process.env.GITHUB_SHA
		if (fromCi && /^[0-9a-f]{40}$/i.test(fromCi)) return { available: true, value: fromCi }
		const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5_000 })
		const sha = stdout.trim()
		return /^[0-9a-f]{40}$/i.test(sha)
			? { available: true, value: sha }
			: { available: false, reason: "commitUnreadable" }
	} catch {
		return { available: false, reason: "gitUnavailable" }
	}
}

const readJsonField = async (
	file: string,
	read: (parsed: Record<string, unknown>) => unknown,
): Promise<MeasuredString> => {
	try {
		const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
		const value = read(parsed)
		return measured(typeof value === "string" ? value : undefined, "fieldMissing")
	} catch {
		return { available: false, reason: "fileUnreadable" }
	}
}

// The only place where VS Code is downloaded, spawned, isolated and torn
// down. Both the smoke driver and future adapters get the same launcher, so
// process and credential isolation cannot drift between entry points.
export function createHostRuntime(options: HostRuntimeOptions): AgentRuntime {
	const { root, artifactsDir } = options
	let temp: string | undefined

	return {
		async launch(workspaceFiles) {
			const extension = path.join(root, "src")
			await fs.access(path.join(extension, "package.json"))
			temp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-evals-"))
			const workspace = path.join(temp, "workspace")
			const isolatedHome = path.join(temp, "home")
			await Promise.all([workspace, isolatedHome].map((folder) => fs.mkdir(folder)))
			const workspaceRoot = await fs.realpath(workspace)
			for (const file of workspaceFiles) {
				const target = path.resolve(workspaceRoot, file.path)
				if (target !== workspaceRoot && !target.startsWith(workspaceRoot + path.sep))
					throw new Error("workspace file path escapes the workspace")
				await fs.mkdir(path.dirname(target), { recursive: true })
				await fs.writeFile(target, file.content)
				if (!(await fs.realpath(target)).startsWith(workspaceRoot + path.sep))
					throw new Error("workspace file escapes the workspace")
			}
			const socket = path.join(temp, "ipc.sock")
			const pkg = JSON.parse(await fs.readFile(path.join(root, "apps/vscode-e2e/package.json"), "utf8")) as {
				devDependencies: Record<string, string>
			}
			const executable = await downloadAndUnzipVSCode({
				version: pkg.devDependencies["@types/vscode"] ?? "1.100.0",
				cachePath: path.join(root, "apps/vscode-e2e/.vscode-test"),
			})
			const args = buildLaunchArgs(
				workspace,
				path.join(temp, "userdata"),
				path.join(temp, "extensions"),
				extension,
			)
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
			const host: AgentHost = {
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
			return host
		},
		connect(): AgentClient {
			const socket = path.join(temp ?? "", "ipc.sock")
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
		async writeArtifact(fileName, value) {
			// Atomic, whitelisted metadata only; no provider text or host logs.
			const safeName = path.basename(fileName)
			const pending = path.join(artifactsDir, `${safeName}.${process.pid}.tmp`)
			await fs.writeFile(pending, JSON.stringify(value, null, 2))
			await fs.rename(pending, path.join(artifactsDir, safeName))
		},
		onInterrupt(listener) {
			process.once("SIGINT", listener)
			process.once("SIGTERM", listener)
			return () => {
				process.removeListener("SIGINT", listener)
				process.removeListener("SIGTERM", listener)
			}
		},
		now: options.now ?? Date.now,
		pause: options.pause ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
		async readIdentity(): Promise<TraceRunIdentity> {
			const fallback = identityUnavailable()
			return {
				commit: await readCommit(root),
				extensionVersion: await readJsonField(
					path.join(root, "src", "package.json"),
					(parsed) => parsed["version"],
				),
				vscodeTarget: await readJsonField(path.join(root, "apps", "vscode-e2e", "package.json"), (parsed) => {
					const devDependencies = parsed["devDependencies"]
					return typeof devDependencies === "object" && devDependencies !== null
						? (devDependencies as Record<string, unknown>)["@types/vscode"]
						: undefined
				}),
				nodeVersion: fallback.nodeVersion,
				platform: fallback.platform,
				arch: fallback.arch,
			}
		},
	}
}
