import type { Stats } from "fs"
import * as fs from "fs/promises"
import { DiffViewProvider, DIFF_VIEW_URI_SCHEME, DIFF_VIEW_LABEL_CHANGES } from "../DiffViewProvider"
import { DecorationController } from "../DecorationController"
import type { Task } from "../../../core/task/Task"
import type { Mock } from "vitest"
import * as vscode from "vscode"
import delay from "delay"
import { DEFAULT_WRITE_DELAY_MS } from "@roo-code/types"

import { makePosition, makeRange, makeTextDocument, makeTextEditor, makeUri } from "../../../test-utils/vscode"

// Mock delay
vi.mock("delay", () => ({
	default: vi.fn().mockResolvedValue(undefined),
}))

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn().mockResolvedValue("file content"),
	writeFile: vi.fn().mockResolvedValue(undefined),
	access: vi.fn().mockResolvedValue(undefined),
	// revertChanges() rolls a new-file edit back by deleting the placeholder and the
	// directories the edit created.
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
	// The abandoned-stream cleanup stats the placeholder before unlinking it: only the
	// file open() created empty is its own to delete. The default double reports exactly
	// that zero-byte placeholder; rows that mean a filled file override it once.
	stat: vi.fn(async () => ({ size: 0 })),
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
			close: vi.fn().mockResolvedValue(true),
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
		parse: vi.fn((_uri) => ({ with: vi.fn(() => ({})) })),
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
	let mockWorkspaceEdit: { replace: Mock; delete: Mock }
	let mockTask: Task

	// Tab doubles: the mocked vscode classes ignore constructor arguments, so the
	// uri/original/modified members the source reads after `instanceof` checks are
	// assigned directly onto real mocked-class instances.
	const makeTextTab = (fsPath: string): vscode.TabInputText =>
		Object.assign(new vscode.TabInputText(makeUri(fsPath)), { uri: makeUri(fsPath) })

	const makeDiffTabInput = (originalScheme: string, modifiedFsPath: string): vscode.TabInputTextDiff =>
		Object.assign(new vscode.TabInputTextDiff(makeUri(modifiedFsPath), makeUri(modifiedFsPath)), {
			original: { scheme: originalScheme },
			modified: { fsPath: modifiedFsPath },
		})

	const makeTab = (input: vscode.Tab["input"], label: string, overrides: Partial<vscode.Tab> = {}): vscode.Tab => ({
		input,
		label,
		isDirty: false,
		isPinned: false,
		isPreview: false,
		isActive: false,
		group: { isActive: false, viewColumn: vscode.ViewColumn.One, activeTab: undefined, tabs: [] },
		...overrides,
	})

	const makePreviewTab = (fsPath: string, isPreview = true): vscode.Tab =>
		makeTab(makeTextTab(fsPath), fsPath, { isPreview })

	// Minimal Uri double: provides only the fsPath/scheme members the restore
	// snapshot path reads, so toEqual assertions stay exact.
	const makeSnapshotUri = (fsPath: string): vscode.Uri => ({ fsPath, scheme: "file" }) as unknown as vscode.Uri

	// Task double provides providerRef.deref() -> getState() with provider settings.
	const makeTaskDouble = (stateOverrides: Record<string, unknown> = {}): Task =>
		({
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						includeDiagnosticMessages: true,
						maxDiagnosticMessages: 50,
						...stateOverrides,
					}),
				}),
			},
		}) as unknown as Task

	beforeEach(() => {
		vi.clearAllMocks()
		mockWorkspaceEdit = {
			replace: vi.fn(),
			delete: vi.fn(),
		}
		vi.mocked(vscode.WorkspaceEdit).mockImplementation(function () {
			// WorkspaceEdit double provides replace() and delete(), the only members
			// update()/revertChanges() call.
			return mockWorkspaceEdit as unknown as vscode.WorkspaceEdit
		})

		// Create a mock Task instance; the double provides providerRef.deref() ->
		// getState() with provider settings (see makeTaskDouble below).
		mockTask = makeTaskDouble({
			// Auto-closing edited tabs is opt-in by default; the legacy
			// "close/keep behavior" suite below asserts the close path, so
			// enable it here. The opt-in default itself is covered by the
			// dedicated "auto-close settings decision table" suite.
			autoCloseZooOpenedFiles: true,
		})

		diffViewProvider = new DiffViewProvider(mockCwd, mockTask)
		// Mock the necessary properties and methods
		diffViewProvider["relPath"] = "test.txt"
		diffViewProvider["activeDiffEditor"] = makeTextEditor({
			document: makeTextDocument({ uri: makeUri(`${mockCwd}/test.txt`), lineCount: 10 }),
		})
		// Decoration doubles provide setActiveLine/clear and
		// updateOverlayAfterLine/addLines/clear respectively.
		diffViewProvider["activeLineController"] = {
			setActiveLine: vi.fn(),
			clear: vi.fn(),
		} as unknown as DecorationController
		diffViewProvider["fadedOverlayController"] = {
			updateOverlayAfterLine: vi.fn(),
			addLines: vi.fn(),
			clear: vi.fn(),
		} as unknown as DecorationController
	})

	describe("update method", () => {
		it("should preserve empty last line when original content has one", async () => {
			diffViewProvider.originalContent = "Original content\n"
			await diffViewProvider.update("New content", true)

			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				"New content\n",
			)
		})

		it("should not add extra newline when accumulated content already ends with one", async () => {
			diffViewProvider.originalContent = "Original content\n"
			await diffViewProvider.update("New content\n", true)

			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				"New content\n",
			)
		})

		it("should not add newline when original content does not end with one", async () => {
			diffViewProvider.originalContent = "Original content"
			await diffViewProvider.update("New content", true)

			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(expect.anything(), expect.anything(), "New content")
		})
	})

	describe("open method", () => {
		it("should pre-open file as text document before executing diff command", async () => {
			// Setup
			const mockEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri(`${mockCwd}/test.md`) }),
			})

			// Track the order of calls
			const callOrder: string[] = []

			// Mock showTextDocument to track when it's called
			vi.mocked(vscode.window.showTextDocument).mockImplementation(async (_uri, options) => {
				callOrder.push("showTextDocument")
				expect(options).toEqual({ preview: false, viewColumn: vscode.ViewColumn.Active, preserveFocus: true })
				return mockEditor
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
					callback(makeTextDocument({ uri: makeUri(`${mockCwd}/test.md`) }))
				}, 0)
				return { dispose: vi.fn() }
			})

			// Mock window.visibleTextEditors to return our editor
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]

			// Set up for file
			diffViewProvider.editType = "modify"

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

		it.each([new Error("Cannot open file"), "Cannot open file"])(
			"should handle showTextDocument failure: %s",
			async (reason) => {
				// Mock showTextDocument to fail
				vi.mocked(vscode.window.showTextDocument).mockRejectedValue(reason)

				// Mock workspace.onDidOpenTextDocument
				const disposeOpenDocument = vi.fn()
				vi.mocked(vscode.workspace.onDidOpenTextDocument).mockReturnValue({ dispose: disposeOpenDocument })

				// Mock window.onDidChangeVisibleTextEditors
				const disposeVisibleEditors = vi.fn()
				vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({
					dispose: disposeVisibleEditors,
				})

				// Set up for file
				diffViewProvider.editType = "modify"

				// Try to open and expect rejection
				await expect(diffViewProvider.open("test.md")).rejects.toThrow(
					"Failed to execute diff command for /mock/cwd/test.md: Cannot open file",
				)
				expect(disposeOpenDocument).toHaveBeenCalledOnce()
				expect(disposeVisibleEditors).toHaveBeenCalledOnce()
			},
		)

		it("records the pin state of an already-open pinned tab", async () => {
			const mockEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri(`${mockCwd}/test.md`) }),
			})

			// An open, pinned, non-dirty tab for the target file.
			const pinnedTab = makeTab(makeTextTab(`${mockCwd}/test.md`), "test.md", { isPinned: true })
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [pinnedTab] }],
				configurable: true,
			})

			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => {
					callback(makeTextDocument({ uri: makeUri(`${mockCwd}/test.md`) }))
				}, 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			diffViewProvider.editType = "modify"

			await diffViewProvider.open("test.md")

			expect(diffViewProvider["documentWasPinned"]).toBe(true)
			expect(diffViewProvider["documentWasOpen"]).toBe(true)
		})
	})

	describe("scrollToFirstDiff method", () => {
		const setupEditor = (currentContent: string) => {
			const revealRange = vi.fn()
			const document = makeTextDocument({
				uri: makeUri(`${mockCwd}/mock-file-target.txt`),
				getText: vi.fn().mockReturnValue(currentContent),
			})
			const editor = makeTextEditor({
				document,
				visibleRanges: [makeRange()],
				revealRange,
			})
			diffViewProvider["activeDiffEditor"] = editor
			// Register the editor as the live modified-side editor so resolveLiveEditor
			// finds it by document identity, mirroring the runtime path.
			vi.mocked(vscode.window).visibleTextEditors = [editor]
			return revealRange
		}

		it("reveals the first changed line for an addition-only diff", () => {
			diffViewProvider.originalContent = "a\nb\nc\n"
			// Insert a new line between b and c (first change is at line index 2).
			const revealRange = setupEditor("a\nb\nNEW\nc\n")

			diffViewProvider.scrollToFirstDiff()

			expect(revealRange).toHaveBeenCalledTimes(1)
			const range = revealRange.mock.calls[0][0]
			expect(range.start.line).toBe(2)
		})

		it("reveals the first changed line for a deletion-only diff", () => {
			diffViewProvider.originalContent = "a\nb\nc\nd\n"
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
			diffViewProvider.originalContent = "a\nb\nc\nd\ne\nf\n"
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
			diffViewProvider.originalContent = "a\nb\nc\nd\n"
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
			diffViewProvider.originalContent = "a\nb\nc\nd\n"
			const revealRange = setupEditor("a\nCHANGED\nc\nd\n")

			diffViewProvider.scrollToFirstDiff()

			const editor = diffViewProvider["activeDiffEditor"]
			if (!editor) {
				throw new Error("activeDiffEditor was not set")
			}
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
				diffViewProvider.originalContent = "a\nb\nc\nd\n"
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
			diffViewProvider.originalContent = "a\nb\nc\nd\n"
			const staleReveal = setupEditor("a\nCHANGED\nc\nd\n")
			const staleEditor = diffViewProvider["activeDiffEditor"]
			if (!staleEditor) {
				throw new Error("activeDiffEditor was not set")
			}

			// A live editor for the SAME document, distinct from the stale capture.
			const liveReveal = vi.fn()
			const liveEditor = makeTextEditor({
				document: staleEditor.document,
				visibleRanges: [makeRange()],
				revealRange: liveReveal,
			})
			vi.mocked(vscode.window).visibleTextEditors = [liveEditor]

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
				diffViewProvider.originalContent = "a\nb\nc\nd\n"
				const firstReveal = setupEditor("a\nCHANGED\nc\nd\n")
				const firstEditor = diffViewProvider["activeDiffEditor"]

				diffViewProvider.scrollToFirstDiff()
				expect(firstReveal).toHaveBeenCalledTimes(1)

				// A later edit swaps in a brand new diff editor before the timer fires.
				const secondReveal = setupEditor("a\nb\nc\nd\n")
				expect(diffViewProvider["activeDiffEditor"]).not.toBe(firstEditor)

				vi.advanceTimersByTime(100)

				// The stale timer saw a different active editor and did nothing more.
				expect(firstReveal).toHaveBeenCalledTimes(1)
				expect(secondReveal).not.toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})

		it("does nothing when there is no diff editor", () => {
			diffViewProvider["activeDiffEditor"] = undefined
			expect(() => diffViewProvider.scrollToFirstDiff()).not.toThrow()
		})
	})

	describe("preview tab snapshot and restore", () => {
		const setTabs = (tabs: vscode.Tab[], viewColumn: vscode.ViewColumn = vscode.ViewColumn.One) => {
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: (): vscode.TabGroup[] => [{ isActive: true, viewColumn, activeTab: tabs[0], tabs }],
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
				makeTextEditor({
					document: makeTextDocument({ uri: makeUri("/mock/cwd/file-1.txt") }),
					visibleRanges: [makeRange(12)],
				}),
			]

			const snapshot = diffViewProvider["captureUnrelatedPreviewTabs"]("/mock/cwd/file-2.txt")

			expect(snapshot).toHaveLength(1)
			expect(snapshot[0].uri.fsPath).toBe("/mock/cwd/file-1.txt")
			expect(snapshot[0].scrollLine).toBe(12)
			expect(snapshot[0].viewColumn).toBe(vscode.ViewColumn.Two)
		})

		it("restores an evicted preview tab in its original group and reapplies its scroll position", async () => {
			const revealRange = vi.fn()
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor({ revealRange }))
			// The captured file is no longer open (evicted by the diff).
			setTabs([])
			diffViewProvider["snapshotPreviewTabs"] = [
				{
					uri: makeSnapshotUri("/mock/cwd/file-1.txt"),
					scrollLine: 12,
					viewColumn: vscode.ViewColumn.Two,
				},
			]

			await diffViewProvider["restorePreviewTabs"]()

			expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
				{ fsPath: "/mock/cwd/file-1.txt", scheme: "file" },
				{ preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Two },
			)
			expect(revealRange).toHaveBeenCalledWith(
				expect.objectContaining({ start: { line: 12, character: 0 } }),
				vscode.TextEditorRevealType.AtTop,
			)
			expect(diffViewProvider["snapshotPreviewTabs"]).toEqual([])
		})

		it("does not restore a preview tab that is still open", async () => {
			setTabs([makePreviewTab("/mock/cwd/file-1.txt")])
			diffViewProvider["snapshotPreviewTabs"] = [
				{
					uri: makeSnapshotUri("/mock/cwd/file-1.txt"),
					scrollLine: 0,
					viewColumn: vscode.ViewColumn.One,
				},
			]

			await diffViewProvider["restorePreviewTabs"]()

			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		})

		it("skips restoring a preview tab whose file no longer exists", async () => {
			setTabs([])
			const fs = await import("fs/promises")
			vi.mocked(fs.access).mockRejectedValueOnce(new Error("ENOENT"))
			diffViewProvider["snapshotPreviewTabs"] = [
				{
					uri: makeSnapshotUri("/mock/cwd/deleted.txt"),
					scrollLine: 0,
					viewColumn: vscode.ViewColumn.One,
				},
			]

			await diffViewProvider["restorePreviewTabs"]()

			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
			expect(diffViewProvider["snapshotPreviewTabs"]).toEqual([])
		})
	})

	describe("showEditedFileWithoutDisruptingFocus", () => {
		it("re-activates the user's editor when they navigated to a different file", async () => {
			// User is viewing file-1 while the edited file is file-2. Keeping file-2
			// open must not yank focus/foreground onto it.
			const userActiveEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri("/mock/cwd/file-1.txt") }),
			})
			vscode.window.activeTextEditor = userActiveEditor
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())
			diffViewProvider["preEditScrollLine"] = 5

			await diffViewProvider["showEditedFileWithoutDisruptingFocus"]("/mock/cwd/file-2.txt")

			// First call re-shows the edited file (preserveFocus); last call restores
			// the user's editor with focus.
			const calls = vi.mocked(vscode.window.showTextDocument).mock.calls
			expect(calls[0][1]).toMatchObject({ preview: false, preserveFocus: true })
			const restoreCall = calls[calls.length - 1]
			expect(restoreCall[0]).toBe(userActiveEditor.document)
			expect(restoreCall[1]).toMatchObject({ viewColumn: 1, preserveFocus: false })
		})

		it("does not re-activate when the user is already on the edited file", async () => {
			const userActiveEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri("/mock/cwd/file-2.txt") }),
			})
			vscode.window.activeTextEditor = userActiveEditor
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())

			await diffViewProvider["showEditedFileWithoutDisruptingFocus"]("/mock/cwd/file-2.txt")

			// Only the single re-show of the edited file; no focus-restore round trip.
			expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1)
		})

		it("re-pins the edited file when it was pinned before the diff", async () => {
			const userActiveEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri("/mock/cwd/file-2.txt") }),
			})
			vscode.window.activeTextEditor = userActiveEditor
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())
			diffViewProvider["documentWasPinned"] = true

			await diffViewProvider["showEditedFileWithoutDisruptingFocus"]("/mock/cwd/file-2.txt")

			// The edited file must be focused (preserveFocus false) so pinEditor
			// targets the correct tab, then the pin command is issued.
			const calls = vi.mocked(vscode.window.showTextDocument).mock.calls
			expect(calls[0][1]).toMatchObject({ preview: false, preserveFocus: false })
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.pinEditor")
		})

		it("does not pin the edited file when it was not pinned before the diff", async () => {
			const userActiveEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri("/mock/cwd/file-2.txt") }),
			})
			vscode.window.activeTextEditor = userActiveEditor
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())
			diffViewProvider["documentWasPinned"] = false

			await diffViewProvider["showEditedFileWithoutDisruptingFocus"]("/mock/cwd/file-2.txt")

			expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.pinEditor")
		})
	})

	describe("closeAllDiffViews method", () => {
		it("should close diff views including those identified by label", async () => {
			// Mock tab groups with various types of tabs
			const mockTabs: vscode.Tab[] = [
				// Normal diff view
				makeTab(
					makeDiffTabInput(DIFF_VIEW_URI_SCHEME, "/test/file1.ts"),
					`file1.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
				),
				// Diff view identified by label (for pre-opened files)
				makeTab(
					// Different scheme due to pre-opening
					makeDiffTabInput("file", "/test/file2.md"),
					`file2.md: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
				),
				// Regular file tab (should not be closed)
				makeTab(makeTextTab("/test/file3.js"), "file3.js"),
				// Dirty diff view (should not be closed)
				makeTab(
					makeDiffTabInput(DIFF_VIEW_URI_SCHEME, "/test/file4.ts"),
					`file4.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
					{ isDirty: true },
				),
			]

			// Mock the tabGroups getter
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: (): vscode.TabGroup[] => [
					{ isActive: true, viewColumn: vscode.ViewColumn.One, activeTab: undefined, tabs: mockTabs },
				],
				configurable: true,
			})

			const closedTabs: vscode.Tab[] = []
			vi.mocked(vscode.window.tabGroups.close).mockImplementation((tab) => {
				// The close API also accepts whole groups; this suite only closes tabs.
				if ("length" in tab || "tabs" in tab) {
					throw new Error("unexpected tab group close")
				}
				closedTabs.push(tab)
				return Promise.resolve(true)
			})

			// Execute closeAllDiffViews
			await diffViewProvider["closeAllDiffViews"]()

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
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())
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
			expect(diffViewProvider.newProblemsMessage).toBe("")
			expect(diffViewProvider.userEdits).toBeUndefined()
			expect(diffViewProvider["relPath"]).toBe("test.ts")
			expect(diffViewProvider["newContent"]).toBe("new content")
		})
	})

	describe("saveChanges method with diagnostic settings", () => {
		beforeEach(() => {
			// Setup common mocks for saveChanges tests
			diffViewProvider["relPath"] = "test.ts"
			diffViewProvider["newContent"] = "new content"
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({ getText: vi.fn().mockReturnValue("new content") }),
			})
			diffViewProvider["preDiagnostics"] = []

			// Mock vscode functions
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
		})

		it("should apply diagnostic delay when diagnosticsEnabled is true", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			// Mock closeAllDiffViews
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)

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
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)

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
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)

			const result = await diffViewProvider.saveChanges()

			// Verify default behavior (enabled=true, delay falls back to DEFAULT_WRITE_DELAY_MS)
			expect(mockDelay).toHaveBeenCalledWith(0)
			expect(vscode.languages.getDiagnostics).toHaveBeenCalled()
			expect(result.newProblemsMessage).toBe("")
		})

		it("pins the default write delay to zero", () => {
			// The tests above compare against the constant, so they would still pass if the
			// default were changed back to 1000. Pin the value the write path actually uses.
			expect(DEFAULT_WRITE_DELAY_MS).toBe(0)
		})

		it("should handle custom delay values", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			// Mock closeAllDiffViews
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)

			await diffViewProvider.saveChanges(true, 5000)

			// Verify custom delay was used
			expect(mockDelay).toHaveBeenCalledWith(5000)
			expect(vscode.languages.getDiagnostics).toHaveBeenCalled()
		})
	})

	describe("preEditScrollLine capture and restore", () => {
		it("should capture scroll line from visible editor at open() time", async () => {
			const mockEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri(`${mockCwd}/scroll.ts`) }),
				visibleRanges: [makeRange(42)],
			})

			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(makeTextDocument({ uri: makeUri(`${mockCwd}/scroll.ts`) })), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			diffViewProvider.editType = "modify"

			await diffViewProvider.open("scroll.ts")

			expect(diffViewProvider["preEditScrollLine"]).toBe(42)
		})

		it("should set preEditScrollLine to undefined when the visible editor has no visibleRanges", async () => {
			const mockEditorNoRanges = makeTextEditor({
				document: makeTextDocument({ uri: makeUri(`${mockCwd}/new.ts`) }),
				// No visibleRanges, so the capture in open() yields undefined.
				visibleRanges: [],
			})

			vi.mocked(vscode.window).visibleTextEditors = [mockEditorNoRanges]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditorNoRanges)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(makeTextDocument({ uri: makeUri(`${mockCwd}/new.ts`) })), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			diffViewProvider.editType = "modify"

			await diffViewProvider.open("new.ts")

			expect(diffViewProvider["preEditScrollLine"]).toBeUndefined()
		})

		it("saveChanges() calls revealRange(AtTop) when documentWasOpen and preEditScrollLine is set", async () => {
			const mockRevealRange = vi.fn()
			const mockSavedEditor = makeTextEditor({ revealRange: mockRevealRange })

			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockSavedEditor)
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["documentWasOpen"] = true
			diffViewProvider["preEditScrollLine"] = 30
			// saveChanges early-exits without relPath, newContent, activeDiffEditor
			diffViewProvider["newContent"] = "content"
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({ getText: vi.fn().mockReturnValue("content") }),
			})

			await diffViewProvider.saveChanges(false)

			expect(mockRevealRange).toHaveBeenCalledWith(
				expect.objectContaining({ start: { line: 30, character: 0 } }),
				vscode.TextEditorRevealType.AtTop,
			)
		})

		it("saveChanges() does NOT call revealRange when preEditScrollLine is undefined", async () => {
			const mockRevealRange = vi.fn()
			const mockSavedEditor = makeTextEditor({ revealRange: mockRevealRange })

			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockSavedEditor)
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["documentWasOpen"] = true
			diffViewProvider["preEditScrollLine"] = undefined
			diffViewProvider["newContent"] = "content"
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({ getText: vi.fn().mockReturnValue("content") }),
			})

			await diffViewProvider.saveChanges(false)

			expect(mockRevealRange).not.toHaveBeenCalled()
		})

		it("saveChanges() cancels a pending deferred scroll so it cannot fight scroll-restore", async () => {
			// With auto-approve, saveChanges runs immediately after scrollToFirstDiff.
			// A late deferred reveal must not fire after the viewport is restored.
			vi.useFakeTimers()
			try {
				const deferredReveal = vi.fn()
				const liveEditor = makeTextEditor({
					document: makeTextDocument({
						uri: makeUri(`${mockCwd}/race.ts`),
						getText: vi.fn().mockReturnValue("a\nCHANGED\nc\nd\n"),
						lineCount: 5,
					}),
					visibleRanges: [makeRange()],
					revealRange: deferredReveal,
				})
				diffViewProvider.originalContent = "a\nb\nc\nd\n"
				diffViewProvider["activeDiffEditor"] = liveEditor
				vi.mocked(vscode.window).visibleTextEditors = [liveEditor]

				// Schedule the deferred reveal, then accept the edit before it fires.
				diffViewProvider.scrollToFirstDiff()
				expect(deferredReveal).toHaveBeenCalledTimes(1)

				vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())
				diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
				diffViewProvider["documentWasOpen"] = true
				diffViewProvider["preEditScrollLine"] = 0
				diffViewProvider["newContent"] = "a\nCHANGED\nc\nd\n"

				await diffViewProvider.saveChanges(false)

				// The timer was cancelled; advancing past it produces no extra reveal.
				vi.advanceTimersByTime(100)
				expect(deferredReveal).toHaveBeenCalledTimes(1)
				expect(diffViewProvider["deferredScrollTimer"]).toBeUndefined()
			} finally {
				vi.useRealTimers()
			}
		})

		it("revertChanges() calls revealRange(AtTop) when documentWasOpen and preEditScrollLine is set", async () => {
			const mockRevealRange = vi.fn()
			const mockSavedEditor = makeTextEditor({ revealRange: mockRevealRange })

			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockSavedEditor)
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["documentWasOpen"] = true
			diffViewProvider["preEditScrollLine"] = 15
			diffViewProvider.editType = "modify"
			diffViewProvider.originalContent = "original"
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(`${mockCwd}/test.txt`),
					getText: vi.fn().mockReturnValue("modified"),
					positionAt: vi.fn().mockReturnValue(makePosition()),
				}),
			})

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

		// vscode types `TextDocument.isDirty` as read-only, but the doubles in this block are plain
		// objects that a test has to dirty on purpose before `saveChanges()` runs. Widening the
		// document view of this one builder keeps every `editor.document.isDirty = ...` below a
		// plain assignment: the mutable structural type is what `makeTextDocument` actually hands
		// back at runtime, so no assertion and no `any` is needed.
		type ActiveDiffEditor = Omit<vscode.TextEditor, "document"> & {
			document: Omit<vscode.TextDocument, "isDirty"> & { isDirty: boolean }
		}

		const buildActiveDiffEditor = (): ActiveDiffEditor =>
			makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					positionAt: vi.fn().mockReturnValue(makePosition()),
				}),
			})

		it("saveChanges() closes the file tab when the file was not open and untouched", async () => {
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = closeFileTab
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["documentWasOpen"] = false
			diffViewProvider["userTouchedDocument"] = false
			diffViewProvider["preEditScrollLine"] = undefined
			diffViewProvider["newContent"] = "content"
			diffViewProvider["activeDiffEditor"] = buildActiveDiffEditor()

			await diffViewProvider.saveChanges(false)

			expect(closeFileTab).toHaveBeenCalledWith(mockTargetPath)
			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		})

		it("saveChanges() keeps the file open when the user touched it", async () => {
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = closeFileTab
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["documentWasOpen"] = false
			diffViewProvider["userTouchedDocument"] = true
			diffViewProvider["preEditScrollLine"] = undefined
			diffViewProvider["newContent"] = "content"
			diffViewProvider["activeDiffEditor"] = buildActiveDiffEditor()

			await diffViewProvider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})

		it("revertChanges() removes the placeholder and created dirs when open() failed before the editor existed", async () => {
			// open() creates the parent dirs and an empty placeholder BEFORE it awaits
			// openDiffEditor(). If that await rejects there is no activeDiffEditor, and the
			// rollback used to bail out - leaving an empty file that the next execute() mistook
			// for an existing file, which a denial then preserved.
			const createdDirs = [`${mockCwd}/new-parent`, `${mockCwd}/new-parent/nested`]
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs,
				// open() claimed the placeholder before its editor open rejected.
				placeholderPath: `${mockCwd}/mock-target-file.ts`,
			})

			await diffViewProvider.revertChanges()

			expect(fs.unlink).toHaveBeenCalledWith(`${mockCwd}/mock-target-file.ts`)
			expect(fs.rmdir).toHaveBeenNthCalledWith(1, createdDirs[1])
			expect(fs.rmdir).toHaveBeenNthCalledWith(2, createdDirs[0])
		})

		it("revertChanges() tolerates a placeholder that was never written", async () => {
			// The failed open may have died before fs.writeFile ran; ENOENT during the
			// rollback is success, not a new failure that would abort the cleanup.
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs: [],
				// Ownership was claimed (open()'s write succeeded); the file vanished externally
				// before the rollback ran.
				placeholderPath: `${mockCwd}/mock-target-file.ts`,
			})
			vi.mocked(fs.unlink).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

			await expect(diffViewProvider.revertChanges()).resolves.toBeUndefined()

			// The rollback still attempted the delete - the tolerance is about not
			// aborting the rest of the cleanup, not about skipping it.
			expect(fs.unlink).toHaveBeenCalledWith(`${mockCwd}/mock-target-file.ts`)
		})

		it("open() does not claim placeholder ownership when the placeholder write fails", async () => {
			// The failed open may have died inside fs.writeFile(); placeholderPath is set only
			// after the write succeeds, so a failed write must not mark a file this edit never
			// created as owned, and the rollback must still remove the directories it did
			// create without unlinking the unowned path.
			const { createDirectoriesForFile } = await import("../../../utils/fs")
			vi.mocked(createDirectoriesForFile).mockResolvedValueOnce([`${mockCwd}/new-parent`])
			vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error("EACCES: permission denied"))

			await expect(diffViewProvider.open("mock-target-file.ts")).rejects.toThrow("EACCES: permission denied")

			expect(diffViewProvider["placeholderPath"]).toBeUndefined()
			expect(diffViewProvider["createdDirs"]).toEqual([`${mockCwd}/new-parent`])

			await diffViewProvider.revertChanges()

			expect(fs.unlink).not.toHaveBeenCalled()
			expect(fs.rmdir).toHaveBeenCalledWith(`${mockCwd}/new-parent`)
		})

		it("discardOwnedPlaceholder() unlinks the owned placeholder and releases ownership", async () => {
			// The approved-but-uncommitted state: the file on disk is still the empty
			// placeholder this edit created, so removing it is safe and releasing ownership
			// after the removal keeps reset() from stranding it unowned.
			diffViewProvider["placeholderPath"] = mockTargetPath

			await diffViewProvider.discardOwnedPlaceholder()

			expect(fs.unlink).toHaveBeenCalledWith(mockTargetPath)
			expect(diffViewProvider["placeholderPath"]).toBeUndefined()
			// The public getter, not only the field it reads: nothing else in this spec asserts the released
			// state, so a getter that always reported true would pass the suite.
			expect(diffViewProvider.ownsPlaceholder).toBe(false)
		})

		it("discardOwnedPlaceholder() keeps ownership when the removal fails", async () => {
			// An EPERM unlink must not release ownership: the placeholder is still on disk,
			// and the caller needs the intact state to retry or to report the hazard.
			diffViewProvider["placeholderPath"] = mockTargetPath
			vi.mocked(fs.unlink).mockRejectedValueOnce(
				Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }),
			)

			await expect(diffViewProvider.discardOwnedPlaceholder()).rejects.toThrow("EPERM: operation not permitted")
			expect(diffViewProvider["placeholderPath"]).toBe(mockTargetPath)
		})

		it("discardOwnedPlaceholder() is a no-op without ownership and tolerates a vanished file", async () => {
			// An edit that never created a file must not unlink anything, and a placeholder
			// that vanished externally is still a released ownership, not a new failure.
			await diffViewProvider.discardOwnedPlaceholder()
			expect(fs.unlink).not.toHaveBeenCalled()

			diffViewProvider["placeholderPath"] = mockTargetPath
			vi.mocked(fs.unlink).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

			await expect(diffViewProvider.discardOwnedPlaceholder()).resolves.toBeUndefined()
			expect(diffViewProvider["placeholderPath"]).toBeUndefined()
		})

		it("revertChanges() stops before the document work for an existing file when no editor exists", async () => {
			// The modify branch used to dereference activeDiffEditor unconditionally. When open()
			// never produced an editor there is no document to restore, and the old code threw a
			// TypeError out of the denial path instead of finishing the teardown.
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "modify",
				createdDirs: [],
			})

			await expect(diffViewProvider.revertChanges()).resolves.toBeUndefined()

			expect(vscode.workspace.applyEdit).not.toHaveBeenCalled()
			expect(fs.unlink).not.toHaveBeenCalled()
			expect(fs.rmdir).not.toHaveBeenCalled()
			// Only the document work is skipped: the shared teardown still runs, so no
			// stale session survives the rollback.
			expect(diffViewProvider["relPath"]).toBeUndefined()
			expect(diffViewProvider["isEditing"]).toBe(false)
			expect(diffViewProvider["editType"]).toBeUndefined()
		})

		it("revertChanges() keeps rolling back the remaining directories when one rmdir hits ENOENT", async () => {
			// Same tolerance as the placeholder, for the created dirs: a directory that never
			// landed must not abort the rest of the rollback and must not surface as a new failure.
			const createdDirs = [`${mockCwd}/new-parent`, `${mockCwd}/new-parent/nested`]
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs,
			})
			vi.mocked(fs.rmdir).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

			await expect(diffViewProvider.revertChanges()).resolves.toBeUndefined()

			expect(fs.rmdir).toHaveBeenCalledTimes(2)
			expect(fs.rmdir).toHaveBeenNthCalledWith(1, createdDirs[1])
			expect(fs.rmdir).toHaveBeenNthCalledWith(2, createdDirs[0])
		})

		it("revertChanges() surfaces a non-ENOENT directory failure instead of swallowing it", async () => {
			// The tolerance is scoped to ENOENT: a directory that exists but could not be removed
			// is a real rollback failure and must reach the caller rather than be hidden.
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs: [`${mockCwd}/new-parent`],
			})
			vi.mocked(fs.rmdir).mockRejectedValueOnce(Object.assign(new Error("EBUSY"), { code: "EBUSY" }))

			await expect(diffViewProvider.revertChanges()).rejects.toThrow("EBUSY")
		})

		it("revertChanges() keeps placeholder ownership when the unlink fails", async () => {
			// A rollback that cannot remove the placeholder must leave it OWNED: the caller
			// skips reset() on that signal and keeps a retry path, instead of the empty file
			// being stranded unowned for the next attempt to mistake for an existing file.
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs: [],
				placeholderPath: mockTargetPath,
			})
			vi.mocked(fs.unlink).mockRejectedValueOnce(
				Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }),
			)

			await expect(diffViewProvider.revertChanges()).rejects.toThrow("EPERM: operation not permitted")
			expect(diffViewProvider["placeholderPath"]).toBe(mockTargetPath)
			expect(diffViewProvider.ownsPlaceholder).toBe(true)
		})

		it("revertChanges() releases placeholder ownership once the unlink succeeded even if a directory removal fails", async () => {
			// Ownership tracks the file, not the whole rollback: after the unlink lands, the
			// ownership is released before the directory loop, so a later EBUSY cannot strand
			// an ownership whose file no longer exists.
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs: [`${mockCwd}/new-parent`],
				placeholderPath: mockTargetPath,
			})
			vi.mocked(fs.rmdir).mockRejectedValueOnce(Object.assign(new Error("EBUSY"), { code: "EBUSY" }))

			await expect(diffViewProvider.revertChanges()).rejects.toThrow("EBUSY")
			expect(fs.unlink).toHaveBeenCalledWith(mockTargetPath)
			expect(diffViewProvider["placeholderPath"]).toBeUndefined()
		})

		it("discardUnapprovedStream() keeps placeholder ownership when the unlink fails", async () => {
			// Same discipline as revertChanges(): the abandoned-stream cleanup runs even with
			// no editor, and a failed unlink must leave the placeholder owned so the caller
			// can skip reset() and keep a retry path instead of stranding it unowned.
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs: [],
				placeholderPath: mockTargetPath,
			})
			vi.mocked(fs.unlink).mockRejectedValueOnce(
				Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }),
			)

			await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow("EPERM: operation not permitted")
			expect(diffViewProvider["placeholderPath"]).toBe(mockTargetPath)
		})

		it("revertChanges() after reset() does not unlink a file this edit never created", async () => {
			// reset() used to leave relPath behind with editType cleared, which is exactly the state
			// that sends the NEXT rollback down the new-file branch: fs.unlink on whatever file this
			// provider last touched. A truncated tool call or an EACCES in a later write then deleted
			// a file the user had already saved.
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs: [],
				placeholderPath: mockTargetPath,
			})

			await diffViewProvider.reset()
			await diffViewProvider.revertChanges()

			expect(diffViewProvider["relPath"]).toBeUndefined()
			expect(fs.unlink).not.toHaveBeenCalled()
		})
		it("revertChanges() after a FAILED reset does not delete the previously approved file", async () => {
			// An approved new-file write landed and reset() then rejected on the tab close.
			// Without the finally, relPath/editType/isEditing and the placeholder ownership
			// survived the failure: the next execution skipped open(), reused the stale create
			// session, and a later denial's rollback unlinked the file the user had approved.
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				isEditing: true,
				createdDirs: [],
				placeholderPath: mockTargetPath,
			})
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockRejectedValue(new Error("close failed"))

			await expect(diffViewProvider.reset()).rejects.toThrow("close failed")

			// The failed reset still released the session and the placeholder ownership.
			expect(diffViewProvider["relPath"]).toBeUndefined()
			expect(diffViewProvider["editType"]).toBeUndefined()
			expect(diffViewProvider["isEditing"]).toBe(false)
			expect(diffViewProvider["placeholderPath"]).toBeUndefined()

			// The next edit's denial rolls back owning no placeholder: the previously approved
			// file must survive even though a relPath is set again. The tab close succeeds this
			// time - only the rollback's delete authority is under test.
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			Object.assign(diffViewProvider, {
				relPath: "follow-up-denied.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs: [],
			})
			await diffViewProvider.revertChanges()
			expect(fs.unlink).not.toHaveBeenCalled()
		})

		it("saveChanges() signals its commit point at the document save, not on return", async () => {
			// Everything after the save - closing the diff views, tab bookkeeping, diagnostics - can
			// still reject. A caller that rolls the tool call back on that rejection would undo a
			// write that already landed, so it has to be told at the save rather than when the
			// method returns.
			const order: string[] = []
			const editor = buildActiveDiffEditor()
			editor.document.isDirty = true
			editor.document.save = vi.fn(async () => {
				order.push("save")
				return true
			})
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				newContent: "content",
				activeDiffEditor: editor,
				placeholderPath: mockTargetPath,
				closeFileTab: vi.fn().mockResolvedValue(undefined),
				restorePreviewTabs: vi.fn().mockResolvedValue(undefined),
			})
			diffViewProvider["closeAllDiffViews"] = vi.fn(async () => {
				order.push("closeDiffViews")
			})

			await diffViewProvider.saveChanges(false, 0, () => {
				order.push("commit")
			})

			expect(order).toEqual(["save", "commit", "closeDiffViews"])
			// Ownership follows the same line: the placeholder open() created is only released once
			// the approved content is on disk.
			expect(diffViewProvider["placeholderPath"]).toBeUndefined()
		})

		it("saveChanges() withholds the commit point and the placeholder when the save rejects", async () => {
			// A rejected save means nothing landed. Signalling the commit point anyway would tell
			// the caller the rollback has to stand down, and clearing placeholderPath would tell
			// discardUnapprovedStream() that nothing this edit created is left to remove - the empty
			// or half-written new file would survive the failed write.
			const order: string[] = []
			const editor = buildActiveDiffEditor()
			editor.document.isDirty = true
			editor.document.save = vi.fn(async () => {
				order.push("save")
				throw new Error("save rejected")
			})
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				newContent: "content",
				activeDiffEditor: editor,
				placeholderPath: mockTargetPath,
				closeFileTab: vi.fn().mockResolvedValue(undefined),
			})

			await expect(diffViewProvider.saveChanges(false, 0, () => order.push("commit"))).rejects.toThrow(
				"save rejected",
			)

			expect(order).toEqual(["save"])
			expect(diffViewProvider["placeholderPath"]).toBe(mockTargetPath)
		})

		it("saveChanges() does not commit when the save resolves false", async () => {
			// save() can resolve false without throwing: the write did not persist. The commit
			// point was never reached, so onCommit must not run and the placeholder must stay
			// owned - reporting the write as durable would strand an unpersisted file whose
			// cleanup ownership had already been released.
			const order: string[] = []
			const editor = buildActiveDiffEditor()
			editor.document.isDirty = true
			editor.document.save = vi.fn(async () => {
				order.push("save")
				return false
			})
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				newContent: "content",
				activeDiffEditor: editor,
				placeholderPath: mockTargetPath,
			})

			await expect(diffViewProvider.saveChanges(false, 0, () => order.push("commit"))).rejects.toThrow(
				"was not confirmed; the write was not committed",
			)

			expect(order).toEqual(["save"])
			expect(diffViewProvider["placeholderPath"]).toBe(mockTargetPath)
		})

		it("saveChanges() commits an already-clean document and releases placeholder ownership", async () => {
			// A clean document already matches disk and never saves, but it crosses the same
			// commit point: the callback must run and the placeholder ownership must be
			// released even though no save happened.
			const editor = buildActiveDiffEditor()
			editor.document.isDirty = false
			const onCommit = vi.fn()
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				newContent: "content",
				activeDiffEditor: editor,
				placeholderPath: mockTargetPath,
				documentWasOpen: false,
				userTouchedDocument: false,
				preEditScrollLine: undefined,
				editType: "modify",
				originalContent: "original",
			})

			await diffViewProvider.saveChanges(false, 0, onCommit)

			expect(editor.document.save).not.toHaveBeenCalled()
			expect(onCommit).toHaveBeenCalledTimes(1)
			expect(diffViewProvider["placeholderPath"]).toBeUndefined()
		})

		it("revertChanges() surfaces a placeholder delete that failed for a non-ENOENT reason", async () => {
			// The ENOENT tolerance is scoped: an unlink that fails for another reason means the
			// unapproved placeholder is still on disk, and the caller must not be told the
			// rollback succeeded.
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs: [],
				placeholderPath: mockTargetPath,
			})
			vi.mocked(fs.unlink).mockRejectedValueOnce(
				Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
			)

			await expect(diffViewProvider.revertChanges()).rejects.toThrow("EACCES: permission denied")
		})

		it("revertChanges() restores the streamed buffer to its pre-stream content before closing and unlinking a new file", async () => {
			// The diff buffer holds the streamed content of a write that was never approved.
			// Saving it as-is persisted exactly what this rollback is undoing - local history, file
			// watchers, and, if the delete below fails, the content itself. The rollback restores the
			// pre-stream content first and only then saves, so the only content ever written is the
			// empty pre-stream buffer.
			const editor = buildActiveDiffEditor()
			editor.document.isDirty = true
			editor.document.save = vi.fn().mockResolvedValue(true)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			const dirtyTab = {
				input: Object.assign(new vscode.TabInputText(makeUri(mockTargetPath)), {
					uri: makeUri(mockTargetPath),
				}),
				isDirty: true,
				label: "mock-target-file.ts",
			}
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [dirtyTab] }],
				configurable: true,
			})
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "create",
				createdDirs: [],
				originalContent: "",
				placeholderPath: mockTargetPath,
			})

			try {
				await diffViewProvider.revertChanges()
			} finally {
				// Do not leak the tab fixture: later tests read the module-level tabGroups.all.
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
			}

			expect(editor.document.save).toHaveBeenCalledTimes(1)
			const [, , replacedText] = mockWorkspaceEdit.replace.mock.calls[0]
			expect(replacedText).toBe("")
			// No force argument: tabGroups.close()'s second parameter is preserveFocus, not a
			// discard flag, so passing true never discarded anything - it only suppressed the
			// prompt while the dirty tab was silently refused.
			expect(vscode.window.tabGroups.close).toHaveBeenCalledWith(dirtyTab)
			expect(fs.unlink).toHaveBeenCalledWith(mockTargetPath)
		})

		it("revertChanges() cleans and closes the dirty vscode.diff tab before unlinking the new file", async () => {
			// The denial-path hazard named on the pre-merge check: openDiffEditor() opens a
			// vscode.diff tab whose input is a TabInputTextDiff, closeAllDiffViews() skips that tab
			// while its modified side is dirty, and unlinking the placeholder underneath the open
			// dirty tab left unapproved content one save away from recreating the deleted file.
			// The provider's own tab helpers are deliberately NOT stubbed: the tab cleanup order
			// through the real helpers is what is under test.
			const callOrder: string[] = []
			const document = {
				isDirty: true,
				getText: () => "partial model output",
				positionAt: (offset: number) => ({ line: 0, character: offset }),
				uri: makeUri(mockTargetPath),
				save: vi.fn(async () => {
					callOrder.push("save")
					document.isDirty = false
					return true
				}),
			}
			const diffTab = {
				label: `mock-target-file.ts ${DIFF_VIEW_LABEL_CHANGES}`,
				input: Object.assign(new vscode.TabInputTextDiff(makeUri("diff-original"), makeUri(mockTargetPath)), {
					original: { scheme: DIFF_VIEW_URI_SCHEME, fsPath: "mock-target-file.ts" },
					modified: { scheme: "file", fsPath: mockTargetPath },
				}),
				// The tab is dirty exactly while the modified-side buffer is: the rollback has to
				// make the buffer clean for the tab to become closeable at all.
				get isDirty() {
					return document.isDirty
				},
			}
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [diffTab] }],
				configurable: true,
			})
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: { document },
				editType: "create",
				createdDirs: [],
				originalContent: "",
				placeholderPath: mockTargetPath,
			})
			vi.mocked(vscode.workspace.applyEdit).mockImplementation(async () => {
				callOrder.push("applyEdit")
				return true
			})
			vi.mocked(vscode.window.tabGroups.close).mockImplementation(async () => {
				callOrder.push("closeTab")
				return true
			})
			vi.mocked(fs.unlink).mockImplementation(async () => {
				callOrder.push("unlink")
				return undefined
			})

			try {
				await diffViewProvider.revertChanges()
			} finally {
				// Do not leak the tab fixture: later tests read the module-level tabGroups.all.
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
			}

			// The buffer is put back to its pre-stream (empty) content and saved clean before
			// anything closes, and the tab is gone before the file is deleted: no save can
			// recreate the abandoned file from a buffer the user never approved.
			expect(callOrder.slice(0, 2)).toEqual(["applyEdit", "save"])
			const [, , replacedText] = mockWorkspaceEdit.replace.mock.calls[0]
			expect(replacedText).toBe("")
			expect(callOrder.indexOf("closeTab")).toBeGreaterThan(-1)
			expect(callOrder.indexOf("closeTab")).toBeLessThan(callOrder.indexOf("unlink"))
			expect(fs.unlink).toHaveBeenCalledWith(mockTargetPath)
		})

		it("revertChanges() reports a discard the editor refused instead of leaving the buffer open", async () => {
			// A forced close can still fail (a vetoing editor). Swallowing that left the unapproved
			// streamed content in an open, saveable buffer while the rollback kept deleting the
			// file underneath it. The failure must propagate, and the buffer must be put back to
			// its pre-stream state so nothing saveable survives.
			const editor = buildActiveDiffEditor()
			editor.document.isDirty = true
			// The diff-side restore/save confirms; the file-scheme buffer below is the one
			// whose close gets vetoed.
			editor.document.save = vi.fn().mockResolvedValue(true)
			const streamedBuffer = {
				uri: makeUri(mockTargetPath),
				getText: vi.fn().mockReturnValue("streamed content"),
				isDirty: true,
				positionAt: vi.fn().mockReturnValue({ line: 0, character: 0 }),
				save: vi.fn().mockResolvedValue(true),
			}
			const dirtyTab = {
				input: Object.assign(new vscode.TabInputText(makeUri(mockTargetPath)), {
					uri: makeUri(mockTargetPath),
				}),
				isDirty: true,
				label: "mock-target-file.ts",
			}
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			const originalDocuments = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [dirtyTab] }],
				configurable: true,
			})
			Object.defineProperty(vscode.workspace, "textDocuments", {
				value: [streamedBuffer],
				configurable: true,
			})
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "create",
				createdDirs: [],
				originalContent: "",
			})
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			vi.mocked(vscode.window.tabGroups.close).mockRejectedValueOnce(new Error("close vetoed"))

			try {
				await expect(diffViewProvider.revertChanges()).rejects.toThrow("could not close the restored buffer")
			} finally {
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
				if (originalDocuments) {
					Object.defineProperty(vscode.workspace, "textDocuments", originalDocuments)
				}
			}

			// The buffer went back to its pre-stream state and was saved clean BEFORE the close,
			// so the close never saw a dirty tab; the rollback then stopped rather than deleting the
			// file out from under a buffer it could not discard.
			expect(vscode.workspace.applyEdit).toHaveBeenCalled()
			expect(streamedBuffer.save).toHaveBeenCalledTimes(1)
			expect(vscode.window.tabGroups.close).toHaveBeenCalledWith(dirtyTab)
			// The buffer was put back to its pre-stream state (empty for a new file): the edit that
			// was applied replaces the streamed text with originalContent.
			const appliedEdit = vi.mocked(vscode.WorkspaceEdit).mock.results[0].value
			expect(appliedEdit.replace).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: mockTargetPath }),
				expect.anything(),
				"",
			)
		})

		it("revertChanges() stops the rollback without closing when the buffer restore is refused", async () => {
			// applyEdit resolving false leaves the streamed content in the buffer. Saving it would
			// persist exactly what this rollback exists to discard, and closing the dirty tab would
			// trade the rollback report for a save-confirmation prompt over unapproved content, so
			// the rollback stops and reports instead.
			const editor = buildActiveDiffEditor()
			editor.document.isDirty = true
			const streamedBuffer = {
				uri: makeUri(mockTargetPath),
				getText: vi.fn().mockReturnValue("streamed content"),
				isDirty: true,
				positionAt: vi.fn().mockReturnValue({ line: 0, character: 0 }),
				save: vi.fn().mockResolvedValue(undefined),
			}
			const dirtyTab = {
				input: Object.assign(new vscode.TabInputText(makeUri(mockTargetPath)), {
					uri: makeUri(mockTargetPath),
				}),
				isDirty: true,
				label: "mock-target-file.ts",
			}
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			const originalDocuments = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [dirtyTab] }],
				configurable: true,
			})
			Object.defineProperty(vscode.workspace, "textDocuments", {
				value: [streamedBuffer],
				configurable: true,
			})
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "create",
				createdDirs: [],
				originalContent: "",
			})
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValueOnce(false)

			try {
				await expect(diffViewProvider.revertChanges()).rejects.toThrow(/could not restore the buffer/i)
			} finally {
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
				if (originalDocuments) {
					Object.defineProperty(vscode.workspace, "textDocuments", originalDocuments)
				}
			}

			// The restore was attempted and refused; the save that would have written the unapproved
			// streamed content to disk never ran, and the dirty tab was NOT closed - closing it
			// would trade a safe rollback report for a save-confirmation prompt over unapproved
			// content. The rollback stops here and reports.
			expect(vscode.workspace.applyEdit).toHaveBeenCalled()
			expect(streamedBuffer.save).not.toHaveBeenCalled()
			expect(vscode.window.tabGroups.close).not.toHaveBeenCalled()
		})

		it("revertChanges() stops the rollback when the file buffer restore is the refused one", async () => {
			// The row above refuses the first applyEdit, which is the diff-editor restore, so the
			// file-scheme buffer's own restore - the guard in front of the tab close - is never the
			// one under test. Here the diff-side restore and its save both confirm, so the rollback
			// reaches the file-scheme buffer and THAT restore is the refusal: the class has to stop
			// before closing a tab whose buffer still holds the streamed content.
			const editor = buildActiveDiffEditor()
			editor.document.isDirty = true
			editor.document.save = vi.fn().mockResolvedValue(true)
			const streamedBuffer = {
				uri: makeUri(mockTargetPath),
				getText: vi.fn().mockReturnValue("streamed content"),
				isDirty: true,
				positionAt: vi.fn((offset: number) => ({ line: 0, character: offset })),
				save: vi.fn().mockResolvedValue(true),
			}
			const fileTab = {
				input: Object.assign(new vscode.TabInputText(makeUri(mockTargetPath)), {
					uri: makeUri(mockTargetPath),
				}),
				isDirty: true,
				label: "mock-target-file.ts",
			}
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			const originalDocuments = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [fileTab] }],
				configurable: true,
			})
			Object.defineProperty(vscode.workspace, "textDocuments", {
				value: [streamedBuffer],
				configurable: true,
			})
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "create",
				createdDirs: [],
				originalContent: "",
			})
			// The first applyEdit is the diff-editor restore and it lands; the second is the
			// file-scheme buffer's restore, and that is the one VS Code refuses.
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValueOnce(true).mockResolvedValueOnce(false)

			try {
				await expect(diffViewProvider.revertChanges()).rejects.toThrow(/could not restore the buffer/i)
			} finally {
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
				if (originalDocuments) {
					Object.defineProperty(vscode.workspace, "textDocuments", originalDocuments)
				}
			}

			// Both restores were attempted, so the refusal that stopped the rollback is the second one;
			// the diff-side save confirmed and the file-scheme buffer was neither saved nor closed.
			expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(2)
			expect(editor.document.save).toHaveBeenCalledTimes(1)
			expect(streamedBuffer.save).not.toHaveBeenCalled()
			expect(vscode.window.tabGroups.close).not.toHaveBeenCalled()
		})

		it("revertChanges() stops the rollback without closing when the clean save is not confirmed", async () => {
			// document.save() resolving false leaves the buffer's clean state unconfirmed. Closing
			// then would prompt the user over a possibly-dirty tab, and answering yes can write
			// content the rollback never confirmed clean, so the close is skipped and the failure
			// is reported.
			const editor = buildActiveDiffEditor()
			editor.document.isDirty = true
			// The diff-side restore/save confirms; the file-scheme buffer below is the one whose
			// save stays unconfirmed.
			editor.document.save = vi.fn().mockResolvedValue(true)
			const streamedBuffer = {
				uri: makeUri(mockTargetPath),
				getText: vi.fn().mockReturnValue("streamed content"),
				isDirty: true,
				positionAt: vi.fn().mockReturnValue({ line: 0, character: 0 }),
				save: vi.fn().mockResolvedValue(false),
			}
			const dirtyTab = {
				input: Object.assign(new vscode.TabInputText(makeUri(mockTargetPath)), {
					uri: makeUri(mockTargetPath),
				}),
				isDirty: true,
				label: "mock-target-file.ts",
			}
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			const originalDocuments = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [dirtyTab] }],
				configurable: true,
			})
			Object.defineProperty(vscode.workspace, "textDocuments", {
				value: [streamedBuffer],
				configurable: true,
			})
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "create",
				createdDirs: [],
				originalContent: "",
			})
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)

			try {
				await expect(diffViewProvider.revertChanges()).rejects.toThrow(/could not save the restored buffer/i)
			} finally {
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
				if (originalDocuments) {
					Object.defineProperty(vscode.workspace, "textDocuments", originalDocuments)
				}
			}

			// The restore applied and the save was attempted, but the unconfirmed save stops the
			// rollback before the close.
			expect(streamedBuffer.save).toHaveBeenCalledTimes(1)
			expect(vscode.window.tabGroups.close).not.toHaveBeenCalled()
		})

		it("revertChanges() closes the file tab when the file was not open and untouched", async () => {
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = closeFileTab
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["documentWasOpen"] = false
			diffViewProvider["userTouchedDocument"] = false
			diffViewProvider["preEditScrollLine"] = undefined
			diffViewProvider.editType = "modify"
			diffViewProvider.originalContent = "original"
			diffViewProvider["activeDiffEditor"] = buildActiveDiffEditor()

			await diffViewProvider.revertChanges()

			expect(closeFileTab).toHaveBeenCalledWith(mockTargetPath)
			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		})

		it("revertChanges() keeps the file open when the user touched it", async () => {
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = closeFileTab
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["documentWasOpen"] = false
			diffViewProvider["userTouchedDocument"] = true
			diffViewProvider["preEditScrollLine"] = undefined
			diffViewProvider.editType = "modify"
			diffViewProvider.originalContent = "original"
			diffViewProvider["activeDiffEditor"] = buildActiveDiffEditor()

			await diffViewProvider.revertChanges()

			expect(closeFileTab).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})

		it("marks userTouchedDocument when the file editor is activated during the diff", async () => {
			let activeCallback: ((editor: vscode.TextEditor) => void) | undefined
			vi.mocked(vscode.window.onDidChangeActiveTextEditor).mockImplementation((cb) => {
				activeCallback = cb
				return { dispose: vi.fn() }
			})

			const mockEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri(mockTargetPath) }),
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(makeTextDocument({ uri: makeUri(mockTargetPath) })), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			diffViewProvider.editType = "modify"
			diffViewProvider["documentWasOpen"] = false

			await diffViewProvider.open("mock-target-file.ts")

			// Simulate the user activating the plain file editor (no diff tab active).
			// TabGroup double provides the activeTab.input the touch-guard inspects.
			const activeGroup: vscode.TabGroup = {
				isActive: true,
				viewColumn: vscode.ViewColumn.One,
				activeTab: makeTab(makeTextTab(mockTargetPath), "mock-target-file.ts"),
				tabs: [],
			}
			Object.defineProperty(vscode.window.tabGroups, "activeTabGroup", {
				value: activeGroup,
				configurable: true,
			})
			activeCallback?.(makeTextEditor({ document: makeTextDocument({ uri: makeUri(mockTargetPath) }) }))

			expect(diffViewProvider["userTouchedDocument"]).toBe(true)
		})
	})

	describe("userTouchedDiffEditor keep/close behavior", () => {
		const mockTargetPath = `${mockCwd}/mock-target-file.ts`

		const buildActiveDiffEditor = () =>
			makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					positionAt: vi.fn().mockReturnValue(makePosition()),
				}),
			})

		it("saveChanges() keeps the file open when the user clicked inside the diff editor", async () => {
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = closeFileTab
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["documentWasOpen"] = false
			diffViewProvider["userTouchedDocument"] = false
			// The user clicked in the diff editor -- the flag is true.
			diffViewProvider["userTouchedDiffEditor"] = true
			diffViewProvider["preEditScrollLine"] = undefined
			diffViewProvider["newContent"] = "content"
			diffViewProvider["activeDiffEditor"] = buildActiveDiffEditor()

			await diffViewProvider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})

		it("saveChanges() closes the file tab when the user only scrolled (not clicked) in the diff", async () => {
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = closeFileTab
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["documentWasOpen"] = false
			diffViewProvider["userTouchedDocument"] = false
			// The user only scrolled -- the flag stays false.
			diffViewProvider["userTouchedDiffEditor"] = false
			diffViewProvider["preEditScrollLine"] = undefined
			diffViewProvider["newContent"] = "content"
			diffViewProvider["activeDiffEditor"] = buildActiveDiffEditor()

			await diffViewProvider.saveChanges(false)

			expect(closeFileTab).toHaveBeenCalledWith(mockTargetPath)
			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		})

		it("open() registers onDidChangeTextEditorSelection and sets userTouchedDiffEditor on event", async () => {
			let selectionCallback: ((event: vscode.TextEditorSelectionChangeEvent) => void) | undefined
			vi.mocked(vscode.window.onDidChangeTextEditorSelection).mockImplementation((cb) => {
				selectionCallback = cb
				return { dispose: vi.fn() }
			})

			const mockEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri(`${mockCwd}/sel.ts`) }),
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(makeTextDocument({ uri: makeUri(`${mockCwd}/sel.ts`) })), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			diffViewProvider.editType = "modify"

			await diffViewProvider.open("sel.ts")

			expect(diffViewProvider["userTouchedDiffEditor"]).toBe(false)

			// Simulate a Mouse selection-change event on the captured diff editor.
			const activeDiffEditor = diffViewProvider["activeDiffEditor"]
			if (!activeDiffEditor) {
				throw new Error("activeDiffEditor was not set")
			}
			selectionCallback?.({
				textEditor: activeDiffEditor,
				selections: [],
				kind: vscode.TextEditorSelectionChangeKind.Mouse,
			})

			expect(diffViewProvider["userTouchedDiffEditor"]).toBe(true)
		})

		it("open() does NOT set userTouchedDiffEditor for programmatic selection changes (kind=Command or undefined)", async () => {
			let selectionCallback: ((event: vscode.TextEditorSelectionChangeEvent) => void) | undefined
			vi.mocked(vscode.window.onDidChangeTextEditorSelection).mockImplementation((cb) => {
				selectionCallback = cb
				return { dispose: vi.fn() }
			})

			const mockEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri(`${mockCwd}/prog.ts`) }),
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(makeTextDocument({ uri: makeUri(`${mockCwd}/prog.ts`) })), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			diffViewProvider.editType = "modify"

			await diffViewProvider.open("prog.ts")

			const activeDiffEditor = diffViewProvider["activeDiffEditor"]
			if (!activeDiffEditor) {
				throw new Error("activeDiffEditor was not set")
			}

			// Programmatic change via editor.selection= (kind undefined) -- e.g. revealDiffLine
			selectionCallback?.({ textEditor: activeDiffEditor, selections: [], kind: undefined })
			expect(diffViewProvider["userTouchedDiffEditor"]).toBe(false)

			// Programmatic change via command (kind=Command)
			selectionCallback?.({
				textEditor: activeDiffEditor,
				selections: [],
				kind: vscode.TextEditorSelectionChangeKind.Command,
			})
			expect(diffViewProvider["userTouchedDiffEditor"]).toBe(false)
		})

		it("open() sets userTouchedDiffEditor when event comes from a fresh editor instance wrapping the same document (stale ref fix)", async () => {
			let selectionCallback: ((event: vscode.TextEditorSelectionChangeEvent) => void) | undefined
			vi.mocked(vscode.window.onDidChangeTextEditorSelection).mockImplementation((cb) => {
				selectionCallback = cb
				return { dispose: vi.fn() }
			})

			const sharedDocument = makeTextDocument({ uri: makeUri(`${mockCwd}/stale.ts`) })
			const originalEditor = makeTextEditor({ document: sharedDocument })
			vi.mocked(vscode.window).visibleTextEditors = [originalEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(originalEditor)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(makeTextDocument({ uri: makeUri(`${mockCwd}/stale.ts`) })), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			diffViewProvider.editType = "modify"

			await diffViewProvider.open("stale.ts")

			// Simulate VS Code giving us a NEW editor object that wraps the same
			// document -- this is the real-world stale reference scenario.
			const freshEditorSameDoc = makeTextEditor({ document: sharedDocument })
			selectionCallback?.({
				textEditor: freshEditorSameDoc,
				selections: [],
				kind: vscode.TextEditorSelectionChangeKind.Mouse,
			})

			expect(diffViewProvider["userTouchedDiffEditor"]).toBe(true)
		})

		it("open() ignores selection events on editors other than the diff editor", async () => {
			let selectionCallback: ((event: vscode.TextEditorSelectionChangeEvent) => void) | undefined
			vi.mocked(vscode.window.onDidChangeTextEditorSelection).mockImplementation((cb) => {
				selectionCallback = cb
				return { dispose: vi.fn() }
			})

			const mockEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri(`${mockCwd}/other.ts`) }),
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(makeTextDocument({ uri: makeUri(`${mockCwd}/other.ts`) })), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			diffViewProvider.editType = "modify"

			await diffViewProvider.open("other.ts")

			// Fire the event with a completely different editor object.
			const unrelatedEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri("/some/other/file.ts") }),
			})
			selectionCallback?.({ textEditor: unrelatedEditor, selections: [], kind: undefined })

			expect(diffViewProvider["userTouchedDiffEditor"]).toBe(false)
		})

		it("revertChanges() closes the file tab even when userTouchedDiffEditor is true (deny ignores diff-touch)", async () => {
			// Asymmetry guard: only saveChanges() passes userTouchedDiffEditor through to
			// keepOrCloseEditedFile(). revertChanges() (deny) must NOT honor a diff-pane
			// touch -- a denied edit on a not-previously-open, document-untouched file
			// should still close the transient tab. This protects the documented intent
			// from accidental regression.
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = closeFileTab
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["documentWasOpen"] = false
			diffViewProvider["userTouchedDocument"] = false
			// The user clicked inside the diff pane -- but this is a deny, so it must be ignored.
			diffViewProvider["userTouchedDiffEditor"] = true
			diffViewProvider["preEditScrollLine"] = undefined
			diffViewProvider.editType = "modify"
			diffViewProvider.originalContent = "original"
			diffViewProvider["activeDiffEditor"] = buildActiveDiffEditor()

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
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(
				makeTextEditor({ revealRange: mockRevealRange }),
			)
			const userActiveEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri(`${mockCwd}/target.ts`) }),
			})
			vscode.window.activeTextEditor = userActiveEditor
			diffViewProvider["lastScrolledSource"] = lastScrolledSource
			diffViewProvider["diffScrollLine"] = diffScrollLine
			diffViewProvider["targetFileScrollLine"] = targetFileScrollLine
			diffViewProvider["preEditScrollLine"] = preEditScrollLine
			diffViewProvider["documentWasPinned"] = false
			return mockRevealRange
		}

		it("uses diffScrollLine when lastScrolledSource is 'diff'", async () => {
			const mockRevealRange = setupForScroll("diff", 20, 5, 0)

			await diffViewProvider["showEditedFileWithoutDisruptingFocus"](`${mockCwd}/target.ts`)

			expect(mockRevealRange).toHaveBeenCalledWith(
				expect.objectContaining({ start: { line: 20, character: 0 } }),
				vscode.TextEditorRevealType.AtTop,
			)
		})

		it("uses targetFileScrollLine when lastScrolledSource is 'targetFile'", async () => {
			const mockRevealRange = setupForScroll("targetFile", 20, 8, 0)

			await diffViewProvider["showEditedFileWithoutDisruptingFocus"](`${mockCwd}/target.ts`)

			expect(mockRevealRange).toHaveBeenCalledWith(
				expect.objectContaining({ start: { line: 8, character: 0 } }),
				vscode.TextEditorRevealType.AtTop,
			)
		})

		it("falls back to preEditScrollLine when lastScrolledSource is undefined", async () => {
			const mockRevealRange = setupForScroll(undefined, 20, 8, 3)

			await diffViewProvider["showEditedFileWithoutDisruptingFocus"](`${mockCwd}/target.ts`)

			expect(mockRevealRange).toHaveBeenCalledWith(
				expect.objectContaining({ start: { line: 3, character: 0 } }),
				vscode.TextEditorRevealType.AtTop,
			)
		})

		it("does not call revealRange when all scroll sources are undefined", async () => {
			const mockRevealRange = setupForScroll(undefined, undefined, undefined, undefined)

			await diffViewProvider["showEditedFileWithoutDisruptingFocus"](`${mockCwd}/target.ts`)

			expect(mockRevealRange).not.toHaveBeenCalled()
		})

		it("targetFile scroll overrides diff scroll regardless of their values", async () => {
			// lastScrolledSource=targetFile means the user scrolled there AFTER the diff,
			// so targetFileScrollLine must win even when diffScrollLine is higher.
			const mockRevealRange = setupForScroll("targetFile", 100, 2, 0)

			await diffViewProvider["showEditedFileWithoutDisruptingFocus"](`${mockCwd}/target.ts`)

			expect(mockRevealRange).toHaveBeenCalledWith(
				expect.objectContaining({ start: { line: 2, character: 0 } }),
				vscode.TextEditorRevealType.AtTop,
			)
		})
	})

	describe("diffScrollListener wiring in open()", () => {
		const openWithScrollListener = async (relPath: string) => {
			let scrollCallback: ((event: vscode.TextEditorVisibleRangesChangeEvent) => void) | undefined
			vi.mocked(vscode.window.onDidChangeTextEditorVisibleRanges).mockImplementation((cb) => {
				scrollCallback = cb
				return { dispose: vi.fn() }
			})

			const fsPath = `${mockCwd}/${relPath}`
			const mockEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri(fsPath) }),
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(makeTextDocument({ uri: makeUri(fsPath) })), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			diffViewProvider.editType = "modify"

			await diffViewProvider.open(relPath)
			if (!scrollCallback) {
				throw new Error(
					"onDidChangeTextEditorVisibleRanges mock was not invoked during open() - scroll listener setup changed",
				)
			}
			const activeDiffEditor = diffViewProvider["activeDiffEditor"]
			if (!activeDiffEditor) {
				throw new Error("activeDiffEditor was not set")
			}
			return {
				scrollCallback,
				activeDiffEditor,
				fsPath,
			}
		}

		it("records diffScrollLine and sets lastScrolledSource to 'diff' on diff editor scroll", async () => {
			const { scrollCallback, activeDiffEditor } = await openWithScrollListener("scroll-diff.ts")

			scrollCallback({ textEditor: activeDiffEditor, visibleRanges: [makeRange(42)] })

			expect(diffViewProvider["diffScrollLine"]).toBe(42)
			expect(diffViewProvider["lastScrolledSource"]).toBe("diff")
		})

		it("records targetFileScrollLine and sets lastScrolledSource to 'targetFile' on target file scroll", async () => {
			const { scrollCallback, fsPath } = await openWithScrollListener("scroll-target.ts")

			const targetFileEditor = makeTextEditor({ document: makeTextDocument({ uri: makeUri(fsPath) }) })
			scrollCallback({ textEditor: targetFileEditor, visibleRanges: [makeRange(17)] })

			expect(diffViewProvider["targetFileScrollLine"]).toBe(17)
			expect(diffViewProvider["lastScrolledSource"]).toBe("targetFile")
		})

		it("ignores scroll events from unrelated editors", async () => {
			const { scrollCallback } = await openWithScrollListener("scroll-unrelated.ts")

			const unrelatedEditor = makeTextEditor({
				document: makeTextDocument({ uri: makeUri("/some/other/file.ts") }),
			})
			scrollCallback({ textEditor: unrelatedEditor, visibleRanges: [makeRange(99)] })

			expect(diffViewProvider["diffScrollLine"]).toBeUndefined()
			expect(diffViewProvider["targetFileScrollLine"]).toBeUndefined()
			expect(diffViewProvider["lastScrolledSource"]).toBeUndefined()
		})

		it("lastScrolledSource reflects the most recent scroll between diff and target file", async () => {
			const { scrollCallback, activeDiffEditor, fsPath } = await openWithScrollListener("scroll-recency.ts")

			// First scroll in diff.
			scrollCallback({ textEditor: activeDiffEditor, visibleRanges: [makeRange(10)] })
			expect(diffViewProvider["lastScrolledSource"]).toBe("diff")

			// Then scroll in the target file -- this must win.
			const targetFileEditor = makeTextEditor({ document: makeTextDocument({ uri: makeUri(fsPath) }) })
			scrollCallback({ textEditor: targetFileEditor, visibleRanges: [makeRange(5)] })
			expect(diffViewProvider["lastScrolledSource"]).toBe("targetFile")

			// Back to diff again.
			scrollCallback({ textEditor: activeDiffEditor, visibleRanges: [makeRange(20)] })
			expect(diffViewProvider["lastScrolledSource"]).toBe("diff")
		})
	})

	describe("auto-close settings decision table", () => {
		const mockTargetPath = `${mockCwd}/auto-close-test.ts`

		const buildActiveDiffEditor = () =>
			makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					positionAt: vi.fn().mockReturnValue(makePosition()),
				}),
			})

		const setupProvider = (stateOverrides: Record<string, unknown> = {}) => {
			const provider = new DiffViewProvider(mockCwd, makeTaskDouble(stateOverrides))
			provider["relPath"] = "auto-close-test.ts"
			provider["newContent"] = "content"
			provider["activeDiffEditor"] = buildActiveDiffEditor()
			provider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			provider["preEditScrollLine"] = undefined
			return provider
		}

		it("already-open file is never auto-closed regardless of settings", async () => {
			const provider = setupProvider({ autoCloseZooOpenedFiles: true })
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			provider["closeFileTab"] = closeFileTab
			provider["documentWasOpen"] = true
			provider["userTouchedDocument"] = false
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())

			await provider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
		})

		it("transient tab is kept when autoCloseZooOpenedFiles is false", async () => {
			const provider = setupProvider({ autoCloseZooOpenedFiles: false })
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			provider["closeFileTab"] = closeFileTab
			provider["documentWasOpen"] = false
			provider["userTouchedDocument"] = false
			provider["userTouchedDiffEditor"] = false
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())

			await provider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})

		it("transient tab is kept by default when autoCloseZooOpenedFiles is unset (opt-in)", async () => {
			// Empty state -> autoCloseZooOpenedFiles is undefined and falls back to the
			// centralized default (false), so an untouched transient tab is kept.
			const provider = setupProvider({})
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			provider["closeFileTab"] = closeFileTab
			provider["documentWasOpen"] = false
			provider["userTouchedDocument"] = false
			provider["userTouchedDiffEditor"] = false
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())

			await provider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})

		it("transient tab is closed when autoCloseZooOpenedFiles is true", async () => {
			const provider = setupProvider({ autoCloseZooOpenedFiles: true })
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			provider["closeFileTab"] = closeFileTab
			provider["documentWasOpen"] = false
			provider["userTouchedDocument"] = false
			provider["userTouchedDiffEditor"] = false

			await provider.saveChanges(false)

			expect(closeFileTab).toHaveBeenCalledWith(mockTargetPath)
		})

		it("touched tab is kept by default (autoCloseZooOpenedFilesAfterUserEdited unset)", async () => {
			const provider = setupProvider({})
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			provider["closeFileTab"] = closeFileTab
			provider["documentWasOpen"] = false
			provider["userTouchedDocument"] = true
			provider["userTouchedDiffEditor"] = false
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())

			await provider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
		})

		it("touched tab is closed when autoCloseZooOpenedFilesAfterUserEdited is true", async () => {
			// The after-edit override only closes when the base auto-close is also
			// enabled, so set both (the base default is now opt-in/false).
			const provider = setupProvider({
				autoCloseZooOpenedFiles: true,
				autoCloseZooOpenedFilesAfterUserEdited: true,
			})
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			provider["closeFileTab"] = closeFileTab
			provider["documentWasOpen"] = false
			provider["userTouchedDocument"] = true
			provider["userTouchedDiffEditor"] = false

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
			provider["closeFileTab"] = closeFileTab
			provider["documentWasOpen"] = false
			provider["userTouchedDocument"] = true
			provider["userTouchedDiffEditor"] = false
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())

			await provider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})

		it("new file tab is closed when autoCloseZooOpenedNewFiles is true (accept path)", async () => {
			const provider = setupProvider({ autoCloseZooOpenedNewFiles: true })
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			provider["closeFileTab"] = closeFileTab
			provider["documentWasOpen"] = false
			provider["userTouchedDocument"] = false
			provider["userTouchedDiffEditor"] = false
			provider.editType = "create"

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
			provider["closeFileTab"] = closeFileTab
			provider["documentWasOpen"] = false
			provider["userTouchedDocument"] = false
			provider["userTouchedDiffEditor"] = false
			provider.editType = "create"
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())

			await provider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})

		it("defaults keep the transient tab open when all settings are unset", async () => {
			// No auto-close settings in state: auto-closing is opt-in, so an
			// untouched transient tab is kept and re-shown (long-standing behavior).
			const provider = setupProvider({})
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			provider["closeFileTab"] = closeFileTab
			provider["documentWasOpen"] = false
			provider["userTouchedDocument"] = false
			provider["userTouchedDiffEditor"] = false
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())

			await provider.saveChanges(false)

			expect(closeFileTab).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})
	})
	describe("discardUnapprovedStream method", () => {
		const mockTargetPath = `${mockCwd}/mock-target-file.ts`

		const makeAbandonedDocument = (callOrder: string[], isDirty = true) => ({
			isDirty,
			getText: () => "partial model output",
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			uri: { fsPath: mockTargetPath, path: mockTargetPath },
			save: vi.fn(async () => {
				callOrder.push("save")
				// A confirmed save: the discard treats an unconfirmed one as a rollback failure.
				return true
			}),
		})

		const openAbandonedView = (document: unknown, createdDirs: string[], callOrder: string[]) =>
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: { document },
				editType: "create",
				createdDirs,
				// open() records the placeholder it wrote; the discard may only delete what it owns.
				placeholderPath: `${mockCwd}/mock-target-file.ts`,
				closeAllDiffViews: vi.fn(async () => {
					callOrder.push("closeDiffViews")
				}),
				closeFileTab: vi.fn(async () => {
					callOrder.push("closeFileTab")
				}),
			})

		it("never persists the unapproved buffer: blanks it with an empty replacement, then deletes the placeholder", async () => {
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			openAbandonedView(document, [], callOrder)
			vi.mocked(vscode.workspace.applyEdit).mockImplementation(async () => {
				callOrder.push("applyEdit")
				return true
			})

			await diffViewProvider.discardUnapprovedStream()

			expect(callOrder).toEqual(["applyEdit", "save", "closeDiffViews", "closeFileTab"])
			// The only content the discard may write is an empty buffer, and it must be
			// written to THIS document before the save that would otherwise persist the
			// partial model output.
			expect(mockWorkspaceEdit.replace).toHaveBeenCalledTimes(1)
			const [replacedUri, , replacedText] = mockWorkspaceEdit.replace.mock.calls[0]
			expect(replacedUri).toEqual(document.uri)
			// The replacement covers the whole buffer: the range is built from
			// positionAt(0) to positionAt(getText().length), so nothing can survive it.
			expect(vi.mocked(vscode.Range)).toHaveBeenCalledWith(
				{ line: 0, character: 0 },
				{ line: 0, character: "partial model output".length },
			)
			expect(replacedText).toBe("")
			expect(mockWorkspaceEdit.delete).not.toHaveBeenCalled()
			// The placeholder for THIS relPath is what gets removed.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("mock-target-file.ts"))
		})

		it("releases the placeholder instead of unlinking a path another writer filled", async () => {
			// The field only names the path open() created empty - it does not prove this edit still
			// owns the file. A second provider working the same path can write and save approved
			// content into that file while this abandoned session still carries the field, and the
			// unlink the cleanup used to run unconditionally deletes that approved write. The bytes
			// are somebody else's now, so only the ownership is released here.
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			openAbandonedView(document, [], callOrder)
			// 42 bytes on disk: not the empty placeholder this edit created.
			vi.mocked(fs.stat).mockResolvedValueOnce({ size: 42 } as unknown as Stats)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValueOnce(true)

			await diffViewProvider.discardUnapprovedStream()

			// The buffer work still happened (the restore is mocked to resolve, so it is not
			// recorded in the order list):
			expect(callOrder).toEqual(["save", "closeDiffViews", "closeFileTab"])
			// ...but the file with content in it is not unlinked, and the ownership is released so
			// the caller can reset the session without a later cleanup deleting the write again.
			expect(fs.unlink).not.toHaveBeenCalled()
			expect(diffViewProvider["placeholderPath"]).toBeUndefined()
			expect(diffViewProvider["ownsPlaceholder"]).toBe(false)
		})

		it("restores a modify buffer in memory and never saves the target file", async () => {
			// revertChanges() restores a modify by applyEdit + document.save(). For a stream the
			// user never approved that save is a write they never asked for, and for a
			// .rooignore-denied path a write the policy forbids outright, so the discard restores
			// the buffer and leaves the file on disk untouched.
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			openAbandonedView(document, [], callOrder)
			Object.assign(diffViewProvider, {
				editType: "modify",
				originalContent: "original content",
				// A modify owns no placeholder: only open() of a create writes one.
				placeholderPath: undefined,
			})
			vi.mocked(vscode.workspace.applyEdit).mockImplementation(async () => {
				callOrder.push("applyEdit")
				return true
			})

			await diffViewProvider.discardUnapprovedStream()

			expect(callOrder).toEqual(["applyEdit", "closeDiffViews", "closeFileTab"])
			const [replacedUri, , replacedText] = mockWorkspaceEdit.replace.mock.calls[0]
			expect(replacedUri).toEqual(document.uri)
			expect(replacedText).toBe("original content")
			// The replacement covers the whole buffer, so no streamed content survives it.
			expect(vi.mocked(vscode.Range)).toHaveBeenCalledWith(
				{ line: 0, character: 0 },
				{ line: 0, character: "partial model output".length },
			)
			expect(document.save).not.toHaveBeenCalled()
			// Nothing is unlinked for a modify: saveChanges() may have written this very file with
			// the user's approval, and this edit created no directories.
			expect(fs.unlink).not.toHaveBeenCalled()
			expect(fs.rmdir).not.toHaveBeenCalled()
		})

		it("stops the cleanup and keeps the placeholder when the buffer restore is refused", async () => {
			// applyEdit resolving false leaves the unapproved partial content in the buffer. Saving then
			// would persist exactly what this method exists to discard, and closing the tabs or unlinking
			// the placeholder underneath that buffer would leave content the user never approved with
			// nothing left that can still recover it - so the rollback stops before the close and the
			// delete, the same way an unconfirmed save of the restored buffer does.
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			openAbandonedView(document, [`${mockCwd}/new-dir`], callOrder)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(false)

			await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow(
				/could not restore the diff editor buffer/i,
			)

			expect(document.save).not.toHaveBeenCalled()
			// Nothing after the refused restore ran: no close and no unlink.
			expect(callOrder).toEqual([])
			expect(fs.unlink).not.toHaveBeenCalled()
			expect(fs.rmdir).not.toHaveBeenCalled()
			// Ownership and the directory snapshot survive the refused restore. The caller skips reset()
			// while the placeholder is still owned, so the retry keeps a session and a discard that still
			// knows what it may delete.
			expect(diffViewProvider["placeholderPath"] as string | undefined).toBe(mockTargetPath)
			expect(diffViewProvider["createdDirs"]).toEqual([`${mockCwd}/new-dir`])
		})

		it("stops the cleanup and keeps placeholder ownership when the save is not confirmed", async () => {
			// document.save() resolving false leaves the emptied buffer dirty over the
			// placeholder: closeAllDiffViews() would skip the dirty tab and the unlink would
			// delete the file underneath it, leaving the buffer one save away from recreating
			// the file from a denied write. The discard stops before the close and the delete,
			// keeping ownership so the caller skips reset() and the session stays retryable.
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			document.save = vi.fn(async () => {
				callOrder.push("save")
				return false
			})
			const closeAllDiffViews = vi.fn(async () => {
				callOrder.push("closeDiffViews")
			})
			const closeFileTab = vi.fn(async () => {
				callOrder.push("closeFileTab")
			})
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: { document },
				editType: "create",
				createdDirs: [`${mockCwd}/new-dir`],
				placeholderPath: `${mockCwd}/mock-target-file.ts`,
				closeAllDiffViews,
				closeFileTab,
			})
			vi.mocked(vscode.workspace.applyEdit).mockImplementation(async () => {
				callOrder.push("applyEdit")
				return true
			})

			await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow(
				/could not save the restored buffer/i,
			)

			// The restore was attempted and the save refused; nothing closes and nothing deletes.
			expect(callOrder).toEqual(["applyEdit", "save"])
			expect(closeAllDiffViews).not.toHaveBeenCalled()
			expect(closeFileTab).not.toHaveBeenCalled()
			expect(fs.unlink).not.toHaveBeenCalled()
			expect(fs.rmdir).not.toHaveBeenCalled()
			// Ownership is preserved: the placeholder is still on disk and still ours.
			expect(diffViewProvider["placeholderPath"] as string | undefined).toBe(`${mockCwd}/mock-target-file.ts`)
		})

		it("removes the directories this edit created in reverse order, after the placeholder unlink", async () => {
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			const createdDirs = [`${mockCwd}/mock-dir`, `${mockCwd}/mock-dir/nested`]
			openAbandonedView(document, createdDirs, callOrder)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)

			await diffViewProvider.discardUnapprovedStream()

			expect(fs.unlink).toHaveBeenCalledTimes(1)
			expect(fs.rmdir).toHaveBeenCalledTimes(createdDirs.length)
			// Reverse order, so a parent is never removed before the child inside it, and
			// only the directories this edit created - never a pre-existing one.
			expect(vi.mocked(fs.rmdir).mock.calls.map((c) => c[0])).toEqual([...createdDirs].reverse())
			const unlinkOrder = vi.mocked(fs.unlink).mock.invocationCallOrder[0]
			for (const order of vi.mocked(fs.rmdir).mock.invocationCallOrder) {
				expect(order).toBeGreaterThan(unlinkOrder)
			}
		})

		it("does not save when the abandoned buffer is already clean", async () => {
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder, false)
			openAbandonedView(document, [], callOrder)

			await diffViewProvider.discardUnapprovedStream()

			expect(vscode.workspace.applyEdit).not.toHaveBeenCalled()
			expect(document.save).not.toHaveBeenCalled()
			expect(mockWorkspaceEdit.replace).not.toHaveBeenCalled()
			expect(fs.unlink).toHaveBeenCalledTimes(1)
		})

		it("keeps the placeholder and the directories when the buffer restore rejects", async () => {
			// A rejected applyEdit leaves the restore unconfirmed, exactly like one that resolves false: the
			// buffer still holds the unapproved content and its tab is still open, so unlinking the placeholder
			// underneath it would leave that buffer one save away from recreating the file with content nobody
			// approved. The artifacts stay owned and the directory snapshot goes back to the session, which is
			// what tells the caller to skip reset() and keep the retry path open.
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			const createdDirs = [`${mockCwd}/mock-dir`]
			openAbandonedView(document, createdDirs, callOrder)
			vi.mocked(vscode.workspace.applyEdit).mockRejectedValue(new Error("applyEdit rejected"))

			await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow("applyEdit rejected")

			expect(callOrder).toEqual([])
			expect(fs.unlink).not.toHaveBeenCalled()
			expect(fs.rmdir).not.toHaveBeenCalled()
			expect(diffViewProvider["placeholderPath"] as string | undefined).toBe(mockTargetPath)
			expect(diffViewProvider["createdDirs"]).toEqual(createdDirs)
		})

		it("keeps the placeholder and the directories when the restored buffer save rejects", async () => {
			// A rejected save is as unconfirmed as one resolving false: the buffer is still dirty over the
			// placeholder this edit created, so the sweep must not delete the file underneath it.
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			const createdDirs = [`${mockCwd}/mock-dir`]
			openAbandonedView(document, createdDirs, callOrder)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			document.save.mockRejectedValueOnce(new Error("save rejected"))

			await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow("save rejected")

			// The mock rejects without running its recording body, so the call is counted, not ordered.
			expect(document.save).toHaveBeenCalledTimes(1)
			expect(callOrder).toEqual([])
			expect(fs.unlink).not.toHaveBeenCalled()
			expect(fs.rmdir).not.toHaveBeenCalled()
			expect(diffViewProvider["placeholderPath"] as string | undefined).toBe(mockTargetPath)
			expect(diffViewProvider["createdDirs"]).toEqual(createdDirs)
		})

		it("sweeps the artifacts when only the tab closes reject on a confirmed buffer", async () => {
			// The half of the contract the two tests above must not swallow: once the buffer outcome is
			// confirmed, a close failure still has to leave the artifacts gone, because the caller resets the
			// session after a throw and nothing else can remove them. The failure still surfaces.
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			openAbandonedView(document, [`${mockCwd}/mock-dir`], callOrder)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			Object.assign(diffViewProvider, {
				closeAllDiffViews: vi.fn().mockRejectedValue(new Error("close rejected")),
			})
			vi.mocked(fs.unlink).mockResolvedValue(undefined)

			await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow("close rejected")

			expect(fs.unlink).toHaveBeenCalledWith(mockTargetPath)
			expect(fs.rmdir).toHaveBeenCalledWith(`${mockCwd}/mock-dir`)
			expect(diffViewProvider["placeholderPath"] as string | undefined).toBeUndefined()
		})

		it("removes the placeholder and created directories even when open() failed before activeDiffEditor was assigned", async () => {
			// open() creates the directories (line 130) and the empty placeholder (line 134)
			// BEFORE openDiffEditor() assigns activeDiffEditor (line 173). If that call rejects
			// - the 10s timeout or a failed vscode.diff - an abandoned create therefore has
			// artifacts on disk and no editor, and the early return must not skip the cleanup.
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs: [`${mockCwd}/mock-dir`],
				// open() had already written the placeholder before openDiffEditor() rejected,
				// so this edit owns the path.
				placeholderPath: `${mockCwd}/mock-target-file.ts`,
			})

			await diffViewProvider.discardUnapprovedStream()

			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("mock-target-file.ts"))
			expect(fs.rmdir).toHaveBeenCalledWith(`${mockCwd}/mock-dir`)
			// Nothing editor-side ran, and nothing threw: the artifacts are the whole job here.
			expect(vscode.workspace.applyEdit).not.toHaveBeenCalled()
			// Bracket access for the private field: the snapshot must be consumed, so a second
			// discard cannot try to remove the same directories again.
			expect(diffViewProvider["createdDirs"]).toEqual([])
		})

		it("logs and rejects when the placeholder unlink fails for a reason other than ENOENT", async () => {
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			openAbandonedView(document, [], callOrder)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			const permissionError = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
			vi.mocked(fs.unlink).mockRejectedValueOnce(permissionError)
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow("EPERM: operation not permitted")

			expect(errorSpy).toHaveBeenCalledWith("Error removing abandoned write_to_file artifacts:", permissionError)
		})

		it("hands the created directories back when the unlink fails, so the retained session can finish the sweep", async () => {
			// The unlink is the first step of the sweep, so an EPERM there leaves the placeholder owned -
			// which is what keeps the session - and the directories this edit created still on disk.
			// If the snapshot is not handed back the retained session forgets them and the retry can
			// only remove the file. Two directories, so the retry has to show the reverse order again.
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			const dirA = `${mockCwd}/mock-dir-a`
			const dirB = `${mockCwd}/nested/mock-dir-b`
			openAbandonedView(document, [dirA, dirB], callOrder)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			vi.mocked(fs.unlink).mockRejectedValueOnce(
				Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }),
			)
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow("EPERM: operation not permitted")

			// Owned, on disk and still tracked: that trio is what makes a retry able to finish the job.
			expect(diffViewProvider["placeholderPath"] as string | undefined).toBe(mockTargetPath)
			expect(diffViewProvider["createdDirs"]).toEqual([dirA, dirB])
			expect(fs.rmdir).not.toHaveBeenCalled()

			await diffViewProvider.discardUnapprovedStream()

			expect(fs.unlink).toHaveBeenCalledTimes(2)
			expect(diffViewProvider["placeholderPath"] as string | undefined).toBeUndefined()
			expect(diffViewProvider["createdDirs"]).toEqual([])
			expect(vi.mocked(fs.rmdir).mock.calls.map((c) => c[0])).toEqual([dirB, dirA])
			expect(errorSpy).toHaveBeenCalledTimes(1)
			errorSpy.mockRestore()
		})

		it("logs and rejects when removing a created directory fails for a reason other than ENOENT", async () => {
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			openAbandonedView(document, [`${mockCwd}/mock-dir`], callOrder)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			vi.mocked(fs.unlink).mockResolvedValue(undefined)
			const notEmpty = Object.assign(new Error("ENOTEMPTY: directory not empty"), { code: "ENOTEMPTY" })
			vi.mocked(fs.rmdir).mockRejectedValueOnce(notEmpty)
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow("ENOTEMPTY: directory not empty")

			expect(errorSpy).toHaveBeenCalledWith("Error removing abandoned write_to_file artifacts:", notEmpty)
		})

		it("tolerates an already-deleted placeholder and directories (ENOENT) without throwing", async () => {
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			// Two created directories: the tolerance has to hold for every one of them, so the
			// rejection is keyed on the path rather than on which call comes first.
			const dirA = `${mockCwd}/mock-dir-a`
			const dirB = `${mockCwd}/nested/mock-dir-b`
			openAbandonedView(document, [dirA, dirB], callOrder)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			// A single unlink call in this flow, so the placeholder stays Once-based.
			vi.mocked(fs.unlink).mockRejectedValueOnce(enoent)
			vi.mocked(fs.rmdir).mockImplementation(async (dir) => {
				if (dir === dirA || dir === dirB) {
					throw enoent
				}
			})
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			await expect(diffViewProvider.discardUnapprovedStream()).resolves.toBeUndefined()

			// Both directories were attempted; the assertion is on the paths, not the order.
			expect(fs.rmdir).toHaveBeenCalledWith(dirA)
			expect(fs.rmdir).toHaveBeenCalledWith(dirB)
			expect(errorSpy).not.toHaveBeenCalledWith(
				"Error removing abandoned write_to_file artifacts:",
				expect.anything(),
			)

			// beforeEach only clears call data, not implementations, so put the default back.
			vi.mocked(fs.rmdir).mockResolvedValue(undefined)
		})

		it("reports the editor failure rather than the cleanup failure when both happen", async () => {
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			openAbandonedView(document, [`${mockCwd}/mock-dir`], callOrder)
			// The buffer outcome has to be confirmed for the sweep to run at all, which is what makes both
			// failures possible in the same call: applyEdit accepted the restore, a tab close then rejects and
			// the placeholder unlink that follows it rejects too.
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			Object.assign(diffViewProvider, {
				closeAllDiffViews: vi.fn().mockRejectedValue(new Error("close rejected")),
			})
			vi.mocked(fs.unlink).mockRejectedValueOnce(Object.assign(new Error("EPERM"), { code: "EPERM" }))
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			// The caller reports a rollback hazard from the thrown error, so the ORIGINAL failure is what must
			// surface; the cleanup failure is still logged for the operator.
			await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow("close rejected")
			expect(errorSpy).toHaveBeenCalledWith(
				"Error removing abandoned write_to_file artifacts:",
				expect.objectContaining({ code: "EPERM" }),
			)
		})

		it("leaves a file this edit never created a placeholder for on disk", async () => {
			// reset() does not clear relPath, and saveDirectly() sets it for an approved write.
			// Without ownership tracking the discard would unlink that approved file: an approved
			// write_to_file to A, then a new write_to_file whose block exits through a rollback
			// path before open() ever ran, still sees relPath === A.
			const callOrder: string[] = []
			const document = makeAbandonedDocument(callOrder)
			Object.assign(diffViewProvider, {
				relPath: "previously-approved-file.ts",
				activeDiffEditor: { document },
				editType: undefined,
				createdDirs: [],
				placeholderPath: undefined,
			})
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)

			await expect(diffViewProvider.discardUnapprovedStream()).resolves.toBeUndefined()

			expect(fs.unlink).not.toHaveBeenCalled()
			expect(fs.rmdir).not.toHaveBeenCalled()
			// The buffer is still blanked and the tab closed: the unapproved content is gone
			// without touching a file the user approved.
			expect(mockWorkspaceEdit.replace).toHaveBeenCalledTimes(1)
			expect(mockWorkspaceEdit.replace.mock.calls[0][2]).toBe("")
		})

		it("removes the placeholder that a new-file open() wrote, driven through the public methods", async () => {
			// The ownership lifecycle lives at the public-method layer, so exercise it there:
			// open() writes the empty placeholder and records it, and the discard of an abandoned
			// create removes exactly that path.
			const relPath = "owned-placeholder.ts"
			const fsPath = `${mockCwd}/${relPath}`
			const mockEditor = {
				document: {
					uri: { fsPath, scheme: "file" },
					getText: vi.fn().mockReturnValue(""),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
					lineCount: 0,
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			}
			// Structural double for the mocked editor: the mock only implements the members
			// open() touches, so it is routed through unknown rather than any.
			const editor = mockEditor as unknown as vscode.TextEditor
			vi.mocked(vscode.window).visibleTextEditors = [editor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(editor)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback({ uri: { fsPath, scheme: "file" } } as vscode.TextDocument), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			vi.mocked(vscode.window.onDidChangeTextEditorVisibleRanges).mockReturnValue({ dispose: vi.fn() })
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
			diffViewProvider.editType = "create"

			await diffViewProvider.open(relPath)

			// open() created the placeholder, and this edit now owns it.
			expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")

			await diffViewProvider.discardUnapprovedStream()

			expect(fs.unlink).toHaveBeenCalledWith(fsPath)
		})

		it("does not remove the file once saveChanges() has approved the content", async () => {
			// saveChanges() turns the placeholder into approved content and drops this edit's
			// claim on it, so a later abandoned cleanup must leave the approved file on disk.
			const relPath = "approved-by-save.ts"
			const fsPath = `${mockCwd}/${relPath}`
			Object.assign(diffViewProvider, {
				relPath,
				newContent: "approved content",
				editType: "create",
				createdDirs: [],
				placeholderPath: fsPath,
				preDiagnostics: [],
				activeDiffEditor: {
					document: {
						uri: { fsPath, scheme: "file" },
						getText: vi.fn().mockReturnValue("approved content"),
						isDirty: false,
						save: vi.fn().mockResolvedValue(undefined),
					},
				},
				closeAllDiffViews: vi.fn().mockResolvedValue(undefined),
				closeFileTab: vi.fn().mockResolvedValue(undefined),
			})
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(undefined as never)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)

			await diffViewProvider.saveChanges(false, 0)

			await diffViewProvider.discardUnapprovedStream()

			expect(fs.unlink).not.toHaveBeenCalled()
		})

		it("closes the dirty vscode.diff tab that only TabInputTextDiff matches, before the unlink", async () => {
			// The hazard named on #1932: openDiffEditor() opens a vscode.diff tab whose input is a
			// TabInputTextDiff, so a rollback helper that looks for TabInputText tabs finds nothing,
			// closeAllDiffViews() then skips the tab while it is dirty, and the streamed content
			// survives in a buffer one save away from recreating a file the user never approved.
			// The provider's own tab helpers are deliberately NOT stubbed here: the tab-input matching
			// is what is under test.
			const callOrder: string[] = []
			const document = {
				isDirty: true,
				getText: () => "partial model output",
				positionAt: (offset: number) => ({ line: 0, character: offset }),
				uri: makeUri(mockTargetPath),
				save: vi.fn(async () => {
					callOrder.push("save")
					document.isDirty = false
					return true
				}),
			}
			const diffTab = {
				label: `mock-target-file.ts ${DIFF_VIEW_LABEL_CHANGES}`,
				input: Object.assign(new vscode.TabInputTextDiff(makeUri("diff-original"), makeUri(mockTargetPath)), {
					original: { scheme: DIFF_VIEW_URI_SCHEME, fsPath: "mock-target-file.ts" },
					modified: { scheme: "file", fsPath: mockTargetPath },
				}),
				// The tab is dirty exactly while the modified-side buffer is: the discard has to make
				// the buffer clean for the tab to become closeable at all.
				get isDirty() {
					return document.isDirty
				},
			}
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [diffTab] }],
				configurable: true,
			})
			Object.assign(diffViewProvider, {
				relPath: "mock-target-file.ts",
				activeDiffEditor: { document },
				editType: "create",
				createdDirs: [],
				placeholderPath: mockTargetPath,
			})
			vi.mocked(vscode.workspace.applyEdit).mockImplementation(async () => {
				callOrder.push("applyEdit")
				return true
			})
			vi.mocked(vscode.window.tabGroups.close).mockImplementation(async () => {
				callOrder.push("closeTab")
				return true
			})
			vi.mocked(fs.unlink).mockImplementation(async () => {
				callOrder.push("unlink")
				return undefined
			})

			try {
				await diffViewProvider.discardUnapprovedStream()
			} finally {
				// Do not leak the tab fixture: later tests read the module-level tabGroups.all.
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
			}

			// The buffer is emptied before anything is closed, and the only content the discard
			// writes is an empty buffer: a later save has nothing left to persist.
			expect(callOrder.slice(0, 2)).toEqual(["applyEdit", "save"])
			const [, , replacedText] = mockWorkspaceEdit.replace.mock.calls[0]
			expect(replacedText).toBe("")
			// The tab is gone before the file is, so no save can recreate the abandoned file from a
			// buffer the user never approved.
			expect(callOrder.indexOf("closeTab")).toBeGreaterThan(-1)
			expect(callOrder.indexOf("closeTab")).toBeLessThan(callOrder.indexOf("unlink"))
			expect(fs.unlink).toHaveBeenCalledWith(mockTargetPath)
		})

		it("does nothing when no abandoned view is open", async () => {
			Object.assign(diffViewProvider, { relPath: undefined, activeDiffEditor: undefined })

			await diffViewProvider.discardUnapprovedStream()

			expect(fs.unlink).not.toHaveBeenCalled()
		})
	})
	describe("isEditingDifferentPath and editingRelPath", () => {
		// The production predicate the streaming guard and the different-path rejection both call.
		// Everywhere else a test double stands in for it, so only these assertions can fail when the
		// predicate itself regresses - for example to always reporting "not a different path".
		it("reports no different path while no edit session is active", () => {
			Object.assign(diffViewProvider, { isEditing: false, relPath: "leftover/path.ts" })

			expect(diffViewProvider.isEditingDifferentPath("any/path.ts")).toBe(false)
			expect(diffViewProvider.editingRelPath).toBeUndefined()
		})

		it("accepts the retained path and rejects another one", () => {
			Object.assign(diffViewProvider, { isEditing: true, relPath: "retained/path.ts" })

			expect(diffViewProvider.isEditingDifferentPath("retained/path.ts")).toBe(false)
			expect(diffViewProvider.isEditingDifferentPath("other/path.ts")).toBe(true)
			expect(diffViewProvider.editingRelPath).toBe("retained/path.ts")
		})

		it("compares the paths exactly as the caller spelled them", () => {
			// Deliberately no normalisation: the predicate is a plain inequality, so a caller that hands
			// over a differently spelled form of the retained path is treated as a second write. Pinning
			// it here is what stops a later normalisation from silently widening the guard with nobody
			// deciding that.
			Object.assign(diffViewProvider, { isEditing: true, relPath: "dir/path.ts" })

			expect(diffViewProvider.isEditingDifferentPath("./dir/path.ts")).toBe(true)
			expect(diffViewProvider.isEditingDifferentPath("dir/path.ts")).toBe(false)
		})
	})
})
