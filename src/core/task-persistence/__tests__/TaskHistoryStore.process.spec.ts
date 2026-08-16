// pnpm --dir src exec vitest run core/task-persistence/__tests__/TaskHistoryStore.process.spec.ts

import { spawn, type ChildProcess } from "child_process"
import { createRequire } from "module"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { fileURLToPath, pathToFileURL } from "url"

import type { HistoryItem } from "@roo-code/types"

import { GlobalFileNames } from "../../../shared/globalFileNames"
import type { ParentToWorkerMessage, WorkerId, WorkerToParentMessage } from "./fixtures/taskHistoryProcessProtocol"

const DIAGNOSTIC_TIMEOUT_MS = 8_000
const MAX_CAPTURED_OUTPUT_BYTES = 32 * 1024
const require = createRequire(import.meta.url)
const tsxLoaderUrl = pathToFileURL(require.resolve("tsx")).href
const workerPath = fileURLToPath(new URL("./fixtures/taskHistoryProcessWorker.ts", import.meta.url))
const workerTsconfigPath = fileURLToPath(new URL("./fixtures/tsconfig.json", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url))

interface HistoryIndex {
	version: number
	entries: HistoryItem[]
}

class ProcessWorker {
	private readonly child: ChildProcess
	private readonly events: WorkerToParentMessage[] = []
	private readonly waiters = new Set<{
		predicate: (event: WorkerToParentMessage) => boolean
		resolve: (event: WorkerToParentMessage) => void
		reject: (error: Error) => void
		timer: ReturnType<typeof setTimeout>
	}>()
	private stdout = ""
	private stderr = ""
	private terminalError: Error | undefined
	private exited = false
	private expectedExit = false

	constructor(
		readonly workerId: WorkerId,
		private readonly onEvent?: (event: WorkerToParentMessage) => void,
	) {
		this.child = spawn(process.execPath, ["--import", tsxLoaderUrl, workerPath], {
			cwd: repositoryRoot,
			env: { ...process.env, TSX_TSCONFIG_PATH: workerTsconfigPath },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		})

		this.child.stdout?.on("data", (chunk: Buffer | string) => {
			this.stdout = appendBounded(this.stdout, chunk.toString())
		})
		this.child.stderr?.on("data", (chunk: Buffer | string) => {
			this.stderr = appendBounded(this.stderr, chunk.toString())
		})
		this.child.on("message", (value: unknown) => this.handleEvent(value))
		this.child.on("error", (error) => this.fail(new Error(`Worker ${workerId} process error: ${error.message}`)))
		this.child.on("exit", (code, signal) => {
			this.exited = true
			if (!this.expectedExit || code !== 0 || this.waiters.size > 0) {
				this.fail(
					new Error(
						`Worker ${workerId} exited prematurely (code=${String(code)}, signal=${String(signal)})${this.diagnostics()}`,
					),
				)
			}
		})
	}

	send(message: ParentToWorkerMessage): void {
		if (this.terminalError) throw this.terminalError
		if (!this.child.connected)
			throw new Error(`Worker ${this.workerId} IPC channel is disconnected${this.diagnostics()}`)
		this.child.send(message, (error) => {
			if (error)
				this.fail(new Error(`Failed to send to worker ${this.workerId}: ${error.message}${this.diagnostics()}`))
		})
	}

	async initialize(storageRoot: string, pauseFirstLockCallback = false): Promise<void> {
		this.send({ type: "initialize", workerId: this.workerId, storageRoot, pauseFirstLockCallback })
		await this.waitFor((event) => event.type === "initialized", "initialize")
	}

	async stage(requestId: string, item: HistoryItem): Promise<Extract<WorkerToParentMessage, { type: "staged" }>> {
		this.send({ type: "stage", requestId, item })
		return this.waitForEventType("staged", requestId)
	}

	flush(requestId: string): void {
		this.send({ type: "flush", requestId })
	}

	async probe(requestId: string): Promise<Extract<WorkerToParentMessage, { type: "probe-result" }>> {
		this.send({ type: "probe", requestId })
		return this.waitForEventType("probe-result", requestId)
	}

	releaseLock(requestId: string): void {
		this.send({ type: "release-lock", requestId })
	}

	waitForEventType<TType extends WorkerToParentMessage["type"]>(
		type: TType,
		requestId: string,
	): Promise<Extract<WorkerToParentMessage, { type: TType }>> {
		return this.waitFor(
			(event): event is Extract<WorkerToParentMessage, { type: TType }> =>
				event.type === type && "requestId" in event && event.requestId === requestId,
			`${type} (${requestId})`,
		)
	}

	async close(): Promise<void> {
		if (this.exited) return
		const requestId = `shutdown-${this.workerId}`
		if (this.child.connected) {
			this.send({ type: "shutdown", requestId })
			await this.waitForEventType("shutdown-complete", requestId)
		}
		this.expectedExit = true
		await this.waitForExit()
	}

	kill(): void {
		if (!this.exited) this.child.kill()
	}

	private waitFor<TEvent extends WorkerToParentMessage>(
		predicate: (event: WorkerToParentMessage) => event is TEvent,
		description: string,
	): Promise<TEvent>
	private waitFor(
		predicate: (event: WorkerToParentMessage) => boolean,
		description: string,
	): Promise<WorkerToParentMessage>
	private waitFor(
		predicate: (event: WorkerToParentMessage) => boolean,
		description: string,
	): Promise<WorkerToParentMessage> {
		if (this.terminalError) return Promise.reject(this.terminalError)
		const existing = this.events.find(predicate)
		if (existing) return Promise.resolve(existing)

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(waiter)
				reject(
					new Error(`Timed out waiting for worker ${this.workerId} to ${description}${this.diagnostics()}`),
				)
			}, DIAGNOSTIC_TIMEOUT_MS)
			const waiter = { predicate, resolve, reject, timer }
			this.waiters.add(waiter)
		})
	}

	private waitForExit(): Promise<void> {
		if (this.exited) return Promise.resolve()
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Timed out waiting for worker ${this.workerId} to exit${this.diagnostics()}`))
			}, DIAGNOSTIC_TIMEOUT_MS)
			this.child.once("exit", () => {
				clearTimeout(timer)
				resolve()
			})
		})
	}

	private handleEvent(value: unknown): void {
		if (!isWorkerEvent(value) || value.workerId !== this.workerId) {
			this.fail(
				new Error(`Worker ${this.workerId} sent malformed IPC: ${JSON.stringify(value)}${this.diagnostics()}`),
			)
			return
		}
		if (value.type === "worker-error") {
			this.fail(
				new Error(
					`Worker ${this.workerId} failed handling ${value.requestType}: ${value.message}\n${value.stack ?? ""}${this.diagnostics()}`,
				),
			)
			return
		}

		this.events.push(value)
		this.onEvent?.(value)
		for (const waiter of this.waiters) {
			if (waiter.predicate(value)) {
				clearTimeout(waiter.timer)
				this.waiters.delete(waiter)
				waiter.resolve(value)
			}
		}
	}

	private fail(error: Error): void {
		if (this.terminalError) return
		this.terminalError = error
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer)
			waiter.reject(error)
		}
		this.waiters.clear()
	}

	private diagnostics(): string {
		const eventSummary = this.events.map((event) => event.type).join(", ")
		return `\nEvents: [${eventSummary}]\nstdout:\n${this.stdout}\nstderr:\n${this.stderr}`
	}
}

describe("TaskHistoryStore separate-process integration", () => {
	let storageRoot: string
	let workers: ProcessWorker[]

	beforeEach(async () => {
		storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-process-"))
		workers = []
	})

	afterEach(async () => {
		try {
			await Promise.all(workers.map((worker) => worker.close()))
		} finally {
			workers.forEach((worker) => worker.kill())
			await fs.rm(storageRoot, { recursive: true, force: true })
		}
	})

	it("rebuilds the index from authoritative task files when both process caches are stale and partial", async () => {
		const workerA = addWorker(workers, new ProcessWorker("A"))
		const workerB = addWorker(workers, new ProcessWorker("B"))

		// Both initialization barriers complete before either task exists. The worker
		// disables all background cache/index activity before constructing the store.
		await Promise.all([workerA.initialize(storageRoot), workerB.initialize(storageRoot)])

		const stagedA = await workerA.stage("stage-a", makeHistoryItem("task-a", 1_000))
		const stagedB = await workerB.stage("stage-b", makeHistoryItem("task-b", 2_000))
		expect(stagedA.cacheIds).toEqual(["task-a"])
		expect(stagedB.cacheIds).toEqual(["task-b"])

		workerA.flush("flush-a")
		await workerA.waitForEventType("flush-completed", "flush-a")
		expect(await readIndexIds(storageRoot)).toEqual(["task-a", "task-b"])

		workerB.flush("flush-b")
		await workerB.waitForEventType("flush-completed", "flush-b")

		expect(await readTaskFileIds(storageRoot, ["task-a", "task-b"])).toEqual(["task-a", "task-b"])
		expect(await readIndexIds(storageRoot)).toEqual(["task-a", "task-b"])
	})

	it("serializes real advisory-lock contention across process IDs without blocking the waiting event loop", async () => {
		const ordering: string[] = []
		const recordOrdering = (event: WorkerToParentMessage): void => {
			if (
				event.type === "lock-acquired" ||
				(event.workerId === "B" && event.type === "lock-attempted") ||
				event.type === "lock-callback-completed"
			) {
				ordering.push(`${event.workerId}:${event.type}`)
			}
		}
		const workerA = addWorker(workers, new ProcessWorker("A", recordOrdering))
		const workerB = addWorker(workers, new ProcessWorker("B", recordOrdering))

		await Promise.all([workerA.initialize(storageRoot, true), workerB.initialize(storageRoot)])
		await workerA.stage("stage-a", makeHistoryItem("task-a", 1_000))
		await workerB.stage("stage-b", makeHistoryItem("task-b", 2_000))

		workerA.flush("flush-a")
		const acquiredA = await workerA.waitForEventType("lock-acquired", "flush-a")
		await workerA.waitForEventType("lock-paused", "flush-a")

		workerB.flush("flush-b")
		const attemptedB = await workerB.waitForEventType("lock-attempted", "flush-b")
		expect(acquiredA.pid).not.toBe(attemptedB.pid)

		// This response is positive, event-driven evidence that B handled another IPC
		// command while its flush remained unresolved outside the critical callback.
		const probeB = await workerB.probe("probe-b-waiting")
		expect(probeB).toMatchObject({ flushPending: true, insideLockCallback: false })
		ordering.push("B:not-entered-responsive")
		expect(ordering).toEqual(["A:lock-acquired", "B:lock-attempted", "B:not-entered-responsive"])

		workerA.releaseLock("release-a")
		await workerA.waitForEventType("lock-callback-completed", "flush-a")
		await workerA.waitForEventType("flush-completed", "flush-a")
		await workerB.waitForEventType("lock-acquired", "flush-b")
		await workerB.waitForEventType("lock-callback-completed", "flush-b")
		await workerB.waitForEventType("flush-completed", "flush-b")

		// IPC order is guaranteed per child channel, but not between A's and B's
		// independent channels after the lock is released. Assert each process's
		// causal sequence without relying on cross-channel delivery timing.
		expect(ordering.filter((entry) => entry.startsWith("A:"))).toEqual([
			"A:lock-acquired",
			"A:lock-callback-completed",
		])
		expect(ordering.filter((entry) => entry.startsWith("B:"))).toEqual([
			"B:lock-attempted",
			"B:not-entered-responsive",
			"B:lock-acquired",
			"B:lock-callback-completed",
		])
		expect(await readIndexIds(storageRoot)).toEqual(["task-a", "task-b"])
	})
})

function addWorker(workers: ProcessWorker[], worker: ProcessWorker): ProcessWorker {
	workers.push(worker)
	return worker
}

function makeHistoryItem(id: string, ts: number): HistoryItem {
	return {
		id,
		number: ts / 1_000,
		ts,
		task: `Task ${id}`,
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.01,
		workspace: path.join("workspace", id),
	}
}

async function readIndexIds(storageRoot: string): Promise<string[]> {
	const indexPath = path.join(storageRoot, "tasks", GlobalFileNames.historyIndex)
	const parsed = JSON.parse(await fs.readFile(indexPath, "utf8")) as unknown
	if (!isHistoryIndex(parsed)) throw new Error(`Malformed task history index at ${indexPath}`)
	return parsed.entries.map((entry) => entry.id).sort()
}

async function readTaskFileIds(storageRoot: string, taskIds: string[]): Promise<string[]> {
	const ids = await Promise.all(
		taskIds.map(async (taskId) => {
			const taskPath = path.join(storageRoot, "tasks", taskId, GlobalFileNames.historyItem)
			const parsed = JSON.parse(await fs.readFile(taskPath, "utf8")) as unknown
			if (!isHistoryItem(parsed)) throw new Error(`Malformed task history item at ${taskPath}`)
			return parsed.id
		}),
	)
	return ids.sort()
}

function isHistoryIndex(value: unknown): value is HistoryIndex {
	return (
		!!value &&
		typeof value === "object" &&
		"version" in value &&
		value.version === 1 &&
		"entries" in value &&
		Array.isArray(value.entries) &&
		value.entries.every(isHistoryItem)
	)
}

function isHistoryItem(value: unknown): value is HistoryItem {
	return !!value && typeof value === "object" && "id" in value && typeof value.id === "string"
}

function isWorkerEvent(value: unknown): value is WorkerToParentMessage {
	return (
		!!value &&
		typeof value === "object" &&
		"type" in value &&
		typeof value.type === "string" &&
		"workerId" in value &&
		(value.workerId === "A" || value.workerId === "B") &&
		"pid" in value &&
		typeof value.pid === "number"
	)
}

function appendBounded(current: string, addition: string): string {
	const combined = current + addition
	if (Buffer.byteLength(combined) <= MAX_CAPTURED_OUTPUT_BYTES) return combined
	return `[output truncated to last ${MAX_CAPTURED_OUTPUT_BYTES} bytes]\n${combined.slice(-MAX_CAPTURED_OUTPUT_BYTES)}`
}
