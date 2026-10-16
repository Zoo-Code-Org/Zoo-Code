import { CodexWebSocketItemSnapshotModel } from "../CodexWebSocketItemSnapshotModel"

describe("CodexWebSocketItemSnapshotModel", () => {
	const call = (args: unknown) => ({ type: "function_call", call_id: "call_1", name: "read_file", arguments: args })

	it("compares structured function arguments without requiring JSON strings", () => {
		const structured = CodexWebSocketItemSnapshotModel.create(call({ path: "file.ts", start: 1 }))
		const serialized = CodexWebSocketItemSnapshotModel.create(call('{"start":1,"path":"file.ts"}'))
		expect(structured.hash).toBe(serialized.hash)
		expect(structured.changedFields(serialized)).toEqual([])
	})

	it("preserves malformed function arguments for exact comparison", () => {
		const first = CodexWebSocketItemSnapshotModel.create(call("invalid JSON"))
		const same = CodexWebSocketItemSnapshotModel.create(call("invalid JSON"))
		const changed = CodexWebSocketItemSnapshotModel.create(call("different invalid JSON"))
		expect(first.hash).toBe(same.hash)
		expect(first.hash).not.toBe(changed.hash)
		expect(first.changedFields(changed)).toEqual(["arguments"])
	})
})
