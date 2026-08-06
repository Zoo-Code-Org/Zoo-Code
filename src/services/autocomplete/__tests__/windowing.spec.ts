import * as vscode from "vscode"

vi.mock("vscode", async () => {
	const actual = await vi.importActual<typeof import("vscode")>("vscode")
	return {
		...actual,
		InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
	}
})

import {
	windowPrefix,
	windowSuffix,
	windowDocument,
	normalizeLineEndings,
	PREFIX_MAX_LINES,
} from "../context/windowing"

function makeDocument(lines: string[], eol = "\n"): vscode.TextDocument {
	const text = lines.join(eol)
	const lineCount = lines.length

	return {
		getText: (range?: vscode.Range) => {
			if (!range) return text
			// Simplified: slice by line/character offsets
			const allLines = lines
			const startLine = range.start.line
			const endLine = range.end.line
			const result: string[] = []
			for (let i = startLine; i <= endLine; i++) {
				if (i >= allLines.length) break
				let line = allLines[i]
				if (i === startLine && startLine < endLine) {
					line = line.slice(range.start.character)
				} else if (i === endLine && endLine > startLine) {
					line = line.slice(0, range.end.character)
				} else if (i === startLine && startLine === endLine) {
					line = line.slice(range.start.character, range.end.character)
				}
				result.push(line)
			}
			return result.join(eol)
		},
		lineAt: (line: number | vscode.Position) => {
			const lineNum = typeof line === "number" ? line : line.line
			return {
				text: lines[Math.min(lineNum, lineCount - 1)] ?? "",
				range: new vscode.Range(lineNum, 0, lineNum, (lines[lineNum] ?? "").length),
				lineNumber: lineNum,
				rangeIncludingLineBreak: new vscode.Range(
					lineNum,
					0,
					lineNum,
					(lines[lineNum] ?? "").length + eol.length,
				),
				firstNonWhitespaceCharacterIndex: 0,
				isEmptyOrWhitespace: false,
			}
		},
		lineCount,
		uri: { fsPath: "/test.ts", toString: () => "file:///test.ts" },
	} as unknown as vscode.TextDocument
}

describe("normalizeLineEndings", () => {
	it("converts CRLF to LF", () => {
		expect(normalizeLineEndings("a\r\nb\r\n")).toBe("a\nb\n")
	})

	it("converts lone CR to LF", () => {
		expect(normalizeLineEndings("a\rb\r")).toBe("a\nb\n")
	})

	it("leaves LF unchanged", () => {
		expect(normalizeLineEndings("a\nb\n")).toBe("a\nb\n")
	})
})

describe("windowPrefix", () => {
	it("returns text before the cursor on the same line", () => {
		const doc = makeDocument(["function add(", "  return a + b", ")"])
		const pos = new vscode.Position(1, 10)
		expect(windowPrefix(doc, pos, 1000)).toContain("return a")
	})

	it("normalises CRLF to LF", () => {
		const doc = makeDocument(["line1", "line2", "line3"], "\r\n")
		const pos = new vscode.Position(2, 0)
		const result = windowPrefix(doc, pos, 1000)
		expect(result).not.toContain("\r")
		expect(result).toContain("line1\nline2\n")
	})

	it("handles BOF (cursor at start of file)", () => {
		const doc = makeDocument(["hello world"])
		const pos = new vscode.Position(0, 0)
		expect(windowPrefix(doc, pos, 1000)).toBe("")
	})

	it("caps at maxChars, keeping the tail near the cursor", () => {
		const doc = makeDocument(["abcdefghijklmnopqrstuvwxyz0123456789"])
		const pos = new vscode.Position(0, 36)
		const result = windowPrefix(doc, pos, 10)
		expect(result.length).toBeLessThanOrEqual(10)
		expect(result).toBe("0123456789")
	})

	it("caps at maxLines", () => {
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`)
		const doc = makeDocument(lines)
		const pos = new vscode.Position(499, 0)
		const result = windowPrefix(doc, pos, 100000)
		const resultLines = result.split("\n")
		expect(resultLines.length).toBeLessThanOrEqual(PREFIX_MAX_LINES)
	})
})

describe("windowSuffix", () => {
	it("returns text after the cursor on the same line", () => {
		const doc = makeDocument(["function add(", "  return a + b", ")"])
		const pos = new vscode.Position(1, 8)
		const result = windowSuffix(doc, pos, 1000)
		expect(result).toContain(" + b")
	})

	it("handles EOF (cursor at end of file)", () => {
		const doc = makeDocument(["hello"])
		const pos = new vscode.Position(0, 5)
		expect(windowSuffix(doc, pos, 1000)).toBe("")
	})

	it("caps at maxChars, keeping the head near the cursor", () => {
		const doc = makeDocument(["abcdefghijklmnopqrstuvwxyz0123456789"])
		const pos = new vscode.Position(0, 0)
		const result = windowSuffix(doc, pos, 10)
		expect(result.length).toBeLessThanOrEqual(10)
		expect(result).toBe("abcdefghij")
	})
})

describe("windowDocument", () => {
	it("returns both prefix and suffix", () => {
		const doc = makeDocument(["function add(", "  return a + b", ")"])
		const pos = new vscode.Position(1, 10)
		const result = windowDocument(doc, pos, 1000, 1000)
		expect(result.prefix).toContain("return a")
		expect(result.suffix).toContain(" + b")
	})
})
