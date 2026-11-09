/** What the helper needs of the hub (the shared `McpHub`): the one call that applies a change. */
interface McpEnabledTarget {
	handleMcpEnabledChange(enabled: boolean): Promise<void>
}

interface Change {
	value: boolean
	settled: boolean
	promise: Promise<void>
}

/** The change that is last in line for each hub. A hub is shared by every provider, so this is across providers too. */
const lastChange = new WeakMap<McpEnabledTarget, Change>()

/**
 * Applies a change of the MCP switch to the hub, one at a time per hub. A save that is sent again (the webview retries
 * one that was not answered in time) carries the same switch: while that change is still being applied, the retry joins
 * it instead of starting another one, so a disconnect that is under way is not started a second time on a transport
 * that is closing (the hub removes a connection only after its close has finished). A different value waits for the
 * change that is under way, so the changes are applied in the order they were made.
 */
export function changeMcpEnabled(hub: McpEnabledTarget, value: boolean): Promise<void> {
	const last = lastChange.get(hub)
	if (last && !last.settled && last.value === value) return last.promise

	const waitFor = last && !last.settled ? last.promise.catch(() => undefined) : Promise.resolve()
	const change: Change = { value, settled: false, promise: Promise.resolve() }
	change.promise = waitFor
		.then(() => hub.handleMcpEnabledChange(value))
		.finally(() => {
			change.settled = true
			if (lastChange.get(hub) === change) lastChange.delete(hub)
		})
	// Whoever waits for it sees its failure; a caller that gave up waiting leaves no rejection unhandled.
	change.promise.catch(() => undefined)
	lastChange.set(hub, change)
	return change.promise
}
