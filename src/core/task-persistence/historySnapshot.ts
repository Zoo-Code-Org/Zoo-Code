import { types } from "node:util"

const nativeCloneRequired = Symbol("native history snapshot required")

function clonePlainHistory(value: unknown): unknown {
	const seen = new WeakMap<object, object>()
	const copy = (current: unknown): unknown => {
		if (typeof current === "function" || typeof current === "symbol") throw nativeCloneRequired
		if (current === null || typeof current !== "object") return current
		if (types.isProxy(current)) throw nativeCloneRequired
		const previous = seen.get(current)
		if (previous !== undefined) return previous

		const prototype: unknown = Object.getPrototypeOf(current)
		if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) throw nativeCloneRequired
		const snapshot: object = Array.isArray(current)
			? new Array<unknown>(current.length)
			: prototype === null
				? Object.create(null)
				: {}
		seen.set(current, snapshot)
		for (const key of Object.keys(current)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key)
			// Native cloning handles accessors once, rather than evaluating them in
			// this pass and evaluating them again if a later property needs fallback.
			if (!descriptor || !("value" in descriptor)) throw nativeCloneRequired
			Object.defineProperty(snapshot, key, {
				value: copy(descriptor.value),
				enumerable: true,
				configurable: true,
				writable: true,
			})
		}
		return snapshot
	}
	return copy(value)
}

/** Isolate JSON history's mutable containers without copying immutable string payloads. */
export function snapshotHistory<T>(value: T): T {
	try {
		// Every supported container is rebuilt, preserving the input's graph/type.
		return clonePlainHistory(value) as T
	} catch (error) {
		if (error !== nativeCloneRequired) throw error
		// Clone the WHOLE graph for non-JSON legacy/provider data. Cloning special
		// objects separately would break aliases/cycles crossing Maps, Sets or views.
		// The plain-clone frame has unwound, releasing its partial snapshot first.
		return structuredClone(value)
	}
}
