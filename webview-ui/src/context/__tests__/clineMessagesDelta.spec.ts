import type { ClineMessage, ClineMessagesDelta } from "@roo-code/types"
import { applyClineMessagesDelta } from "../clineMessagesDelta"

const first: ClineMessage = { ts: 1, type: "say", say: "text", text: "one" }
const second: ClineMessage = { ts: 2, type: "say", say: "text", text: "two" }
const state = { currentTaskId: "task", clineMessagesSeq: 1, clineMessages: [first] }
const delta: ClineMessagesDelta = {
	taskId: "task",
	baseSeq: 1,
	baseLength: 1,
	length: 2,
	updates: [{ index: 1, message: second }],
}

describe("transcript delta application", () => {
	it("appends and updates without mutating the previous state", () => {
		expect(applyClineMessagesDelta(state, delta)).toEqual([first, second])
		expect(state.clineMessages).toEqual([first])
		const edited = { ...first, text: "edited" }
		expect(
			applyClineMessagesDelta(state, { ...delta, updates: [{ index: 0, message: edited }, ...delta.updates] }),
		).toEqual([edited, second])
	})

	it.each([
		{ taskId: "background" },
		{ baseSeq: 0 },
		{ baseSeq: 2 },
		{ baseLength: 2 },
		{ length: 0 },
		{ updates: [] },
		{ updates: [{ index: 3, message: second }] },
		{ updates: [delta.updates[0], delta.updates[0]] },
	])("requests recovery for a mismatched or incomplete patch: %j", (override) => {
		expect(applyClineMessagesDelta(state, { ...delta, ...override })).toBeUndefined()
	})

	it("preserves the array reference when nothing changed", () => {
		expect(applyClineMessagesDelta(state, { ...delta, length: 1, updates: [] })).toBe(state.clineMessages)
	})
})
