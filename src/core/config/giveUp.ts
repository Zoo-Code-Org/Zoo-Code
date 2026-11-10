/**
 * The ways for a caller to take back the work it has queued and that has not started (a store that waits for its turn,
 * a change of the MCP switch that waits behind another): when its wait times out, and when its provider is disposed.
 * Each caller has an `AbortController`, which is kept for its provider only while it is in use.
 */
const controllersByOwner = new WeakMap<object, Set<AbortController>>()

export function giveUpControllerFor(owner: object): { controller: AbortController; done: () => void } {
	let controllers = controllersByOwner.get(owner)
	if (!controllers) {
		controllers = new Set()
		controllersByOwner.set(owner, controllers)
	}
	const controller = new AbortController()
	const kept = controllers
	kept.add(controller)
	return { controller, done: () => kept.delete(controller) }
}

/** The provider is disposed: everything its callers have queued and that has not started is taken back. */
export function giveUpAllOf(owner: object): void {
	const controllers = controllersByOwner.get(owner)
	controllersByOwner.delete(owner)
	for (const controller of controllers ?? []) controller.abort(new Error("The provider was disposed"))
}
