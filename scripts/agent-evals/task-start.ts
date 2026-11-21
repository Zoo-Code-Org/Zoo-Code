import { RooCodeEventName, taskStartResponseSchema } from "@roo-code/types"

export type TaskStartWaiter = {
	onTaskEvent: (event: unknown) => string | undefined
	onDisconnect: () => void
	onExit: () => void
	result: Promise<string>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

// Correlates one StartNewTask request with its sanitized response, similar to
// JSON-RPC: the sender generates the requestId and the reply copies it back.
// The waiter settles exactly once. A matched success resolves with the
// accepted task ID. A matched failure, a timeout, an IPC disconnect, or a
// VS Code exit rejects. Unmatched or malformed responses never settle it.
export function createTaskStartWaiter({
	requestId,
	timeoutMs,
}: {
	requestId: string
	timeoutMs: number
}): TaskStartWaiter {
	let resolveResult!: (taskId: string) => void
	let rejectResult!: (error: Error) => void
	const result = new Promise<string>((resolve, reject) => {
		resolveResult = resolve
		rejectResult = reject
	})

	let settled = false
	let timer: NodeJS.Timeout | undefined

	const settle = (finish: () => void): void => {
		if (settled) {
			return
		}
		settled = true
		if (timer !== undefined) {
			clearTimeout(timer)
			timer = undefined
		}
		finish()
	}

	const rejectWith = (message: string): void => {
		settle(() => rejectResult(new Error(message)))
	}

	timer = setTimeout(() => {
		rejectWith(`task start response missing after ${timeoutMs}ms (requestId=${requestId})`)
	}, timeoutMs)

	return {
		onTaskEvent(event: unknown): string | undefined {
			if (settled) return undefined
			if (!isRecord(event) || event["eventName"] !== RooCodeEventName.TaskStartResponse) {
				return undefined
			}

			const payload = event["payload"]
			if (!Array.isArray(payload) || payload.length === 0) {
				return undefined
			}

			const parsed = taskStartResponseSchema.safeParse(payload[0])
			if (!parsed.success || parsed.data.requestId !== requestId) {
				return undefined
			}

			const response = parsed.data
			if (response.success) {
				const acceptedTaskId = response.taskId
				settle(() => resolveResult(acceptedTaskId))
				return acceptedTaskId
			}

			const { errorCode, errorMessage, stage } = response
			// The stage is a fixed sanitized token from the response schema; it
			// names the startup phase that stopped responding.
			const stageDetail = stage === undefined ? "" : ` (stage=${stage})`
			rejectWith(`${errorCode}: ${errorMessage}${stageDetail}`)
			return undefined
		},

		onDisconnect(): void {
			rejectWith("IPC disconnected before the task start response arrived")
		},

		onExit(): void {
			rejectWith("VS Code exited before the task start response arrived")
		},

		result,
	}
}
