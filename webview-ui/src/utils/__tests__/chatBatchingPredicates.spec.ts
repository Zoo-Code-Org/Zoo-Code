import { isBoundary, isIgnorableBetweenTargets } from "../chatBatchingPredicates"
import { batchNearby } from "../batchNearby"

interface TestItem {
	ts: number
	type: string
	text: string
	say?: string
}

const sayToolRow = (text: string): TestItem => ({
	ts: Date.now(),
	type: "say",
	say: "tool",
	text,
})

describe("chatBatchingPredicates - parallelSubtasks", () => {
	it("treats the parallelSubtasks panel row as a boundary", () => {
		expect(isBoundary({ type: "say", say: "tool", text: '{"tool":"parallelSubtasks","subtasks":[]}' })).toBe(true)
	})

	it("does not treat other say tool rows as boundaries", () => {
		expect(isBoundary({ type: "say", say: "tool", text: '{"tool":"runSlashCommand","command":"test"}' })).toBe(
			false,
		)
	})

	it("does not treat a row that merely contains the literal as a boundary (F-12)", () => {
		expect(
			isBoundary({
				type: "say",
				say: "tool",
				text: '{"tool":"runSlashCommand","command":"grep parallelSubtasks src"}',
			}),
		).toBe(false)
	})

	it("does not treat a malformed row that contains the literal as a boundary", () => {
		expect(isBoundary({ type: "say", say: "tool", text: '{"tool":"parallelSubtasks",' })).toBe(false)
	})

	it("keeps rows of other say types non-boundary even when they contain the literal (F-12)", () => {
		expect(isBoundary({ type: "say", say: "command_output", text: "log: parallelSubtasks launched" })).toBe(false)
		expect(isBoundary({ type: "ask", text: '{"tool":"parallelSubtasks"}' })).toBe(false)
	})

	it("does not treat a parallelSubtasks say row as ignorable between targets", () => {
		const batchContext: TestItem = { ts: 1, type: "say", say: "tool", text: "{}" }
		expect(
			isIgnorableBetweenTargets({ type: "say", say: "tool", text: '{"tool":"parallelSubtasks"}' }, batchContext),
		).toBe(false)
	})

	it("keeps non-say messages non-boundary", () => {
		expect(isBoundary({ type: "ask", say: "parallelSubtasks" })).toBe(false)
	})

	it("preserves boundary behavior for every pre-existing say type", () => {
		expect(isBoundary({ type: "say", say: "user_feedback" })).toBe(true)
		expect(isBoundary({ type: "say", say: "user_feedback_diff" })).toBe(true)
		expect(isBoundary({ type: "say", say: "text", text: "visible" })).toBe(true)
		expect(isBoundary({ type: "say", say: "completion_result" })).toBe(true)
		expect(isBoundary({ type: "say", say: "checkpoint_saved" })).toBe(true)
		expect(isBoundary({ type: "say", say: "error" })).toBe(true)
		expect(isBoundary({ type: "say", say: "condense_context" })).toBe(true)
		expect(isBoundary({ type: "say", say: "codebase_search_result" })).toBe(true)
	})

	it("preserves non-boundary behavior for pre-existing say types", () => {
		expect(isBoundary({ type: "say", say: "text", text: "" })).toBe(false)
		expect(isBoundary({ type: "say", say: "api_req_started" })).toBe(false)
		expect(isBoundary({ type: "say", say: "reasoning" })).toBe(false)
		expect(isBoundary({ type: "say", say: "command_output" })).toBe(false)
	})

	it("preserves ignorable behavior for pre-existing say types", () => {
		expect(isIgnorableBetweenTargets({ type: "say", say: "api_req_started" })).toBe(true)
		expect(isIgnorableBetweenTargets({ type: "say", say: "reasoning" })).toBe(true)
		expect(isIgnorableBetweenTargets({ type: "say", say: "text", text: "" })).toBe(true)
		expect(isIgnorableBetweenTargets({ type: "say", say: "error" })).toBe(false)
	})
})

describe("batchNearby - parallelSubtasks panel row", () => {
	// Mirrors ChatView's isReadFileAsk: targets are tool *asks* only, so the
	// panel row (a say message) is never a batch target itself.
	const isToolAsk = (m: TestItem) => m.type === "ask" && !!m.text?.startsWith("{")
	const synthesizeBatch = (batch: TestItem[]): TestItem => ({
		...batch[0],
		text: `BATCH:${batch.map((m) => m.text).join(",")}`,
	})
	const options = {
		isTarget: isToolAsk,
		isIgnorableBetweenTargets,
		isBoundary,
		synthesize: synthesizeBatch,
	}

	it("splits adjacent tool asks around the panel row instead of merging them", () => {
		const panelRow = sayToolRow(JSON.stringify({ tool: "parallelSubtasks", subtasks: [] }))
		const messages: TestItem[] = [
			{ ts: 1, type: "ask", text: '{"tool":"readFile"}' },
			panelRow,
			{ ts: 3, type: "ask", text: '{"tool":"editFile"}' },
		]
		const result = batchNearby(messages, options)
		expect(result).toEqual(messages)
	})
})
