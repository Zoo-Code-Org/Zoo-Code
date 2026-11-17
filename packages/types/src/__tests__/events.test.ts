import {
	RooCodeEventName,
	TASK_START_FAILURE_ERROR_CODE,
	TASK_START_FAILURE_ERROR_MESSAGE,
	TASK_START_STAGES,
	taskEventSchema,
	taskStartResponseSchema,
} from "../events.js"

const requestId = "final-smoke-0123abcdef456789"

describe("taskStartResponseSchema", () => {
	it("accepts a success response with the accepted task ID", () => {
		const result = taskStartResponseSchema.safeParse({ requestId, success: true, taskId: "task-1" })
		expect(result.success).toBe(true)

		if (result.success) {
			expect(result.data).toEqual({ requestId, success: true, taskId: "task-1" })
		}
	})

	it("accepts the fixed failure response", () => {
		const result = taskStartResponseSchema.safeParse({
			requestId,
			success: false,
			errorCode: TASK_START_FAILURE_ERROR_CODE,
			errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
		})
		expect(result.success).toBe(true)

		if (result.success && !result.data.success) {
			expect(result.data.success).toBe(false)
			expect(result.data.stage).toBeUndefined()
		}
	})

	it("accepts a failure response carrying each allowed stage", () => {
		for (const stage of TASK_START_STAGES) {
			const result = taskStartResponseSchema.safeParse({
				requestId,
				success: false,
				errorCode: TASK_START_FAILURE_ERROR_CODE,
				errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
				stage,
			})
			expect(result.success).toBe(true)

			if (result.success && !result.data.success) {
				expect(result.data.stage).toBe(stage)
			}
		}
	})

	it("rejects a failure response carrying an unknown stage", () => {
		const result = taskStartResponseSchema.safeParse({
			requestId,
			success: false,
			errorCode: TASK_START_FAILURE_ERROR_CODE,
			errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
			stage: "secretStore",
		})
		expect(result.success).toBe(false)
	})

	it("rejects a failure response carrying a non-string stage", () => {
		const result = taskStartResponseSchema.safeParse({
			requestId,
			success: false,
			errorCode: TASK_START_FAILURE_ERROR_CODE,
			errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
			stage: { name: "taskCreation" },
		})
		expect(result.success).toBe(false)
	})

	it("rejects a success response carrying a stage", () => {
		const result = taskStartResponseSchema.safeParse({
			requestId,
			success: true,
			taskId: "task-1",
			stage: "taskCreation",
		})
		expect(result.success).toBe(false)
	})

	it("rejects a success response without a taskId", () => {
		const result = taskStartResponseSchema.safeParse({ requestId, success: true })
		expect(result.success).toBe(false)
	})

	it("rejects a failure response carrying an unfixed error code", () => {
		const result = taskStartResponseSchema.safeParse({
			requestId,
			success: false,
			errorCode: "provider_auth_failed",
			errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
		})
		expect(result.success).toBe(false)
	})

	it("rejects a failure response carrying a raw error message", () => {
		const result = taskStartResponseSchema.safeParse({
			requestId,
			success: false,
			errorCode: TASK_START_FAILURE_ERROR_CODE,
			errorMessage: "openai rejected the key sk-secret-123 at https://api.example.com",
		})
		expect(result.success).toBe(false)
	})

	it("rejects an empty requestId", () => {
		const result = taskStartResponseSchema.safeParse({ requestId: "", success: true, taskId: "task-1" })
		expect(result.success).toBe(false)
	})

	it("rejects a success response with an extra top-level field", () => {
		const result = taskStartResponseSchema.safeParse({
			requestId,
			success: true,
			taskId: "task-1",
			providerError: "openai rejected the key sk-secret-123",
		})
		expect(result.success).toBe(false)
	})

	it("rejects a failure response with an extra field on the error object", () => {
		const result = taskStartResponseSchema.safeParse({
			requestId,
			success: false,
			errorCode: TASK_START_FAILURE_ERROR_CODE,
			errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
			detail: { apiKey: "sk-secret-123", url: "https://api.example.com" },
		})
		expect(result.success).toBe(false)
	})
})

describe("taskEventSchema TaskStartResponse", () => {
	it("routes a success response through the task event envelope", () => {
		const result = taskEventSchema.safeParse({
			eventName: RooCodeEventName.TaskStartResponse,
			payload: [{ requestId, success: true, taskId: "task-1" }],
		})
		expect(result.success).toBe(true)
	})

	it("routes a failure response through the task event envelope", () => {
		const result = taskEventSchema.safeParse({
			eventName: RooCodeEventName.TaskStartResponse,
			payload: [
				{
					requestId,
					success: false,
					errorCode: TASK_START_FAILURE_ERROR_CODE,
					errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
				},
			],
		})
		expect(result.success).toBe(true)
	})

	it("routes a failure response with a stage through the task event envelope", () => {
		const result = taskEventSchema.safeParse({
			eventName: RooCodeEventName.TaskStartResponse,
			payload: [
				{
					requestId,
					success: false,
					errorCode: TASK_START_FAILURE_ERROR_CODE,
					errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
					stage: "taskCreation",
				},
			],
		})
		expect(result.success).toBe(true)
	})

	it("rejects a failure payload with an unknown stage through the task event envelope", () => {
		const result = taskEventSchema.safeParse({
			eventName: RooCodeEventName.TaskStartResponse,
			payload: [
				{
					requestId,
					success: false,
					errorCode: TASK_START_FAILURE_ERROR_CODE,
					errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
					stage: "keyring",
				},
			],
		})
		expect(result.success).toBe(false)
	})

	it("rejects a failure payload with a stage plus an extra field through the task event envelope", () => {
		const result = taskEventSchema.safeParse({
			eventName: RooCodeEventName.TaskStartResponse,
			payload: [
				{
					requestId,
					success: false,
					errorCode: TASK_START_FAILURE_ERROR_CODE,
					errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
					stage: "taskCreation",
					rawError: "sk-secret-123",
				},
			],
		})
		expect(result.success).toBe(false)
	})

	it("rejects a success payload with an extra field through the task event envelope", () => {
		const result = taskEventSchema.safeParse({
			eventName: RooCodeEventName.TaskStartResponse,
			payload: [{ requestId, success: true, taskId: "task-1", stack: "at run (api.ts:1:1)" }],
		})
		expect(result.success).toBe(false)
	})

	it("rejects a failure payload with an extra error field through the task event envelope", () => {
		const result = taskEventSchema.safeParse({
			eventName: RooCodeEventName.TaskStartResponse,
			payload: [
				{
					requestId,
					success: false,
					errorCode: TASK_START_FAILURE_ERROR_CODE,
					errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
					rawError: "sk-secret-123",
				},
			],
		})
		expect(result.success).toBe(false)
	})
})
