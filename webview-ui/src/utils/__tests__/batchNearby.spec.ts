import { batchNearby } from "../batchNearby"

interface TestItem {
	ts: number
	type: string
	text: string
	say?: string
}

/** Helper: create a minimal test item with an identifiable text field. */
function msg(text: string, type = "say", say?: string): TestItem {
	return { ts: Date.now(), type, text, say }
}

/** Predicate: matches items whose text starts with "match". */
const isMatch = (m: TestItem) => !!m.text?.startsWith("match")

/** Predicate for realistic qwen tests: matches JSON tool calls. */
const isToolCall = (m: TestItem) => !!m.text?.startsWith("{")

/** Ignorable: api_req_started/finished, empty text, reasoning. */
const isIgnorableBetweenTargets = (m: TestItem): boolean => {
	if (m.type !== "say") return false
	return (
		m.say === "api_req_started" ||
		m.say === "api_req_finished" ||
		(m.say === "text" && !m.text?.trim()) ||
		m.say === "reasoning"
	)
}

/** Boundary: user_feedback, visible text, completion_result, checkpoint_saved, error. */
const isBoundary = (m: TestItem): boolean => {
	if (m.type !== "say") return false
	return (
		m.say === "user_feedback" ||
		m.say === "user_feedback_diff" ||
		(m.say === "text" && !!m.text?.trim()) ||
		m.say === "completion_result" ||
		m.say === "checkpoint_saved" ||
		m.say === "error" ||
		m.say === "condense_context"
	)
}

/** Synthesize: merges a batch into a single item with a "BATCH:" marker. */
const synthesizeBatch = (batch: TestItem[]): TestItem => ({
	...batch[0],
	text: `BATCH:${batch.map((m) => m.text).join(",")}`,
})

describe("batchNearby", () => {
	test("empty input returns empty output", () => {
		expect(
			batchNearby([], { isTarget: isMatch, isIgnorableBetweenTargets, isBoundary, synthesize: synthesizeBatch }),
		).toEqual([])
	})

	test("no matches returns passthrough", () => {
		const messages = [msg("a"), msg("b"), msg("c")]
		const result = batchNearby(messages, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toEqual(messages)
	})

	test("single match is passed through without batching", () => {
		const messages = [msg("a"), msg("match-1", "ask"), msg("b")]
		const result = batchNearby(messages, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(3)
		expect(result[1].text).toBe("match-1")
	})

	test("two consecutive matches produce one synthetic message", () => {
		const messages = [msg("a"), msg("match-1", "ask"), msg("match-2", "ask"), msg("b")]
		const result = batchNearby(messages, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(3)
		expect(result[0].text).toBe("a")
		expect(result[1].text).toBe("BATCH:match-1,match-2")
		expect(result[2].text).toBe("b")
	})

	test("non-consecutive matches separated by ignorable messages ARE batched", () => {
		const messages = [msg("a"), msg("match-1", "ask"), msg("", "say", "api_req_started"), msg("match-2", "ask")]
		const result = batchNearby(messages, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(2)
		expect(result[0].text).toBe("a")
		expect(result[1].text).toBe("BATCH:match-1,match-2")
	})

	test("non-consecutive matches separated by empty text are batched", () => {
		const messages = [msg("match-1", "ask"), msg("", "say", "text"), msg("match-2", "ask")]
		const result = batchNearby(messages, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(1)
		expect(result[0].text).toBe("BATCH:match-1,match-2")
	})

	test("boundary message stops batching", () => {
		const messages = [msg("match-1", "ask"), msg("visible text", "say", "text"), msg("match-2", "ask")]
		const result = batchNearby(messages, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(3)
		expect(result[0].text).toBe("match-1")
		expect(result[1].text).toBe("visible text")
		expect(result[2].text).toBe("match-2")
	})

	test("boundary message stops batching with ignorable before it", () => {
		const messages = [
			msg("match-1", "ask"),
			msg("", "say", "api_req_started"),
			msg("visible text", "say", "text"),
			msg("match-2", "ask"),
		]
		const result = batchNearby(messages, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(3)
		expect(result[0].text).toBe("match-1")
		expect(result[1].text).toBe("visible text")
		expect(result[2].text).toBe("match-2")
	})

	test("multiple batches separated by boundaries", () => {
		const messages = [
			msg("match-1", "ask"),
			msg("", "say", "api_req_started"),
			msg("match-2", "ask"),
			msg("visible text", "say", "text"),
			msg("match-3", "ask"),
			msg("", "say", "reasoning"),
			msg("match-4", "ask"),
		]
		const result = batchNearby(messages, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(3)
		expect(result[0].text).toBe("BATCH:match-1,match-2")
		expect(result[1].text).toBe("visible text")
		expect(result[2].text).toBe("BATCH:match-3,match-4")
	})

	test("user_feedback stops batching", () => {
		const messages = [
			msg("match-1", "ask"),
			msg("", "say", "api_req_started"),
			msg("match-2", "ask"),
			msg("feedback", "say", "user_feedback"),
		]
		const result = batchNearby(messages, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(2) // api_req_started ignorable → skipped; [BATCH:match-1,match-2, "feedback"]
		expect(result[0].text).toBe("BATCH:match-1,match-2")
		expect(result[1].text).toBe("feedback")
	})

	test("error stops batching", () => {
		const messages = [
			msg("match-1", "ask"),
			msg("", "say", "api_req_started"),
			msg("match-2", "ask"),
			msg("err", "say", "error"),
		]
		const result = batchNearby(messages, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(2) // api_req_started ignorable → skipped; [BATCH:match-1,match-2, "err"]
		expect(result[0].text).toBe("BATCH:match-1,match-2")
		expect(result[1].text).toBe("err")
	})

	test("checkpoint_saved stops batching", () => {
		const messages = [
			msg("match-1", "ask"),
			msg("", "say", "api_req_started"),
			msg("match-2", "ask"),
			msg("ck", "say", "checkpoint_saved"),
		]
		const result = batchNearby(messages, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(2) // api_req_started ignorable → skipped; [BATCH:match-1,match-2, "ck"]
		expect(result[0].text).toBe("BATCH:match-1,match-2")
		expect(result[1].text).toBe("ck")
	})

	test("completion_result stops batching", () => {
		const messages = [
			msg("match-1", "ask"),
			msg("", "say", "api_req_started"),
			msg("match-2", "ask"),
			msg("done", "say", "completion_result"),
		]
		const result = batchNearby(messages, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(2) // api_req_started ignorable → skipped; [BATCH:match-1,match-2, "done"]
		expect(result[0].text).toBe("BATCH:match-1,match-2")
		expect(result[1].text).toBe("done")
	})

	test("non-ignorable non-target message stops batching", () => {
		const messages = [msg("match-1", "ask"), msg("command_output", "say", "command_output"), msg("match-2", "ask")]
		const result = batchNearby(messages, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(3)
		expect(result[0].text).toBe("match-1")
		expect(result[1].text).toBe("command_output")
		expect(result[2].text).toBe("match-2")
	})

	test("all items match → single synthetic message", () => {
		const items = [msg("match-1", "ask"), msg("match-2", "ask"), msg("match-3", "ask")]
		const result = batchNearby(items, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(1)
		expect(result[0].text).toBe("BATCH:match-1,match-2,match-3")
	})

	test("does not mutate the input array", () => {
		const items = [msg("match-1", "ask"), msg("match-2", "ask")]
		const original = [...items]
		batchNearby(items, { isTarget: isMatch, isIgnorableBetweenTargets, isBoundary, synthesize: synthesizeBatch })
		expect(items).toHaveLength(2)
		expect(items).toEqual(original)
	})

	test("returns a new array, not the same reference", () => {
		const items = [msg("a"), msg("b")]
		const result = batchNearby(items, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).not.toBe(items)
	})

	test("synthesize callback receives the correct batches", () => {
		const spy = vi.fn(synthesizeBatch)
		const items = [
			msg("match-1", "ask"),
			msg("", "say", "api_req_started"),
			msg("match-2", "ask"),
			msg("other"),
			msg("match-3", "ask"),
			msg("", "say", "reasoning"),
			msg("match-4", "ask"),
		]
		batchNearby(items, { isTarget: isMatch, isIgnorableBetweenTargets, isBoundary, synthesize: spy })
		expect(spy).toHaveBeenCalledTimes(2)
		expect(spy.mock.calls[0][0]).toHaveLength(2)
		expect(spy.mock.calls[1][0]).toHaveLength(2)
	})

	test("batch at the end of the array", () => {
		const items = [msg("other"), msg("match-1", "ask"), msg("", "say", "api_req_started"), msg("match-2", "ask")]
		const result = batchNearby(items, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(2)
		expect(result[0].text).toBe("other")
		expect(result[1].text).toBe("BATCH:match-1,match-2")
	})

	test("batch at the beginning of the array", () => {
		const items = [msg("match-1", "ask"), msg("", "say", "api_req_finished"), msg("match-2", "ask"), msg("other")]
		const result = batchNearby(items, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(2)
		expect(result[0].text).toBe("BATCH:match-1,match-2")
		expect(result[1].text).toBe("other")
	})

	test("multiple ignorable messages between targets", () => {
		const items = [
			msg("match-1", "ask"),
			msg("", "say", "api_req_started"),
			msg("", "say", "reasoning"),
			msg("", "say", "api_req_finished"),
			msg("match-2", "ask"),
		]
		const result = batchNearby(items, {
			isTarget: isMatch,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(1)
		expect(result[0].text).toBe("BATCH:match-1,match-2")
	})

	test("realistic qwen scenario: tool calls with api_req rows between them", () => {
		const messages = [
			msg('{"tool":"readFile","path":"a.ts"}', "ask"),
			msg("", "say", "api_req_started"),
			msg("", "say", "text"), // empty streaming row
			msg('{"tool":"readFile","path":"b.ts"}', "ask"),
			msg("", "say", "api_req_finished"),
			msg('{"tool":"editFile","path":"c.ts"}', "ask"),
		]
		const result = batchNearby(messages, {
			isTarget: isToolCall,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(1) // all JSON tool calls batched together (no boundary between them)
		expect(result[0].text).toBe(
			'BATCH:{"tool":"readFile","path":"a.ts"},{"tool":"readFile","path":"b.ts"},{"tool":"editFile","path":"c.ts"}',
		)
	})

	test("realistic qwen scenario: two turns separated by user feedback", () => {
		const messages = [
			msg('{"tool":"readFile","path":"a.ts"}', "ask"),
			msg("", "say", "api_req_started"),
			msg('{"tool":"readFile","path":"b.ts"}', "ask"),
			msg("feedback", "say", "user_feedback"), // boundary
			msg('{"tool":"readFile","path":"c.ts"}', "ask"),
			msg("", "say", "api_req_started"),
			msg('{"tool":"readFile","path":"d.ts"}', "ask"),
		]
		const result = batchNearby(messages, {
			isTarget: isToolCall,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeBatch,
		})
		expect(result).toHaveLength(3) // [BATCH:a,b, "feedback", BATCH:c,d] — api_req_started skipped as ignorable
		expect(result[0].text).toBe('BATCH:{"tool":"readFile","path":"a.ts"},{"tool":"readFile","path":"b.ts"}')
		expect(result[1].text).toBe("feedback")
		expect(result[2].text).toBe('BATCH:{"tool":"readFile","path":"c.ts"},{"tool":"readFile","path":"d.ts"}')
	})
})
