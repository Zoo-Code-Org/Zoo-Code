// npx vitest core/mentions/__tests__/folderInlineBudget.spec.ts

import { assembleFolderInline, DEFAULT_FOLDER_INLINE_BUDGET, type FolderInlineFileInput } from "../folderInlineBudget"

/** Builds a readable file input whose extracted text has `count` lines. */
function readable(relPath: string, count: number, seed = "x"): FolderInlineFileInput {
	const lines = Array.from({ length: count }, (_, k) => `${seed}${k + 1}`)
	return {
		relPath,
		extracted: { content: `${lines.join("\n")}\n`, totalLines: count, returnedLines: count },
	}
}

/** Builds a readable file input from raw content, reporting what it renders as. */
function raw(relPath: string, content: string): FolderInlineFileInput {
	const lines = content.split("\n")
	if (lines[lines.length - 1] === "") {
		lines.pop()
	}
	return { relPath, extracted: { content, totalLines: lines.length, returnedLines: lines.length } }
}

/** A line-and-character budget that lets the line caps decide on their own. */
const LINE_ONLY_BUDGET = { perFileChars: 100_000, totalChars: 1_000_000 }

describe("assembleFolderInline - budget math", () => {
	it.each([
		{
			name: "caps one file at perFileLines",
			files: [readable("a.txt", 300)],
			budget: { perFileLines: 250, totalLines: 1000, ...LINE_ONLY_BUDGET },
			wantShown: [250],
			wantTotal: 250,
			wantSkipped: [],
			wantTruncated: [true],
		},
		{
			name: "stops at the total budget and skips the rest",
			files: [readable("a.txt", 100), readable("b.txt", 100), readable("c.txt", 100)],
			budget: { perFileLines: 250, totalLines: 150, ...LINE_ONLY_BUDGET },
			wantShown: [100, 50],
			wantTotal: 150,
			wantSkipped: [{ relPath: "c.txt", reason: "budget" }],
			wantTruncated: [false, true],
		},
		{
			name: "keeps a whole file when it fits the remaining budget",
			files: [readable("a.txt", 40), readable("b.txt", 60)],
			budget: { perFileLines: 250, totalLines: 150, ...LINE_ONLY_BUDGET },
			wantShown: [40, 60],
			wantTotal: 100,
			wantSkipped: [],
			wantTruncated: [false, false],
		},
		{
			name: "skips every file once the budget is spent",
			files: [readable("a.txt", 100), readable("b.txt", 100)],
			budget: { perFileLines: 250, totalLines: 100, ...LINE_ONLY_BUDGET },
			wantShown: [100],
			wantTotal: 100,
			wantSkipped: [{ relPath: "b.txt", reason: "budget" }],
			wantTruncated: [false],
		},
		{
			name: "zero budget skips every readable file",
			files: [readable("a.txt", 10), readable("b.txt", 10)],
			budget: { perFileLines: 250, totalLines: 0, ...LINE_ONLY_BUDGET },
			wantShown: [],
			wantTotal: 0,
			wantSkipped: [
				{ relPath: "a.txt", reason: "budget" },
				{ relPath: "b.txt", reason: "budget" },
			],
			wantTruncated: [],
		},
	])("budget ledger slices: $name", ({ files, budget, wantShown, wantTotal, wantSkipped, wantTruncated }) => {
		const result = assembleFolderInline(files, budget)

		expect(result.included.map((slice) => slice.shownLines)).toStrictEqual(wantShown)
		expect(result.totalShownLines).toBe(wantTotal)
		expect(result.skipped).toStrictEqual(wantSkipped)
		expect(result.included.map((slice) => slice.wasTruncated)).toStrictEqual(wantTruncated)
		expect(result.totalShownLines).toBeLessThanOrEqual(budget.totalLines)
	})
})

describe("assembleFolderInline - character budget", () => {
	it("caps a single oversized line by characters instead of letting it through", () => {
		// The PR 2680 round-4 finding: one notebook source line can carry
		// millions of characters and passes both line caps as a single line.
		const hugeLine = `${"H".repeat(50_000)}\ntail\n`
		const result = assembleFolderInline([raw("big.ipynb", hugeLine)], {
			perFileLines: 250,
			totalLines: 1000,
			perFileChars: 1000,
			totalChars: 100_000,
		})

		// No complete line fits the character cap, so the file is skipped as
		// budget instead of dumping the oversized line into the block.
		expect(result.included).toStrictEqual([])
		expect(result.skipped).toStrictEqual([{ relPath: "big.ipynb", reason: "budget" }])
		expect(result.totalShownLines).toBe(0)
	})

	it("keeps the complete lines that fit and reports the character cut", () => {
		const content = `first\n${"x".repeat(5000)}\nthird\n`
		const result = assembleFolderInline([raw("a.txt", content)], {
			perFileLines: 250,
			totalLines: 1000,
			perFileChars: 1000,
			totalChars: 100_000,
		})

		expect(result.included).toHaveLength(1)
		const slice = result.included[0]
		expect(slice.content).toBe("first\n")
		expect(slice.shownLines).toBe(1)
		expect(slice.content.length).toBeLessThanOrEqual(1000)
		expect(slice.wasTruncated).toBe(true)
	})

	it("stops a later file at the total character budget", () => {
		const files = [raw("big.txt", "head\nxxxx\n"), readable("small.txt", 10)]
		const result = assembleFolderInline(files, {
			perFileLines: 250,
			totalLines: 1000,
			perFileChars: 6,
			totalChars: 6,
		})

		// The first file's cut leaves one character of the total character
		// budget, which fits no complete line, so the second is skipped even
		// though line budget remains.
		expect(result.included.map((slice) => slice.relPath)).toStrictEqual(["big.txt"])
		expect(result.included[0].content).toBe("head\n")
		expect(result.skipped).toStrictEqual([{ relPath: "small.txt", reason: "budget" }])
	})

	it("charges only the bounded content against the budgets", () => {
		const files = [raw("cut.txt", `head\n${"x".repeat(5000)}\n`), readable("after.txt", 100)]
		const result = assembleFolderInline(files, {
			perFileLines: 250,
			totalLines: 1000,
			perFileChars: 1000,
			totalChars: 1100,
		})

		// The cut file contributes at most perFileChars, so the follow-up file
		// keeps room for the rest of the total character budget.
		expect(result.included.map((slice) => slice.relPath)).toStrictEqual(["cut.txt", "after.txt"])
		expect(result.included[0].content).toBe("head\n")
		expect(result.included[0].content.length).toBeLessThanOrEqual(1000)
		expect(result.included[0].wasTruncated).toBe(true)
		expect(result.included[1].shownLines).toBe(100)
	})
})

describe("assembleFolderInline - invariant properties", () => {
	it.each([
		{
			perFileLines: 250,
			totalLines: 1000,
			perFileChars: 100_000,
			totalChars: 1_000_000,
			counts: [5000, 1, 300, 0],
		},
		{ perFileLines: 10, totalLines: 25, perFileChars: 100_000, totalChars: 1_000_000, counts: [5000, 5000, 5000] },
		{ perFileLines: 3, totalLines: 7, perFileChars: 100_000, totalChars: 1_000_000, counts: [4, 4, 4, 4, 4] },
		{ perFileLines: 250, totalLines: 1000, perFileChars: 40, totalChars: 120, counts: [50, 50, 50] },
	])(
		"shown lines and characters never pass their budgets (perFile=$perFileLines total=$totalLines perFileChars=$perFileChars totalChars=$totalChars)",
		({ perFileLines, totalLines, perFileChars, totalChars, counts }) => {
			const files = counts.map((count, i) => readable(`${i}.txt`, count))
			const result = assembleFolderInline(files, { perFileLines, totalLines, perFileChars, totalChars })

			expect(result.totalShownLines).toBeLessThanOrEqual(totalLines)
			let totalCharsShown = 0
			result.included.forEach((slice, i) => {
				expect(slice.shownLines).toBeLessThanOrEqual(perFileLines)
				expect(slice.content.length).toBeLessThanOrEqual(perFileChars)
				// Every shown line is a line the file actually has.
				expect(slice.shownLines).toBeLessThanOrEqual(counts[i])
				totalCharsShown += slice.content.length
			})
			expect(totalCharsShown).toBeLessThanOrEqual(totalChars)
		},
	)

	it("caps extractable binary extractions (notebook-shaped, unbounded extractor output)", () => {
		// Binary-format extraction returns every extracted line with no cap;
		// the ledger's caps are what keeps a huge notebook bounded.
		const notebook = readable("data.ipynb", 5000)
		const result = assembleFolderInline([notebook])

		expect(result.included).toHaveLength(1)
		expect(result.included[0].shownLines).toBe(DEFAULT_FOLDER_INLINE_BUDGET.perFileLines)
		expect(result.included[0].content).not.toContain("x2501")
		expect(result.totalShownLines).toBe(DEFAULT_FOLDER_INLINE_BUDGET.perFileLines)
	})

	it("skips unreadable files with a reason and keeps the order", () => {
		const files: FolderInlineFileInput[] = [
			readable("a.txt", 20),
			{ relPath: "locked.txt", extracted: null },
			readable("c.txt", 20),
		]
		const result = assembleFolderInline(files, { perFileLines: 250, totalLines: 1000, ...LINE_ONLY_BUDGET })

		expect(result.included.map((slice) => slice.relPath)).toStrictEqual(["a.txt", "c.txt"])
		expect(result.skipped).toStrictEqual([{ relPath: "locked.txt", reason: "unreadable" }])
	})

	it("includes an empty extraction as an empty slice without spending budget", () => {
		const files: FolderInlineFileInput[] = [
			{ relPath: "empty.txt", extracted: { content: "", totalLines: 0, returnedLines: 0 } },
			readable("b.txt", 60),
		]
		const result = assembleFolderInline(files, { perFileLines: 250, totalLines: 100, ...LINE_ONLY_BUDGET })

		expect(result.included.map((slice) => slice.shownLines)).toStrictEqual([0, 60])
		expect(result.skipped).toStrictEqual([])
		expect(result.included[0].content).toBe("")
		expect(result.included[0].wasTruncated).toBe(false)
	})

	it("slices on rendered lines: the shown content holds exactly shownLines lines", () => {
		const result = assembleFolderInline([readable("a.txt", 300)], {
			perFileLines: 100,
			totalLines: 1000,
			...LINE_ONLY_BUDGET,
		})
		const slice = result.included[0]

		expect(slice.shownLines).toBe(100)
		expect(slice.content.split("\n")).toHaveLength(101) // 100 lines + trailing newline
		expect(slice.content).toContain("x100\n")
		expect(slice.content).not.toContain("x101")
	})

	it("is deterministic: the same input yields the same result", () => {
		const files = [readable("a.txt", 120), readable("b.txt", 30), readable("c.txt", 300)]
		const budget = { perFileLines: 100, totalLines: 200, ...LINE_ONLY_BUDGET }

		expect(assembleFolderInline(files, budget)).toStrictEqual(assembleFolderInline(files, budget))
	})

	it("preserves the input order of included and skipped files", () => {
		const files: FolderInlineFileInput[] = [
			readable("a.txt", 120),
			readable("b.txt", 300),
			readable("c.txt", 120),
			{ relPath: "d.err", extracted: null },
		]
		const result = assembleFolderInline(files, { perFileLines: 100, totalLines: 200, ...LINE_ONLY_BUDGET })

		expect(result.included.map((slice) => slice.relPath)).toStrictEqual(["a.txt", "b.txt"])
		expect(result.skipped).toStrictEqual([
			{ relPath: "c.txt", reason: "budget" },
			{ relPath: "d.err", reason: "unreadable" },
		])
	})
})
