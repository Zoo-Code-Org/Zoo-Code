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
	// The abandoned-stream discard removes the placeholder file and the directories it
	// created, so the discard path needs these two.
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
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

		const buildActiveDiffEditor = () =>
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
		// An abandoned partial stream was never approved. revertChanges() saves a dirty
		// new-file buffer before deleting the file, which would put partial model output on
		// disk (and leave it there if the delete fails), so the discard path blanks the
		// buffer first and only then saves the empty placeholder before removing it.
		describe("discardUnapprovedStream method", () => {
			const makeAbandonedDocument = (callOrder: string[], isDirty = true) => ({
				isDirty,
				getText: () => "partial model output",
				positionAt: (offset: number) => ({ line: 0, character: offset }),
				uri: { fsPath: mockTargetPath, path: mockTargetPath },
				save: vi.fn(async () => {
					callOrder.push("save")
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

			it("leaves no session behind for a task that was disposed while the discard ran", async () => {
				// Task.dispose() starts this discard and runs no reset() afterwards, so the discard
				// itself has to end the session. isEditing and the editor reference are what a late
				// handlePartial() continuation reads to decide whether it still owns a view, and a
				// disposed task must not keep either - nor the streamed lines it just discarded.
				const callOrder: string[] = []
				const document = makeAbandonedDocument(callOrder)
				openAbandonedView(document, [], callOrder)
				diffViewProvider.isEditing = true
				diffViewProvider["streamedLines"] = ["partial model output"]
				vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)

				await diffViewProvider.discardUnapprovedStream()

				expect(diffViewProvider.isEditing).toBe(false)
				expect(diffViewProvider.editType).toBeUndefined()
				expect(diffViewProvider["activeDiffEditor"]).toBeUndefined()
				expect(diffViewProvider["streamedLines"]).toEqual([])
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

				expect(callOrder).toEqual(["closeDiffViews", "applyEdit", "save", "closeFileTab"])
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

			it("blanks, saves and removes a dirty create whose placeholder still holds what open() wrote", async () => {
				// The accept path of the save gate with a dirty buffer. The row above reaches the gate only
				// with a clean buffer, which never enters the restore branch at all, and the rows below
				// cover a placeholder somebody else rewrote or removed, so nothing covered the ordinary
				// case: a dirty create whose placeholder still holds the empty content open() wrote. The
				// guard agrees, so the emptied buffer is saved onto the file this edit owns and the file is
				// then removed.
				const relPath = "dirty-matching-placeholder.ts"
				const fsPath = `${mockCwd}/${relPath}`
				const mockEditor = {
					document: {
						uri: { fsPath, scheme: "file" },
						getText: vi.fn().mockReturnValue("partial model output"),
						positionAt: (offset: number) => ({ line: 0, character: offset }),
						isDirty: true,
						save: vi.fn().mockResolvedValue(undefined),
						lineCount: 0,
					},
					selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
					edit: vi.fn().mockResolvedValue(true),
					revealRange: vi.fn(),
				}
				// Structural double routed through unknown rather than any: only the members the discard
				// touches, the same double shape the neighbouring rows use.
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
				vi.mocked(fs.readFile).mockResolvedValue("")

				await diffViewProvider.open(relPath)
				expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")
				vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await expect(diffViewProvider.discardUnapprovedStream()).resolves.toBeUndefined()

				// Emptied with one replacement, saved once onto the path this edit owns, and then removed:
				// the guard read agreed twice, so neither the keep branch nor the failure branch ran.
				expect(mockWorkspaceEdit.replace).toHaveBeenCalledTimes(1)
				expect(editor.document.save).toHaveBeenCalledTimes(1)
				expect(fs.unlink).toHaveBeenCalledWith(fsPath)
				expect(errorSpy).not.toHaveBeenCalledWith(
					"Error removing abandoned write_to_file artifacts:",
					expect.anything(),
				)
			})

			it("keeps an editor that arrives after the deferred diff command from publishing into a released session", async () => {
				// The reviewer named this ordering: a release can reach the provider while open() is still
				// parked inside openDiffEditor(), before the vscode.diff command settles. This row drives the
				// real open() against a mocked executeCommand("vscode.diff") that resolves only when the
				// test releases it, and leaves openDiffEditor() itself alone because it is private. What it
				// pins is open() reacting to a session that was released before that command settled, on the
				// create path where open() wrote an empty placeholder - not the extension host that would
				// really raise these events.
				const callOrder: string[] = []
				const lateDocument = makeTextDocument({
					uri: makeUri(`${mockCwd}/test.txt`),
					isDirty: true,
					getText: () => "partial model output",
				})
				const lateEditor = makeTextEditor({ document: lateDocument })
				let resolveDiffCommand: () => void = () => {}
				const diffCommandSettled = new Promise<void>((resolve) => {
					resolveDiffCommand = resolve
				})
				// openDiffEditor() registers these listeners before it invokes the diff command, so the
				// doubles hand the callbacks back instead of being stubbed away.
				let onDidOpenTextDocument: ((document: vscode.TextDocument) => unknown) | undefined
				// openDiffEditor() hands back a disposable for each of the two listeners it registers
				// before the deferred diff command, and the question this row has to answer is whether the
				// document callback releases them. Both are kept as distinct objects here - the
				// visible-editors fallback is registered against its own double rather than the module
				// mock's shared one, so neither assertion can satisfy the other.
				const documentListenerDisposable = { dispose: vi.fn() }
				const visibleEditorsListenerDisposable = { dispose: vi.fn() }
				vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
					onDidOpenTextDocument = callback
					return documentListenerDisposable
				})
				vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockImplementation(
					() => visibleEditorsListenerDisposable,
				)
				// The three listeners open() registers after the editor lands stay on the module mock's
				// own disposable double, so registering them is still observable from outside.
				Object.defineProperty(vscode.window.tabGroups, "all", { value: [], configurable: true })
				vi.mocked(vscode.window).visibleTextEditors = []
				vi.mocked(vscode.window.showTextDocument).mockResolvedValue(lateEditor)
				vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
					callOrder.push(String(command))
					// Only this test lets the diff command settle, which is what defers the diff editor.
					await diffCommandSettled
					callOrder.push("diffCommandSettled")
				})
				// A denied write_to_file empties the buffer; the replace is what would be saved.
				vi.mocked(vscode.workspace.applyEdit).mockImplementation(async () => {
					callOrder.push("applyEdit")
					return true
				})
				Object.assign(diffViewProvider, {
					editType: "create" as const,
					// Every step the released-session stand-down reaches for is recorded, so the order below
					// names the whole of it rather than re-testing what each helper does: the plain tab close,
					// the listener release, the deferred-scroll cancel and the diff-tab close are four separate
					// calls, and dropping any one of them changes this array.
					closeAllDiffViews: vi.fn(async () => {
						callOrder.push("closeDiffViews")
					}),
					closeFileTab: vi.fn(async () => {
						callOrder.push("closeFileTab")
					}),
					disposeActiveEditorListener: vi.fn(() => {
						callOrder.push("disposeActiveEditorListener")
					}),
					cancelDeferredScroll: vi.fn(() => {
						callOrder.push("cancelDeferredScroll")
					}),
				})
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
				vi.mocked(fs.readFile).mockResolvedValue("content the user saved after open()")
				vi.mocked(fs.unlink).mockResolvedValue(undefined)
				const openPromise = diffViewProvider.open("test.txt")
				// The streamed text is what the deny discards; open() owns the placeholder it wrote.
				diffViewProvider["streamedLines"] = ["partial model output"]
				// Let open() run up to the point where it invokes the diff command and stop it there:
				// this macrotask queues behind every already-pending microtask, and the command
				// double stays unresolved, so open() is parked exactly where the reviewer named.
				await new Promise((resolve) => setTimeout(resolve, 0))
				// open() publishes its editor only when the await below it resolves, so the field
				// starts empty for this scenario rather than carrying the double the beforeEach installs.
				diffViewProvider["activeDiffEditor"] = undefined
				// open() is parked on the diff command, so it has published no editor yet.
				expect(callOrder).toEqual(["vscode.diff"])
				expect(diffViewProvider["activeDiffEditor"]).toBeUndefined()
				expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
					"vscode.diff",
					expect.anything(),
					expect.anything(),
					expect.anything(),
					{ preserveFocus: true },
				)
				// The release runs while open() is still awaiting that command.
				const released = diffViewProvider.discardUnapprovedStream()
				await expect(released).rejects.toThrow(/no longer holds the empty placeholder/)
				// The release refused before any closing: with no editor published it has nothing to work
				// from, so it neither empties the buffer nor removes the placeholder it no longer owns.
				expect(callOrder).toEqual(["vscode.diff"])
				expect(vscode.workspace.applyEdit).not.toHaveBeenCalled()
				expect(lateDocument.save).not.toHaveBeenCalled()
				// Then the host catches up: the command settles and the editor finally appears.
				resolveDiffCommand()
				vi.mocked(vscode.window).visibleTextEditors = [lateEditor]
				if (typeof onDidOpenTextDocument !== "function") {
					throw new Error("open() never registered the document listener it uses to await the diff editor")
				}
				await onDidOpenTextDocument(lateDocument)
				await openPromise
				// The document callback is what resolves openDiffEditor(), and releasing the two temporary
				// listeners is part of that resolution: a subscription that survived the race would leave
				// one of these two dispose calls uncalled.
				expect(documentListenerDisposable.dispose).toHaveBeenCalledTimes(1)
				expect(visibleEditorsListenerDisposable.dispose).toHaveBeenCalledTimes(1)
				// The late editor never published into the released session.
				expect(diffViewProvider["activeDiffEditor"]).toBeUndefined()
				expect(DecorationController).not.toHaveBeenCalled()
				expect(vscode.window.onDidChangeActiveTextEditor).not.toHaveBeenCalled()
				expect(vscode.window.onDidChangeTextEditorSelection).not.toHaveBeenCalled()
				expect(vscode.window.onDidChangeTextEditorVisibleRanges).not.toHaveBeenCalled()
				expect(fs.unlink).not.toHaveBeenCalled()
				// Two closings follow the release and both belong to open(), reached through the same
				// helpers the release paths use: first the plain text tab open() pre-opened, then the diff
				// tabs. The two helpers are doubles above, so this row names the order of the closings and
				// the parked-open row below is the one that names the tab types. The diff command settling
				// is recorded before either, and the release that already ran must not run again.
				expect(callOrder).toEqual([
					"vscode.diff",
					"diffCommandSettled",
					"closeFileTab",
					"disposeActiveEditorListener",
					"cancelDeferredScroll",
					"closeDiffViews",
				])
				// Leave the document-open double as the module mock defined it, for the rows after
				// this one, since a mockImplementation here outlives the test that set it.
				vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation(() => ({ dispose: vi.fn() }))
				errorSpy.mockRestore()
			})
			it("does not save the emptied buffer over content that arrived in the placeholder after open()", async () => {
				// The reviewer's ordering ask, at the layer that would have caught it. The tests above all
				// run with a dirty buffer and no recorded placeholder content, so open() wrote nothing this
				// discard can recognise as its own and the identity check is skipped; this unit's own tests
				// all set isDirty to false. Dirty plus a recorded identity is the combination none of them
				// covered, and it is the case where an emptied buffer used to be saved onto the path before
				// anything noticed that the path no longer held what open() wrote. Here the save is the only
				// write this document can make, so a save that never happens is the whole claim.
				const callOrder: string[] = []
				const document = makeAbandonedDocument(callOrder)
				openAbandonedView(document, [], callOrder)
				diffViewProvider["placeholderContent"] = ""
				vi.mocked(vscode.workspace.applyEdit).mockImplementation(async () => {
					callOrder.push("applyEdit")
					return true
				})
				// Somebody else's content is what now holds the placeholder's path.
				vi.mocked(fs.readFile).mockResolvedValue("content the user saved after open()")
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow(
					/no longer holds the empty placeholder/,
				)

				// The buffer is still blanked in memory and the tab is still closed - only the write is
				// withheld. With the identity check running after the buffer work, this list would read
				// closeDiffViews, applyEdit, save, closeFileTab.
				expect(callOrder).toEqual(["closeDiffViews", "applyEdit", "closeFileTab"])
				expect(document.save).not.toHaveBeenCalled()
				expect(mockWorkspaceEdit.replace).toHaveBeenCalledTimes(1)
				// The file is kept, so nothing removed it either.
				expect(fs.unlink).not.toHaveBeenCalled()
				expect(errorSpy).toHaveBeenCalledWith(
					"Error removing abandoned write_to_file artifacts:",
					expect.objectContaining({
						message: expect.stringContaining("no longer holds the empty placeholder"),
					}),
				)
				expect(diffViewProvider["placeholderPath"]).toBeUndefined()
				expect(diffViewProvider["placeholderContent"]).toBeUndefined()
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

				expect(callOrder).toEqual(["closeDiffViews", "applyEdit", "closeFileTab"])
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

			it("does not save and reports the hazard when the buffer restore fails to apply", async () => {
				// applyEdit resolving false leaves the unapproved partial content in the buffer. Saving
				// then would persist exactly what this method exists to discard, so the save is skipped
				// and the caller is told the rollback did not happen.
				const callOrder: string[] = []
				const document = makeAbandonedDocument(callOrder)
				openAbandonedView(document, [], callOrder)
				vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(false)

				await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow(
					/could not restore the diff editor buffer/i,
				)

				expect(document.save).not.toHaveBeenCalled()
				// The artifacts still have to go: the caller runs reset() next, which drops
				// placeholderPath/createdDirs and leaves nothing else able to remove them.
				expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("mock-target-file.ts"))
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

			it("still removes the placeholder and the created directories when the editor work rejects, and reports the failure", async () => {
				const callOrder: string[] = []
				const document = makeAbandonedDocument(callOrder)
				const createdDirs = [`${mockCwd}/mock-dir`]
				openAbandonedView(document, createdDirs, callOrder)
				vi.mocked(vscode.workspace.applyEdit).mockRejectedValue(new Error("applyEdit rejected"))

				// The caller (releaseAbandonedDiffView) treats a throw as "rollback hazard", so
				// the failure must still surface - but only after the artifacts are gone, because
				// the caller then runs reset(), which drops relPath/createdDirs and leaves
				// nothing else able to remove them.
				await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow("applyEdit rejected")

				expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("mock-target-file.ts"))
				expect(fs.rmdir).toHaveBeenCalledWith(`${mockCwd}/mock-dir`)
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

				await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow(
					"EPERM: operation not permitted",
				)

				expect(errorSpy).toHaveBeenCalledWith(
					"Error removing abandoned write_to_file artifacts:",
					permissionError,
				)
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

				await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow(
					"ENOTEMPTY: directory not empty",
				)

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
				vi.mocked(vscode.workspace.applyEdit).mockRejectedValue(new Error("applyEdit rejected"))
				vi.mocked(fs.unlink).mockRejectedValueOnce(Object.assign(new Error("EPERM"), { code: "EPERM" }))
				vi.spyOn(console, "error").mockImplementation(() => {})

				// The caller reports a rollback hazard from the thrown error, so the ORIGINAL failure
				// is what must surface; the cleanup failure is still logged for the operator.
				await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow("applyEdit rejected")
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

			it("closes a diff editor that open() publishes after a release already ran, and registers nothing behind it", async () => {
				// The review's late-open scenario, driven through the real open(): the editor call inside
				// open() is still pending while the abort path releases the view, and only then resolves.
				// open() itself is the production method; the innermost openDiffEditor() call is deferred
				// and only vscode and fs are doubles.
				const relPath = "late-open.ts"
				const fsPath = `${mockCwd}/${relPath}`
				let handOverEditor: (editor: vscode.TextEditor) => void = () => {}
				const pendingEditorCall = new Promise<vscode.TextEditor>((resolve) => {
					handOverEditor = resolve
				})
				const lateEditor = {
					document: {
						uri: { fsPath, scheme: "file" },
						lineCount: 0,
						getText: vi.fn().mockReturnValue(""),
						isDirty: false,
						save: vi.fn().mockResolvedValue(undefined),
					},
					selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
					visibleRanges: [],
					edit: vi.fn().mockResolvedValue(true),
					revealRange: vi.fn(),
				}
				// Structural double routed through unknown rather than any: it carries only the members
				// the late teardown touches.
				const lateEditorDouble = lateEditor as unknown as vscode.TextEditor
				const lateDiffTab = makeTab(makeDiffTabInput("cline-diff", fsPath), "diff tab")
				// The other tab the awaited call puts on screen: openDiffEditor() pre-opens the file as a
				// plain text document before it runs the diff command, and a plain text tab is not a
				// diff tab, so closeAllDiffViews() cannot reach it and only closeFileTab() can.
				const latePlainTab = makeTab(makeTextTab(fsPath), "plain tab")

				// The shared setup already carries an editor and two decoration controllers, so their
				// identities are captured: open() would have replaced both controllers and assigned the
				// editor it awaited, and unchanged identities prove it published neither.
				const editorBefore = diffViewProvider["activeDiffEditor"]
				const overlayControllerBefore = diffViewProvider["fadedOverlayController"]
				const lineControllerBefore = diffViewProvider["activeLineController"]

				// Bracket access rather than a cast: openDiffEditor is private, and deferring it is the
				// only way to hold open() inside the await the release is racing.
				diffViewProvider["openDiffEditor"] = async () => pendingEditorCall
				vi.mocked(fs.readFile).mockResolvedValue("")
				diffViewProvider.editType = "create"

				const opening = diffViewProvider.open(relPath)
				await new Promise((resolve) => setTimeout(resolve, 0))

				// open() is parked on the editor call, so it has published nothing yet: the editor is
				// still the one the setup installed, and no listener has been registered.
				expect(diffViewProvider["activeDiffEditor"]).toBe(editorBefore)
				expect(vscode.window.onDidChangeActiveTextEditor).not.toHaveBeenCalled()

				// The release the abort path performs, while open() is still parked.
				await diffViewProvider.discardUnapprovedStream()
				expect(diffViewProvider.isEditing).toBe(false)

				// The diff tab the awaited call put on screen, as the tab group would show it now. This
				// spec installs tabGroups.all through a getter, so the late tab is installed the same way,
				// and close() is answered with a promise because closeAllDiffViews() awaits it.
				Object.defineProperty(vscode.window.tabGroups, "all", {
					get: (): vscode.TabGroup[] => [
						{
							isActive: true,
							viewColumn: vscode.ViewColumn.One,
							activeTab: lateDiffTab,
							tabs: [latePlainTab, lateDiffTab],
						},
					],
					configurable: true,
				})
				vi.mocked(vscode.window.tabGroups.close).mockResolvedValue(true)
				handOverEditor(lateEditorDouble)
				await opening

				// The late editor is closed through the helper the release paths already use, and nothing
				// was published behind it: no listeners registered, no deferred scroll pending, and the
				// editor reference dropped so a later update() cannot act on it.
				expect(vscode.window.tabGroups.close).toHaveBeenCalledWith(lateDiffTab)
				// Both tab types are closed before ownership of the file is dropped, and only two
				// helpers can close them: the diff tab is closeAllDiffViews() and the plain text tab is
				// closeFileTab(), so this assertion is the one that answers a guard without the close.
				expect(vscode.window.tabGroups.close).toHaveBeenCalledWith(latePlainTab)
				expect(vscode.window.onDidChangeActiveTextEditor).not.toHaveBeenCalled()
				expect(vscode.window.onDidChangeTextEditorSelection).not.toHaveBeenCalled()
				expect(vscode.window.onDidChangeTextEditorVisibleRanges).not.toHaveBeenCalled()
				expect(diffViewProvider["activeEditorListener"]).toBeUndefined()
				expect(diffViewProvider["diffEditorSelectionListener"]).toBeUndefined()
				expect(diffViewProvider["diffScrollListener"]).toBeUndefined()
				expect(diffViewProvider["deferredScrollTimer"]).toBeUndefined()
				expect(diffViewProvider["activeDiffEditor"]).toBeUndefined()
				// Same controller objects as before open() ran: the late route returned before creating
				// the pair open() normally installs, so there was nothing on this path to dispose.
				expect(diffViewProvider["fadedOverlayController"]).toBe(overlayControllerBefore)
				expect(diffViewProvider["activeLineController"]).toBe(lineControllerBefore)
				expect(diffViewProvider.isEditing).toBe(false)

				// Leave the tab-group getter as this spec found it so a later test does not see the tab
				// this test installed.
				Object.defineProperty(vscode.window.tabGroups, "all", { value: [], configurable: true })
			})

			it("keeps a placeholder that no longer holds the content open() wrote, and reports it as a cleanup failure", async () => {
				// The persistence ask, at the public-method layer: open() writes an empty placeholder and
				// records what it wrote; if something else puts content in that path before the discard,
				// the discard leaves the file alone. This spec's fs is a double, so the content is the
				// answer the double gives the guard's read - what the test pins is that a mismatch keeps
				// the file, writes nothing over it, and reports through the channel this site already uses.
				const relPath = "kept-placeholder.ts"
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
				// Structural double routed through unknown rather than any: it carries only the members
				// open() touches, the same double shape the placeholder test below uses.
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
				vi.mocked(fs.readFile).mockResolvedValue("")

				await diffViewProvider.open(relPath)
				expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")

				// Content lands in the placeholder between open() and the discard.
				vi.mocked(fs.readFile).mockResolvedValue("content the user typed into the preview\n")
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow(
					/no longer holds the empty placeholder/,
				)

				expect(fs.unlink).not.toHaveBeenCalledWith(fsPath)
				// Nothing wrote over it: the only write to that path in this test is the one open() did.
				expect(fs.writeFile).toHaveBeenCalledTimes(1)
				// The kept file is reported through the console.error call this cleanup site already
				// makes for a cleanup it could not finish, with the error that names it.
				expect(errorSpy).toHaveBeenCalledWith(
					"Error removing abandoned write_to_file artifacts:",
					expect.any(Error),
				)
				// The edit drops its claim on the path even though the file stays: a later discard has
				// nothing to remove and does not report the same kept file twice.
				expect(diffViewProvider["placeholderPath"]).toBeUndefined()
				expect(diffViewProvider["placeholderContent"]).toBeUndefined()
			})

			it("keeps the placeholder when content arrives between the guard read and the unlink", async () => {
				// The guard's read is the first read the discard makes and the re-check immediately before the
				// unlink is the second. The first answer has to let the unlink through and the second has to stop
				// it, so the two reads are mocked in that order and nothing else in the flow reads this path.
				const relPath = "rewritten-after-guard-placeholder.ts"
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
				// Structural double routed through unknown rather than any: only the members the discard
				// touches, the same double shape the row above uses.
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
				vi.mocked(fs.readFile).mockResolvedValue("")

				await diffViewProvider.open(relPath)
				expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")

				// Read one: still the empty placeholder open() wrote. Read two: a formatter has rewritten it.
				vi.mocked(fs.readFile).mockResolvedValueOnce("").mockResolvedValueOnce("content a formatter rewrote\n")
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow(
					/no longer holds the empty placeholder/,
				)

				// Nothing was removed and nothing was written over the file that arrived: the only write to
				// that path is still the empty placeholder open() made, and the kept file is reported through
				// the console.error call this cleanup site already makes for a cleanup it could not finish.
				expect(fs.unlink).not.toHaveBeenCalledWith(fsPath)
				expect(fs.writeFile).toHaveBeenCalledTimes(1)
				expect(errorSpy).toHaveBeenCalledWith(
					"Error removing abandoned write_to_file artifacts:",
					expect.any(Error),
				)
			})
			it("treats a placeholder that vanished between the guard read and the unlink as already removed", async () => {
				// The re-check must not turn a file that disappeared into a reported failure: this site already
				// tolerates an unlink that finds nothing, and a file that is gone before the unlink is the same
				// case arrived one await earlier.
				const relPath = "vanished-after-guard-placeholder.ts"
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
				// Structural double routed through unknown rather than any: only the members the discard
				// touches, the same double shape the row above uses.
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
				vi.mocked(fs.readFile).mockResolvedValue("")

				await diffViewProvider.open(relPath)
				expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")

				// Read one: still the placeholder open() wrote. Read two: the file is gone, so the re-check
				// takes its own ENOENT branch, and the unlink that follows finds nothing either. Neither
				// tolerance is allowed to turn into a reported failure.
				const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
				vi.mocked(fs.readFile).mockResolvedValueOnce("").mockRejectedValueOnce(enoent)
				vi.mocked(fs.unlink).mockRejectedValueOnce(enoent)
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await expect(diffViewProvider.discardUnapprovedStream()).resolves.toBeUndefined()

				expect(fs.unlink).toHaveBeenCalledWith(fsPath)
				expect(fs.writeFile).toHaveBeenCalledTimes(1)
				expect(errorSpy).not.toHaveBeenCalledWith(
					"Error removing abandoned write_to_file artifacts:",
					expect.anything(),
				)
			})

			it("reports the failure when the re-check's own read fails for a reason other than the file being gone", async () => {
				// The re-check tolerates the file having vanished and rethrows anything else, because a read that
				// proved nothing about the file does not license removing it. Every earlier row let this read
				// succeed, so its failure path was never executed at all.

				const relPath = "denied-recheck-placeholder.ts"
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
				// Structural double routed through unknown rather than any: only the members the discard
				// touches, the same double shape the neighbouring rows use.
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
				vi.mocked(fs.readFile).mockResolvedValue("")

				await diffViewProvider.open(relPath)
				expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")

				// Read one still agrees; read two is refused for a reason that says nothing about the file.
				const denied: NodeJS.ErrnoException = new Error("EACCES: permission denied, read")
				denied.code = "EACCES"
				vi.mocked(fs.readFile).mockResolvedValueOnce("").mockRejectedValue(denied)
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow(/permission denied, read/)
				expect(fs.unlink).not.toHaveBeenCalledWith(fsPath)
				expect(fs.writeFile).toHaveBeenCalledTimes(1)
				expect(errorSpy).toHaveBeenCalledWith(
					"Error removing abandoned write_to_file artifacts:",
					expect.objectContaining({ code: "EACCES" }),
				)
			})

			it("treats a re-check that rejected with no error object as a cleanup it could not finish", async () => {
				// A promise can reject with no value at all. The optional chain on this catch is what keeps that
				// from becoming a crash: the re-check then proves nothing, the file is left alone, and the discard
				// resolves with the report this site already makes, the same way it does when the guard read is
				// the one that says nothing.

				const relPath = "reasonless-recheck-placeholder.ts"
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
				// Structural double routed through unknown rather than any: only the members the discard
				// touches, the same double shape the neighbouring rows use.
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
				vi.mocked(fs.readFile).mockResolvedValue("")

				await diffViewProvider.open(relPath)
				expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")

				// Read one agrees; read two rejects with nothing in the rejection.
				vi.mocked(fs.readFile).mockResolvedValueOnce("").mockRejectedValue(undefined)
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await expect(diffViewProvider.discardUnapprovedStream()).resolves.toBeUndefined()
				expect(errorSpy).toHaveBeenCalledWith("Error removing abandoned write_to_file artifacts:", undefined)
				expect(fs.unlink).not.toHaveBeenCalledWith(fsPath)
				expect(fs.writeFile).toHaveBeenCalledTimes(1)
			})

			it("keeps the file when the guard read found foreign content even though a later read finds it back", async () => {
				// The guard's answer is the decisive one: it ran before the awaited buffer work, and a re-read that
				// finds the placeholder content again after a read that found something else does not undo that
				// finding. The discard refuses both the save and the removal and reports the kept file, rather
				// than letting the second answer overwrite the first.

				const relPath = "rewritten-then-restored-placeholder.ts"
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
				// Structural double routed through unknown rather than any: only the members the discard
				// touches, the same double shape the neighbouring rows use.
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
				vi.mocked(fs.readFile).mockResolvedValue("")

				await diffViewProvider.open(relPath)
				expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")

				// The guard read is the only read this path makes: its answer is decisive, so the row queues
				// exactly the one value it uses rather than a second that would outlive the test.
				vi.mocked(fs.readFile).mockResolvedValueOnce("content a formatter rewrote\n")
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow(
					/no longer holds the empty placeholder/,
				)
				expect(fs.unlink).not.toHaveBeenCalledWith(fsPath)
				expect(fs.writeFile).toHaveBeenCalledTimes(1)
				expect(errorSpy).toHaveBeenCalledWith(
					"Error removing abandoned write_to_file artifacts:",
					expect.any(Error),
				)
			})

			it("does not touch a file the guard read could not read even when a later read would have agreed", async () => {
				// A guard read that failed for a reason other than the file being gone is the case where the
				// discard knows nothing about the file, and it has to stop there: entering the unlink path anyway
				// because a later read happened to agree would remove a file the method never proved anything
				// about. The failure is reported the way this site reports every cleanup it could not finish.

				const relPath = "unreadable-then-readable-placeholder.ts"
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
				// Structural double routed through unknown rather than any: only the members the discard
				// touches, the same double shape the neighbouring rows use.
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
				vi.mocked(fs.readFile).mockResolvedValue("")

				await diffViewProvider.open(relPath)
				expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")

				const denied: NodeJS.ErrnoException = new Error("EACCES: permission denied, read")
				denied.code = "EACCES"
				// The guard read is refused for a reason that says nothing about the file, and it is the last
				// read the discard makes here: a stopped cleanup never gets to agree with anything.
				// The failure is queued rather than made the default, so the row leaves nothing behind in
				// either direction - and a reading that did go on to read again would read the plain
				// default above and remove the file this reading proved nothing about.
				vi.mocked(fs.readFile).mockRejectedValueOnce(denied)
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow(/permission denied, read/)
				expect(fs.unlink).not.toHaveBeenCalledWith(fsPath)
				expect(fs.writeFile).toHaveBeenCalledTimes(1)
				expect(errorSpy).toHaveBeenCalledWith(
					"Error removing abandoned write_to_file artifacts:",
					expect.objectContaining({ code: "EACCES" }),
				)
			})

			it("reports an unlink that rejected with no error object instead of throwing past the discard", async () => {
				// The optional chain on this catch is what makes a rejection carrying nothing a cleanup that could
				// not be finished rather than a crash inside the catch: the discard reports it through the channel
				// this site already has and returns, the way it returns when the guard read is the one that carried
				// nothing. The row above this file's other ENOENT rows covers an unlink failure that does carry a
				// code; this one covers the rejection with no object to carry one, which is what the chain is for.

				const relPath = "reasonless-unlink-placeholder.ts"
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
				// Structural double routed through unknown rather than any: only the members the discard
				// touches, the same double shape the neighbouring rows use.
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
				vi.mocked(fs.readFile).mockResolvedValue("")

				await diffViewProvider.open(relPath)
				expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")

				// Both reads agree, so the removal is attempted, and it rejects with nothing in the rejection.
				vi.mocked(fs.unlink).mockRejectedValueOnce(undefined)
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await expect(diffViewProvider.discardUnapprovedStream()).resolves.toBeUndefined()

				// Reported, not swallowed: the file was not removed and nobody proved it was gone, so the
				// discard says so on the channel it already uses and leaves the failure unrecorded rather than
				// rethrowing a value that carries no message.
				expect(fs.unlink).toHaveBeenCalledWith(fsPath)
				expect(errorSpy).toHaveBeenCalledWith("Error removing abandoned write_to_file artifacts:", undefined)
				expect(fs.writeFile).toHaveBeenCalledTimes(1)
			})

			it("tolerates a placeholder somebody else already deleted instead of reporting a cleanup failure", async () => {
				// The guard reads the file before removing it, so a placeholder that is already gone is not
				// a failure: there is nothing left to remove. That is the ENOENT tolerance this site had
				// before the read was added, kept on the new path rather than lost to it.
				const relPath = "already-gone-placeholder.ts"
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
				// Structural double routed through unknown rather than any: only the members open() touches.
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
				vi.mocked(fs.readFile).mockResolvedValue("")

				await diffViewProvider.open(relPath)
				expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")

				// Somebody else removed the file before the discard ran.
				const missing: NodeJS.ErrnoException = new Error("ENOENT: no such file, already removed")
				missing.code = "ENOENT"
				vi.mocked(fs.readFile).mockRejectedValue(missing)
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await expect(diffViewProvider.discardUnapprovedStream()).resolves.toBeUndefined()

				expect(fs.unlink).not.toHaveBeenCalledWith(fsPath)
				expect(errorSpy).not.toHaveBeenCalledWith(
					"Error removing abandoned write_to_file artifacts:",
					expect.anything(),
				)
			})

			it("does not save the emptied buffer when the guard read proved the placeholder is gone", async () => {
				// The same ENOENT the unlink block already tolerates. A placeholder that is not there has
				// nothing to save onto, and dropping the emptied create buffer onto that path recreates the
				// empty file the discard just declined to remove. The buffer is still blanked, because the
				// unapproved bytes must not survive in the editor either.
				const relPath = "gone-before-save-placeholder.ts"
				const fsPath = `${mockCwd}/${relPath}`
				const mockEditor = {
					document: {
						uri: { fsPath, scheme: "file" },
						getText: vi.fn().mockReturnValue("partial model output"),
						positionAt: (offset: number) => ({ line: 0, character: offset }),
						isDirty: true,
						save: vi.fn().mockResolvedValue(undefined),
						lineCount: 0,
					},
					selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
					edit: vi.fn().mockResolvedValue(true),
					revealRange: vi.fn(),
				}
				// Structural double routed through unknown rather than any: only the members the discard
				// touches, the same double shape the row above uses.
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
				vi.mocked(fs.readFile).mockResolvedValue("")

				await diffViewProvider.open(relPath)
				expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")

				// Somebody else removed the file before the discard ran: the guard read reports ENOENT and
				// leaves the recorded match untouched, which is what the save gate now has to notice.
				const missing: NodeJS.ErrnoException = new Error("ENOENT: no such file, already removed")
				missing.code = "ENOENT"
				vi.mocked(fs.readFile).mockRejectedValue(missing)
				vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await expect(diffViewProvider.discardUnapprovedStream()).resolves.toBeUndefined()

				// Blanked, not written: the replace ran, the save did not, and the only write to that path
				// is still the empty placeholder open() made. Nothing was removed and nothing was reported.
				expect(mockWorkspaceEdit.replace).toHaveBeenCalledTimes(1)
				expect(editor.document.save).not.toHaveBeenCalled()
				expect(fs.writeFile).toHaveBeenCalledTimes(1)
				expect(fs.unlink).not.toHaveBeenCalledWith(fsPath)
				expect(errorSpy).not.toHaveBeenCalledWith(
					"Error removing abandoned write_to_file artifacts:",
					expect.anything(),
				)
			})

			it("keeps the placeholder when the guard's read fails for a reason that does not say it is gone", async () => {
				// The read that guards the unlink can fail for reasons that say nothing about the file being
				// gone - a permission refusal, for example. Only ENOENT means there was nothing left to
				// remove, so anything else is rethrown: the discard keeps the file and reports it through
				// the console.error call this cleanup site already makes, and the method rejects with that
				// error the way it rejects for an unlink it could not finish.
				const relPath = "unreadable-placeholder.ts"
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
				// Structural double routed through unknown rather than any: only the members open() touches.
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
				vi.mocked(fs.readFile).mockResolvedValue("")

				await diffViewProvider.open(relPath)
				expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")

				// The guard's read now fails for a reason that is not 'already gone'.
				const denied: NodeJS.ErrnoException = new Error("EACCES: permission denied, read")
				denied.code = "EACCES"
				vi.mocked(fs.readFile).mockRejectedValue(denied)
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await expect(diffViewProvider.discardUnapprovedStream()).rejects.toThrow(/permission denied, read/)

				// A read that said nothing about the file being gone does not license removing it.
				expect(fs.unlink).not.toHaveBeenCalledWith(fsPath)
				expect(fs.writeFile).toHaveBeenCalledTimes(1)
				expect(errorSpy).toHaveBeenCalledWith(
					"Error removing abandoned write_to_file artifacts:",
					expect.objectContaining({ code: "EACCES" }),
				)
				// The edit drops its claim on the path with the failure, so a later discard does not
				// report the same kept file twice.
				expect(diffViewProvider["placeholderPath"]).toBeUndefined()
				expect(diffViewProvider["placeholderContent"]).toBeUndefined()
			})

			it("reports a guard read that rejected with no error object and touches nothing", async () => {
				// The optional chain on the error binding is the whole difference between "this read proved
				// nothing about the file" and "this read blew up": a promise can reject with no value at all,
				// and reaching .code on that would throw inside the catch and escape the discard as some other
				// failure - no cleanup report from this site, and no answer about the file. The row above
				// covers a rejection that does carry a code; this one covers a rejection with no object to
				// carry one, which is the case the optional chain exists for.
				const relPath = "reasonless-rejection-placeholder.ts"
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
				// Structural double routed through unknown rather than any: only the members the discard
				// touches, the same double shape the neighbouring rows use.
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
				vi.mocked(fs.readFile).mockResolvedValue("")

				await diffViewProvider.open(relPath)
				expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")

				// The guard read now rejects with nothing in the rejection: no code to read, so the catch
				// can only conclude that the read proved nothing.
				vi.mocked(fs.readFile).mockRejectedValue(undefined)
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await expect(diffViewProvider.discardUnapprovedStream()).resolves.toBeUndefined()

				// Reported through the channel this cleanup site already has, with the file left exactly as it
				// was found and no second write to it.
				expect(errorSpy).toHaveBeenCalledWith("Error removing abandoned write_to_file artifacts:", undefined)
				expect(fs.unlink).not.toHaveBeenCalledWith(fsPath)
				expect(fs.writeFile).toHaveBeenCalledTimes(1)
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
				// The discard reads the placeholder back before unlinking it, so the double has to answer
				// with the empty content open() wrote; the test above covers the mismatching answer.
				vi.mocked(fs.readFile).mockResolvedValue("")

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

			it("does nothing when no abandoned view is open", async () => {
				Object.assign(diffViewProvider, { relPath: undefined, activeDiffEditor: undefined })

				await diffViewProvider.discardUnapprovedStream()

				expect(fs.unlink).not.toHaveBeenCalled()
			})
		})
	})
})
