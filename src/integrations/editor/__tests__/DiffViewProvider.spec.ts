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
}))

// Mock utils
vi.mock("../../../utils/fs", () => ({
	createDirectoriesForFile: vi.fn().mockResolvedValue([]),
}))

// Mock path
vi.mock("path", () => ({
	resolve: vi.fn((cwd, relPath) => `${cwd}/${relPath}`),
	normalize: vi.fn((p: string) => p),
	basename: vi.fn((path) => path.split("/").pop()),
	dirname: vi.fn((path) => path.split("/").slice(0, -1).join("/") || "/"),
	join: (...args: string[]) => args.join("/"),
	// diagnosticsToProblemsString formats its output header via
	// path.relative(cwd, uri.fsPath).toPosix(); the object-with-toPosix shape
	// mirrors the repo's own diagnostics.spec.ts mock.
	relative: vi.fn((cwd: string, p: string) => ({ toPosix: () => p.replace(`${cwd}/`, "") })),
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
	let mockTask: TaskDouble

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

	// Task double: providerRef.deref() -> getState() with provider settings, plus say() for the
	// fire-and-forget diagnostics tail. It is typed as this shape rather than `any` so the assertions
	// on those members stay type-checked, and DiffViewProvider is handed it through asTask() because
	// the class only ever reads providerRef and say off it - that keeps the one unavoidable
	// `as unknown as Task` cast in a single named place.
	type TaskDouble = { providerRef: { deref: Mock }; say: Mock }

	const asTask = (double: TaskDouble): Task => double as unknown as Task

	const makeTaskDouble = (stateOverrides: Record<string, unknown> = {}): TaskDouble => ({
		providerRef: {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					includeDiagnosticMessages: true,
					maxDiagnosticMessages: 50,
					...stateOverrides,
				}),
			}),
		},
		say: vi.fn().mockResolvedValue(true),
	})

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

		diffViewProvider = new DiffViewProvider(mockCwd, asTask(mockTask))
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

			// L1: saveDirectly resolves before the fire-and-forget diagnostics
			// tail runs; flush one macrotask tick so the mocked delay (and the
			// post-write getDiagnostics) have been reached before asserting.
			await new Promise((resolve) => setTimeout(resolve, 0))

			// Verify the tail applied the configured write delay
			expect(mockDelay).toHaveBeenCalledWith(2000, expect.objectContaining({ signal: expect.any(AbortSignal) }))
			expect(vscode.languages.getDiagnostics).toHaveBeenCalled()

			// Verify result: L1 no longer returns a problems message
			expect(result.newProblemsMessage).toBeUndefined()
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

			// L1: no diagnostics tail is launched, so nothing is ever emitted
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(mockTask.say).not.toHaveBeenCalled()
		})

		it("should handle negative delay values", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			await diffViewProvider.saveDirectly("test.ts", "new content", true, true, -500)

			// L1: the tail runs after resolve; flush one macrotask tick first.
			await new Promise((resolve) => setTimeout(resolve, 0))

			// Verify delay was called with 0 (safe minimum)
			expect(mockDelay).toHaveBeenCalledWith(0, expect.objectContaining({ signal: expect.any(AbortSignal) }))
		})

		it("should store results for formatFileWriteResponse", async () => {
			await diffViewProvider.saveDirectly("test.ts", "new content", true, true, 1000)

			// Verify internal state was updated (L1: the problems message is no
			// longer stored; it is emitted asynchronously via say("error"))
			expect(diffViewProvider["newProblemsMessage"]).toBeUndefined()
			expect(diffViewProvider["userEdits"]).toBeUndefined()
			expect(diffViewProvider["relPath"]).toBe("test.ts")
			expect(diffViewProvider["newContent"]).toBe("new content")
		})

		it("resolves immediately and emits new problems via say('error') after the write delay", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()
			vi.mocked(vscode.languages.getDiagnostics).mockClear()

			// Pre-write diagnostics are empty; the post-write snapshot (read by
			// the fire-and-forget tail) reports one new Error-severity problem.
			// vscode.workspace.fs.stat is an unimplemented vi.fn() mock, so
			// diagnosticsToProblemsString takes its "(unavailable)" fallback
			// branch and still formats the line.
			const newDiag: vscode.Diagnostic = {
				severity: vscode.DiagnosticSeverity.Error,
				range: new vscode.Range(0, 0, 0, 1),
				message: "boom",
			}
			const postDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [[makeUri(`${mockCwd}/test.ts`), [newDiag]]]
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValueOnce([]).mockReturnValue(postDiagnostics)

			const result = await diffViewProvider.saveDirectly("test.ts", "new content", true, true, 100)

			// L1: saveDirectly resolves before the tail emits anything.
			expect(result.newProblemsMessage).toBeUndefined()
			expect(mockTask.say).not.toHaveBeenCalled()

			// Flush the fire-and-forget tail (the mocked delay resolves immediately).
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockDelay).toHaveBeenCalledWith(100, expect.objectContaining({ signal: expect.any(AbortSignal) }))
			expect(mockTask.say).toHaveBeenCalledTimes(1)
			// The existing "error" ClineSay type is used, with the new-problems text. Asserted
			// by position so this test stays about the channel and the text, not the arity.
			expect(mockTask.say.mock.calls[0]?.[0]).toBe("error")
			expect(mockTask.say.mock.calls[0]?.[1]).toContain("New problems detected after saving file: test.ts")
			expect(mockTask.say.mock.calls[0]?.[1]).toContain("boom")
		})

		it("emits the post-save diagnostics as a non-interactive say so a pending ask survives", async () => {
			// The tail runs writeDelayMs after saveDirectly resolved, so the task has usually
			// moved on and may be waiting in ask() for the user. say() bumps lastMessageTs
			// unless the message is non-interactive, and ask()'s pWaitFor treats a moved
			// lastMessageTs as "superseded" - the pending ask would throw AskIgnoredError even
			// though the user never answered.
			const newDiag: vscode.Diagnostic = {
				severity: vscode.DiagnosticSeverity.Error,
				range: new vscode.Range(0, 0, 0, 1),
				message: "boom",
			}
			const postDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [[makeUri(`${mockCwd}/test.ts`), [newDiag]]]
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValueOnce([]).mockReturnValue(postDiagnostics)

			await diffViewProvider.saveDirectly("test.ts", "new content", true, true, 100)
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockTask.say).toHaveBeenCalledTimes(1)
			expect(mockTask.say.mock.calls[0]?.[6]).toEqual({ isNonInteractive: true })
			// Only the interactivity flag differs: the channel and the text are unchanged.
			expect(mockTask.say.mock.calls[0]?.[0]).toBe("error")
			expect(mockTask.say.mock.calls[0]?.[1]).toContain("New problems detected after saving file: test.ts")
			// The tail releases its controller when it completes - including the failing tail
			// below: without the finally cleanup, completed tails accumulate until disposal.
			expect(diffViewProvider["postSaveTails"].size).toBe(0)
		})

		it("does not start a tail when cancellation lands while the save is awaiting the write", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()
			vi.mocked(vscode.languages.getDiagnostics).mockClear()

			// Hold the publish pending, start the save, cancel (Task disposal), then release:
			// the save's tail-start point is reached after cancellation and must refuse to
			// start the tail.
			const fs = await import("fs/promises")
			const writeFileMock = vi.mocked(fs.writeFile)
			let releaseWrite!: () => void
			writeFileMock.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						releaseWrite = resolve
					}) as never,
			)
			const savePromise = diffViewProvider.saveDirectly("test.ts", "new content", true, true, 100)
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(writeFileMock).toHaveBeenCalledTimes(1)

			diffViewProvider.cancelPostSaveDiagnosticsTails()
			releaseWrite()
			await savePromise
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockDelay).not.toHaveBeenCalled()
			expect(mockTask.say).not.toHaveBeenCalled()
		})

		it("keeps each overlapping save's own diagnostics baseline", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()
			vi.mocked(vscode.languages.getDiagnostics).mockClear()

			// Both saves are started before either tail runs. The first save's pre-save
			// snapshot is empty, the second save's snapshot already has the problem (it
			// landed between the two writes); the post snapshot has it too. Each tail must
			// compare against its OWN captured baseline: the first emits once and the
			// second emits nothing. Using the shared this.preDiagnostics would emit zero.
			const diag: vscode.Diagnostic = {
				severity: vscode.DiagnosticSeverity.Error,
				range: new vscode.Range(0, 0, 0, 1),
				message: "overlap-problem",
			}
			const diagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [[makeUri(mockCwd + "/test.ts"), [diag]]]
			vi.mocked(vscode.languages.getDiagnostics)
				.mockReturnValueOnce([])
				.mockReturnValueOnce(diagnostics)
				.mockReturnValue(diagnostics)

			// Gate both tail delays so the two saves overlap before either tail runs.
			const releases: Array<() => void> = []
			mockDelay.mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						releases.push(resolve)
					}),
			)

			await diffViewProvider.saveDirectly("test.ts", "first", true, true, 100)
			await diffViewProvider.saveDirectly("test.ts", "second", true, true, 100)
			expect(releases).toHaveLength(2)

			releases.forEach((release) => release())
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockTask.say).toHaveBeenCalledTimes(1)
			expect(mockTask.say.mock.calls[0]?.[1]).toContain("overlap-problem")

			mockDelay.mockImplementation(() => Promise.resolve())
		})

		it("reports a run of overlapping saves of one file once, from the newest save", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()
			vi.mocked(vscode.languages.getDiagnostics).mockClear()

			// Both saves finish before the LSP answers, so each captured an empty baseline:
			// without supersession every tail diffs the same later problem and the user gets
			// one error row per save, the older row blaming a write that was clean.
			const diag: vscode.Diagnostic = {
				severity: vscode.DiagnosticSeverity.Error,
				range: new vscode.Range(0, 0, 0, 1),
				message: "superseded-run-problem",
			}
			const postDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [[makeUri(mockCwd + "/test.ts"), [diag]]]
			vi.mocked(vscode.languages.getDiagnostics)
				.mockReturnValueOnce([])
				.mockReturnValueOnce([])
				.mockReturnValue(postDiagnostics)

			// Gate both delays so neither tail can run until both saves have registered.
			const releases: Array<() => void> = []
			mockDelay.mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						releases.push(resolve)
					}),
			)

			try {
				await diffViewProvider.saveDirectly("test.ts", "first", true, true, 100)
				await diffViewProvider.saveDirectly("test.ts", "second", true, true, 100)
				expect(releases).toHaveLength(2)

				releases.forEach((release) => release())
				await new Promise((resolve) => setTimeout(resolve, 0))

				// Only the newest save's tail reports, and the superseded tail stops before
				// querying diagnostics: the workspace snapshot is read three times (the two
				// baselines plus one post) instead of four, and one row reaches the task.
				expect(vscode.languages.getDiagnostics).toHaveBeenCalledTimes(3)
				expect(mockTask.say).toHaveBeenCalledTimes(1)
				expect(mockTask.say.mock.calls[0]?.[1]).toContain("superseded-run-problem")
			} finally {
				mockDelay.mockImplementation(() => Promise.resolve())
			}
		})

		it("stops a tail whose delay is aborted before any diagnostics work", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()
			vi.mocked(vscode.languages.getDiagnostics).mockClear()
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			// The mocked delay rejects with an AbortError when the tail's signal aborts;
			// cancellation lands during the wait, before the post-save snapshot.
			mockDelay.mockImplementation(
				(_ms: number, options?: { signal?: AbortSignal }) =>
					new Promise<void>((_resolve, reject) => {
						options?.signal?.addEventListener(
							"abort",
							() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
							{ once: true },
						)
					}),
			)

			try {
				await diffViewProvider.saveDirectly("test.ts", "content", true, true, 100)
				await new Promise((resolve) => setTimeout(resolve, 0))
				// Only saveDirectly's pre-save snapshot ran so far.
				expect(vscode.languages.getDiagnostics).toHaveBeenCalledTimes(1)

				diffViewProvider.cancelPostSaveDiagnosticsTails()
				await new Promise((resolve) => setTimeout(resolve, 0))

				// The aborted tail returns before querying diagnostics or emitting anything.
				expect(vscode.languages.getDiagnostics).toHaveBeenCalledTimes(1)
				expect(mockTask.say).not.toHaveBeenCalled()
				expect(warnSpy).not.toHaveBeenCalled()
			} finally {
				warnSpy.mockRestore()
				mockDelay.mockImplementation(() => Promise.resolve())
			}
		})

		it("attributes only the saved file's new problems to the saved file", async () => {
			vi.mocked(vscode.languages.getDiagnostics).mockClear()

			// Multi-file write sequence: a later file's new error must not be
			// attributed to this tail's relPath by the workspace-wide snapshot.
			const ownDiag: vscode.Diagnostic = {
				severity: vscode.DiagnosticSeverity.Error,
				range: new vscode.Range(0, 0, 0, 1),
				message: "own-problem",
			}
			const otherDiag: vscode.Diagnostic = {
				severity: vscode.DiagnosticSeverity.Error,
				range: new vscode.Range(0, 0, 0, 1),
				message: "other-file-problem",
			}
			const postDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [
				[makeUri(`${mockCwd}/test.ts`), [ownDiag]],
				[makeUri(`${mockCwd}/other.ts`), [otherDiag]],
			]
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValueOnce([]).mockReturnValue(postDiagnostics)

			await diffViewProvider.saveDirectly("test.ts", "new content", true, true, 100)

			// Flush the fire-and-forget tail.
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockTask.say).toHaveBeenCalledTimes(1)
			expect(mockTask.say.mock.calls[0]?.[1]).toContain("own-problem")
		})

		it("narrows the tail payload to Error-severity diagnostics", async () => {
			// The tail formats with an explicit Error-only severity list. Mixed fixtures
			// are what make a widened severity list fail this test instead of passing silently.
			const ownWarning: vscode.Diagnostic = {
				severity: vscode.DiagnosticSeverity.Warning,
				range: new vscode.Range(0, 0, 0, 1),
				message: "own-warning",
			}
			const ownError: vscode.Diagnostic = {
				severity: vscode.DiagnosticSeverity.Error,
				range: new vscode.Range(0, 0, 0, 1),
				message: "own-error",
			}
			const mixedDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [
				[makeUri(`${mockCwd}/test.ts`), [ownWarning, ownError]],
			]
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValueOnce([]).mockReturnValue(mixedDiagnostics)

			await diffViewProvider.saveDirectly("test.ts", "new content", true, true, 100)
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockTask.say).toHaveBeenCalledTimes(1)
			expect(mockTask.say.mock.calls[0]?.[1]).toContain("own-error")
			expect(mockTask.say.mock.calls[0]?.[1]).not.toContain("own-warning")
			expect(diffViewProvider["postSaveTails"].size).toBe(0)

			// Warning-only diagnostics must not emit at all.
			mockTask.say.mockClear()
			const warningOnly: [vscode.Uri, vscode.Diagnostic[]][] = [[makeUri(`${mockCwd}/test.ts`), [ownWarning]]]
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValueOnce([]).mockReturnValue(warningOnly)

			await diffViewProvider.saveDirectly("test.ts", "more content", true, true, 100)
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockTask.say).not.toHaveBeenCalled()
		})

		it("stops a post-save tail that is cancelled while the diagnostic settings are read", async () => {
			const mockDelay = vi.mocked(delay)
			// Two delay() calls exist on this path (the save's own settle wait and the tail's),
			// so both must resolve: if the tail's wait never resolves the test would pass
			// vacuously instead of proving the re-check.
			mockDelay.mockImplementationOnce(() => Promise.resolve()).mockImplementationOnce(() => Promise.resolve())

			// A real problem is pending, so the only thing that can keep it from being
			// persisted is the re-check after the awaited settings read.
			const ownDiag: vscode.Diagnostic = {
				severity: vscode.DiagnosticSeverity.Error,
				range: new vscode.Range(0, 0, 0, 1),
				message: "cancelled-tail-problem",
			}
			const postDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [[makeUri(`${mockCwd}/test.ts`), [ownDiag]]]
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValueOnce([]).mockReturnValue(postDiagnostics)

			// diagnosticsToProblemsString starts its formatting pass with a
			// vscode.workspace.fs.stat per problem file, so clearing it here makes the
			// "no stat call" assertion below about this row's formatting pass only.
			vi.mocked(vscode.workspace.fs.stat).mockClear()

			// The settings read is the last await before the formatting and the emit. Resolving
			// it AFTER the cancellation is how a cancellation lands inside it: the await returns
			// normally and only the signal shows that the task is gone.
			const provider = mockTask.providerRef.deref()
			const originalGetState = provider.getState
			const slowGetState = vi.fn(
				() =>
					new Promise((resolve) =>
						setTimeout(() => resolve({ includeDiagnosticMessages: true, maxDiagnosticMessages: 50 }), 20),
					),
			)
			provider.getState = slowGetState

			try {
				await diffViewProvider.saveDirectly("test.ts", "content", true, true, 100)
				// Let the tail pass the settle delay and reach the settings await.
				await new Promise((resolve) => setTimeout(resolve, 5))
				expect(mockTask.say).not.toHaveBeenCalled()

				diffViewProvider.cancelPostSaveDiagnosticsTails()
				// The pending settings read resolves after the cancellation.
				await new Promise((resolve) => setTimeout(resolve, 80))

				expect(slowGetState).toHaveBeenCalledTimes(1)
				// The tail had already taken its pre-save baseline and read the post-save
				// diagnostics; it stopped at the re-check, so the pending problem is never
				// emitted into a task that no longer exists.
				expect(vscode.languages.getDiagnostics).toHaveBeenCalledTimes(2)
				expect(mockTask.say).not.toHaveBeenCalled()
				// The re-check after the settings read exists to skip the formatting pass, and
				// its first observable effect is the stat call above. Asserting on it is what
				// makes deleting that re-check fail this row: the emit guard further down would
				// otherwise hide the regression by suppressing say() all over again.
				expect(vscode.workspace.fs.stat).not.toHaveBeenCalled()
			} finally {
				provider.getState = originalGetState
			}
		})

		it("releases a tail whose cancellation lands inside a settings read that never returns", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockImplementation(() => Promise.resolve())
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])

			// The hardest shape of the same race: a settings read that never settles, so the
			// tail's own signal is the only thing that can end it. The tail unregisters its
			// controller in its finally block, so an entry still sitting in postSaveTails
			// after the abort proves the tail is parked on the read - holding the task and
			// the pre-save snapshot - instead of settling when the task is disposed.
			const provider = mockTask.providerRef.deref()
			provider.getState = vi.fn(() => new Promise<never>(() => {}))

			await diffViewProvider.saveDirectly("test.ts", "content", true, true, 0)
			await new Promise((resolve) => setTimeout(resolve, 0))
			const waiting = [...diffViewProvider["postSaveTails"]]
			expect(waiting).toHaveLength(1)

			// Disposal aborts the registered controller; here that is done directly so the
			// never-settling read cannot be the thing that ends the tail.
			waiting[0].abort()
			await new Promise((resolve) => setTimeout(resolve, 20))

			expect(diffViewProvider["postSaveTails"].size).toBe(0)
			expect(mockTask.say).not.toHaveBeenCalled()
		})

		it("attributes diagnostics to the saved file when the URI casing differs (Windows)", async () => {
			const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32")
			vi.mocked(vscode.languages.getDiagnostics).mockClear()

			// The diagnostic URI uses different casing than the saved relPath:
			// on Windows this is still the same file (arePathsEqual).
			const newDiag: vscode.Diagnostic = {
				severity: vscode.DiagnosticSeverity.Error,
				range: new vscode.Range(0, 0, 0, 1),
				message: "case-mismatch-problem",
			}
			const postDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [[makeUri(`${mockCwd}/Test.ts`), [newDiag]]]
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValueOnce([]).mockReturnValue(postDiagnostics)

			try {
				await diffViewProvider.saveDirectly("test.ts", "new content", true, true, 100)

				// Flush the fire-and-forget tail.
				await new Promise((resolve) => setTimeout(resolve, 0))

				expect(mockTask.say).toHaveBeenCalledTimes(1)
				expect(mockTask.say.mock.calls[0]?.[1]).toContain("case-mismatch-problem")
			} finally {
				// Restore on assertion failure too: a leaked win32 override would apply Windows
				// path rules to later tests' comparisons.
				platformSpy.mockRestore()
			}
		})

		it("does not block the save on a diagnostics settle delay when diagnostics are disabled", async () => {
			// openFile=false used to await a 100 ms settle delay even when
			// diagnostics were disabled; that delay now lives in the tail, which
			// does not run at all when diagnosticsEnabled is false.
			vi.mocked(vscode.languages.getDiagnostics).mockClear()
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			const result = await diffViewProvider.saveDirectly("test.ts", "new content", false, false)

			expect(result.finalContent).toBe("new content")
			expect(mockDelay).not.toHaveBeenCalled()
			expect(mockTask.say).not.toHaveBeenCalled()
		})

		it("carries the in-memory settle delay in the tail for openFile=false saves", async () => {
			vi.mocked(vscode.languages.getDiagnostics).mockClear()
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			await diffViewProvider.saveDirectly("test.ts", "new content", false, true, 100)

			// writeDelayMs (100) + the 100 ms in-memory diagnostics settle, both
			// applied by the tail instead of the save path.
			expect(mockDelay).toHaveBeenCalledWith(200, expect.objectContaining({ signal: expect.any(AbortSignal) }))
		})

		it("never calls say when there are no new problems", async () => {
			vi.mocked(vscode.languages.getDiagnostics).mockClear()
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])

			await diffViewProvider.saveDirectly("test.ts", "new content", true, true, 50)

			// Flush the fire-and-forget tail (pre/post snapshots are both empty,
			// so diagnosticsToProblemsString returns "" and nothing is emitted).
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockTask.say).not.toHaveBeenCalled()
		})

		it("logs a warning instead of an unhandled rejection when the post-save say() is aborted", async () => {
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			vi.mocked(vscode.languages.getDiagnostics).mockClear()

			// One new Error-severity problem so the tail reaches say().
			const newDiag: vscode.Diagnostic = {
				severity: vscode.DiagnosticSeverity.Error,
				range: new vscode.Range(0, 0, 0, 1),
				message: "boom",
			}
			const postDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [[makeUri(`${mockCwd}/test.ts`), [newDiag]]]
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValueOnce([]).mockReturnValue(postDiagnostics)

			// The task is aborted while the diagnostics tail is emitting: say() rejects.
			mockTask.say.mockRejectedValueOnce(new Error("aborted"))

			try {
				await diffViewProvider.saveDirectly("test.ts", "new content", true, true, 0)
				// Flush the fire-and-forget tail.
				await new Promise((resolve) => setTimeout(resolve, 0))

				// The method's outer catch swallows the rejection with a warning.
				expect(consoleWarnSpy).toHaveBeenCalledWith(
					expect.stringContaining("Post-save diagnostics emit failed:"),
				)
				// Even the failing tail releases its controller.
				expect(diffViewProvider["postSaveTails"].size).toBe(0)
			} finally {
				// Restore on assertion failure too: a leaked spy would swallow later tests' warnings.
				consoleWarnSpy.mockRestore()
			}
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
			const provider = new DiffViewProvider(mockCwd, asTask(makeTaskDouble(stateOverrides)))
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
})
