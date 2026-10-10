import { randomUUID } from "node:crypto"
import { TaskCommandName, type TaskCommand } from "@roo-code/types"
import { buildSmokeConfiguration, SMOKE_PROMPT, SMOKE_TIMEOUT_MS, SOLHEIM_BASE_URL, SOLHEIM_MODEL } from "./config.ts"
import { collectEvidence, smokeCode, type SmokeCode, type SmokeEvidence } from "./evidence.ts"
import { createTaskStartWaiter } from "./task-start.ts"

export interface SmokeHost {
	readonly exited: boolean
	onExit(listener: () => void): void
	signal(signal: NodeJS.Signals): void
}
export interface SmokeClient {
	readonly isReady: boolean
	onTaskEvent(listener: (event: unknown) => void): void
	onDisconnect(listener: () => void): void
	sendCommand(command: TaskCommand): void
	disconnect(): void
}
export type SmokeVerdict = {
	kind: "provider-smoke"
	model: string
	provider: string
	passed: boolean
	code: SmokeCode
	gates: {
		extensionActivated: boolean
		ipcConnected: boolean
		taskAccepted: boolean
		providerResponseSeen: boolean
		completionSeen: boolean
		childExited: boolean
	}
	durationMs: number
}
export interface SmokeRuntime {
	launch(): Promise<SmokeHost>
	connect(): SmokeClient
	cleanup(): Promise<void>
	writeVerdict(verdict: SmokeVerdict): Promise<void>
	onInterrupt(listener: () => void): () => void
	now(): number
	pause(ms: number): Promise<void>
}

// Only the adapter can spawn VS Code, read credentials or write files. Tests
// exercise the same controller with synthetic IPC and a deterministic clock.
export async function runSmoke(runtime: SmokeRuntime, apiKey: string): Promise<SmokeVerdict> {
	const started = runtime.now()
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
	let host: SmokeHost | undefined
	let client: SmokeClient | undefined
	let waiter: ReturnType<typeof createTaskStartWaiter> | undefined
	async function until(check: () => boolean, timeoutMs: number, stopOnLoss = true): Promise<void> {
		const deadline = runtime.now() + timeoutMs
		while (!check() && (!stopOnLoss || !sessionLost) && runtime.now() < deadline) await runtime.pause(100)
	}
	const markLost = () => {
		sessionLost = true
		waiter?.onExit()
	}
	const unsubscribe = runtime.onInterrupt(() => {
		markLost()
		try {
			host?.signal("SIGTERM")
		} catch {
			/* Teardown retries independently. */
		}
	})
	try {
		if (!apiKey) throw new Error("Provider credential missing")
		host = await runtime.launch()
		host.onExit(markLost)
		client = runtime.connect()
		client.onDisconnect(() => {
			sessionLost = true
			waiter?.onDisconnect()
		})
		let taskId: string | undefined
		client.onTaskEvent((event) => {
			const id = waiter?.onTaskEvent(event)
			if (id && taskId === undefined) taskId = id
			collectEvidence(evidence, event, taskId)
		})
		await until(() => client?.isReady === true, SMOKE_TIMEOUT_MS)
		activated = client.isReady
		if (!activated) code = "ACTIVATION_FAILED"
		else {
			const requestId = randomUUID()
			waiter = createTaskStartWaiter({ requestId, timeoutMs: 35_000 })
			// A synchronous send failure must not leave a rejected timer promise.
			void waiter.result.catch(() => {})
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
		// Never expose thrown provider, filesystem or host messages.
	} finally {
		waiter?.onExit()
		const attempt = async (operation: () => unknown) => {
			try {
				await operation()
			} catch {
				if (code === "OK") code = "TEARDOWN_FAILED"
			}
		}
		if (client?.isReady) await attempt(() => client?.sendCommand({ commandName: TaskCommandName.CloseTask }))
		if (host && !host.exited) {
			await attempt(() => until(() => host?.exited === true, 5_000, false))
			for (const signal of ["SIGTERM", "SIGKILL"] as const) {
				if (host.exited) break
				await attempt(() => host?.signal(signal))
				await attempt(() => until(() => host?.exited === true, 5_000, false))
			}
			if (!host.exited && code === "OK") code = "TEARDOWN_FAILED"
		}
		await attempt(() => client?.disconnect())
		if (!host || host.exited) await attempt(() => runtime.cleanup())
		await attempt(unsubscribe)
	}
	const verdict: SmokeVerdict = {
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
			childExited: !host || host.exited,
		},
		durationMs: runtime.now() - started,
	}
	await runtime.writeVerdict(verdict)
	return verdict
}

export const smokeExitCode = (verdict: SmokeVerdict): number => (verdict.passed ? 0 : 1)
