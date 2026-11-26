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

describe("assembleFolderInline - budget math", () => {
	it.each([
		{
			name: "caps one file at perFileLines",
			files: [readable("a.txt", 300)],
			budget: { perFileLines: 250, totalLines: 1000 },
			wantShown: [250],
			wantTotal: 250,
			wantSkipped: [],
			wantTruncated: [true],
		},
		{
			name: "stops at the total budget and skips the rest",
			files: [readable("a.txt", 100), readable("b.txt", 100), readable("c.txt", 100)],
			budget: { perFileLines: 250, totalLines: 150 },
			wantShown: [100, 50],
			wantTotal: 150,
			wantSkipped: [{ relPath: "c.txt", reason: "budget" }],
			wantTruncated: [false, true],
		},
		{
			name: "keeps a whole file when it fits the remaining budget",
			files: [readable("a.txt", 40), readable("b.txt", 60)],
			budget: { perFileLines: 250, totalLines: 150 },
			wantShown: [40, 60],
			wantTotal: 100,
			wantSkipped: [],
			wantTruncated: [false, false],
		},
		{
			name: "skips every file once the budget is spent",
			files: [readable("a.txt", 100), readable("b.txt", 100)],
			budget: { perFileLines: 250, totalLines: 100 },
			wantShown: [100],
			wantTotal: 100,
			wantSkipped: [{ relPath: "b.txt", reason: "budget" }],
			wantTruncated: [false],
		},
		{
			name: "zero budget skips every readable file",
			files: [readable("a.txt", 10), readable("b.txt", 10)],
			budget: { perFileLines: 250, totalLines: 0 },
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

describe("assembleFolderInline - invariant properties", () => {
	it.each([
		{ perFileLines: 250, totalLines: 1000, counts: [5000, 1, 300, 0] },
		{ perFileLines: 10, totalLines: 25, counts: [5000, 5000, 5000] },
		{ perFileLines: 3, totalLines: 7, counts: [4, 4, 4, 4, 4] },
	])(
		"shown lines never pass either budget (perFile=$perFileLines total=$totalLines counts=$counts)",
		({ perFileLines, totalLines, counts }) => {
			const files = counts.map((count, i) => readable(`${i}.txt`, count))
			const result = assembleFolderInline(files, { perFileLines, totalLines })

			expect(result.totalShownLines).toBeLessThanOrEqual(totalLines)
			for (const slice of result.included) {
				expect(slice.shownLines).toBeLessThanOrEqual(perFileLines)
			}
			// Every shown line is a line the file actually has.
			result.included.forEach((slice, i) => {
				expect(slice.shownLines).toBeLessThanOrEqual(counts[i])
			})
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
		const result = assembleFolderInline(files, { perFileLines: 250, totalLines: 1000 })

		expect(result.included.map((slice) => slice.relPath)).toStrictEqual(["a.txt", "c.txt"])
		expect(result.skipped).toStrictEqual([{ relPath: "locked.txt", reason: "unreadable" }])
	})

	it("includes an empty extraction as an empty slice without spending budget", () => {
		const files: FolderInlineFileInput[] = [
			{ relPath: "empty.txt", extracted: { content: "", totalLines: 0, returnedLines: 0 } },
			readable("b.txt", 60),
		]
		const result = assembleFolderInline(files, { perFileLines: 250, totalLines: 100 })

		expect(result.included.map((slice) => slice.shownLines)).toStrictEqual([0, 60])
		expect(result.skipped).toStrictEqual([])
		expect(result.included[0].content).toBe("")
		expect(result.included[0].wasTruncated).toBe(false)
	})

	it("slices on rendered lines: the shown content holds exactly shownLines lines", () => {
		const result = assembleFolderInline([readable("a.txt", 300)], { perFileLines: 100, totalLines: 1000 })
		const slice = result.included[0]

		expect(slice.shownLines).toBe(100)
		expect(slice.content.split("\n")).toHaveLength(101) // 100 lines + trailing newline
		expect(slice.content).toContain("x100\n")
		expect(slice.content).not.toContain("x101")
	})

	it("is deterministic: the same input yields the same result", () => {
		const files = [readable("a.txt", 120), readable("b.txt", 30), readable("c.txt", 300)]
		const budget = { perFileLines: 100, totalLines: 200 }

		expect(assembleFolderInline(files, budget)).toStrictEqual(assembleFolderInline(files, budget))
	})

	it("preserves the input order of included and skipped files", () => {
		const files: FolderInlineFileInput[] = [
			readable("a.txt", 120),
			readable("b.txt", 300),
			readable("c.txt", 120),
			{ relPath: "d.err", extracted: null },
		]
		const result = assembleFolderInline(files, { perFileLines: 100, totalLines: 200 })

		expect(result.included.map((slice) => slice.relPath)).toStrictEqual(["a.txt", "b.txt"])
		expect(result.skipped).toStrictEqual([
			{ relPath: "c.txt", reason: "budget" },
			{ relPath: "d.err", reason: "unreadable" },
		])
	})
})
