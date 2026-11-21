// npx vitest src/integrations/editor/__tests__/EditorUtils.spec.ts

import type { Mock } from "vitest"
import * as vscode from "vscode"

import { EditorUtils } from "../EditorUtils"

import { makeUri } from "../../../test-utils/vscode"

// TextDocument double provides getText/lineAt mocks plus lineCount and uri.fsPath.
type MockTextDocument = vscode.TextDocument & {
	getText: Mock<(range: vscode.Range) => string>
	lineAt: Mock<(line: number) => Pick<vscode.TextLine, "text" | "lineNumber">>
}

// Use simple classes to simulate VSCode's Range and Position behavior.
vi.mock("vscode", () => {
	class MockPosition {
		constructor(
			public line: number,
			public character: number,
		) {}
	}
	class MockRange {
		start: MockPosition
		end: MockPosition
		constructor(start: MockPosition, end: MockPosition) {
			this.start = start
			this.end = end
		}
	}

	return {
		Range: MockRange,
		Position: MockPosition,
		workspace: {
			getWorkspaceFolder: vi.fn(),
		},
		window: { activeTextEditor: undefined },
		languages: {
			getDiagnostics: vi.fn(() => []),
		},
	}
})

describe("EditorUtils", () => {
	let mockDocument: MockTextDocument

	beforeEach(() => {
		mockDocument = {
			getText: vi.fn((_range: vscode.Range) => ""),
			lineAt: vi.fn(),
			lineCount: 10,
			uri: makeUri("/test/file.ts"),
		} as unknown as MockTextDocument
	})

	describe("getEffectiveRange", () => {
		it("should return selected text when available", () => {
			const mockRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 10))
			mockDocument.getText.mockReturnValue("selected text")

			const result = EditorUtils.getEffectiveRange(mockDocument, mockRange)

			expect(result).toEqual({
				range: mockRange,
				text: "selected text",
			})
		})

		it("should return null for empty line", () => {
			const mockRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 10))
			mockDocument.getText.mockReturnValue("")
			mockDocument.lineAt.mockReturnValue({ text: "", lineNumber: 0 })

			const result = EditorUtils.getEffectiveRange(mockDocument, mockRange)

			expect(result).toBeNull()
		})

		it("should expand empty selection to full lines", () => {
			// Simulate a caret (empty selection) on line 2 at character 5.
			const initialRange = new vscode.Range(new vscode.Position(2, 5), new vscode.Position(2, 5))
			// Return non-empty text for any line with text (lines 1, 2, and 3).
			mockDocument.lineAt.mockImplementation((line: number) => {
				return { text: `Line ${line} text`, lineNumber: line }
			})
			mockDocument.getText.mockImplementation((range) => {
				// If the range is exactly the empty initial selection, return an empty string.
				if (
					range.start.line === initialRange.start.line &&
					range.start.character === initialRange.start.character &&
					range.end.line === initialRange.end.line &&
					range.end.character === initialRange.end.character
				) {
					return ""
				}
				return "expanded text"
			})

			const result = EditorUtils.getEffectiveRange(mockDocument, initialRange)

			expect(result).not.toBeNull()
			// Expected effective range: from the beginning of line 1 to the end of line 3.
			expect(result?.range.start).toEqual({ line: 1, character: 0 })
			expect(result?.range.end).toEqual({ line: 3, character: 11 })
			expect(result?.text).toBe("expanded text")
		})
	})

	describe("hasIntersectingRange", () => {
		it("should return false for ranges that only touch boundaries", () => {
			// Range1: [0, 0) - [0, 10) and Range2: [0, 10) - [0, 20)
			const range1 = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 10))
			const range2 = new vscode.Range(new vscode.Position(0, 10), new vscode.Position(0, 20))
			expect(EditorUtils.hasIntersectingRange(range1, range2)).toBe(false)
		})

		it("should return true for overlapping ranges", () => {
			// Range1: [0, 0) - [0, 15) and Range2: [0, 10) - [0, 20)
			const range1 = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 15))
			const range2 = new vscode.Range(new vscode.Position(0, 10), new vscode.Position(0, 20))
			expect(EditorUtils.hasIntersectingRange(range1, range2)).toBe(true)
		})

		it("should return false for non-overlapping ranges", () => {
			// Range1: [0, 0) - [0, 10) and Range2: [1, 0) - [1, 5)
			const range1 = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 10))
			const range2 = new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 5))
			expect(EditorUtils.hasIntersectingRange(range1, range2)).toBe(false)
		})
	})

	describe("getFilePath", () => {
		it("should return relative path when in workspace", () => {
			vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
				uri: makeUri("/test"),
				name: "test",
				index: 0,
			})

			const result = EditorUtils.getFilePath(mockDocument)

			expect(result).toBe("file.ts")
		})

		it("should return absolute path when not in workspace", () => {
			vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined)

			const result = EditorUtils.getFilePath(mockDocument)

			expect(result).toBe("/test/file.ts")
		})
	})
})
