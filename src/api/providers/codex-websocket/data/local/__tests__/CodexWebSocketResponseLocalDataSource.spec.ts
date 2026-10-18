import { CodexWebSocketResponseLocalDataSource } from "../CodexWebSocketResponseLocalDataSource"
import type { CachedCodexResponse } from "../../../models/CachedCodexResponse"

describe("CodexWebSocketResponseLocalDataSource", () => {
	const response = (): CachedCodexResponse => ({ id: "resp_1", settings: "settings-hash", input: [] })

	it("starts empty and retains the latest response snapshot", () => {
		const store = new CodexWebSocketResponseLocalDataSource()
		expect(store.read()).toBeUndefined()
		const cached = response()
		store.write(cached)
		expect(store.read()).toBe(cached)
		const next = { ...response(), id: "resp_2" }
		store.write(next)
		expect(store.read()).toBe(next)
	})

	it("clears cached state idempotently", () => {
		const store = new CodexWebSocketResponseLocalDataSource()
		store.write(response())
		store.clear()
		store.clear()
		expect(store.read()).toBeUndefined()
	})

	it("replaces a cached response with an absent response", () => {
		const store = new CodexWebSocketResponseLocalDataSource()
		store.write(response())
		store.write(undefined)
		expect(store.read()).toBeUndefined()
	})

	it("isolates state between task-local stores", () => {
		const first = new CodexWebSocketResponseLocalDataSource()
		const second = new CodexWebSocketResponseLocalDataSource()
		first.write(response())
		expect(second.read()).toBeUndefined()
		second.write({ ...response(), id: "resp_2" })
		first.clear()
		expect(second.read()?.id).toBe("resp_2")
	})
})
