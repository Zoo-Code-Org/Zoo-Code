import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcess } from "node:child_process"
import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { IpcClient } from "@roo-code/ipc"
import { IpcMessageType, TaskCommandName, type TaskEvent } from "@roo-code/types"
import {
	buildChildEnvironment,
	buildLaunchArgs,
	buildSmokeConfiguration,
	SMOKE_PROMPT,
	SMOKE_TIMEOUT_MS,
	SOLHEIM_BASE_URL,
	SOLHEIM_MODEL,
} from "./config.ts"
import { collectEvidence, smokeCode, type SmokeCode, type SmokeEvidence } from "./evidence.ts"
import { createTaskStartWaiter } from "./task-start.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const out = process.env.SOLHEIM_SMOKE_OUT_DIR
if (!out) throw new Error("Set SOLHEIM_SMOKE_OUT_DIR to a scratch directory")
await fs.mkdir(out, { recursive: true })
const started = Date.now()
const evidence: SmokeEvidence = {
	providerResponseSeen: false,
	completionSeen: false,
	unexpectedTool: false,
	aborted: false,
}
let code: SmokeCode = "SETUP_FAILED"
let activated = false
let accepted = false
let sessionLost = false
let child: ChildProcess | undefined
let client: IpcClient | undefined
let temp: string | undefined
let exited = false
let waiter: ReturnType<typeof createTaskStartWaiter> | undefined
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, timeoutMs: number, stopOnSessionLoss = true): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (!check() && (!stopOnSessionLoss || !sessionLost) && Date.now() < deadline) await pause(100)
	return check()
}
function signalChild(signal: NodeJS.Signals): void {
	if (!child?.pid || exited) return
	try {
		process.kill(-child.pid, signal)
	} catch {
		child.kill(signal)
	}
}
function interrupted(): void {
	sessionLost = true
	waiter?.onExit()
	signalChild("SIGTERM")
}
process.once("SIGINT", interrupted)
process.once("SIGTERM", interrupted)

try {
	const apiKey = process.env.SOLHEIM_API_KEY
	if (!apiKey) throw new Error("Provider credential missing")
	const extension = path.join(root, "src")
	await fs.access(path.join(extension, "package.json"))
	temp = await fs.mkdtemp(path.join(os.tmpdir(), "solheim-smoke-"))
	const workspace = path.join(temp, "workspace")
	const home = path.join(temp, "home")
	await Promise.all([workspace, home].map((folder) => fs.mkdir(folder)))
	const socket = path.join(temp, "ipc.sock")
	const pkg = JSON.parse(await fs.readFile(path.join(root, "apps/vscode-e2e/package.json"), "utf8")) as {
		devDependencies: Record<string, string>
	}
	const executable = await downloadAndUnzipVSCode({
		version: pkg.devDependencies["@types/vscode"] ?? "1.100.0",
		cachePath: path.join(root, "apps/vscode-e2e/.vscode-test"),
	})
	const args = buildLaunchArgs(workspace, path.join(temp, "userdata"), path.join(temp, "extensions"), extension)
	child = process.env.DISPLAY
		? spawn(executable, args, {
				detached: true,
				env: buildChildEnvironment(process.env, home, socket),
				stdio: "ignore",
			})
		: spawn("xvfb-run", ["-a", executable, ...args], {
				detached: true,
				env: buildChildEnvironment(process.env, home, socket),
				stdio: "ignore",
			})
	child.once("error", () => {
		sessionLost = true
		exited = true
		waiter?.onExit()
	})
	child.once("close", () => {
		sessionLost = true
		exited = true
		waiter?.onExit()
	})
	client = new IpcClient(socket, () => {})
	client.on(IpcMessageType.Disconnect, () => {
		sessionLost = true
		waiter?.onDisconnect()
	})
	let taskId: string | undefined
	client.on(IpcMessageType.TaskEvent, (event: TaskEvent) => {
		const id = waiter?.onTaskEvent(event)
		if (id && taskId === undefined) taskId = id
		collectEvidence(evidence, event, taskId)
	})
	activated = await until(() => client?.isReady === true, SMOKE_TIMEOUT_MS)
	if (!activated) code = "ACTIVATION_FAILED"
	else {
		const requestId = randomUUID()
		waiter = createTaskStartWaiter({ requestId, timeoutMs: 35_000 })
		client.sendCommand({
			commandName: TaskCommandName.StartNewTask,
			data: { requestId, text: SMOKE_PROMPT, newTab: false, configuration: buildSmokeConfiguration(apiKey) },
		})
		try {
			taskId = await waiter.result
			accepted = true
		} catch {
			code = "TASK_START_FAILED"
		}
		if (accepted) {
			await until(
				() =>
					evidence.unexpectedTool ||
					evidence.aborted ||
					(evidence.providerResponseSeen && evidence.completionSeen),
				SMOKE_TIMEOUT_MS,
			)
			code = smokeCode(evidence, sessionLost)
		}
	}
} catch {
	/* Keep failures fixed and credential-free, never print thrown provider/host text. */
} finally {
	// Teardown is independently bounded, including spawn/activation failures.
	if (client?.isReady) client.sendCommand({ commandName: TaskCommandName.CloseTask })
	if (child && !exited) {
		await until(() => exited, 5_000, false)
		if (!exited) {
			signalChild("SIGTERM")
			await until(() => exited, 5_000, false)
		}
		if (!exited) {
			signalChild("SIGKILL")
			await until(() => exited, 5_000, false)
		}
		if (!exited && code === "OK") code = "TEARDOWN_FAILED"
	}
	client?.disconnect()
	if (temp && (!child || exited)) await fs.rm(temp, { recursive: true, force: true })
}
// Whitelisted metadata only: model answers and host logs are never saved or uploaded.
const verdict = {
	kind: "provider-smoke",
	model: SOLHEIM_MODEL,
	provider: SOLHEIM_BASE_URL,
	passed: code === "OK",
	code,
	gates: {
		extensionActivated: activated,
		ipcConnected: activated,
		taskAccepted: accepted,
		providerResponseSeen: evidence.providerResponseSeen,
		completionSeen: evidence.completionSeen,
	},
	durationMs: Date.now() - started,
}
// Write then rename, so a reader sees the old or the new verdict and never a partial one.
const verdictTemp = path.join(out, `verdict.json.${process.pid}.tmp`)
await fs.writeFile(verdictTemp, JSON.stringify(verdict, null, 2))
await fs.rename(verdictTemp, path.join(out, "verdict.json"))
console.log(`Solheim provider smoke: ${code}`)
process.exit(code === "OK" ? 0 : 1)
