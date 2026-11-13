import { RooCodeEventName, type ClineMessage, type RooCodeAPI } from "@roo-code/types"

export const isCompletedAsk = (message: ClineMessage) => message.type === "ask" && message.partial !== true

type WaitForOptions = {
	timeout?: number
	interval?: number
}

export const waitFor = (
	condition: (() => Promise<boolean>) | (() => boolean),
	{ timeout = 30_000, interval = 250 }: WaitForOptions = {},
) => {
	return new Promise<void>((resolve, reject) => {
		let settled = false
		let intervalId: NodeJS.Timeout | undefined
		const timeoutId = setTimeout(() => {
			settled = true
			if (intervalId) clearTimeout(intervalId)
			reject(new Error(`Timeout after ${Math.floor(timeout / 1000)}s`))
		}, timeout)

		const cleanup = () => {
			clearTimeout(timeoutId)
			if (intervalId) clearTimeout(intervalId)
		}
		const check = async () => {
			try {
				const isSatisfied = await condition()
				if (settled) return

				if (isSatisfied) {
					settled = true
					cleanup()
					resolve()
				} else {
					intervalId = setTimeout(() => void check(), interval)
				}
			} catch (error) {
				if (settled) return
				settled = true
				cleanup()
				reject(error)
			}
		}

		void check()
	})
}

type WaitUntilAbortedOptions = WaitForOptions & {
	api: RooCodeAPI
	taskId: string
}

export const waitUntilAborted = async ({ api, taskId, ...options }: WaitUntilAbortedOptions) => {
	const set = new Set<string>()
	api.on(RooCodeEventName.TaskAborted, (taskId) => set.add(taskId))
	await waitFor(() => set.has(taskId), options)
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

/**
 * The per-view mode pin and the view-local buffer are cleared here because no public
 * door on RooCodeAPI clears them: `cancelTask()` rehydrates the task from its history
 * item, which writes both, and a later suite would otherwise resolve the provider that
 * pin points at instead of the one its own setup configured. The two private clear
 * helpers are read off the exports object through a widened alias and verified by a
 * type guard, so a surface change fails loudly instead of silently skipping the clear.
 */
type ViewStateClearDoor = {
	_clearViewLocalState?: () => void
	clearPersistedViewState?: () => Promise<void>
	viewStateId?: string
}

type ViewStateCarryingApi = RooCodeAPI & { sidebarProvider?: ViewStateClearDoor }

const isViewStateClearDoor = (value: unknown): value is ViewStateClearDoor =>
	typeof value === "object" && value !== null && "_clearViewLocalState" in value && "clearPersistedViewState" in value

export const clearViewStateBetweenSuites = async (api: RooCodeAPI): Promise<void> => {
	const provider = (api as ViewStateCarryingApi)["sidebarProvider"]

	if (!isViewStateClearDoor(provider)) {
		console.log("[view-state-teardown] exports object carries no view-state clear door; nothing cleared")
		return
	}

	const viewStateId = typeof provider["viewStateId"] === "string" ? provider["viewStateId"] : "unset"
	await provider["clearPersistedViewState"]?.()
	provider["_clearViewLocalState"]?.()
	console.log(`[view-state-teardown] cleared the persisted entry and the view-local buffer for viewId=${viewStateId}`)
}
