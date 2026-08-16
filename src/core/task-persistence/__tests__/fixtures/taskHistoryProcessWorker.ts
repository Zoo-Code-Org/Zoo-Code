import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryStore } from "../../TaskHistoryStore"
import { taskHistoryLock } from "../../TaskHistoryLock"
import type { ParentToWorkerMessage, WorkerId, WorkerToParentMessage } from "./taskHistoryProcessProtocol"

let workerId: WorkerId | undefined
let store: TaskHistoryStore | undefined
let pauseFirstLockCallback = false
let releasePausedLock: (() => void) | undefined
let activeFlush: Promise<void> | undefined
let activeFlushRequestId: string | undefined
let flushPending = false
let insideLockCallback = false

// These tests control every reconciliation and flush through IPC barriers. Patch the
// child-only prototype before constructing/initializing the store so no watcher,
// periodic timer, or debounced write can make either process's cache less stale.
TaskHistoryStore.prototype["startWatcher"] = () => undefined
TaskHistoryStore.prototype["startPeriodicReconciliation"] = () => undefined
TaskHistoryStore.prototype["scheduleIndexWrite"] = () => undefined

const originalWithLock = taskHistoryLock.withLock.bind(taskHistoryLock)
taskHistoryLock.withLock = async function <T>(globalStoragePath: string, callback: () => Promise<T>): Promise<T> {
	const requestId = requireActiveFlushRequestId()
	send({ type: "lock-attempted", ...identity(), requestId })

	return originalWithLock(globalStoragePath, async () => {
		insideLockCallback = true
		send({ type: "lock-acquired", ...identity(), requestId })

		try {
			if (pauseFirstLockCallback) {
				pauseFirstLockCallback = false
				send({ type: "lock-paused", ...identity(), requestId })
				await new Promise<void>((resolve) => {
					releasePausedLock = resolve
				})
				releasePausedLock = undefined
			}

			const result = await callback()
			send({ type: "lock-callback-completed", ...identity(), requestId })
			return result
		} finally {
			insideLockCallback = false
		}
	})
}

process.on("message", (value: unknown) => {
	void handleMessage(value).catch((error: unknown) => {
		const requestType = getMessageType(value)
		const normalized = error instanceof Error ? error : new Error(String(error))
		if (workerId) {
			send({
				type: "worker-error",
				...identity(),
				requestType,
				message: normalized.message,
				stack: normalized.stack,
			})
		} else {
			console.error(`[task-history-process-worker] ${requestType}:`, normalized)
			process.exitCode = 1
		}
	})
})

async function handleMessage(value: unknown): Promise<void> {
	const message = parseParentMessage(value)

	switch (message.type) {
		case "initialize": {
			if (store) throw new Error("Worker was initialized more than once")
			workerId = message.workerId
			pauseFirstLockCallback = message.pauseFirstLockCallback
			store = new TaskHistoryStore(message.storageRoot)
			await store.initialize()
			send({ type: "initialized", ...identity(), cacheIds: cacheIds(store) })
			return
		}
		case "stage": {
			const activeStore = requireStore()
			await activeStore.upsert(message.item)
			send({ type: "staged", ...identity(), requestId: message.requestId, cacheIds: cacheIds(activeStore) })
			return
		}
		case "flush": {
			if (activeFlush) throw new Error("A flush is already active")
			const activeStore = requireStore()
			activeFlushRequestId = message.requestId
			flushPending = true
			send({ type: "flush-started", ...identity(), requestId: message.requestId })
			activeFlush = activeStore
				.flushIndex()
				.then(() => {
					send({ type: "flush-completed", ...identity(), requestId: message.requestId })
				})
				.finally(() => {
					flushPending = false
					activeFlushRequestId = undefined
					activeFlush = undefined
				})
			await activeFlush
			return
		}
		case "probe": {
			send({
				type: "probe-result",
				...identity(),
				requestId: message.requestId,
				flushPending,
				insideLockCallback,
			})
			return
		}
		case "release-lock": {
			if (!releasePausedLock) throw new Error("No paused lock callback is awaiting release")
			releasePausedLock()
			send({ type: "lock-released-by-parent", ...identity(), requestId: message.requestId })
			return
		}
		case "shutdown": {
			releasePausedLock?.()
			await activeFlush?.catch(() => undefined)
			send({ type: "shutdown-complete", ...identity(), requestId: message.requestId }, () => process.disconnect())
			return
		}
	}
}

function parseParentMessage(value: unknown): ParentToWorkerMessage {
	if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") {
		throw new Error("Received malformed parent IPC message")
	}

	const message = value as Record<string, unknown>
	switch (message.type) {
		case "initialize":
			if (
				(message.workerId === "A" || message.workerId === "B") &&
				typeof message.storageRoot === "string" &&
				typeof message.pauseFirstLockCallback === "boolean"
			) {
				return {
					type: "initialize",
					workerId: message.workerId,
					storageRoot: message.storageRoot,
					pauseFirstLockCallback: message.pauseFirstLockCallback,
				}
			}
			break
		case "stage":
			if (typeof message.requestId === "string" && isHistoryItem(message.item)) {
				return { type: "stage", requestId: message.requestId, item: message.item }
			}
			break
		case "flush":
		case "probe":
		case "release-lock":
		case "shutdown":
			if (typeof message.requestId === "string") {
				return { type: message.type, requestId: message.requestId }
			}
			break
	}

	throw new Error(`Received invalid ${String(message.type)} IPC message`)
}

function isHistoryItem(value: unknown): value is HistoryItem {
	return !!value && typeof value === "object" && "id" in value && typeof value.id === "string"
}

function getMessageType(value: unknown): string {
	return value && typeof value === "object" && "type" in value && typeof value.type === "string"
		? value.type
		: "unknown"
}

function requireStore(): TaskHistoryStore {
	if (!store) throw new Error("Worker has not been initialized")
	return store
}

function requireActiveFlushRequestId(): string {
	if (!activeFlushRequestId) throw new Error("Task-history lock was invoked outside a parent-requested flush")
	return activeFlushRequestId
}

function identity(): { workerId: WorkerId; pid: number } {
	if (!workerId) throw new Error("Worker identity is not initialized")
	return { workerId, pid: process.pid }
}

function cacheIds(activeStore: TaskHistoryStore): string[] {
	return activeStore
		.getAll()
		.map((item) => item.id)
		.sort()
}

function send(message: WorkerToParentMessage, callback?: (error: Error | null) => void): void {
	if (!process.send) throw new Error("Worker IPC channel is unavailable")
	if (callback) {
		process.send(message, callback)
	} else {
		process.send(message)
	}
}
