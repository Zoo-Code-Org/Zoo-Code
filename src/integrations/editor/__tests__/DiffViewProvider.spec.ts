import { DiffViewProvider, DIFF_VIEW_URI_SCHEME, DIFF_VIEW_LABEL_CHANGES } from "../DiffViewProvider"
import * as vscode from "vscode"
import * as path from "path"
import delay from "delay"

// Mock delay
vi.mock("delay", () => ({
	default: vi.fn().mockResolvedValue(undefined),
}))

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn().mockResolvedValue("file content"),
	writeFile: vi.fn().mockResolvedValue(undefined),
	access: vi.fn().mockResolvedValue(undefined),
}))

// Mock utils
vi.mock("../../../utils/fs", () => ({
	createDirectoriesForFile: vi.fn().mockResolvedValue([]),
}))

// Mock path
vi.mock("path", () => ({
	resolve: vi.fn((cwd, relPath) => `${cwd}/${relPath}`),
	basename: vi.fn((path) => path.split("/").pop()),
}))

// Mock vscode
vi.mock("vscode", () => ({
	workspace: {
		applyEdit: vi.fn(),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		openTextDocument: vi.fn().mockResolvedValue({
			isDirty: false,
			save: vi.fn().mockResolvedValue(undefined),
		}),
		textDocuments: [],
		fs: {
			stat: vi.fn(),
		},
	},
	window: {
		createTextEditorDecorationType: vi.fn(),
		showTextDocument: vi.fn(),
		onDidChangeVisibleTextEditors: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextEditorSelection: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextEditorVisibleRanges: vi.fn(() => ({ dispose: vi.fn() })),
		tabGroups: {
			all: [],
			close: vi.fn(),
			activeTabGroup: { activeTab: undefined },
		},
		visibleTextEditors: [],
	},
	commands: {
		executeCommand: vi.fn(),
	},
	languages: {
		getDiagnostics: vi.fn(() => []),
	},
	DiagnosticSeverity: {
		Error: 0,
		Warning: 1,
		Information: 2,
		Hint: 3,
	},
	WorkspaceEdit: vi.fn().mockImplementation(function () {
		return {
			replace: vi.fn(),
			delete: vi.fn(),
		}
	}),
	ViewColumn: {
		Active: 1,
		Beside: 2,
		One: 1,
		Two: 2,
		Three: 3,
		Four: 4,
		Five: 5,
		Six: 6,
		Seven: 7,
		Eight: 8,
		Nine: 9,
	},
	// Use regular functions (not arrows) so these mocks can be invoked with `new`.
	// vitest v4 / tinyspy invokes the implementation as a constructor for `new mock()`,
	// and arrow functions throw "is not a constructor".
	Range: vi.fn().mockImplementation(function (startLine, startChar, endLine, endChar) {
		return {
			start: { line: startLine, character: startChar },
			end: { line: endLine, character: endChar },
		}
	}),
	Position: vi.fn().mockImplementation(function (line, character) {
		return { line, character }
	}),
	Selection: vi.fn().mockImplementation(function (anchor, active) {
		return { anchor, active }
	}),
	TextEditorRevealType: {
		Default: 0,
		InCenter: 2,
		InCenterIfOutsideViewport: 3,
		AtTop: 4,
	},
	TextEditorSelectionChangeKind: {
		Keyboard: 1,
		Mouse: 2,
		Command: 3,
	},
	TabInputText: class TabInputText {},
	TabInputTextDiff: class TabInputTextDiff {},
	Uri: {
		file: vi.fn((path) => ({ fsPath: path })),
		parse: vi.fn((uri) => ({ with: vi.fn(() => ({})) })),
	},
}))

// Mock DecorationController
vi.mock("../DecorationController", () => ({
	DecorationController: vi.fn().mockImplementation(function () {
		return {
			setActiveLine: vi.fn(),
			updateOverlayAfterLine: vi.fn(),
			addLines: vi.fn(),
			clear: vi.fn(),
		}
	}),
}))

describe("DiffViewProvider", () => {
	let diffViewProvider: DiffViewProvider
	const mockCwd = "/mock/cwd"
	let mockWorkspaceEdit: { replace: any; delete: any }
	let mockTask: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockWorkspaceEdit = {
			replace: vi.fn(),
			delete: vi.fn(),
		}
		vi.mocked(vscode.WorkspaceEdit).mockImplementation(function () {
			return mockWorkspaceEdit as any
		})

		// Create a mock Task instance
		mockTask = {
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						includeDiagnosticMessages: true,
						maxDiagnosticMessages: 50,
					}),
				}),
			},
		}

		diffViewProvider = new DiffViewProvider(mockCwd, mockTask)
		// Mock the necessary properties and methods
		;(diffViewProvider as any).relPath = "test.txt"
		;(diffViewProvider as any).activeDiffEditor = {
			document: {
				uri: { fsPath: `${mockCwd}/test.txt` },
				getText: vi.fn(),
				lineCount: 10,
			},
			selection: {
				active: { line: 0, character: 0 },
				anchor: { line: 0, character: 0 },
			},
			edit: vi.fn().mockResolvedValue(true),
			revealRange: vi.fn(),
		}
		;(diffViewProvider as any).activeLineController = { setActiveLine: vi.fn(), clear: vi.fn() }
		;(diffViewProvider as any).fadedOverlayController = {
			updateOverlayAfterLine: vi.fn(),
			addLines: vi.fn(),
			clear: vi.fn(),
		}
	})

	describe("update method", () => {
		it("should preserve empty last line when original content has one", async () => {
			;(diffViewProvider as any).originalContent = "Original content\n"
			await diffViewProvider.update("New content", true)

			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				"New content\n",
			)
		})

		it("should not add extra newline when accumulated content already ends with one", async () => {
			;(diffViewProvider as any).originalContent = "Original content\n"
			await diffViewProvider.update("New content\n", true)

			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				"New content\n",
			)
		})

		it("should not add newline when original content does not end with one", async () => {
			;(diffViewProvider as any).originalContent = "Original content"
			await diffViewProvider.update("New content", true)

			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(expect.anything(), expect.anything(), "New content")
		})
	})

	describe("open method", () => {
		it("should pre-open file as text document before executing diff command", async () => {
			// Setup
			const mockEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.md`, scheme: "file" },
					getText: vi.fn().mockReturnValue(""),
					lineCount: 0,
				},
				selection: {
					active: { line: 0, character: 0 },
					anchor: { line: 0, character: 0 },
				},
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			}

			// Track the order of calls
			const callOrder: string[] = []

			// Mock showTextDocument to track when it's called
			vi.mocked(vscode.window.showTextDocument).mockImplementation(async (uri, options) => {
				callOrder.push("showTextDocument")
				expect(options).toEqual({ preview: false, viewColumn: vscode.ViewColumn.Active, preserveFocus: true })
				return mockEditor as any
			})

			// Mock executeCommand to track when it's called
			vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
				callOrder.push("executeCommand")
				expect(command).toBe("vscode.diff")
				return undefined
			})

			// Mock workspace.onDidOpenTextDocument to trigger immediately
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				// Trigger the callback immediately with the document
				setTimeout(() => {
					callback({ uri: { fsPath: `${mockCwd}/test.md`, scheme: "file" } } as any)
				}, 0)
				return { dispose: vi.fn() }
			})

			// Mock window.visibleTextEditors to return our editor
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor as any]

			// Set up for file
			;(diffViewProvider as any).editType = "modify"

			// Execute open
			await diffViewProvider.open("test.md")

			// Verify that showTextDocument was called before executeCommand
			expect(callOrder).toEqual(["showTextDocument", "executeCommand"])

			// Verify that showTextDocument was called with preview: false and preserveFocus: true
			expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: `${mockCwd}/test.md` }),
				{ preview: false, viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
			)

			// Verify that the diff command was executed
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
				"vscode.diff",
				expect.any(Object),
				expect.any(Object),
				`test.md: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
				{ preserveFocus: true },
			)
		})

		it("should handle showTextDocument failure", async () => {
			// Mock showTextDocument to fail
			vi.mocked(vscode.window.showTextDocument).mockRejectedValue(new Error("Cannot open file"))

			// Mock workspace.onDidOpenTextDocument
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockReturnValue({ dispose: vi.fn() })

			// Mock window.onDidChangeVisibleTextEditors
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })

			// Set up for file
			;(diffViewProvider as any).editType = "modify"

			// Try to open and expect rejection
			await expect(diffViewProvider.open("test.md")).rejects.toThrow(
				"Failed to execute diff command for /mock/cwd/test.md: Cannot open file",
			)
		})

		it("records the pin state of an already-open pinned tab", async () => {
			const mockEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.md`, scheme: "file" },
					getText: vi.fn().mockReturnValue(""),
					lineCount: 0,
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			}

			// An open, pinned, non-dirty tab for the target file.
			const pinnedTab = {
				input: Object.assign(new (vscode as any).TabInputText(), {
					uri: { fsPath: `${mockCwd}/test.md`, scheme: "file" },
				}),
				isDirty: false,
				isPinned: true,
				label: "test.md",
			}
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [pinnedTab] }],
				configurable: true,
			})

			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => {
					callback({ uri: { fsPath: `${mockCwd}/test.md`, scheme: "file" } } as any)
				}, 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor as any]
			;(diffViewProvider as any).editType = "modify"

			await diffViewProvider.open("test.md")

			expect((diffViewProvider as any).documentWasPinned).toBe(true)
			expect((diffViewProvider as any).documentWasOpen).toBe(true)
		})
	})

	describe("scrollToFirstDiff method", () => {
		const setupEditor = (currentContent: string) => {
			const revealRange = vi.fn()
			// Mirror how VS Code reports lineCount: a trailing newline yields a final
			// empty line, so the count is the number of "\n"-delimited segments.
			const lineCount = currentContent === "" ? 0 : currentContent.split("\n").length
			const lines = currentContent.split("\n")
			const document = {
				uri: { fsPath: `${mockCwd}/mock-file-target.txt`, scheme: "file" },
				getText: vi.fn().mockReturnValue(currentContent),
				lineCount,
				lineAt: vi.fn().mockImplementation((line: number) => ({ text: lines[line] ?? "" })),
			}
			const editor = {
				document,
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				visibleRanges: [{ start: { line: 0 }, end: { line: 0 } }],
				revealRange,
			}
			;(diffViewProvider as any).activeDiffEditor = editor
			// Register the editor as the live modified-side editor so resolveLiveEditor
			// finds it by document identity, mirroring the runtime path.
			vi.mocked(vscode.window).visibleTextEditors = [editor as any]
			return revealRange
		}

		it("reveals the first changed line for an addition-only diff", () => {
			;(diffViewProvider as any).originalContent = "a\nb\nc\n"
			// Insert a new line between b and c (first change is at line index 2).
			const revealRange = setupEditor("a\nb\nNEW\nc\n")

			diffViewProvider.scrollToFirstDiff()

			expect(revealRange).toHaveBeenCalledTimes(1)
			const range = revealRange.mock.calls[0][0]
			expect(range.start.line).toBe(2)
		})

		it("reveals the first changed line for a deletion-only diff", () => {
			;(diffViewProvider as any).originalContent = "a\nb\nc\nd\n"
			// Remove line c; the first change is the removed block at line index 2.
			const revealRange = setupEditor("a\nb\nd\n")

			diffViewProvider.scrollToFirstDiff()

			expect(revealRange).toHaveBeenCalledTimes(1)
			const range = revealRange.mock.calls[0][0]
			expect(range.start.line).toBe(2)
		})

		it("clamps to the last line for a removal at the end of the file", () => {
			// Long file; remove the final lines. The first-change index lands past the
			// end of the shortened modified document, so it must be clamped to a real
			// line or the diff widget will not scroll.
			;(diffViewProvider as any).originalContent = "a\nb\nc\nd\ne\nf\n"
			const revealRange = setupEditor("a\nb\nc\n")

			diffViewProvider.scrollToFirstDiff()

			expect(revealRange).toHaveBeenCalledTimes(1)
			const range = revealRange.mock.calls[0][0]
			// Modified document has lines a,b,c (+ trailing empty) => lastLine index 3.
			// The removed block begins at index 3, which is within bounds here.
			expect(range.start.line).toBeLessThanOrEqual(3)
			expect(range.start.line).toBeGreaterThanOrEqual(0)
		})

		it("reveals the first changed line for a mixed diff", () => {
			;(diffViewProvider as any).originalContent = "a\nb\nc\nd\n"
			// Change line b (index 1) -- first divergence from the original.
			const revealRange = setupEditor("a\nCHANGED\nc\nd\n")

			diffViewProvider.scrollToFirstDiff()

			expect(revealRange).toHaveBeenCalledTimes(1)
			const range = revealRange.mock.calls[0][0]
			expect(range.start.line).toBe(1)
		})

		it("anchors the selection on the target line so an in-viewport diff still scrolls", () => {
			// Regression for the case where the file is already scrolled to the middle
			// and the diff target is inside the current viewport: a bare revealRange is
			// a no-op, leaving the viewport pinned at the top. Moving the selection to
			// the target first forces the diff widget to scroll to the change.
			;(diffViewProvider as any).originalContent = "a\nb\nc\nd\n"
			const revealRange = setupEditor("a\nCHANGED\nc\nd\n")

			diffViewProvider.scrollToFirstDiff()

			const editor = (diffViewProvider as any).activeDiffEditor
			expect(editor.selection.active.line).toBe(1)
			expect(editor.selection.anchor.line).toBe(1)
			expect(revealRange).toHaveBeenCalledTimes(1)
			expect(revealRange.mock.calls[0][0].start.line).toBe(1)
		})

		it("re-reveals the target line after layout settles", () => {
			// The diff editor can snap the viewport back to the top during its late
			// layout pass when the file was already scrolled. A deferred re-reveal
			// makes the scroll stick. Verify the second reveal fires on a timer.
			vi.useFakeTimers()
			try {
				;(diffViewProvider as any).originalContent = "a\nb\nc\nd\n"
				const revealRange = setupEditor("a\nCHANGED\nc\nd\n")

				diffViewProvider.scrollToFirstDiff()

				expect(revealRange).toHaveBeenCalledTimes(1)
				// Mock timer - no wall clock time elapses here
				vi.advanceTimersByTime(100)
				expect(revealRange).toHaveBeenCalledTimes(2)
				for (const call of revealRange.mock.calls) {
					expect(call[0].start.line).toBe(1)
				}
			} finally {
				vi.useRealTimers()
			}
		})

		it("reveals on the live modified-side editor, not a stale captured reference", () => {
			// Regression for "scrolls to top": the captured activeDiffEditor can be a
			// detached editor whose visibleRanges no longer match the on-screen diff,
			// making revealRange a no-op. The reveal must target the live editor found
			// in visibleTextEditors for the same document.
			;(diffViewProvider as any).originalContent = "a\nb\nc\nd\n"
			const staleReveal = setupEditor("a\nCHANGED\nc\nd\n")
			const staleEditor = (diffViewProvider as any).activeDiffEditor

			// A live editor for the SAME document, distinct from the stale capture.
			const liveReveal = vi.fn()
			const liveEditor = {
				document: staleEditor.document,
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				visibleRanges: [{ start: { line: 0 }, end: { line: 0 } }],
				revealRange: liveReveal,
			}
			vi.mocked(vscode.window).visibleTextEditors = [liveEditor as any]

			diffViewProvider.scrollToFirstDiff()

			expect(liveReveal).toHaveBeenCalledTimes(1)
			expect(staleReveal).not.toHaveBeenCalled()
			expect(liveReveal.mock.calls[0][0].start.line).toBe(1)
		})

		it("does not re-reveal a stale line on a diff editor opened by a later edit", () => {
			// Regression for the "stuck at line 0" bug: a deferred reveal must not act
			// after a subsequent edit swapped in a different active diff editor.
			vi.useFakeTimers()
			try {
				;(diffViewProvider as any).originalContent = "a\nb\nc\nd\n"
				const firstReveal = setupEditor("a\nCHANGED\nc\nd\n")
				const firstEditor = (diffViewProvider as any).activeDiffEditor

				diffViewProvider.scrollToFirstDiff()
				expect(firstReveal).toHaveBeenCalledTimes(1)

				// A later edit swaps in a brand new diff editor before the timer fires.
				const secondReveal = setupEditor("a\nb\nc\nd\n")
				expect((diffViewProvider as any).activeDiffEditor).not.toBe(firstEditor)

				vi.advanceTimersByTime(100)

				// The stale timer saw a different active editor and did nothing more.
				expect(firstReveal).toHaveBeenCalledTimes(1)
				expect(secondReveal).not.toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})

		it("does nothing when there is no diff editor", () => {
			;(diffViewProvider as any).activeDiffEditor = undefined
			expect(() => diffViewProvider.scrollToFirstDiff()).not.toThrow()
		})
	})

	describe("preview tab snapshot and restore", () => {
		const makePreviewTab = (fsPath: string, isPreview = true) => {
			const input = Object.assign(new (vscode as any).TabInputText(), {
				uri: { fsPath, scheme: "file" },
			})
			return { isPreview, input, label: fsPath }
		}

		const setTabs = (tabs: any[], viewColumn = vscode.ViewColumn.One) => {
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs, viewColumn }],
				configurable: true,
			})
		}

		it("captures unrelated preview tabs with their scroll position and group, excluding the diff target", () => {
			setTabs(
				[
					makePreviewTab("/mock/cwd/file-1.txt"),
					makePreviewTab("/mock/cwd/file-2.txt"), // diff target -- excluded
					makePreviewTab("/mock/cwd/file-3.txt", false), // not a preview -- excluded
				],
				vscode.ViewColumn.Two,
			)
			vi.mocked(vscode.window).visibleTextEditors = [
				{
					document: { uri: { fsPath: "/mock/cwd/file-1.txt", scheme: "file" } },
					visibleRanges: [{ start: { line: 12 } }],
				} as any,
			]

			const snapshot = (diffViewProvider as any).captureUnrelatedPreviewTabs("/mock/cwd/file-2.txt")

			expect(snapshot).toHaveLength(1)
			expect(snapshot[0].uri.fsPath).toBe("/mock/cwd/file-1.txt")
			expect(snapshot[0].scrollLine).toBe(12)
			expect(snapshot[0].viewColumn).toBe(vscode.ViewColumn.Two)
		})

		it("restores an evicted preview tab in its original group and reapplies its scroll position", async () => {
			const revealRange = vi.fn()
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange } as any)
			// The captured file is no longer open (evicted by the diff).
			setTabs([])
			;(diffViewProvider as any).snapshotPreviewTabs = [
				{
					uri: { fsPath: "/mock/cwd/file-1.txt", scheme: "file" },
					scrollLine: 12,
					viewColumn: vscode.ViewColumn.Two,
				},
			]

			await (diffViewProvider as any).restorePreviewTabs()

			expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
				{ fsPath: "/mock/cwd/file-1.txt", scheme: "file" },
				{ preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Two },
			)
			expect(revealRange).toHaveBeenCalledWith(
				expect.objectContaining({ start: { line: 12, character: 0 } }),
				vscode.TextEditorRevealType.AtTop,
			)
			expect((diffViewProvider as any).snapshotPreviewTabs).toEqual([])
		})

		it("does not restore a preview tab that is still open", async () => {
			setTabs([makePreviewTab("/mock/cwd/file-1.txt")])
			;(diffViewProvider as any).snapshotPreviewTabs = [
				{
					uri: { fsPath: "/mock/cwd/file-1.txt", scheme: "file" },
					scrollLine: 0,
					viewColumn: vscode.ViewColumn.One,
				},
			]

			await (diffViewProvider as any).restorePreviewTabs()

			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		})

		it("skips restoring a preview tab whose file no longer exists", async () => {
			setTabs([])
			const fs = await import("fs/promises")
			vi.mocked(fs.access).mockRejectedValueOnce(new Error("ENOENT"))
			;(diffViewProvider as any).snapshotPreviewTabs = [
				{
					uri: { fsPath: "/mock/cwd/deleted.txt", scheme: "file" },
					scrollLine: 0,
					viewColumn: vscode.ViewColumn.One,
				},
			]

			await (diffViewProvider as any).restorePreviewTabs()

			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
			expect((diffViewProvider as any).snapshotPreviewTabs).toEqual([])
		})
	})

	describe("showEditedFileWithoutDisruptingFocus", () => {
		it("re-activates the user's editor when they navigated to a different file", async () => {
			// User is viewing file-1 while the edited file is file-2. Keeping file-2
			// open must not yank focus/foreground onto it.
			const userActiveEditor = {
				document: { uri: { fsPath: "/mock/cwd/file-1.txt", scheme: "file" } },
				viewColumn: 1,
			}
			;(vscode.window as any).activeTextEditor = userActiveEditor
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange: vi.fn() } as any)
			;(diffViewProvider as any).preEditScrollLine = 5

			await (diffViewProvider as any).showEditedFileWithoutDisruptingFocus("/mock/cwd/file-2.txt")

			// First call re-shows the edited file (preserveFocus); last call restores
			// the user's editor with focus.
			const calls = vi.mocked(vscode.window.showTextDocument).mock.calls
			expect(calls[0][1]).toMatchObject({ preview: false, preserveFocus: true })
			const restoreCall = calls[calls.length - 1]
			expect(restoreCall[0]).toBe(userActiveEditor.document)
			expect(restoreCall[1]).toMatchObject({ viewColumn: 1, preserveFocus: false })
		})

		it("does not re-activate when the user is already on the edited file", async () => {
			const userActiveEditor = {
				document: { uri: { fsPath: "/mock/cwd/file-2.txt", scheme: "file" } },
				viewColumn: 1,
			}
			;(vscode.window as any).activeTextEditor = userActiveEditor
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange: vi.fn() } as any)

			await (diffViewProvider as any).showEditedFileWithoutDisruptingFocus("/mock/cwd/file-2.txt")

			// Only the single re-show of the edited file; no focus-restore round trip.
			expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1)
		})

		it("re-pins the edited file when it was pinned before the diff", async () => {
			const userActiveEditor = {
				document: { uri: { fsPath: "/mock/cwd/file-2.txt", scheme: "file" } },
				viewColumn: 1,
			}
			;(vscode.window as any).activeTextEditor = userActiveEditor
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange: vi.fn() } as any)
			;(diffViewProvider as any).documentWasPinned = true

			await (diffViewProvider as any).showEditedFileWithoutDisruptingFocus("/mock/cwd/file-2.txt")

			// The edited file must be focused (preserveFocus false) so pinEditor
			// targets the correct tab, then the pin command is issued.
			const calls = vi.mocked(vscode.window.showTextDocument).mock.calls
			expect(calls[0][1]).toMatchObject({ preview: false, preserveFocus: false })
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.pinEditor")
		})

		it("does not pin the edited file when it was not pinned before the diff", async () => {
			const userActiveEditor = {
				document: { uri: { fsPath: "/mock/cwd/file-2.txt", scheme: "file" } },
				viewColumn: 1,
			}
			;(vscode.window as any).activeTextEditor = userActiveEditor
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange: vi.fn() } as any)
			;(diffViewProvider as any).documentWasPinned = false

			await (diffViewProvider as any).showEditedFileWithoutDisruptingFocus("/mock/cwd/file-2.txt")

			expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.pinEditor")
		})
	})

	describe("closeAllDiffViews method", () => {
		it("should close diff views including those identified by label", async () => {
			// Mock tab groups with various types of tabs
			const mockTabs = [
				// Normal diff view
				{
					input: {
						constructor: { name: "TabInputTextDiff" },
						original: { scheme: DIFF_VIEW_URI_SCHEME },
						modified: { fsPath: "/test/file1.ts" },
					},
					label: `file1.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
					isDirty: false,
				},
				// Diff view identified by label (for pre-opened files)
				{
					input: {
						constructor: { name: "TabInputTextDiff" },
						original: { scheme: "file" }, // Different scheme due to pre-opening
						modified: { fsPath: "/test/file2.md" },
					},
					label: `file2.md: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
					isDirty: false,
				},
				// Regular file tab (should not be closed)
				{
					input: {
						constructor: { name: "TabInputText" },
						uri: { fsPath: "/test/file3.js" },
					},
					label: "file3.js",
					isDirty: false,
				},
				// Dirty diff view (should not be closed)
				{
					input: {
						constructor: { name: "TabInputTextDiff" },
						original: { scheme: DIFF_VIEW_URI_SCHEME },
						modified: { fsPath: "/test/file4.ts" },
					},
					label: `file4.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
					isDirty: true,
				},
			]

			// Make tabs appear as TabInputTextDiff instances
			mockTabs.forEach((tab) => {
				if (tab.input.constructor.name === "TabInputTextDiff") {
					Object.setPrototypeOf(tab.input, vscode.TabInputTextDiff.prototype)
				}
			})

			// Mock the tabGroups getter
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [
					{
						tabs: mockTabs as any,
					},
				],
				configurable: true,
			})

			const closedTabs: any[] = []
			vi.mocked(vscode.window.tabGroups.close).mockImplementation((tab) => {
				closedTabs.push(tab)
				return Promise.resolve(true)
			})

			// Execute closeAllDiffViews
			await (diffViewProvider as any).closeAllDiffViews()

			// Verify that only the appropriate tabs were closed
			expect(closedTabs).toHaveLength(2)
			expect(closedTabs[0].label).toBe(`file1.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`)
			expect(closedTabs[1].label).toBe(`file2.md: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`)

			// Verify that the regular file and dirty diff were not closed
			expect(closedTabs.find((t) => t.label === "file3.js")).toBeUndefined()
			expect(
				closedTabs.find((t) => t.label === `file4.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)` && t.isDirty),
			).toBeUndefined()
		})
	})

	describe("saveDirectly method", () => {
		beforeEach(() => {
			// Mock vscode functions
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
		})

		it("should write content directly to file without opening diff view", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			const result = await diffViewProvider.saveDirectly("test.ts", "new content", true, true, 2000)

			// Verify file was written
			const fs = await import("fs/promises")
			expect(fs.writeFile).toHaveBeenCalledWith(`${mockCwd}/test.ts`, "new content", "utf-8")

			// Verify file was opened without focus
			expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: `${mockCwd}/test.ts` }),
				{ preview: false, preserveFocus: true },
			)

			// Verify diagnostics were checked after delay
			expect(mockDelay).toHaveBeenCalledWith(2000)
			expect(vscode.languages.getDiagnostics).toHaveBeenCalled()

			// Verify result
			expect(result.newProblemsMessage).toBe("")
			expect(result.userEdits).toBeUndefined()
			expect(result.finalContent).toBe("new content")
		})

		it("should not open file when openWithoutFocus is false", async () => {
			await diffViewProvider.saveDirectly("test.ts", "new content", false, true, 1000)

			// Verify file was written
			const fs = await import("fs/promises")
			expect(fs.writeFile).toHaveBeenCalledWith(`${mockCwd}/test.ts`, "new content", "utf-8")

			// Verify file was NOT opened
			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		})

		it("should skip diagnostics when diagnosticsEnabled is false", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()
			vi.mocked(vscode.languages.getDiagnostics).mockClear()

			await diffViewProvider.saveDirectly("test.ts", "new content", true, false, 1000)

			// Verify file was written
			const fs = await import("fs/promises")
			expect(fs.writeFile).toHaveBeenCalledWith(`${mockCwd}/test.ts`, "new content", "utf-8")

			// Verify delay was NOT called
			expect(mockDelay).not.toHaveBeenCalled()
			// getDiagnostics is called once for pre-diagnostics, but not for post-diagnostics
			expect(vscode.languages.getDiagnostics).toHaveBeenCalledTimes(1)
		})

		it("should handle negative delay values", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			await diffViewProvider.saveDirectly("test.ts", "new content", true, true, -500)

			// Verify delay was called with 0 (safe minimum)
			expect(mockDelay).toHaveBeenCalledWith(0)
		})

		it("should store results for formatFileWriteResponse", async () => {
			await diffViewProvider.saveDirectly("test.ts", "new content", true, true, 1000)

			// Verify internal state was updated
			expect((diffViewProvider as any).newProblemsMessage).toBe("")
			expect((diffViewProvider as any).userEdits).toBeUndefined()
			expect((diffViewProvider as any).relPath).toBe("test.ts")
			expect((diffViewProvider as any).newContent).toBe("new content")
		})
	})

	describe("saveChanges method with diagnostic settings", () => {
		beforeEach(() => {
			// Setup common mocks for saveChanges tests
			;(diffViewProvider as any).relPath = "test.ts"
			;(diffViewProvider as any).newContent = "new content"
			;(diffViewProvider as any).activeDiffEditor = {
				document: {
					getText: vi.fn().mockReturnValue("new content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
			}
			;(diffViewProvider as any).preDiagnostics = []

			// Mock vscode functions
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
		})

		it("should apply diagnostic delay when diagnosticsEnabled is true", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			// Mock closeAllDiffViews
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)

			const result = await diffViewProvider.saveChanges(true, 3000)

			// Verify delay was called with correct duration
			expect(mockDelay).toHaveBeenCalledWith(3000)
			expect(vscode.languages.getDiagnostics).toHaveBeenCalled()
			expect(result.newProblemsMessage).toBe("")
		})

		it("should skip diagnostics when diagnosticsEnabled is false", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			// Mock closeAllDiffViews
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)

			const result = await diffViewProvider.saveChanges(false, 2000)

			// Verify delay was NOT called and diagnostics were NOT checked
			expect(mockDelay).not.toHaveBeenCalled()
			expect(vscode.languages.getDiagnostics).not.toHaveBeenCalled()
			expect(result.newProblemsMessage).toBe("")
		})

		it("should use default values when no parameters provided", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			// Mock closeAllDiffViews
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)

			const result = await diffViewProvider.saveChanges()

			// Verify default behavior (enabled=true, delay=2000ms)
			expect(mockDelay).toHaveBeenCalledWith(1000)
			expect(vscode.languages.getDiagnostics).toHaveBeenCalled()
			expect(result.newProblemsMessage).toBe("")
		})

		it("should handle custom delay values", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			// Mock closeAllDiffViews
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)

			const result = await diffViewProvider.saveChanges(true, 5000)

			// Verify custom delay was used
			expect(mockDelay).toHaveBeenCalledWith(5000)
			expect(vscode.languages.getDiagnostics).toHaveBeenCalled()
		})
	})

	describe("preEditScrollLine capture and restore", () => {
		it("should capture scroll line from visible editor at open() time", async () => {
			const mockEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/scroll.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue(""),
					lineCount: 0,
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
				visibleRanges: [{ start: { line: 42 } }],
			}

			vi.mocked(vscode.window).visibleTextEditors = [mockEditor as any]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback({ uri: { fsPath: `${mockCwd}/scroll.ts`, scheme: "file" } } as any), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			;(diffViewProvider as any).editType = "modify"

			await diffViewProvider.open("scroll.ts")

			expect((diffViewProvider as any).preEditScrollLine).toBe(42)
		})

		it("should set preEditScrollLine to undefined when the visible editor has no visibleRanges", async () => {
			const mockEditorNoRanges = {
				document: {
					uri: { fsPath: `${mockCwd}/new.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue(""),
					lineCount: 0,
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
				// No visibleRanges, so the capture in open() yields undefined.
			}

			vi.mocked(vscode.window).visibleTextEditors = [mockEditorNoRanges as any]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditorNoRanges as any)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback({ uri: { fsPath: `${mockCwd}/new.ts`, scheme: "file" } } as any), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			;(diffViewProvider as any).editType = "modify"

			await diffViewProvider.open("new.ts")

			expect((diffViewProvider as any).preEditScrollLine).toBeUndefined()
		})

		it("saveChanges() calls revealRange(AtTop) when documentWasOpen and preEditScrollLine is set", async () => {
			const mockRevealRange = vi.fn()
			const mockSavedEditor = { revealRange: mockRevealRange }

			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockSavedEditor as any)
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(diffViewProvider as any).documentWasOpen = true
			;(diffViewProvider as any).preEditScrollLine = 30
			// saveChanges early-exits without relPath, newContent, activeDiffEditor
			;(diffViewProvider as any).newContent = "content"
			;(diffViewProvider as any).activeDiffEditor = {
				document: {
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
			}

			await diffViewProvider.saveChanges(false)

			expect(mockRevealRange).toHaveBeenCalledWith(
				expect.objectContaining({ start: { line: 30, character: 0 } }),
				vscode.TextEditorRevealType.AtTop,
			)
		})

		it("saveChanges() does NOT call revealRange when preEditScrollLine is undefined", async () => {
			const mockRevealRange = vi.fn()
			const mockSavedEditor = { revealRange: mockRevealRange }

			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockSavedEditor as any)
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(diffViewProvider as any).documentWasOpen = true
			;(diffViewProvider as any).preEditScrollLine = undefined
			;(diffViewProvider as any).newContent = "content"
			;(diffViewProvider as any).activeDiffEditor = {
				document: {
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
			}

			await diffViewProvider.saveChanges(false)

			expect(mockRevealRange).not.toHaveBeenCalled()
		})

		it("saveChanges() cancels a pending deferred scroll so it cannot fight scroll-restore", async () => {
			// With auto-approve, saveChanges runs immediately after scrollToFirstDiff.
			// A late deferred reveal must not fire after the viewport is restored.
			vi.useFakeTimers()
			try {
				const deferredReveal = vi.fn()
				const liveEditor = {
					document: {
						uri: { fsPath: `${mockCwd}/race.ts`, scheme: "file" },
						getText: vi.fn().mockReturnValue("a\nCHANGED\nc\nd\n"),
						isDirty: false,
						save: vi.fn().mockResolvedValue(undefined),
						lineCount: 5,
						lineAt: vi.fn().mockReturnValue({ text: "" }),
					},
					selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
					visibleRanges: [{ start: { line: 0 }, end: { line: 0 } }],
					revealRange: deferredReveal,
				}
				;(diffViewProvider as any).originalContent = "a\nb\nc\nd\n"
				;(diffViewProvider as any).activeDiffEditor = liveEditor
				vi.mocked(vscode.window).visibleTextEditors = [liveEditor as any]

				// Schedule the deferred reveal, then accept the edit before it fires.
				diffViewProvider.scrollToFirstDiff()
				expect(deferredReveal).toHaveBeenCalledTimes(1)

				vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange: vi.fn() } as any)
				;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
				;(diffViewProvider as any).documentWasOpen = true
				;(diffViewProvider as any).preEditScrollLine = 0
				;(diffViewProvider as any).newContent = "a\nCHANGED\nc\nd\n"

				await diffViewProvider.saveChanges(false)

				// The timer was cancelled; advancing past it produces no extra reveal.
				vi.advanceTimersByTime(100)
				expect(deferredReveal).toHaveBeenCalledTimes(1)
				expect((diffViewProvider as any).deferredScrollTimer).toBeUndefined()
			} finally {
				vi.useRealTimers()
			}
		})

		it("revertChanges() calls revealRange(AtTop) when documentWasOpen and preEditScrollLine is set", async () => {
			const mockRevealRange = vi.fn()
			const mockSavedEditor = { revealRange: mockRevealRange }

			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockSavedEditor as any)
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(diffViewProvider as any).documentWasOpen = true
			;(diffViewProvider as any).preEditScrollLine = 15
			;(diffViewProvider as any).editType = "modify"
			;(diffViewProvider as any).originalContent = "original"
			;(diffViewProvider as any).activeDiffEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.txt` },
					getText: vi.fn().mockReturnValue("modified"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
					positionAt: vi.fn().mockReturnValue({ line: 0, character: 0 }),
				},
			}

			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)

			await diffViewProvider.revertChanges()

			expect(mockRevealRange).toHaveBeenCalledWith(
				expect.objectContaining({ start: { line: 15, character: 0 } }),
				vscode.TextEditorRevealType.AtTop,
			)
		})
	})

	describe("userTouchedDocument close/keep behavior", () => {
		const mockTargetPath = `${mockCwd}/mock-target-file.ts`

		const buildActiveDiffEditor = () => ({
			document: {
				uri: { fsPath: mockTargetPath },
				getText: vi.fn().mockReturnValue("content"),
				isDirty: false,
				save: vi.fn().mockResolvedValue(undefined),
				positionAt: vi.fn().mockReturnValue({ line: 0, character: 0 }),
			},
		})

		it("saveChanges() closes the file tab when the file was not open and untouched", async () => {
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(diffViewProvider as any).closeFileTab = closeFileTab
			;(diffViewProvider as any).relPath = "mock-target-file.ts"
			;(diffViewProvider as any).documentWasOpen = false
			;(diffViewProvider as any).userTouchedDocument = false
			;(diffViewProvider as any).preEditScrollLine = undefined
			;(diffViewProvider as any).newContent = "content"
			;(diffViewProvider as any).activeDiffEditor = buildActiveDiffEditor()

			await diffViewProvider.saveChanges(false)

			expect(closeFileTab).toHaveBeenCalledWith(mockTargetPath)
			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		})

		it("saveChanges() keeps the file open when the user touched it", async () => {
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange: vi.fn() } as any)
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(diffViewProvider as any).closeFileTab = closeFileTab
			;(diffViewProvider as any).relPath = "mock-target-file.ts"
			;(diffViewProvider as any).documentWasOpen = false
			;(diffViewProvider as any).userTouchedDocument = true
			;(diffViewProvider as any).preEditScrollLine = undefined
			;(diffViewProvider as any).newContent = "content"
			;(diffViewProvider as any).activeDiffEditor = buildActiveDiffEditor()

			await diffViewProvider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})

		it("revertChanges() closes the file tab when the file was not open and untouched", async () => {
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(diffViewProvider as any).closeFileTab = closeFileTab
			;(diffViewProvider as any).relPath = "mock-target-file.ts"
			;(diffViewProvider as any).documentWasOpen = false
			;(diffViewProvider as any).userTouchedDocument = false
			;(diffViewProvider as any).preEditScrollLine = undefined
			;(diffViewProvider as any).editType = "modify"
			;(diffViewProvider as any).originalContent = "original"
			;(diffViewProvider as any).activeDiffEditor = buildActiveDiffEditor()

			await diffViewProvider.revertChanges()

			expect(closeFileTab).toHaveBeenCalledWith(mockTargetPath)
			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		})

		it("revertChanges() keeps the file open when the user touched it", async () => {
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange: vi.fn() } as any)
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(diffViewProvider as any).closeFileTab = closeFileTab
			;(diffViewProvider as any).relPath = "mock-target-file.ts"
			;(diffViewProvider as any).documentWasOpen = false
			;(diffViewProvider as any).userTouchedDocument = true
			;(diffViewProvider as any).preEditScrollLine = undefined
			;(diffViewProvider as any).editType = "modify"
			;(diffViewProvider as any).originalContent = "original"
			;(diffViewProvider as any).activeDiffEditor = buildActiveDiffEditor()

			await diffViewProvider.revertChanges()

			expect(closeFileTab).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})

		it("marks userTouchedDocument when the file editor is activated during the diff", async () => {
			let activeCallback: ((editor: any) => void) | undefined
			vi.mocked(vscode.window.onDidChangeActiveTextEditor).mockImplementation((cb: any) => {
				activeCallback = cb
				return { dispose: vi.fn() }
			})

			const mockEditor = {
				document: {
					uri: { fsPath: mockTargetPath, scheme: "file" },
					getText: vi.fn().mockReturnValue(""),
					lineCount: 0,
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			}
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor as any]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback({ uri: { fsPath: mockTargetPath, scheme: "file" } } as any), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			;(diffViewProvider as any).editType = "modify"
			;(diffViewProvider as any).documentWasOpen = false

			await diffViewProvider.open("mock-target-file.ts")

			// Simulate the user activating the plain file editor (no diff tab active).
			;(vscode.window.tabGroups as any).activeTabGroup = { activeTab: { input: {} } }
			activeCallback?.({
				document: { uri: { fsPath: mockTargetPath, scheme: "file" } },
			})

			expect((diffViewProvider as any).userTouchedDocument).toBe(true)
		})
	})

	describe("userTouchedDiffEditor keep/close behavior", () => {
		const mockTargetPath = `${mockCwd}/mock-target-file.ts`

		const buildActiveDiffEditor = () => ({
			document: {
				uri: { fsPath: mockTargetPath },
				getText: vi.fn().mockReturnValue("content"),
				isDirty: false,
				save: vi.fn().mockResolvedValue(undefined),
				positionAt: vi.fn().mockReturnValue({ line: 0, character: 0 }),
			},
		})

		it("saveChanges() keeps the file open when the user clicked inside the diff editor", async () => {
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange: vi.fn() } as any)
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(diffViewProvider as any).closeFileTab = closeFileTab
			;(diffViewProvider as any).relPath = "mock-target-file.ts"
			;(diffViewProvider as any).documentWasOpen = false
			;(diffViewProvider as any).userTouchedDocument = false
			// The user clicked in the diff editor -- the flag is true.
			;(diffViewProvider as any).userTouchedDiffEditor = true
			;(diffViewProvider as any).preEditScrollLine = undefined
			;(diffViewProvider as any).newContent = "content"
			;(diffViewProvider as any).activeDiffEditor = buildActiveDiffEditor()

			await diffViewProvider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})

		it("saveChanges() closes the file tab when the user only scrolled (not clicked) in the diff", async () => {
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(diffViewProvider as any).closeFileTab = closeFileTab
			;(diffViewProvider as any).relPath = "mock-target-file.ts"
			;(diffViewProvider as any).documentWasOpen = false
			;(diffViewProvider as any).userTouchedDocument = false
			// The user only scrolled -- the flag stays false.
			;(diffViewProvider as any).userTouchedDiffEditor = false
			;(diffViewProvider as any).preEditScrollLine = undefined
			;(diffViewProvider as any).newContent = "content"
			;(diffViewProvider as any).activeDiffEditor = buildActiveDiffEditor()

			await diffViewProvider.saveChanges(false)

			expect(closeFileTab).toHaveBeenCalledWith(mockTargetPath)
			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		})

		it("open() registers onDidChangeTextEditorSelection and sets userTouchedDiffEditor on event", async () => {
			let selectionCallback: ((event: any) => void) | undefined
			vi.mocked(vscode.window.onDidChangeTextEditorSelection).mockImplementation((cb: any) => {
				selectionCallback = cb
				return { dispose: vi.fn() }
			})

			const mockEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/sel.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue(""),
					lineCount: 0,
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			}
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor as any]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback({ uri: { fsPath: `${mockCwd}/sel.ts`, scheme: "file" } } as any), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			;(diffViewProvider as any).editType = "modify"

			await diffViewProvider.open("sel.ts")

			expect((diffViewProvider as any).userTouchedDiffEditor).toBe(false)

			// Simulate a Mouse selection-change event on the captured diff editor.
			const activeDiffEditor = (diffViewProvider as any).activeDiffEditor
			selectionCallback?.({
				textEditor: activeDiffEditor,
				kind: vscode.TextEditorSelectionChangeKind.Mouse,
			})

			expect((diffViewProvider as any).userTouchedDiffEditor).toBe(true)
		})

		it("open() does NOT set userTouchedDiffEditor for programmatic selection changes (kind=Command or undefined)", async () => {
			let selectionCallback: ((event: any) => void) | undefined
			vi.mocked(vscode.window.onDidChangeTextEditorSelection).mockImplementation((cb: any) => {
				selectionCallback = cb
				return { dispose: vi.fn() }
			})

			const mockEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/prog.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue(""),
					lineCount: 0,
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			}
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor as any]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback({ uri: { fsPath: `${mockCwd}/prog.ts`, scheme: "file" } } as any), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			;(diffViewProvider as any).editType = "modify"

			await diffViewProvider.open("prog.ts")

			const activeDiffEditor = (diffViewProvider as any).activeDiffEditor

			// Programmatic change via editor.selection= (kind undefined) -- e.g. revealDiffLine
			selectionCallback?.({ textEditor: activeDiffEditor, kind: undefined })
			expect((diffViewProvider as any).userTouchedDiffEditor).toBe(false)

			// Programmatic change via command (kind=Command)
			selectionCallback?.({
				textEditor: activeDiffEditor,
				kind: vscode.TextEditorSelectionChangeKind.Command,
			})
			expect((diffViewProvider as any).userTouchedDiffEditor).toBe(false)
		})

		it("open() sets userTouchedDiffEditor when event comes from a fresh editor instance wrapping the same document (stale ref fix)", async () => {
			let selectionCallback: ((event: any) => void) | undefined
			vi.mocked(vscode.window.onDidChangeTextEditorSelection).mockImplementation((cb: any) => {
				selectionCallback = cb
				return { dispose: vi.fn() }
			})

			const sharedDocument = {
				uri: { fsPath: `${mockCwd}/stale.ts`, scheme: "file" },
				getText: vi.fn().mockReturnValue(""),
				lineCount: 0,
			}
			const originalEditor = {
				document: sharedDocument,
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			}
			vi.mocked(vscode.window).visibleTextEditors = [originalEditor as any]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(originalEditor as any)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback({ uri: { fsPath: `${mockCwd}/stale.ts`, scheme: "file" } } as any), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			;(diffViewProvider as any).editType = "modify"

			await diffViewProvider.open("stale.ts")

			// Simulate VS Code giving us a NEW editor object that wraps the same
			// document -- this is the real-world stale reference scenario.
			const freshEditorSameDoc = { document: sharedDocument }
			selectionCallback?.({
				textEditor: freshEditorSameDoc,
				kind: vscode.TextEditorSelectionChangeKind.Mouse,
			})

			expect((diffViewProvider as any).userTouchedDiffEditor).toBe(true)
		})

		it("open() ignores selection events on editors other than the diff editor", async () => {
			let selectionCallback: ((event: any) => void) | undefined
			vi.mocked(vscode.window.onDidChangeTextEditorSelection).mockImplementation((cb: any) => {
				selectionCallback = cb
				return { dispose: vi.fn() }
			})

			const mockEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/other.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue(""),
					lineCount: 0,
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			}
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor as any]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback({ uri: { fsPath: `${mockCwd}/other.ts`, scheme: "file" } } as any), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			;(diffViewProvider as any).editType = "modify"

			await diffViewProvider.open("other.ts")

			// Fire the event with a completely different editor object.
			const unrelatedEditor = { document: { uri: { fsPath: "/some/other/file.ts", scheme: "file" } } }
			selectionCallback?.({ textEditor: unrelatedEditor })

			expect((diffViewProvider as any).userTouchedDiffEditor).toBe(false)
		})

		it("revertChanges() closes the file tab even when userTouchedDiffEditor is true (deny ignores diff-touch)", async () => {
			// Asymmetry guard: only saveChanges() passes userTouchedDiffEditor through to
			// keepOrCloseEditedFile(). revertChanges() (deny) must NOT honor a diff-pane
			// touch -- a denied edit on a not-previously-open, document-untouched file
			// should still close the transient tab. This protects the documented intent
			// from accidental regression.
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(diffViewProvider as any).closeFileTab = closeFileTab
			;(diffViewProvider as any).relPath = "mock-target-file.ts"
			;(diffViewProvider as any).documentWasOpen = false
			;(diffViewProvider as any).userTouchedDocument = false
			// The user clicked inside the diff pane -- but this is a deny, so it must be ignored.
			;(diffViewProvider as any).userTouchedDiffEditor = true
			;(diffViewProvider as any).preEditScrollLine = undefined
			;(diffViewProvider as any).editType = "modify"
			;(diffViewProvider as any).originalContent = "original"
			;(diffViewProvider as any).activeDiffEditor = buildActiveDiffEditor()

			await diffViewProvider.revertChanges()

			expect(closeFileTab).toHaveBeenCalledWith(mockTargetPath)
			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		})
	})

	describe("scroll position precedence in showEditedFileWithoutDisruptingFocus", () => {
		const setupForScroll = (
			lastScrolledSource: "diff" | "targetFile" | undefined,
			diffScrollLine: number | undefined,
			targetFileScrollLine: number | undefined,
			preEditScrollLine: number | undefined,
		) => {
			const mockRevealRange = vi.fn()
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange: mockRevealRange } as any)
			const userActiveEditor = {
				document: { uri: { fsPath: `${mockCwd}/target.ts`, scheme: "file" } },
				viewColumn: 1,
			}
			;(vscode.window as any).activeTextEditor = userActiveEditor
			;(diffViewProvider as any).lastScrolledSource = lastScrolledSource
			;(diffViewProvider as any).diffScrollLine = diffScrollLine
			;(diffViewProvider as any).targetFileScrollLine = targetFileScrollLine
			;(diffViewProvider as any).preEditScrollLine = preEditScrollLine
			;(diffViewProvider as any).documentWasPinned = false
			return mockRevealRange
		}

		it("uses diffScrollLine when lastScrolledSource is 'diff'", async () => {
			const mockRevealRange = setupForScroll("diff", 20, 5, 0)

			await (diffViewProvider as any).showEditedFileWithoutDisruptingFocus(`${mockCwd}/target.ts`)

			expect(mockRevealRange).toHaveBeenCalledWith(
				expect.objectContaining({ start: { line: 20, character: 0 } }),
				vscode.TextEditorRevealType.AtTop,
			)
		})

		it("uses targetFileScrollLine when lastScrolledSource is 'targetFile'", async () => {
			const mockRevealRange = setupForScroll("targetFile", 20, 8, 0)

			await (diffViewProvider as any).showEditedFileWithoutDisruptingFocus(`${mockCwd}/target.ts`)

			expect(mockRevealRange).toHaveBeenCalledWith(
				expect.objectContaining({ start: { line: 8, character: 0 } }),
				vscode.TextEditorRevealType.AtTop,
			)
		})

		it("falls back to preEditScrollLine when lastScrolledSource is undefined", async () => {
			const mockRevealRange = setupForScroll(undefined, 20, 8, 3)

			await (diffViewProvider as any).showEditedFileWithoutDisruptingFocus(`${mockCwd}/target.ts`)

			expect(mockRevealRange).toHaveBeenCalledWith(
				expect.objectContaining({ start: { line: 3, character: 0 } }),
				vscode.TextEditorRevealType.AtTop,
			)
		})

		it("does not call revealRange when all scroll sources are undefined", async () => {
			const mockRevealRange = setupForScroll(undefined, undefined, undefined, undefined)

			await (diffViewProvider as any).showEditedFileWithoutDisruptingFocus(`${mockCwd}/target.ts`)

			expect(mockRevealRange).not.toHaveBeenCalled()
		})

		it("targetFile scroll overrides diff scroll regardless of their values", async () => {
			// lastScrolledSource=targetFile means the user scrolled there AFTER the diff,
			// so targetFileScrollLine must win even when diffScrollLine is higher.
			const mockRevealRange = setupForScroll("targetFile", 100, 2, 0)

			await (diffViewProvider as any).showEditedFileWithoutDisruptingFocus(`${mockCwd}/target.ts`)

			expect(mockRevealRange).toHaveBeenCalledWith(
				expect.objectContaining({ start: { line: 2, character: 0 } }),
				vscode.TextEditorRevealType.AtTop,
			)
		})
	})

	describe("diffScrollListener wiring in open()", () => {
		const openWithScrollListener = async (relPath: string) => {
			let scrollCallback: ((event: any) => void) | undefined
			vi.mocked(vscode.window.onDidChangeTextEditorVisibleRanges).mockImplementation((cb: any) => {
				scrollCallback = cb
				return { dispose: vi.fn() }
			})

			const fsPath = `${mockCwd}/${relPath}`
			const mockEditor = {
				document: {
					uri: { fsPath, scheme: "file" },
					getText: vi.fn().mockReturnValue(""),
					lineCount: 0,
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			}
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor as any]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback({ uri: { fsPath, scheme: "file" } } as any), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			;(diffViewProvider as any).editType = "modify"

			await diffViewProvider.open(relPath)
			if (!scrollCallback) {
				throw new Error(
					"onDidChangeTextEditorVisibleRanges mock was not invoked during open() - scroll listener setup changed",
				)
			}
			return {
				scrollCallback,
				activeDiffEditor: (diffViewProvider as any).activeDiffEditor,
				fsPath,
			}
		}

		it("records diffScrollLine and sets lastScrolledSource to 'diff' on diff editor scroll", async () => {
			const { scrollCallback, activeDiffEditor } = await openWithScrollListener("scroll-diff.ts")

			scrollCallback({ textEditor: activeDiffEditor, visibleRanges: [{ start: { line: 42 } }] })

			expect((diffViewProvider as any).diffScrollLine).toBe(42)
			expect((diffViewProvider as any).lastScrolledSource).toBe("diff")
		})

		it("records targetFileScrollLine and sets lastScrolledSource to 'targetFile' on target file scroll", async () => {
			const { scrollCallback, fsPath } = await openWithScrollListener("scroll-target.ts")

			const targetFileEditor = {
				document: { uri: { fsPath, scheme: "file" } },
			}
			scrollCallback({ textEditor: targetFileEditor, visibleRanges: [{ start: { line: 17 } }] })

			expect((diffViewProvider as any).targetFileScrollLine).toBe(17)
			expect((diffViewProvider as any).lastScrolledSource).toBe("targetFile")
		})

		it("ignores scroll events from unrelated editors", async () => {
			const { scrollCallback } = await openWithScrollListener("scroll-unrelated.ts")

			const unrelatedEditor = {
				document: { uri: { fsPath: "/some/other/file.ts", scheme: "file" } },
			}
			scrollCallback({ textEditor: unrelatedEditor, visibleRanges: [{ start: { line: 99 } }] })

			expect((diffViewProvider as any).diffScrollLine).toBeUndefined()
			expect((diffViewProvider as any).targetFileScrollLine).toBeUndefined()
			expect((diffViewProvider as any).lastScrolledSource).toBeUndefined()
		})

		it("lastScrolledSource reflects the most recent scroll between diff and target file", async () => {
			const { scrollCallback, activeDiffEditor, fsPath } = await openWithScrollListener("scroll-recency.ts")

			// First scroll in diff.
			scrollCallback({ textEditor: activeDiffEditor, visibleRanges: [{ start: { line: 10 } }] })
			expect((diffViewProvider as any).lastScrolledSource).toBe("diff")

			// Then scroll in the target file -- this must win.
			const targetFileEditor = { document: { uri: { fsPath, scheme: "file" } } }
			scrollCallback({ textEditor: targetFileEditor, visibleRanges: [{ start: { line: 5 } }] })
			expect((diffViewProvider as any).lastScrolledSource).toBe("targetFile")

			// Back to diff again.
			scrollCallback({ textEditor: activeDiffEditor, visibleRanges: [{ start: { line: 20 } }] })
			expect((diffViewProvider as any).lastScrolledSource).toBe("diff")
		})
	})

	describe("auto-close settings decision table", () => {
		const mockTargetPath = `${mockCwd}/auto-close-test.ts`

		const buildActiveDiffEditor = () => ({
			document: {
				uri: { fsPath: mockTargetPath },
				getText: vi.fn().mockReturnValue("content"),
				isDirty: false,
				save: vi.fn().mockResolvedValue(undefined),
				positionAt: vi.fn().mockReturnValue({ line: 0, character: 0 }),
			},
		})

		const setupProvider = (stateOverrides: Record<string, unknown> = {}) => {
			const task = {
				providerRef: {
					deref: vi.fn().mockReturnValue({
						getState: vi.fn().mockResolvedValue({
							includeDiagnosticMessages: true,
							maxDiagnosticMessages: 50,
							...stateOverrides,
						}),
					}),
				},
			}
			const provider = new DiffViewProvider(mockCwd, task as any)
			;(provider as any).relPath = "auto-close-test.ts"
			;(provider as any).newContent = "content"
			;(provider as any).activeDiffEditor = buildActiveDiffEditor()
			;(provider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(provider as any).preEditScrollLine = undefined
			return provider
		}

		it("already-open file is never auto-closed regardless of settings", async () => {
			const provider = setupProvider({ autoCloseZooOpenedFiles: true })
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			;(provider as any).closeFileTab = closeFileTab
			;(provider as any).documentWasOpen = true
			;(provider as any).userTouchedDocument = false
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange: vi.fn() } as any)

			await provider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
		})

		it("transient tab is kept when autoCloseZooOpenedFiles is false", async () => {
			const provider = setupProvider({ autoCloseZooOpenedFiles: false })
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			;(provider as any).closeFileTab = closeFileTab
			;(provider as any).documentWasOpen = false
			;(provider as any).userTouchedDocument = false
			;(provider as any).userTouchedDiffEditor = false
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange: vi.fn() } as any)

			await provider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})

		it("transient tab is closed when autoCloseZooOpenedFiles is true (default)", async () => {
			const provider = setupProvider({ autoCloseZooOpenedFiles: true })
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			;(provider as any).closeFileTab = closeFileTab
			;(provider as any).documentWasOpen = false
			;(provider as any).userTouchedDocument = false
			;(provider as any).userTouchedDiffEditor = false

			await provider.saveChanges(false)

			expect(closeFileTab).toHaveBeenCalledWith(mockTargetPath)
		})

		it("touched tab is kept by default (autoCloseZooOpenedFilesAfterUserEdited unset)", async () => {
			const provider = setupProvider({})
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			;(provider as any).closeFileTab = closeFileTab
			;(provider as any).documentWasOpen = false
			;(provider as any).userTouchedDocument = true
			;(provider as any).userTouchedDiffEditor = false
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange: vi.fn() } as any)

			await provider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
		})

		it("touched tab is closed when autoCloseZooOpenedFilesAfterUserEdited is true", async () => {
			const provider = setupProvider({ autoCloseZooOpenedFilesAfterUserEdited: true })
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			;(provider as any).closeFileTab = closeFileTab
			;(provider as any).documentWasOpen = false
			;(provider as any).userTouchedDocument = true
			;(provider as any).userTouchedDiffEditor = false

			await provider.saveChanges(false)

			expect(closeFileTab).toHaveBeenCalledWith(mockTargetPath)
		})

		it("touched tab is kept when autoCloseZooOpenedFilesAfterUserEdited is true but autoCloseZooOpenedFiles is false", async () => {
			// The after-edit override is a refinement of the base auto-close, so it
			// has no effect when autoCloseZooOpenedFiles is disabled.
			const provider = setupProvider({
				autoCloseZooOpenedFiles: false,
				autoCloseZooOpenedFilesAfterUserEdited: true,
			})
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			;(provider as any).closeFileTab = closeFileTab
			;(provider as any).documentWasOpen = false
			;(provider as any).userTouchedDocument = true
			;(provider as any).userTouchedDiffEditor = false
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange: vi.fn() } as any)

			await provider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})

		it("new file tab is closed when autoCloseZooOpenedNewFiles is true (accept path)", async () => {
			const provider = setupProvider({ autoCloseZooOpenedNewFiles: true })
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			;(provider as any).closeFileTab = closeFileTab
			;(provider as any).documentWasOpen = false
			;(provider as any).userTouchedDocument = false
			;(provider as any).userTouchedDiffEditor = false
			;(provider as any).editType = "create"

			await provider.saveChanges(false)

			expect(closeFileTab).toHaveBeenCalledWith(mockTargetPath)
		})

		it("new file tab follows transient-tab rule when autoCloseZooOpenedNewFiles is false and autoCloseZooOpenedFiles is also false", async () => {
			// autoCloseZooOpenedNewFiles=false means the new-file fast-path is skipped;
			// the file then falls through to the normal transient-tab rule.
			// With autoCloseZooOpenedFiles=false the tab should be kept.
			const provider = setupProvider({
				autoCloseZooOpenedNewFiles: false,
				autoCloseZooOpenedFiles: false,
			})
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			;(provider as any).closeFileTab = closeFileTab
			;(provider as any).documentWasOpen = false
			;(provider as any).userTouchedDocument = false
			;(provider as any).userTouchedDiffEditor = false
			;(provider as any).editType = "create"
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({ revealRange: vi.fn() } as any)

			await provider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})

		it("defaults preserve existing behavior when all settings are unset", async () => {
			// No auto-close settings in state: transient tab should be closed (existing default).
			const provider = setupProvider({})
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			;(provider as any).closeFileTab = closeFileTab
			;(provider as any).documentWasOpen = false
			;(provider as any).userTouchedDocument = false
			;(provider as any).userTouchedDiffEditor = false

			await provider.saveChanges(false)

			expect(closeFileTab).toHaveBeenCalledWith(mockTargetPath)
		})
	})
})
