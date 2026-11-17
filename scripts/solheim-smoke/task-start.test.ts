import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { RooCodeEventName, TASK_START_FAILURE_ERROR_CODE, TASK_START_FAILURE_ERROR_MESSAGE } from "@roo-code/types"

import { createTaskStartWaiter } from "./task-start.ts"

const REQUEST_ID = "final-smoke-0123abcdef456789"

const startResponse = (payload: unknown): unknown => ({
	eventName: RooCodeEventName.TaskStartResponse,
	payload: [payload],
})

const successPayload = (requestId = REQUEST_ID): unknown => ({
	requestId,
	success: true,
	taskId: "accepted-task-1",
})

const failurePayload = (requestId = REQUEST_ID): Record<string, unknown> => ({
	requestId,
	success: false,
	errorCode: TASK_START_FAILURE_ERROR_CODE,
	errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
})

const settledOutcome = async (promise: Promise<string>): Promise<"resolved" | "rejected" | "pending"> => {
	const probe = promise.then(
		() => "resolved" as const,
		() => "rejected" as const,
	)
	return Promise.race([probe, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 10))])
}

describe("createTaskStartWaiter", () => {
	it("resolves with the accepted task ID on a matching success response", async () => {
		const waiter = createTaskStartWaiter({ requestId: REQUEST_ID, timeoutMs: 1_000 })

		waiter.onTaskEvent(startResponse(successPayload()))

		assert.equal(await waiter.result, "accepted-task-1")
	})

	it("rejects with the fixed sanitized failure values on a matching failure response", async () => {
		const waiter = createTaskStartWaiter({ requestId: REQUEST_ID, timeoutMs: 1_000 })

		waiter.onTaskEvent(startResponse(failurePayload()))

		await assert.rejects(waiter.result, (error: Error) => {
			assert.equal(error.message, `${TASK_START_FAILURE_ERROR_CODE}: ${TASK_START_FAILURE_ERROR_MESSAGE}`)
			return true
		})
	})

	it("rejects with the stage in the sanitized error on a failure response carrying a stage", async () => {
		const waiter = createTaskStartWaiter({ requestId: REQUEST_ID, timeoutMs: 1_000 })

		waiter.onTaskEvent(
			startResponse({
				...failurePayload(),
				stage: "taskCreation",
			}),
		)

		await assert.rejects(waiter.result, (error: Error) => {
			assert.equal(
				error.message,
				`${TASK_START_FAILURE_ERROR_CODE}: ${TASK_START_FAILURE_ERROR_MESSAGE} (stage=taskCreation)`,
			)
			return true
		})
	})

	it("rejects with the stage unknown in the sanitized error when the response names it", async () => {
		const waiter = createTaskStartWaiter({ requestId: REQUEST_ID, timeoutMs: 1_000 })

		waiter.onTaskEvent(
			startResponse({
				...failurePayload(),
				stage: "unknown",
			}),
		)

		await assert.rejects(waiter.result, (error: Error) => {
			assert.match(error.message, /\(stage=unknown\)$/)
			return true
		})
	})

	it("ignores a failure response carrying an unknown stage value", async () => {
		const waiter = createTaskStartWaiter({ requestId: REQUEST_ID, timeoutMs: 1_000 })

		waiter.onTaskEvent(
			startResponse({
				...failurePayload(),
				stage: "secretStore",
			}),
		)
		assert.equal(await settledOutcome(waiter.result), "pending")

		waiter.onTaskEvent(startResponse(failurePayload()))
		await assert.rejects(waiter.result, /task_start_failed/)
	})

	it("ignores responses for a different requestId", async () => {
		const waiter = createTaskStartWaiter({ requestId: REQUEST_ID, timeoutMs: 1_000 })

		waiter.onTaskEvent(startResponse(successPayload("some-other-request")))
		assert.equal(await settledOutcome(waiter.result), "pending")

		waiter.onTaskEvent(startResponse(successPayload()))
		assert.equal(await waiter.result, "accepted-task-1")
	})

	it("ignores malformed and non-start events", async () => {
		const waiter = createTaskStartWaiter({ requestId: REQUEST_ID, timeoutMs: 1_000 })

		waiter.onTaskEvent({ eventName: RooCodeEventName.TaskCreated, payload: ["task-x"] })
		waiter.onTaskEvent(startResponse({ requestId: REQUEST_ID, success: true }))
		waiter.onTaskEvent(startResponse("not-an-object"))
		waiter.onTaskEvent({ eventName: RooCodeEventName.TaskStartResponse })
		waiter.onTaskEvent(undefined)
		assert.equal(await settledOutcome(waiter.result), "pending")

		waiter.onTaskEvent(startResponse(successPayload()))
		assert.equal(await waiter.result, "accepted-task-1")
	})

	it("ignores a success response carrying extra top-level fields", async () => {
		const waiter = createTaskStartWaiter({ requestId: REQUEST_ID, timeoutMs: 1_000 })

		waiter.onTaskEvent(
			startResponse({
				requestId: REQUEST_ID,
				success: true,
				taskId: "accepted-task-1",
				providerError: "key sk-secret-123 rejected",
			}),
		)
		assert.equal(await settledOutcome(waiter.result), "pending")

		waiter.onTaskEvent(startResponse(successPayload()))
		assert.equal(await waiter.result, "accepted-task-1")
	})

	it("cannot settle on a failure response carrying extra top-level fields", async () => {
		const waiter = createTaskStartWaiter({ requestId: REQUEST_ID, timeoutMs: 1_000 })

		waiter.onTaskEvent(
			startResponse({
				requestId: REQUEST_ID,
				success: false,
				errorCode: TASK_START_FAILURE_ERROR_CODE,
				errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
				detail: { apiKey: "sk-secret-123", url: "https://api.example.com" },
			}),
		)
		assert.equal(await settledOutcome(waiter.result), "pending")

		waiter.onTaskEvent(startResponse(failurePayload()))
		await assert.rejects(waiter.result, /task_start_failed/)
	})

	it("settles only once: later responses cannot change the outcome", async () => {
		const waiter = createTaskStartWaiter({ requestId: REQUEST_ID, timeoutMs: 1_000 })

		waiter.onTaskEvent(startResponse(failurePayload()))
		await assert.rejects(waiter.result, /task_start_failed/)

		assert.equal(waiter.onTaskEvent(startResponse(successPayload())), undefined)
		waiter.onDisconnect()
		waiter.onExit()
		await assert.rejects(waiter.result, /task_start_failed/)
	})

	it("rejects on timeout", async () => {
		const waiter = createTaskStartWaiter({ requestId: REQUEST_ID, timeoutMs: 10 })

		await assert.rejects(waiter.result, (error: Error) => {
			assert.match(error.message, /task start response missing after 10ms/)
			assert.match(error.message, new RegExp(REQUEST_ID))
			return true
		})
	})

	it("rejects on IPC disconnect", async () => {
		const waiter = createTaskStartWaiter({ requestId: REQUEST_ID, timeoutMs: 10_000 })

		waiter.onDisconnect()

		await assert.rejects(waiter.result, /IPC disconnected before the task start response arrived/)
	})

	it("rejects on VS Code exit", async () => {
		const waiter = createTaskStartWaiter({ requestId: REQUEST_ID, timeoutMs: 10_000 })

		waiter.onExit()

		await assert.rejects(waiter.result, /VS Code exited before the task start response arrived/)
	})

	it("stops the timeout once settled", async () => {
		const waiter = createTaskStartWaiter({ requestId: REQUEST_ID, timeoutMs: 10 })

		waiter.onTaskEvent(startResponse(successPayload()))
		await waiter.result

		// A pending timer must not reject after success. Wait past the
		// original deadline; a leak would reject the already-settled promise
		// handler chain here.
		await new Promise((resolve) => setTimeout(resolve, 30))
		assert.equal(await waiter.result, "accepted-task-1")
	})
})
