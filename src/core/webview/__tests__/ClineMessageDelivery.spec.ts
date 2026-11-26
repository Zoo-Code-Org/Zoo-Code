import type { ClineMessage } from "@roo-code/types"
import { ClineMessageDelivery } from "../ClineMessageDelivery"

const message = (ts: number, text = "hello"): ClineMessage => ({ ts, type: "say", say: "text", text })

describe("incremental transcript delivery", () => {
	it("keeps full file snapshots out of both initial delivery and later deltas", () => {
		const delivery = new ClineMessageDelivery()
		const originalContent = "large pre-edit file".repeat(10_000)
		const fileEdit = (ts: number): ClineMessage => ({
			ts,
			type: "ask",
			ask: "tool",
			text: JSON.stringify({ tool: "appliedDiff", path: "file.ts", originalContent }),
		})
		const messages = [fileEdit(1)]
		const first = delivery.prepare({ currentTaskId: "task", clineMessagesSeq: 1, clineMessages: messages })
		expect(JSON.stringify(first)).not.toContain(originalContent)
		messages.push(fileEdit(2))
		const second = delivery.prepare({ currentTaskId: "task", clineMessagesSeq: 2, clineMessages: messages })
		expect(second?.clineMessagesDelta?.updates).toHaveLength(1)
		expect(JSON.stringify(second)).not.toContain(originalContent)
		expect(JSON.parse(messages[1].text ?? "{}").originalContent).toBe(originalContent)
	})

	it("sends one appended message for a 10,000-message transcript", () => {
		const delivery = new ClineMessageDelivery()
		const messages = Array.from({ length: 10000 }, (_, index) => message(index, "x".repeat(2000)))
		const state = { currentTaskId: "task", clineMessagesSeq: 1, clineMessages: messages }
		expect(delivery.prepare(state)?.state?.clineMessages).toHaveLength(10000)
		const added = message(10000, "new")
		messages.push(added)
		const result = delivery.prepare({ ...state, clineMessagesSeq: 2 })
		expect(result?.state?.clineMessages).toBeUndefined()
		expect(result?.clineMessagesDelta).toEqual({
			taskId: "task",
			baseSeq: 1,
			baseLength: 10000,
			length: 10001,
			updates: [{ index: 10000, message: added }],
		})
		expect(JSON.stringify(result).length).toBeLessThan(500)
	})

	it("detects in-place edits and preserves the baseline after a stale async snapshot", () => {
		const delivery = new ClineMessageDelivery()
		const messages = [message(1), message(2)]
		const state = { currentTaskId: "task", clineMessagesSeq: 2, clineMessages: messages }
		delivery.prepare(state)
		expect(delivery.prepare({ ...state, clineMessagesSeq: 1, clineMessages: [] })).toBeUndefined()
		messages[0].text = "edited"
		const result = delivery.prepare({ ...state, clineMessagesSeq: 3 })
		expect(result?.clineMessagesDelta?.updates).toEqual([{ index: 0, message: messages[0] }])
		expect(result?.clineMessagesDelta?.baseSeq).toBe(2)
	})

	it("fully syncs on task switches, shrinking history and explicit recovery", () => {
		const delivery = new ClineMessageDelivery()
		const state = { currentTaskId: "a", clineMessagesSeq: 1, clineMessages: [message(1), message(2)] }
		delivery.prepare(state)
		expect(delivery.prepare({ ...state, currentTaskId: "b", clineMessagesSeq: 2 })?.state?.clineMessages).toEqual(
			state.clineMessages,
		)
		expect(
			delivery.prepare({ ...state, currentTaskId: "b", clineMessagesSeq: 3, clineMessages: [message(1)] })
				?.clineMessagesDelta,
		).toBeUndefined()
		expect(delivery.prepare({ ...state, clineMessagesSeq: 4 }, true)?.state?.clineMessages).toEqual(
			state.clineMessages,
		)
	})
})
