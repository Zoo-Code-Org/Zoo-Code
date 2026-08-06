import {
	stopAtStopTokens,
	filterHallucinatedPathLine,
	stopAtSuffixRepetition,
	stopAtSimilarLine,
	stopAtReasoningBlock,
	stopAtProseLine,
	stopAtLines,
	stopAtRepetitionLoop,
	DEFAULT_TRANSFORMS,
	type TransformContext,
} from "../stream/transforms"
import { StreamPostProcessor } from "../stream/StreamPostProcessor"

const ctx = (overrides: Partial<TransformContext> = {}): TransformContext => ({
	prefix: "",
	suffix: "",
	stopSequences: [],
	maxLines: 256,
	...overrides,
})

async function drain(gen: AsyncGenerator<string>): Promise<string> {
	let result = ""
	for await (const chunk of gen) {
		result += chunk
	}
	return result
}

async function* fromChunks(chunks: string[]): AsyncGenerator<string, void, undefined> {
	for (const chunk of chunks) {
		yield chunk
	}
}

describe("stopAtStopTokens", () => {
	it("truncates at a stop token in the chunk", () => {
		expect(stopAtStopTokens.onChunk("", "hello<EOD>world", ctx({ stopSequences: ["<EOD>"] }))).toBe("hello")
	})

	it("returns the chunk unchanged when no stop token is present", () => {
		expect(stopAtStopTokens.onChunk("", "hello world", ctx({ stopSequences: ["<EOD>"] }))).toBe("hello world")
	})

	it("handles a stop token straddling the accumulated/chunk boundary", () => {
		// Accumulated has "hello<EO", chunk has "D>world". The stop token "<EOD>"
		// straddles: it starts in accumulated and ends in chunk. The transform
		// truncates at the stop token boundary — accumulated is kept, chunk is consumed.
		const result = stopAtStopTokens.onChunk("hello<EO", "D>world", ctx({ stopSequences: ["<EOD>"] }))
		// The stop token consumed the chunk; nothing new to emit (the partial in accumulated is already emitted).
		// The transform returns null or empty to signal stop.
		expect(result === null || result === "").toBe(true)
	})

	it("passes through when no stop sequences are configured", () => {
		expect(stopAtStopTokens.onChunk("", "hello", ctx({ stopSequences: [] }))).toBe("hello")
	})
})

describe("filterHallucinatedPathLine", () => {
	it("drops a 'Path:' hallucination line and stops", () => {
		expect(filterHallucinatedPathLine.onChunk("", "Path: src/foo.ts\nbar", ctx())).toBe("")
	})

	it("drops a 'diff --git' hallucination", () => {
		expect(filterHallucinatedPathLine.onChunk("", "diff --git a/foo b/foo\nbar", ctx())).toBe("")
	})

	it("passes through normal code", () => {
		expect(filterHallucinatedPathLine.onChunk("", "const x = 1", ctx())).toBe("const x = 1")
	})

	it("keeps output before the hallucination", () => {
		// Accumulated already has the good text; the chunk contains the hallucination.
		// The transform returns "" (nothing new to emit) and signals stop.
		const result = filterHallucinatedPathLine.onChunk("const x = 1\n", "Path: foo.ts\nbar", ctx())
		expect(result === null || result === "").toBe(true)
	})
})

describe("stopAtSuffixRepetition", () => {
	it("stops when the output begins repeating the suffix", () => {
		const suffix = ") { return a + b }"
		expect(stopAtSuffixRepetition.onChunk(") { return a", "", ctx({ suffix }))).toBe("")
	})

	it("does not stop for a short overlap below the threshold", () => {
		expect(stopAtSuffixRepetition.onChunk("hello", " world", ctx({ suffix: "world is a long suffix" }))).toBe(
			" world",
		)
	})

	it("passes through when there is no suffix", () => {
		expect(stopAtSuffixRepetition.onChunk("", "hello", ctx({ suffix: "" }))).toBe("hello")
	})
})

describe("stopAtSimilarLine", () => {
	it("stops when an output line matches a suffix line", () => {
		const prefix = "function add(a, b) {\n  return a + b\n}"
		const suffix = ""
		// Accumulated has "  return a + b" which matches a prefix line
		expect(stopAtSimilarLine.onChunk("  return a + b\n", "extra", ctx({ prefix, suffix }))).toBe("")
	})

	it("does not stop on the first line (not enough lines)", () => {
		expect(stopAtSimilarLine.onChunk("", "single line", ctx({ prefix: "different", suffix: "" }))).toBe(
			"single line",
		)
	})

	it("passes through lines not matching surrounding text", () => {
		const prefix = "function foo() {}"
		expect(stopAtSimilarLine.onChunk("const x = 1\n", "const y = 2\n", ctx({ prefix, suffix: "" }))).toBe(
			"const y = 2\n",
		)
	})
})

describe("StreamPostProcessor composed pipeline", () => {
	const processor = new StreamPostProcessor(DEFAULT_TRANSFORMS)

	it("stops at a stop token through the full pipeline", async () => {
		const result = await drain(
			processor.process(fromChunks(["hello", "<EOD>world"]), ctx({ stopSequences: ["<EOD>"] })),
		)
		expect(result).toBe("hello")
	})

	it("drops a hallucinated path line", async () => {
		const result = await drain(processor.process(fromChunks(["const x = 1\n", "Path: src/foo.ts\nbar"]), ctx()))
		expect(result).toBe("const x = 1\n")
	})

	it("stops at suffix repetition through the pipeline", async () => {
		const suffix = "  return a + b\n}"
		const result = await drain(processor.process(fromChunks(["  return a", " + b\n}"]), ctx({ suffix })))
		// The output starts repeating the suffix; the overlap is trimmed
		expect(result).not.toContain("}")
	})

	it("passes through normal code", async () => {
		const result = await drain(processor.process(fromChunks(["const x = 1\n", "const y = 2\n"]), ctx()))
		expect(result).toBe("const x = 1\nconst y = 2\n")
	})
})
describe("stopAtReasoningBlock", () => {
	const ctx = { prefix: "", suffix: "", stopSequences: [] as string[], maxLines: 100 }

	it("cuts at a <think> opener arriving mid-chunk", () => {
		// The exact failure seen with lfm2.5-2.6b: the tag is not on a token
		// boundary, so stop sequences never fire.
		expect(stopAtReasoningBlock.onChunk("", "return a + b\n<think>Now I should", ctx)).toBe("return a + b\n")
	})

	it("cuts at a markdown fence", () => {
		expect(stopAtReasoningBlock.onChunk("", "x = 1\n```\n", ctx)).toBe("x = 1\n")
	})

	it("cuts at an explanatory opener", () => {
		expect(stopAtReasoningBlock.onChunk("", "foo()\nThis code calculates the primes", ctx)).toBe("foo()\n")
	})

	it("emits nothing once the opener is already in the accumulated text", () => {
		expect(stopAtReasoningBlock.onChunk("done<think>", " more", ctx)).toBe("")
	})

	it("passes clean code through untouched", () => {
		expect(stopAtReasoningBlock.onChunk("", "const x = compute(a, b)", ctx)).toBe("const x = compute(a, b)")
	})
})

describe("stopAtProseLine", () => {
	const ctx = { prefix: "", suffix: "", stopSequences: [] as string[], maxLines: 100 }

	it("stops at a full sentence on its own line", () => {
		expect(stopAtProseLine.onChunk("", "x = 1\nThe function returns a value.\ny = 2\n", ctx)).toBe("x = 1")
	})

	it("does not treat code as prose", () => {
		const code = "for (const n of nums) {\n    if (isPrime(n)) result.push(n)\n}\n"

		expect(stopAtProseLine.onChunk("", code, ctx)).toBe(code)
	})

	it("does not treat comments as prose", () => {
		const code = "// Calculate whether it is prime.\nconst p = check(n)\n"

		expect(stopAtProseLine.onChunk("", code, ctx)).toBe(code)
	})

	it("never inspects the first line, which continues the cursor line", () => {
		expect(stopAtProseLine.onChunk("", "Some words that look like prose.\n", ctx)).toBe(
			"Some words that look like prose.\n",
		)
	})
})

describe("stopAtLines", () => {
	const ctx = { prefix: "", suffix: "", stopSequences: [] as string[], maxLines: 2 }

	it("caps the completion at maxLines", () => {
		expect(stopAtLines.onChunk("", "a\nb\nc\nd", ctx)).toBe("a\nb")
	})

	it("is disabled when maxLines is zero", () => {
		expect(stopAtLines.onChunk("", "a\nb\nc", { ...ctx, maxLines: 0 })).toBe("a\nb\nc")
	})
})

describe("stopAtRepetitionLoop", () => {
	const ctx = { prefix: "", suffix: "", stopSequences: [] as string[], maxLines: 100 }

	it("cuts a degenerate repeating run", () => {
		// Observed with a small model under greedy sampling: `1616161616...`.
		// No stop token appears and it is all one line, so nothing else ends it.
		const input = "x = 16161616161616161616161616"
		const out = stopAtRepetitionLoop.onChunk("", input, ctx)

		expect(out ?? "").not.toBe(input)
		expect((out ?? "").length).toBeLessThan(input.length)
	})

	it("leaves ordinary code alone", () => {
		const code = "for (const item of items) { total += item.value }"

		expect(stopAtRepetitionLoop.onChunk("", code, ctx)).toBe(code)
	})

	it("does not fire on short output", () => {
		expect(stopAtRepetitionLoop.onChunk("", "abab", ctx)).toBe("abab")
	})
})

describe("stopAtRepetitionLoop — phrase-level loops", () => {
	const c = { prefix: "", suffix: "", stopSequences: [] as string[], maxLines: 100 }

	it("cuts a repeated multi-character phrase", () => {
		// Reported: `"A" * primer_length` emitted three times in a row. The old
		// 6-character unit limit could not see a 19-character phrase.
		const looped = '"A" * primer_length'.repeat(3)
		const out = stopAtRepetitionLoop.onChunk("", looped, c)

		expect((out ?? "").length).toBeLessThan(looped.length)
	})

	it("still cuts a short digit run", () => {
		const looped = "12537".repeat(8)

		expect((stopAtRepetitionLoop.onChunk("", looped, c) ?? "").length).toBeLessThan(looped.length)
	})

	it("leaves ordinary repeated-but-distinct code alone", () => {
		const code = "self.a = a\n        self.b = b\n        self.c = c"

		expect(stopAtRepetitionLoop.onChunk("", code, c)).toBe(code)
	})
})
