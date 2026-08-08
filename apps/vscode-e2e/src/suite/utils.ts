import { RooCodeEventName, type RooCodeAPI } from "@roo-code/types"

type WaitForOptions = {
	timeout?: number
	interval?: number
}

export const waitFor = (
	condition: (() => Promise<boolean>) | (() => boolean),
	{ timeout = 30_000, interval = 250 }: WaitForOptions = {},
) => {
	let timeoutId: NodeJS.Timeout | undefined = undefined

	return Promise.race([
		new Promise<void>((resolve) => {
			const check = async () => {
				const result = condition()
				const isSatisfied = result instanceof Promise ? await result : result

				if (isSatisfied) {
					if (timeoutId) {
						clearTimeout(timeoutId)
						timeoutId = undefined
					}

					resolve()
				} else {
					setTimeout(check, interval)
				}
			}

			check()
		}),
		new Promise((_, reject) => {
			timeoutId = setTimeout(() => {
				reject(new Error(`Timeout after ${Math.floor(timeout / 1000)}s`))
			}, timeout)
		}),
	])
}

type WaitUntilAbortedOptions = WaitForOptions & {
	api: RooCodeAPI
	taskId: string
	action?: () => Promise<void>
}

export const waitUntilAborted = async ({ api, taskId, action, ...options }: WaitUntilAbortedOptions) => {
	const set = new Set<string>()
	const handler = (id: string) => set.add(id)
	api.on(RooCodeEventName.TaskAborted, handler)
	try {
		if (action) {
			await action()
		}
		await waitFor(async () => {
			if (set.has(taskId)) return true
			const item = await api.getTaskHistoryItem(taskId)
			return (item?.status as string) === "cancelled" || item?.status === "interrupted"
		}, options)
	} finally {
		api.off(RooCodeEventName.TaskAborted, handler)
	}
}

type WaitUntilCompletedOptions = WaitForOptions & {
	api: RooCodeAPI
	taskId?: string
	start?: () => Promise<string>
}

export const waitUntilCompleted = async ({
	api,
	taskId: passedTaskId,
	start,
	...options
}: WaitUntilCompletedOptions): Promise<string> => {
	const completed = new Set<string>()
	const handler = (id: string) => completed.add(id)
	api.on(RooCodeEventName.TaskCompleted, handler)
	try {
		const taskId = passedTaskId ?? (await start!())
		await waitFor(() => completed.has(taskId), options)
		return taskId
	} finally {
		api.off(RooCodeEventName.TaskCompleted, handler)
	}
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
