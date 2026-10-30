import { MultiSearchReplaceDiffStrategy } from "../multi-search-replace"

// Guards the POST-FAILURE "LIKELY CAUSE" hint for mistyped start-line markers.
// The heuristic must never act as an upfront rejection gate.
describe("MultiSearchReplaceDiffStrategy malformed start-line marker hint", () => {
	let strategy: MultiSearchReplaceDiffStrategy

	beforeEach(() => {
		strategy = new MultiSearchReplaceDiffStrategy()
	})

	const nonMatchingFile = ["alpha", "beta", "gamma", "delta", "epsilon"].join("\n")

	function buildDiff(searchBody: string, replaceBody: string): string {
		return `<<<<<<< SEARCH\n${searchBody}\n=======\n${replaceBody}\n>>>>>>> REPLACE`
	}

	function firstFailureError(result: Awaited<ReturnType<MultiSearchReplaceDiffStrategy["applyDiff"]>>): string {
		expect(result.success).toBe(false)
		const failures = result.failParts ?? []
		expect(failures.length).toBeGreaterThan(0)
		const failure = failures[0]
		if (failure.success || !failure.error) {
			throw new Error("Expected a failed block with error details")
		}
		return failure.error
	}

	it("adds LIKELY CAUSE when the first search line is a bare ':3' marker and the block fails", async () => {
		const diffContent = buildDiff(":3\nnot-in-the-file", "replacement")
		const result = await strategy.applyDiff(nonMatchingFile, diffContent)

		const errorText = firstFailureError(result)
		expect(errorText).toContain("LIKELY CAUSE")
		expect(errorText).toContain(":start_line:")
	})

	const markerVariants = ["start_line:3", ":start-line 3", ": start_line : 3", ":START_LINE:3", "Start_Line: 3"]

	it.each(markerVariants)("adds LIKELY CAUSE for the malformed marker variant %j", async (markerVariant) => {
		const diffContent = buildDiff(`${markerVariant}\nnot-in-the-file`, "replacement")
		const result = await strategy.applyDiff(nonMatchingFile, diffContent)

		expect(firstFailureError(result)).toContain("LIKELY CAUSE")
	})

	it.each([": 3", ":42", "startline:3", "start_line:42"])(
		"adds LIKELY CAUSE for the spacing, multi-digit or separator-less marker %j",
		async (markerVariant) => {
			const diffContent = buildDiff(`${markerVariant}\nnot-in-the-file`, "replacement")
			const result = await strategy.applyDiff(nonMatchingFile, diffContent)

			const errorText = firstFailureError(result)
			expect(errorText).toContain("first line of your search content looks like a malformed start-line marker")
			expect(errorText).not.toContain(markerVariant)
		},
	)

	it("skips the marker hint for an overlong whitespace-padded first line", async () => {
		const paddedLine = `startline${" ".repeat(40_000)}3`
		const diffContent = buildDiff(`${paddedLine}\nnot-in-the-file`, "replacement")

		const startedAt = performance.now()
		const errorText = firstFailureError(await strategy.applyDiff(nonMatchingFile, diffContent))

		expect(errorText).not.toContain("LIKELY CAUSE")
		expect(performance.now() - startedAt).toBeLessThan(2_000)
	})

	it.each([
		{ length: 64, hinted: true },
		{ length: 65, hinted: false },
	])("hints only while the first line fits the length guard ($length chars)", async ({ length, hinted }) => {
		const firstLine = `startline${" ".repeat(length - 10)}3`
		expect(firstLine).toHaveLength(length)
		const diffContent = buildDiff(`${firstLine}\nnot-in-the-file`, "replacement")
		const errorText = firstFailureError(await strategy.applyDiff(nonMatchingFile, diffContent))

		expect(errorText.includes("LIKELY CAUSE")).toBe(hinted)
	})

	it.each(["value:3", ":3 trailing", "x start_line:3"])(
		"omits LIKELY CAUSE when %j only contains a marker-like fragment",
		async (firstLine) => {
			const diffContent = buildDiff(`${firstLine}\nnot-in-the-file`, "replacement")
			const result = await strategy.applyDiff(nonMatchingFile, diffContent)

			expect(firstFailureError(result)).not.toContain("LIKELY CAUSE")
		},
	)

	it("does not claim a separator was swallowed when none follows the marker", async () => {
		const diffContent = buildDiff(":3\nnot-in-the-file", "replacement")
		const result = await strategy.applyDiff(nonMatchingFile, diffContent)

		const errorText = firstFailureError(result)
		expect(errorText).toContain(
			"looks like a malformed start-line marker and was therefore searched for as literal file text. The only recognized form",
		)
		expect(errorText).not.toContain("together with")
	})

	it("detects a swallowed separator even when it is indented", async () => {
		const diffContent = buildDiff("  :start_line:3\n  -------\nnot-in-the-file", "replacement")
		const result = await strategy.applyDiff(nonMatchingFile, diffContent)

		expect(firstFailureError(result)).toContain('together with the "-------" line after it')
	})

	it("reports the real similarity, threshold and distance for a near miss", async () => {
		const diffContent = buildDiff("alpha\nbetx", "replacement")
		const result = await strategy.applyDiff(nonMatchingFile, diffContent)

		const errorText = firstFailureError(result)
		const similarity = /\((\d+)% similar, needs 100%\)\n\nDebug Info:\n- Similarity Score: (\d+)%\n/.exec(errorText)
		expect(similarity).not.toBeNull()
		expect(Number(similarity?.[1])).toBeGreaterThan(50)
		expect(similarity?.[2]).toBe(similarity?.[1])
		expect(errorText).toMatch(/- Levenshtein Distance: [1-9]\d* characters\n/)
	})

	it("still applies cleanly when the file genuinely contains a ':3' line (hint is not a gate)", async () => {
		const fileWithMarkerLikeLine = ["alpha", ":3", "beta", "gamma"].join("\n")
		const diffContent = buildDiff(":3\nbeta", ":3\nBETA")

		const result = await strategy.applyDiff(fileWithMarkerLikeLine, diffContent)

		expect(result.success).toBe(true)
		if (!result.success) {
			throw new Error("Expected marker-like file content to match")
		}
		expect(result.content).toBe(["alpha", ":3", "BETA", "gamma"].join("\n"))
		expect(result.content).not.toContain("LIKELY CAUSE")
		expect(result.failParts ?? []).toHaveLength(0)
	})

	it("reports the parsed block count when repair splits an inline SEARCH marker", async () => {
		const original = ["alpha", "beta"].join("\n")
		const diffContent = "<<<<<<< SEARCH\nalpha\n=======\nALPHA x <<<<<<< SEARCH\nmissing\n>>>>>>> REPLACE"

		const result = await strategy.applyDiff(original, diffContent)

		expect(result.success).toBe(true)
		if (!result.success) {
			throw new Error("Expected the first repaired block to apply")
		}
		expect(result.content).toBe(["ALPHA x", "beta"].join("\n"))
		expect(result.blockCount).toBe(2)
		expect(result.failParts?.filter((part) => !part.success)).toHaveLength(1)
	})

	it("omits the hint for ordinary non-matching content but keeps the file-changed tip", async () => {
		const diffContent = buildDiff("completely unrelated content\nsecond line", "replacement")
		const result = await strategy.applyDiff(nonMatchingFile, diffContent)

		const errorText = firstFailureError(result)
		expect(errorText).not.toContain("LIKELY CAUSE")
		expect(errorText).toContain(
			"- Tried both standard and aggressive line number stripping\n" +
				"- Tip: Use the read_file tool to get the latest content of the file before attempting " +
				"to use the apply_diff tool again, as the file content may have changed\n" +
				"- Tip: The SEARCH block must contain complete, whole lines — partial-line (substring) matching is not supported. " +
				"If the target line is very long, copy the entire line into the SEARCH block",
		)
	})

	it("does not flag the correct ':start_line:3' marker form", async () => {
		const diffContent = `<<<<<<< SEARCH\n:start_line:3\n-------\nnot-in-the-file\n=======\nreplacement\n>>>>>>> REPLACE`
		const result = await strategy.applyDiff(nonMatchingFile, diffContent)

		expect(firstFailureError(result)).not.toContain("LIKELY CAUSE")
	})

	it("adds LIKELY CAUSE when a well-formed ':start_line:N' line goes unparsed and swallows its separator", async () => {
		// Indenting the marker makes the parser miss it, so both it and the "-------" become search text.
		const diffContent = buildDiff("  :start_line:3\n-------\nnot-in-the-file", "replacement")
		const result = await strategy.applyDiff(nonMatchingFile, diffContent)

		const errorText = firstFailureError(result)
		expect(errorText).toContain("LIKELY CAUSE")
		expect(errorText).toContain('together with the "-------" line after it')
	})
})
