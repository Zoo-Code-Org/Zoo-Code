import { fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
	createHostEventStreamParser,
	createTextRedactor,
	hostCommandSchema,
	hostHelloSchema,
	negotiateProtocol,
	parentHelloSchema,
	validateNegotiatedStreamSession,
	validateStreamLifecycle,
	ZOO_HOST_PROTOCOL_VERSION,
	type HostCommand,
	type HostEvent,
	type HostHello,
	type ParentHello,
	type ZooCapability,
	type ZooError,
	type ZooErrorCode,
	type ZooStreamEvent,
} from "@roo-code/zoo-protocol"

type PendingCommand = {
	acknowledged: boolean
	resolve: (event: Extract<HostEvent, { type: "command.done" }>) => void
	reject: (error: Error) => void
}
type OutboundHostCommand = HostCommand extends infer Command
	? Command extends HostCommand
		? Omit<Command, "v" | "id">
		: never
	: never
type HostClientOptions = {
	workspace: string
	storageRoot: string
	extensionRoot: string
	onEvent: (event: ZooStreamEvent) => void
	debug?: boolean
}

const requiredCapabilities: ZooCapability[] = [
	"task:start",
	"task:resume",
	"task:cancel",
	"history:list",
	"host:shutdown",
]

export class ZooClientError extends Error {
	constructor(
		public readonly code: ZooErrorCode,
		message: string,
		public readonly detail?: ZooError,
	) {
		super(message)
		this.name = "ZooClientError"
	}
}

export class HostClient {
	private child: ChildProcess | undefined
	private parser: ReturnType<typeof createHostEventStreamParser> | undefined
	private readonly pending = new Map<string, PendingCommand>()
	private failure: Error | undefined
	private rejectFailure: ((error: Error) => void) | undefined
	public readonly failed = new Promise<never>((_, reject) => (this.rejectFailure = reject))
	private hello: HostHello | undefined
	private selection: ParentHello | undefined
	private resolveInitialized: (() => void) | undefined
	private initialized = new Promise<void>((resolve) => (this.resolveInitialized = resolve))
	private lastHeartbeat = Date.now()
	private watchdog: NodeJS.Timeout | undefined
	private readonly commands: HostCommand[] = []
	private readonly hostEvents: HostEvent[] = []
	private readonly publicEvents: ZooStreamEvent[] = []
	private initiatingCommandId: string | undefined
	private pendingResult: ZooStreamEvent | undefined

	constructor(private readonly options: HostClientOptions) {}

	public async start(timeoutMs = 45_000): Promise<void> {
		const deadline = Date.now() + timeoutMs
		const hostPath =
			process.env.ZOO_HOST_PATH ??
			fileURLToPath(new URL("../../../packages/zoo-host/dist/child.js", import.meta.url))
		const child = fork(hostPath, [], {
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			env: {
				...process.env,
				ZOO_HOST_CONFIG: JSON.stringify({
					extensionRoot: this.options.extensionRoot,
					workspaceRoot: this.options.workspace,
					storageRoot: this.options.storageRoot,
					appRoot: this.options.extensionRoot,
					buildVersion: "0.1.0",
				}),
			},
		})
		this.child = child
		child.stdout?.resume()
		const stderrRedactor = createTextRedactor()
		child.stderr?.on("data", (chunk: Buffer) => {
			if (this.options.debug) process.stderr.write(stderrRedactor.push(chunk.toString("utf8")))
		})
		child.stderr?.once("end", () => {
			if (this.options.debug) process.stderr.write(stderrRedactor.flush())
		})
		child.once("exit", (code, signal) => this.fail(new Error(`Zoo host exited (${signal ?? code ?? "unknown"})`)))
		child.once("error", (error) => this.fail(error))

		const hello = await Promise.race([
			this.waitForHello(child, Math.max(1, Math.min(15_000, deadline - Date.now()))),
			this.failed,
		])
		this.hello = hello
		const negotiation = negotiateProtocol(hello, [ZOO_HOST_PROTOCOL_VERSION], requiredCapabilities)
		if (!negotiation.ok) throw new ZooClientError("protocol_incompatible", negotiation.message)
		this.parser = createHostEventStreamParser({ hostId: hello.hostId })
		child.on("message", (message) => this.receive(message))
		this.selection = parentHelloSchema.parse({
			type: "hello.select",
			version: negotiation.version,
			clientVersion: "0.1.0",
			requiredCapabilities,
		})
		child.send(this.selection)
		let initializationTimer: NodeJS.Timeout | undefined
		try {
			await Promise.race([
				this.initialized,
				this.failed,
				new Promise<never>((_, reject) => {
					initializationTimer = setTimeout(
						() => reject(new Error("Zoo host initialization timed out")),
						Math.max(1, Math.min(30_000, deadline - Date.now())),
					)
				}),
			])
		} finally {
			if (initializationTimer) clearTimeout(initializationTimer)
		}
		this.lastHeartbeat = Date.now()
		this.watchdog = setInterval(() => {
			if (Date.now() - this.lastHeartbeat > 5_000) this.fail(new Error("Zoo host heartbeat timed out"))
		}, 1_000)
		this.watchdog.unref()
	}

	public async command(input: OutboundHostCommand, timeoutMs = 15_000) {
		if (!this.child?.connected) throw this.failure ?? new Error("Zoo host is unavailable")
		const id = randomUUID()
		const command = hostCommandSchema.parse({ v: ZOO_HOST_PROTOCOL_VERSION, id, ...input })
		this.commands.push(command)
		if (command.type === "task.start" || command.type === "task.resume") this.initiatingCommandId = command.id
		return new Promise<Extract<HostEvent, { type: "command.done" }>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new ZooClientError("task_timed_out", `Host command timed out: ${command.type}`))
			}, timeoutMs)
			this.pending.set(id, {
				acknowledged: false,
				resolve: (event) => {
					clearTimeout(timer)
					resolve(event)
				},
				reject: (error) => {
					clearTimeout(timer)
					reject(error)
				},
			})
			this.child!.send(command, (error) => {
				if (error) this.pending.get(id)?.reject(error)
			})
		})
	}

	public async stop(timeoutMs = 7_000): Promise<boolean> {
		const child = this.child
		if (!child) return true
		if (this.watchdog) clearInterval(this.watchdog)
		this.watchdog = undefined
		const deadline = Date.now() + Math.max(0, timeoutMs)
		if (timeoutMs <= 0) {
			child.kill("SIGKILL")
			return false
		}
		if (child.connected && !this.failure)
			await this.command({ type: "host.shutdown" }, Math.max(1, Math.min(5_000, deadline - Date.now()))).catch(
				() => undefined,
			)
		child.disconnect()
		return new Promise<boolean>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
			const remaining = Math.max(0, deadline - Date.now())
			if (remaining === 0) {
				child.kill("SIGKILL")
				return resolve(false)
			}
			const timer = setTimeout(() => {
				child.kill("SIGKILL")
				resolve(false)
			}, remaining)
			child.once("exit", () => {
				clearTimeout(timer)
				resolve(true)
			})
		})
	}

	private waitForHello(child: ChildProcess, timeoutMs: number) {
		return new Promise<ReturnType<typeof hostHelloSchema.parse>>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Zoo host startup timed out")), timeoutMs)
			child.once("message", (message) => {
				clearTimeout(timer)
				try {
					resolve(hostHelloSchema.parse(message))
				} catch (error) {
					reject(error)
				}
			})
		})
	}

	private receive(input: unknown): void {
		try {
			for (const event of this.parser?.push(input) ?? []) {
				this.hostEvents.push(event)
				if (event.type === "host.heartbeat") this.lastHeartbeat = Date.now()
				if (event.type === "event") {
					this.publicEvents.push(event.event)
					if (event.event.type === "system.init") {
						if (!this.hello || !this.selection)
							throw new Error("Host initialized before protocol negotiation")
						const validation = validateNegotiatedStreamSession(this.hello, this.selection, [event.event])
						if (!validation.ok) throw new ZooClientError(validation.code, validation.message)
						this.resolveInitialized?.()
					}
					if (event.event.type === "task.result") {
						if (this.pendingResult) throw new Error("Stream emitted multiple task results")
						this.pendingResult = event.event
						this.flushResult()
					} else {
						this.options.onEvent(event.event)
					}
				}
				if (event.type === "command.ack") {
					const pending = this.pending.get(event.commandId)
					if (!pending || pending.acknowledged) throw new Error(`Invalid ACK for command ${event.commandId}`)
					pending.acknowledged = true
				}
				if (event.type === "command.done") {
					const pending = this.pending.get(event.commandId)
					if (!pending?.acknowledged) throw new Error(`DONE preceded ACK for command ${event.commandId}`)
					pending.resolve(event)
					this.pending.delete(event.commandId)
					this.flushResult()
				}
				if (event.type === "command.error") {
					const pending = this.pending.get(event.commandId)
					if (!pending?.acknowledged) throw new Error(`ERROR preceded ACK for command ${event.commandId}`)
					pending.reject(new ZooClientError(event.error.code, event.error.message, event.error))
					this.pending.delete(event.commandId)
					this.flushResult()
				}
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)))
		}
	}

	private flushResult(): void {
		if (!this.pendingResult || !this.initiatingCommandId) return
		if (this.commands.some((command) => this.pending.has(command.id))) return
		const validation = validateStreamLifecycle(this.publicEvents, this.commands, this.hostEvents, {
			initiatingCommandId: this.initiatingCommandId,
			commandIds: this.commands.map((command) => command.id),
		})
		if (!validation.ok) throw new ZooClientError(validation.code, validation.message)
		const result = this.pendingResult
		this.pendingResult = undefined
		this.options.onEvent(result)
	}

	private fail(error: Error): void {
		if (this.failure) return
		this.failure = error
		this.rejectFailure?.(error)
		for (const pending of this.pending.values()) pending.reject(error)
		this.pending.clear()
	}
}

export const defaultStorageRoot = () => path.join(os.homedir(), ".zoo")
