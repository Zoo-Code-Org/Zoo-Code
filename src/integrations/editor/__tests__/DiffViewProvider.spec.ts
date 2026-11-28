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
	// revertChanges() rolls a new-file edit back by unlinking the placeholder and rmdir-ing the
	// directories the edit created, so those two need real doubles here or the rollback throws.
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
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
		it("should handle showTextDocument failure", async () => {
			// Mock showTextDocument to fail
			vi.mocked(vscode.window.showTextDocument).mockRejectedValue(new Error("Cannot open file"))

			// Mock workspace.onDidOpenTextDocument
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockReturnValue({ dispose: vi.fn() })

			// Mock window.onDidChangeVisibleTextEditors
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })

			// Set up for file
			diffViewProvider["editType"] = "modify"

			// Try to open and expect rejection
			await expect(diffViewProvider.open("test.md")).rejects.toThrow(
				"Failed to execute diff command for /mock/cwd/test.md: Cannot open file",
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
		it("refuses to finish installing when a later open() takes the provider during its awaits", async () => {
			const stalePath = "stale-target.md"
			const newerPath = "newer-target.md"
			// The stale call parks inside its pre-edit read. Everything open() writes on the far side of that
			// await - the baseline, the directories, the placeholder, the tab bookkeeping, the buffer it
			// acquires - is shared state, so letting the stale call finish would install it over the edit
			// that already replaced it.
			let releaseStaleRead: (value: string) => void = () => undefined
			const staleRead = new Promise<string>((resolve) => {
				releaseStaleRead = resolve
			})
			vi.mocked(fs.readFile)
				.mockImplementationOnce(() => staleRead)
				.mockResolvedValueOnce("the newer edit’s own baseline")
			const staleEditor = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(`${mockCwd}/${stalePath}`),
				}),
			})
			const newerEditor = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(`${mockCwd}/${newerPath}`),
				}),
			})
			// Stubbed to the editor the real acquisition would hand back for each path: this case is about which
			// install the provider answers to, not about the tab plumbing or the acquisition timer.
			diffViewProvider["openDiffEditor"] = vi
				.fn()
				.mockImplementation(async () => (diffViewProvider["relPath"] === newerPath ? newerEditor : staleEditor))
			diffViewProvider.editType = "modify"

			const staleOpen = diffViewProvider.open(stalePath)
			await diffViewProvider.open(newerPath)
			const newerSession = diffViewProvider["editSession"]
			expect(diffViewProvider["activeDiffEditor"]).toBe(newerEditor)
			releaseStaleRead("the stale read, delivered after the newer open landed")

			await expect(staleOpen).rejects.toThrow(/superseded/i)

			// The newer install keeps every field the stale one would have written over it on the far side of
			// the await it was parked in.
			expect(diffViewProvider["relPath"]).toBe(newerPath)
			expect(diffViewProvider["editType"]).toBe("modify")
			expect(diffViewProvider["isEditing"]).toBe(true)
			expect(diffViewProvider["originalContent"]).toBe("the newer edit’s own baseline")
			expect(diffViewProvider["createdDirs"]).toEqual([])
			expect(diffViewProvider["activeDiffEditor"]).toBe(newerEditor)
			expect(diffViewProvider["editSession"]).toBe(newerSession)
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
			// Self-contained: the unit moved revertChanges()'s early-return guard from !activeDiffEditor
			// to !isEditing, so this fixture has to declare an edit in progress on its own target.
			diffViewProvider["relPath"] = "test.txt"
			diffViewProvider["isEditing"] = true
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

		const buildActiveDiffEditor = (docOverrides: { isDirty?: boolean } = {}) =>
			makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					positionAt: vi.fn().mockReturnValue(makePosition()),
					isDirty: docOverrides.isDirty ?? false,
					...docOverrides,
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
		it("revertChanges() neither saves nor deletes when the editor refuses the restore", async () => {
			// A refused WorkspaceEdit leaves the unapproved streamed content in the buffer. Saving it
			// would persist exactly what this rollback exists to undo, and deleting the placeholder
			// underneath would report a rollback that never finished. The refusal has to reach the
			// caller that reports failures, which is what the user gets instead of a false success.
			const editor = buildActiveDiffEditor({ isDirty: true })
			editor.document.getText = vi.fn().mockReturnValue("streamed content")
			const dirtyTab = {
				input: Object.assign(new vscode.TabInputText(makeUri(mockTargetPath)), {
					uri: makeUri(mockTargetPath),
				}),
				isDirty: true,
				label: "mock-target-file.ts",
			}
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			const originalDocs = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [dirtyTab] }],
				configurable: true,
			})
			Object.defineProperty(vscode.workspace, "textDocuments", {
				get: () => [editor.document],
				configurable: true,
			})
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(false)
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "create",
				createdDirs: [],
				originalContent: "pre-stream content",
			})

			try {
				await expect(diffViewProvider.revertChanges()).rejects.toThrow("could not restore the streamed buffer")
			} finally {
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
				if (originalDocs) {
					Object.defineProperty(vscode.workspace, "textDocuments", originalDocs)
				}
			}

			// Nothing saveable was left behind, and nothing was closed or deleted on top of the refusal.
			expect(editor.document.save).not.toHaveBeenCalled()
			expect(vscode.window.tabGroups.close).not.toHaveBeenCalled()
			expect(fs.unlink).not.toHaveBeenCalled()
		})
		it("revertChanges() restores and saves the buffer through the real rollback path", async () => {
			// The two tests above spy restorePreStreamBuffer() and saveBufferClean(), so the restoration
			// itself never runs there and only proves ordering. This one leaves both real: the buffer must
			// be put back through a WorkspaceEdit and saved clean, which is what stops close() from ever
			// seeing a dirty tab holding content the user never approved.
			const editor = buildActiveDiffEditor({ isDirty: true })
			editor.document.getText = vi.fn().mockReturnValue("streamed content")
			const dirtyTab = {
				input: Object.assign(new vscode.TabInputText(makeUri(mockTargetPath)), {
					uri: makeUri(mockTargetPath),
				}),
				isDirty: true,
				label: "mock-target-file.ts",
			}
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			const originalDocs = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [dirtyTab] }],
				configurable: true,
			})
			Object.defineProperty(vscode.workspace, "textDocuments", {
				// The real restore and save look the document up here; without this the methods would find
				// nothing and pass without touching anything.
				get: () => [editor.document],
				configurable: true,
			})
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "create",
				createdDirs: [],
				originalContent: "pre-stream content",
			})

			try {
				await diffViewProvider.revertChanges()
			} finally {
				// Do not leak the fixtures: later tests read the module-level tabGroups.all and textDocuments.
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
				if (originalDocs) {
					Object.defineProperty(vscode.workspace, "textDocuments", originalDocs)
				}
			}

			// The real restore replaced the whole buffer with the pre-stream content.
			expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1)
			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(
				editor.document.uri,
				expect.anything(),
				"pre-stream content",
			)
			// The real save ran on the restored buffer, and only then was the tab closed.
			expect(editor.document.save).toHaveBeenCalledTimes(1)
			const saveOrder = vi.mocked(editor.document.save).mock.invocationCallOrder[0]
			const closeOrder = vi.mocked(vscode.window.tabGroups.close).mock.invocationCallOrder.at(-1)
			expect(closeOrder).toBeGreaterThan(saveOrder)
			expect(fs.unlink).toHaveBeenCalledWith(mockTargetPath)
		})
		it("revertChanges() reports a close that rejected instead of deleting underneath it", async () => {
			// tabGroups.close() can reject, not only resolve false (the editor throws on veto). The rejection
			// used to be logged and swallowed, so the rollback continued, unlinked the placeholder, and
			// removed the directories it had created underneath a tab that was still open. The rejection
			// must surface as the rollback failure with the original error kept as its cause, and the
			// filesystem cleanup must not run: after a refused discard the caller owns the next step
			// (fail closed), so this rollback must not delete around it.
			const editor = buildActiveDiffEditor({ isDirty: true })
			const closeError = new Error("Tab close rejected by the editor")
			const dirtyTab = {
				input: Object.assign(new vscode.TabInputText(makeUri(mockTargetPath)), {
					uri: makeUri(mockTargetPath),
				}),
				isDirty: true,
				label: "mock-target-file.ts",
			}
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			const originalDocs = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			const originalClose = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "close")
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [dirtyTab] }],
				configurable: true,
			})
			Object.defineProperty(vscode.workspace, "textDocuments", {
				get: () => [editor.document],
				configurable: true,
			})
			Object.defineProperty(vscode.window.tabGroups, "close", {
				value: vi.fn().mockRejectedValue(closeError),
				configurable: true,
			})
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "create",
				createdDirs: [`${mockCwd}/new-parent`],
				originalContent: "",
			})

			try {
				// The failure is reported, not swallowed: revertChanges() rejects with the rollback
				// error, and the original rejection stays reachable as its cause.
				const failure = await diffViewProvider.revertChanges().then(
					() => undefined,
					(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
				)
				expect(failure).toBeInstanceOf(Error)
				expect(failure?.message).toContain("could not close the restored buffer")
				expect(failure?.cause).toBe(closeError)
				// Cleanup ownership is retained: the close was attempted without a force flag, and
				// neither the placeholder unlink nor the created-directory rmdir ran underneath the
				// still-open tab.
				expect(vscode.window.tabGroups.close).toHaveBeenCalledWith(dirtyTab)
				expect(fs.unlink).not.toHaveBeenCalled()
				expect(fs.rmdir).not.toHaveBeenCalled()
			} finally {
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
				if (originalDocs) {
					Object.defineProperty(vscode.workspace, "textDocuments", originalDocs)
				}
				if (originalClose) {
					Object.defineProperty(vscode.window.tabGroups, "close", originalClose)
				}
			}
		})
		it("revertChanges() reports a close the editor refused instead of deleting underneath it", async () => {
			// Even a restored, saved buffer can fail to close (a vetoing editor). Swallowing that let
			// the rollback delete the file underneath an open tab. The failure must propagate, and
			// the file must survive: unlinking after a refused close leaves an open tab on a ghost.
			const editor = buildActiveDiffEditor({ isDirty: true })
			const dirtyTab = {
				input: Object.assign(new vscode.TabInputText(makeUri(mockTargetPath)), {
					uri: makeUri(mockTargetPath),
				}),
				isDirty: true,
				label: "mock-target-file.ts",
			}
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			const originalDocs = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			const originalClose = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "close")
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [dirtyTab] }],
				configurable: true,
			})
			Object.defineProperty(vscode.workspace, "textDocuments", {
				get: () => [editor.document],
				configurable: true,
			})
			Object.defineProperty(vscode.window.tabGroups, "close", {
				value: vi.fn().mockResolvedValue(false),
				configurable: true,
			})
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "create",
				createdDirs: [],
				originalContent: "",
			})

			try {
				await expect(diffViewProvider.revertChanges()).rejects.toThrow("could not close the restored buffer")
				// This test owns only the refusal handling; the restore-before-close ordering is
				// asserted by the test above. What matters here is that the close was attempted
				// without a force flag and the file survived a close the editor vetoed.
				expect(vscode.window.tabGroups.close).toHaveBeenCalledWith(dirtyTab)
				expect(fs.unlink).not.toHaveBeenCalled()
			} finally {
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
				if (originalDocs) {
					Object.defineProperty(vscode.workspace, "textDocuments", originalDocs)
				}
				if (originalClose) {
					Object.defineProperty(vscode.window.tabGroups, "close", originalClose)
				}
			}
		})
		it("revertChanges() reports a save the editor did not perform for an existing file", async () => {
			// A restore that applied but did not persist leaves a dirty buffer one save away from disk.
			// save() resolves false in that case, and treating it as success would report a rollback that
			// never completed.
			const editor = buildActiveDiffEditor({ isDirty: true })
			editor.document.getText = vi.fn().mockReturnValue("streamed content")
			editor.document.save = vi.fn().mockResolvedValue(false)
			const originalDocs = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			Object.defineProperty(vscode.workspace, "textDocuments", { get: () => [], configurable: true })
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "modify",
				createdDirs: [],
				originalContent: "pre-stream content",
			})
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["keepOrCloseEditedFile"] = vi.fn().mockResolvedValue(undefined)

			try {
				await expect(diffViewProvider.revertChanges()).rejects.toThrow("could not save the restored buffer")
				expect(diffViewProvider["keepOrCloseEditedFile"]).not.toHaveBeenCalled()
			} finally {
				if (originalDocs) {
					Object.defineProperty(vscode.workspace, "textDocuments", originalDocs)
				}
			}
		})
		it("revertChanges() does not save an existing file when the editor refuses the restore", async () => {
			// The user must not be told the write was rolled back while the existing file still holds
			// content they never approved: the refusal has to reach the reporting layer, and the save
			// that would persist it must not run.
			const editor = buildActiveDiffEditor({ isDirty: true })
			editor.document.getText = vi.fn().mockReturnValue("streamed content")
			const originalDocs = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			Object.defineProperty(vscode.workspace, "textDocuments", { get: () => [], configurable: true })
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(false)
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "modify",
				createdDirs: [],
				originalContent: "pre-stream content",
			})
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["keepOrCloseEditedFile"] = vi.fn().mockResolvedValue(undefined)

			try {
				await expect(diffViewProvider.revertChanges()).rejects.toThrow("could not restore the streamed buffer")
				expect(editor.document.save).not.toHaveBeenCalled()
				expect(diffViewProvider["keepOrCloseEditedFile"]).not.toHaveBeenCalled()
			} finally {
				if (originalDocs) {
					Object.defineProperty(vscode.workspace, "textDocuments", originalDocs)
				}
			}
		})
		it("revertChanges() restores and saves an existing file through the real rollback path", async () => {
			// The existing-file branch used to build its own WorkspaceEdit, discard applyEdit()'s boolean,
			// and save unconditionally, so a refused restore wrote the unapproved streamed content to an
			// existing file. It now runs through the same contract as the new-file branch. textDocuments is
			// deliberately left empty: the branch reached this document through activeDiffEditor, and if the
			// restore resolved it by path again it would find nothing and skip the restore in silence.
			const editor = buildActiveDiffEditor({ isDirty: true })
			editor.document.getText = vi.fn().mockReturnValue("streamed content")
			const originalDocs = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			Object.defineProperty(vscode.workspace, "textDocuments", { get: () => [], configurable: true })
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "modify",
				createdDirs: [],
				originalContent: "pre-stream content",
			})
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["keepOrCloseEditedFile"] = vi.fn().mockResolvedValue(undefined)

			try {
				await diffViewProvider.revertChanges()
			} finally {
				if (originalDocs) {
					Object.defineProperty(vscode.workspace, "textDocuments", originalDocs)
				}
			}

			expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1)
			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(
				editor.document.uri,
				expect.anything(),
				"pre-stream content",
			)
			expect(editor.document.save).toHaveBeenCalledTimes(1)
			expect(fs.unlink).not.toHaveBeenCalled()
		})
		it("revertChanges() restores the buffer through the real helpers when only the diff editor holds it", async () => {
			// Same shape as the no-tab test above, but without stubbing restorePreStreamBuffer /
			// saveBufferClean: the document is reached through activeDiffEditor, the restore is
			// applied to it, and the save is asserted on the document itself.
			const editor = buildActiveDiffEditor({ isDirty: true })
			editor.document.getText = vi.fn().mockReturnValue("streamed content")
			const originalDocs = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			// The document is registered so the real helpers can resolve it; the TAB list stays
			// empty: only the diff editor holds the document.
			Object.defineProperty(vscode.workspace, "textDocuments", {
				get: () => [editor.document],
				configurable: true,
			})
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			Object.defineProperty(vscode.window.tabGroups, "all", { get: () => [{ tabs: [] }], configurable: true })
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "create",
				createdDirs: [],
				originalContent: "",
			})
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)

			try {
				await diffViewProvider.revertChanges()
			} finally {
				if (originalDocs) Object.defineProperty(vscode.workspace, "textDocuments", originalDocs)
				if (originalTabs) Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
			}

			// The real rollback ran even though no plain text tab exists for the path.
			expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1)
			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(editor.document.uri, expect.anything(), "")
			expect(editor.document.save).toHaveBeenCalledTimes(1)
			// Rollback completed: the empty placeholder it created is unlinked.
			expect(fs.unlink).toHaveBeenCalledWith(mockTargetPath)
		})
		it("revertChanges() restores and saves the buffer once even when no plain text tab is open", async () => {
			// The document can be open only through the diff editor: the user closed the plain text
			// tab, so tabGroups.all yields no TabInputText for the path. Restoring inside the tab loop
			// meant nothing ran, closeAllDiffViews() then skipped the dirty diff tab, and the unlink
			// left a dirty diff tab holding unapproved content that a later save would recreate.
			const editor = buildActiveDiffEditor({ isDirty: true })
			const teardown = diffViewProvider as unknown as {
				restorePreStreamBuffer: (absolutePath: string) => Promise<void>
				saveBufferClean: (absolutePath: string) => Promise<void>
			}
			const restore = vi.spyOn(teardown, "restorePreStreamBuffer").mockResolvedValue(undefined)
			const saveClean = vi.spyOn(teardown, "saveBufferClean").mockResolvedValue(undefined)
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			Object.defineProperty(vscode.window.tabGroups, "all", {
				// No plain TabInputText tab for this path - only the diff editor holds the document.
				get: () => [{ tabs: [] }],
				configurable: true,
			})
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "create",
				createdDirs: [],
				originalContent: "",
			})

			let restoreArgs: unknown[] = []
			let saveArgs: unknown[] = []
			let restoreOrder = 0
			let saveOrder = 0
			try {
				await diffViewProvider.revertChanges()
				// mockRestore() clears the recorded history, so the evidence is captured here.
				restoreArgs = restore.mock.calls.map((args) => args[0])
				saveArgs = saveClean.mock.calls.map((args) => args[0])
				restoreOrder = restore.mock.invocationCallOrder[0]
				saveOrder = saveClean.mock.invocationCallOrder[0]
			} finally {
				// Do not leak the fixture: later tests read the module-level tabGroups.all.
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
				restore.mockRestore()
				saveClean.mockRestore()
			}

			// Exactly once each, restore before save, even with an empty tab list.
			expect(restoreArgs).toEqual([mockTargetPath])
			expect(saveArgs).toEqual([mockTargetPath])
			expect(saveOrder).toBeGreaterThan(restoreOrder)
			// The rollback still completed: the file it created was unlinked.
			expect(fs.unlink).toHaveBeenCalledWith(mockTargetPath)
		})
		it("revertChanges() restores the streamed buffer before closing it for a new file", async () => {
			// tabGroups.close()'s second argument is preserveFocus, not a force-discard flag: closing
			// a dirty tab prompts or is refused, which is how unapproved streamed content survived a
			// "forced" close. The buffer must be restored to its pre-stream content and saved clean
			// BEFORE the close, so close() never sees a dirty tab.
			const editor = buildActiveDiffEditor({ isDirty: true })
			const teardown = diffViewProvider as unknown as {
				restorePreStreamBuffer: (absolutePath: string) => Promise<void>
				saveBufferClean: (absolutePath: string) => Promise<void>
			}
			let restoreArgs: unknown[] = []
			let saveArgs: unknown[] = []
			let restoreOrder = 0
			let saveOrder = 0
			const restore = vi.spyOn(teardown, "restorePreStreamBuffer").mockResolvedValue(undefined)
			const saveClean = vi.spyOn(teardown, "saveBufferClean").mockResolvedValue(undefined)
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
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "create",
				createdDirs: [],
				originalContent: "",
			})

			try {
				await diffViewProvider.revertChanges()
				// mockRestore() clears the recorded history, so the evidence is captured here.
				restoreArgs = restore.mock.calls.map((args) => args[0])
				saveArgs = saveClean.mock.calls.map((args) => args[0])
				restoreOrder = restore.mock.invocationCallOrder[0]
				saveOrder = saveClean.mock.invocationCallOrder[0]
			} finally {
				// Do not leak the fixture: later tests read the module-level tabGroups.all.
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
				restore.mockRestore()
				saveClean.mockRestore()
			}

			expect(restoreArgs).toEqual([mockTargetPath])
			expect(saveArgs).toEqual([mockTargetPath])
			expect(saveOrder).toBeGreaterThan(restoreOrder)
			const closeOrder = vi.mocked(vscode.window.tabGroups.close).mock.invocationCallOrder.at(-1)
			expect(closeOrder).toBeGreaterThan(saveOrder)
			// No force flag: the tab is clean by the time it is closed.
			expect(vscode.window.tabGroups.close).toHaveBeenCalledWith(dirtyTab)
			expect(fs.unlink).toHaveBeenCalledWith(mockTargetPath)
		})
		it("revertChanges() surfaces a placeholder delete that failed for a non-ENOENT reason", async () => {
			// The ENOENT tolerance is scoped: an unlink that fails for another reason means the
			// unapproved placeholder is still on disk, and the caller must not be told the
			// rollback succeeded.
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs: [],
			})
			vi.mocked(fs.unlink).mockRejectedValueOnce(
				Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
			)

			await expect(diffViewProvider.revertChanges()).rejects.toThrow("EACCES: permission denied")
		})
		it("revertChanges() surfaces a non-ENOENT directory failure instead of swallowing it", async () => {
			// The tolerance is scoped to ENOENT: a directory that exists but could not be removed
			// is a real rollback failure and must reach the caller rather than be hidden.
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs: [`${mockCwd}/new-parent`],
			})
			vi.mocked(fs.rmdir).mockRejectedValueOnce(Object.assign(new Error("EBUSY"), { code: "EBUSY" }))

			await expect(diffViewProvider.revertChanges()).rejects.toThrow("EBUSY")
		})
		it("revertChanges() reports whether a rollback was performed", async () => {
			// The return value is the caller's evidence. WriteToFileTool keeps its refused-rollback
			// marker unless revertChanges() confirms a rollback, because a resolved promise also covers
			// the case where this provider no longer has an edit in progress to restore - and that is
			// exactly the state a fail-closed caller must not read as "the buffer was restored".
			Object.assign(diffViewProvider, {
				isEditing: false,
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs: [],
			})
			await expect(diffViewProvider.revertChanges()).resolves.toBe(false)

			Object.assign(diffViewProvider, { isEditing: true })
			await expect(diffViewProvider.revertChanges()).resolves.toBe(true)
			expect(fs.unlink).toHaveBeenCalledWith(`${mockCwd}/mock-target-file.ts`)
		})
		it("revertChanges() keeps rolling back the remaining directories when one rmdir hits ENOENT", async () => {
			// Same tolerance as the placeholder, for the created dirs: a directory that never
			// landed must not abort the rest of the rollback and must not surface as a new failure.
			const createdDirs = [`${mockCwd}/new-parent`, `${mockCwd}/new-parent/nested`]
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs,
			})
			vi.mocked(fs.rmdir).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

			await expect(diffViewProvider.revertChanges()).resolves.toBe(true)

			expect(fs.rmdir).toHaveBeenCalledTimes(2)
			expect(fs.rmdir).toHaveBeenNthCalledWith(1, createdDirs[1])
			expect(fs.rmdir).toHaveBeenNthCalledWith(2, createdDirs[0])
		})
		it("revertChanges() stops before the document work for an existing file when no editor exists", async () => {
			// The modify branch used to dereference activeDiffEditor unconditionally. When open()
			// never produced an editor there is no document to restore, and the old code threw a
			// TypeError out of the denial path instead of finishing the teardown.
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "modify",
				createdDirs: [],
			})

			// No editor means no document to restore: the stream's content is still on disk, and the
			// caller has to be able to tell that apart from a completed rollback.
			await expect(diffViewProvider.revertChanges()).resolves.toBe(false)

			expect(vscode.workspace.applyEdit).not.toHaveBeenCalled()
			expect(fs.unlink).not.toHaveBeenCalled()
			expect(fs.rmdir).not.toHaveBeenCalled()
		})
		it("revertChanges() tolerates a placeholder that was never written", async () => {
			// The failed open may have died before fs.writeFile ran; ENOENT during the
			// rollback is success, not a new failure that would abort the cleanup.
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs: [],
			})
			vi.mocked(fs.unlink).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

			// The rollback ran, so it reports a performed rollback even though the delete hit ENOENT.
			await expect(diffViewProvider.revertChanges()).resolves.toBe(true)

			// The rollback still attempted the delete - the tolerance is about not
			// aborting the rest of the cleanup, not about skipping it.
			expect(fs.unlink).toHaveBeenCalledWith(`${mockCwd}/mock-target-file.ts`)
		})
		it("reset() clears relPath so a later teardown cannot reuse a stale target", async () => {
			Object.assign(diffViewProvider, { isEditing: true, relPath: "mock-target-file.ts" })

			await diffViewProvider.reset()

			expect(diffViewProvider["relPath"]).toBeUndefined()
		})
		it("revertChanges() leaves an earlier edit's file alone when no edit is in progress", async () => {
			// reset() used to leave relPath behind while clearing editType. A later stream that never
			// opened a diff view then reached this method with a stale relPath and no editType, took
			// the new-file branch, and unlinked the PREVIOUS edit's target - an existing user file,
			// permanently. Nothing may be deleted unless an edit is actually in progress.
			Object.assign(diffViewProvider, {
				isEditing: false,
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: undefined,
				createdDirs: [`${mockCwd}/new-parent`],
			})

			await expect(diffViewProvider.revertChanges()).resolves.toBe(false)

			expect(fs.unlink).not.toHaveBeenCalled()
			expect(fs.rmdir).not.toHaveBeenCalled()
		})
		it("revertChanges() removes the placeholder and created dirs when open() failed before the editor existed", async () => {
			// open() creates the parent dirs and an empty placeholder BEFORE it awaits
			// openDiffEditor(). If that await rejects there is no activeDiffEditor, and the
			// rollback used to bail out - leaving an empty file that the next execute() mistook
			// for an existing file, which a denial then preserved.
			const createdDirs = [`${mockCwd}/new-parent`, `${mockCwd}/new-parent/nested`]
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs,
			})

			await diffViewProvider.revertChanges()

			expect(fs.unlink).toHaveBeenCalledWith(`${mockCwd}/mock-target-file.ts`)
			expect(fs.rmdir).toHaveBeenNthCalledWith(1, createdDirs[1])
			expect(fs.rmdir).toHaveBeenNthCalledWith(2, createdDirs[0])
		})

		it("revertChanges() closes the file tab when the file was not open and untouched", async () => {
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = closeFileTab
			diffViewProvider["relPath"] = "mock-target-file.ts"
			// revertChanges() returns early unless an edit is in progress: the unit moved the guard from
			// !activeDiffEditor to !isEditing, so a fixture that only sets activeDiffEditor would exit here.
			diffViewProvider["isEditing"] = true
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
			// revertChanges() returns early unless an edit is in progress: the unit moved the guard from
			// !activeDiffEditor to !isEditing, so a fixture that only sets activeDiffEditor would exit here.
			diffViewProvider["isEditing"] = true
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
			// revertChanges() returns early unless an edit is in progress: the unit moved the guard from
			// !activeDiffEditor to !isEditing, so a fixture that only sets activeDiffEditor would exit here.
			diffViewProvider["isEditing"] = true
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

	describe("attemptRollbackRecovery() re-acquires the buffer it is rolling back", () => {
		// The recovery entry point exists because reset() has already forgotten the edit: a refused
		// rollback reports itself, the tool keeps the captured context across that reset, and the context
		// is handed back later. Installing only the recorded metadata left revertChanges() free to report
		// a result the caller could not act on, in both edit types, which is the pair of wrong reports the
		// two cases below pin.
		const recoveryContextFor = (relPath: string, editType: "create" | "modify", createdDirs: string[] = []) => ({
			relPath,
			absolutePath: `${mockCwd}/${relPath}`,
			editType,
			createdDirs,
			// The record describes the install the provider answers to when it is captured, which is what lets a
			// recovery tell a retry apart from the attempt it was asked to undo.
			editSession: diffViewProvider["editSession"],
			originalContent: editType === "modify" ? "on-disk original" : "",
		})

		const simulateReset = () => {
			Object.assign(diffViewProvider, {
				isEditing: false,
				relPath: undefined,
				editType: undefined,
				createdDirs: [],
				originalContent: undefined,
				activeDiffEditor: undefined,
			})
			// Stubbed to the editor the real acquisition would hand back for this path. openDiffEditor() is
			// covered by the open() suite, and leaving it live here would make the case depend on tab
			// plumbing and a ten-second acquisition timeout instead of on the recovery contract.
			const document = makeTextDocument({
				uri: makeUri(`${mockCwd}/mock-recovery-target.ts`),
				getText: vi.fn().mockReturnValue("streamed, never approved"),
				isDirty: true,
			})
			const editor = makeTextEditor({ document })
			diffViewProvider["openDiffEditor"] = vi.fn().mockResolvedValue(editor)
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
			return editor
		}

		it("discards the dirty buffer of a refused create instead of reporting a clean rollback", async () => {
			const relPath = "mock-recovery-target.ts"
			const absolutePath = `${mockCwd}/${relPath}`
			simulateReset()
			// The row asks this case to name the side of the discard the unlink may sit on, so the discard
			// is held unresolved and the placeholder is asserted still on disk inside that window. The
			// promise is resolved by the test and never by the production await, so the rollback proceeds
			// only after the ordering question has been answered.
			let settleDiscard: (() => void) | undefined
			const discardHeld = new Promise<void>((resolve) => {
				settleDiscard = resolve
			})
			const discardFileTab = vi.fn(() => discardHeld)
			diffViewProvider["discardFileTab"] = discardFileTab

			const recovery = diffViewProvider.attemptRollbackRecovery(
				recoveryContextFor(relPath, "create", [`${mockCwd}/new-parent`]),
			)

			// Let the recovery run to its await on the held discard, then answer the ordering question while
			// that await is still pending: a rollback that unlinked the placeholder before discarding the
			// buffer has already deleted the file by this point and fails here, while the assertions that
			// describe the finished rollback stay green in either order.
			await vi.waitFor(() => {
				expect(discardFileTab).toHaveBeenCalledWith(absolutePath)
			})
			expect(fs.unlink).not.toHaveBeenCalledWith(absolutePath)
			settleDiscard?.()

			await expect(recovery).resolves.toBe(true)

			// The buffer work has to happen before the placeholder goes away. With metadata-only recovery
			// revertChanges() skipped the document branch, unlinked the placeholder, deleted the created
			// directory and still returned true: the tool read that as a restored buffer, cleared its
			// fail-closed refusal, and the next open() of this path saved content the user never approved.
			expect(diffViewProvider["openDiffEditor"]).toHaveBeenCalledTimes(1)
			expect(discardFileTab).toHaveBeenCalledWith(absolutePath)
			expect(fs.unlink).toHaveBeenCalledWith(absolutePath)
			expect(fs.rmdir).toHaveBeenCalledWith(`${mockCwd}/new-parent`)
			// The recovery leaves the provider as clean as the rollback it reports.
			expect(diffViewProvider["isEditing"]).toBe(false)
			expect(diffViewProvider["activeDiffEditor"]).toBeUndefined()
		})

		it("restores the install when the recovery cannot re-acquire the buffer", async () => {
			const relPath = "mock-recovery-target."
			const absolutePath = `${mockCwd}/${relPath}`
			const editor = simulateReset()
			const gone = new Error("EPERM: the file is gone before the buffer could be reopened")
			const acquisition = vi.fn().mockRejectedValueOnce(gone).mockResolvedValue(editor)
			diffViewProvider["openDiffEditor"] = acquisition
			const restorePreStreamBuffer = vi.fn().mockResolvedValue(undefined)
			const saveBufferClean = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreStreamBuffer"] = restorePreStreamBuffer
			diffViewProvider["saveBufferClean"] = saveBufferClean
			diffViewProvider["keepOrCloseEditedFile"] = vi.fn().mockResolvedValue(undefined)

			// A file that is gone by the time the retry runs is the shape this branch has to survive: the
			// acquisition rejects, and the caller reads the rejection as a refused restore. What used to
			// survive the rejection was the install itself - isEditing true with no editor - and the next
			// attempt then walked past the acquisition into a revertChanges() that found no document, and
			// in the create shape it deleted the placeholder, ran its own cleanup and reported a clean
			// rollback with the dirty buffer still open. Rethrowing only helps if the provider is put
			// back exactly as it was found, which is what the assertions after the rejection check.
			await expect(diffViewProvider.attemptRollbackRecovery(recoveryContextFor(relPath, "modify"))).rejects.toBe(
				gone,
			)

			expect(acquisition).toHaveBeenCalledTimes(1)
			expect(restorePreStreamBuffer).not.toHaveBeenCalled()
			expect(saveBufferClean).not.toHaveBeenCalled()
			expect(diffViewProvider["isEditing"]).toBe(false)
			expect(diffViewProvider["relPath"]).toBeUndefined()
			expect(diffViewProvider["editType"]).toBeUndefined()
			expect(diffViewProvider["createdDirs"]).toEqual([])
			expect(diffViewProvider["originalContent"]).toBeUndefined()
			expect(diffViewProvider["activeDiffEditor"]).toBeUndefined()

			// The caller keeps its refusal until a rollback reports completion, so the next attempt has to
			// reach the acquisition again. A half-installed provider would report false there without
			// trying, and the path would stay refused for the rest of the task with its buffer on screen.
			await expect(diffViewProvider.attemptRollbackRecovery(recoveryContextFor(relPath, "modify"))).resolves.toBe(
				true,
			)
			expect(acquisition).toHaveBeenCalledTimes(2)
			expect(restorePreStreamBuffer).toHaveBeenCalledWith(absolutePath, editor.document, "on-disk original")
			expect(saveBufferClean).toHaveBeenCalledWith(absolutePath, editor.document)
		})

		it("restores and saves an existing file instead of reporting that there was nothing to restore", async () => {
			const relPath = "mock-recovery-target.ts"
			const absolutePath = `${mockCwd}/${relPath}`
			const editor = simulateReset()
			const restorePreStreamBuffer = vi.fn().mockResolvedValue(undefined)
			const saveBufferClean = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreStreamBuffer"] = restorePreStreamBuffer
			diffViewProvider["saveBufferClean"] = saveBufferClean
			diffViewProvider["keepOrCloseEditedFile"] = vi.fn().mockResolvedValue(undefined)

			await expect(diffViewProvider.attemptRollbackRecovery(recoveryContextFor(relPath, "modify"))).resolves.toBe(
				true,
			)

			// Without the re-acquisition this branch found no document, took the "editor vanished" return
			// false, and every later retry on the same path reported the same nothing: the refusal could
			// never be lifted, so the path stayed blocked for the rest of the task even though the file
			// was sitting there, dirty, waiting to be restored.
			expect(restorePreStreamBuffer).toHaveBeenCalledWith(absolutePath, editor.document, "on-disk original")
			expect(saveBufferClean).toHaveBeenCalledWith(absolutePath, editor.document)
		})

		it("stops when a retry takes the provider for another edit while the buffer is being acquired", async () => {
			const relPath = "mock-recovery-target.ts"
			const otherRelPath = "another-target.ts"
			const editor = simulateReset()
			const restorePreStreamBuffer = vi.fn().mockResolvedValue(undefined)
			const saveBufferClean = vi.fn().mockResolvedValue(undefined)
			const keepOrCloseEditedFile = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreStreamBuffer"] = restorePreStreamBuffer
			diffViewProvider["saveBufferClean"] = saveBufferClean
			diffViewProvider["keepOrCloseEditedFile"] = keepOrCloseEditedFile
			// The acquisition is the await this recovery performs, and the next attempt does not wait for it:
			// a refused rollback reports, the tool keeps the captured context across the reset, and the
			// retry opens a different target on this same provider while this recovery is still waiting.
			// open() overwrites exactly the fields revertChanges() works from, so a recovery that finished
			// here unchecked would restore and save the other edit's content into the other edit's target.
			// A distinct editor double, so an assertion can tell whose editor is in the slot rather than only
			// that the slot is empty.
			const interloperEditor = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(`${mockCwd}/${otherRelPath}`),
					getText: vi.fn().mockReturnValue("the other edit's own streamed buffer"),
					isDirty: true,
				}),
			})
			const otherCreatedDirs = [`${mockCwd}/nested`]
			diffViewProvider["openDiffEditor"] = vi.fn(async () => {
				Object.assign(diffViewProvider, {
					isEditing: true,
					relPath: otherRelPath,
					editType: "modify",
					createdDirs: otherCreatedDirs,
					// open() stamps a new session on every install, so a retry is a new edit even when its target and
					// edit type are the ones already on the provider.
					editSession: diffViewProvider["editSession"] + 1,
					originalContent: "the other file's own original",
					activeDiffEditor: interloperEditor,
				})
				return editor
			})

			// The caller keeps its refusal on a false return, which is the only honest outcome here:
			// no rollback of this edit ran.
			await expect(diffViewProvider.attemptRollbackRecovery(recoveryContextFor(relPath, "modify"))).resolves.toBe(
				false,
			)

			// Nothing was restored and nothing was saved for either path.
			expect(restorePreStreamBuffer).not.toHaveBeenCalled()
			expect(saveBufferClean).not.toHaveBeenCalled()
			expect(keepOrCloseEditedFile).not.toHaveBeenCalled()
			// The live edit keeps the provider it just took, in every respect: its own target, its own edit
			// type, its own baseline, the directories its own open() made, and the editor its own flow
			// installed. An identity assertion is what makes the last one a claim about the other edit's
			// editor rather than about an empty slot: a recovery that steered the provider on its way out
			// could clear the slot or fill it with the buffer this recovery had just reopened.
			expect(diffViewProvider["isEditing"]).toBe(true)
			expect(diffViewProvider["relPath"]).toBe(otherRelPath)
			expect(diffViewProvider["editType"]).toBe("modify")
			expect(diffViewProvider["originalContent"]).toBe("the other file's own original")
			expect(diffViewProvider["createdDirs"]).toEqual(otherCreatedDirs)
			expect(diffViewProvider["activeDiffEditor"]).toBe(interloperEditor)
		})

		it("leaves a live edit alone when its own acquisition rejects after another edit was taken", async () => {
			const relPath = "mock-recovery-target.ts"
			const otherRelPath = "another-target.ts"
			simulateReset()
			const gone = new Error("EPERM: the file is gone before the buffer could be reopened")
			const restorePreStreamBuffer = vi.fn().mockResolvedValue(undefined)
			const saveBufferClean = vi.fn().mockResolvedValue(undefined)
			const keepOrCloseEditedFile = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreStreamBuffer"] = restorePreStreamBuffer
			diffViewProvider["saveBufferClean"] = saveBufferClean
			diffViewProvider["keepOrCloseEditedFile"] = keepOrCloseEditedFile
			// The interleaving of the case above, with the acquisition rejecting instead of settling: a retry
			// takes the provider for its own target while this recovery waits, and then the buffer this
			// recovery needs cannot be reopened. The recovery reports its own failure, and the fields it
			// captured are not its own to put back any more - restoring them unconditionally handed the
			// provider to a stale install while an edit on another target was live on it, with its buffer
			// open and its baseline gone.
			// The same install as the case above, editor included: the slot holds the other edit's own
			// buffer, so an assertion about it says whether a failed recovery cleared somebody else's editor.
			const interloperEditor = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(`${mockCwd}/${otherRelPath}`),
					getText: vi.fn().mockReturnValue("the other edit's own streamed buffer"),
					isDirty: true,
				}),
			})
			const otherCreatedDirs = [`${mockCwd}/nested`]
			diffViewProvider["openDiffEditor"] = vi.fn(async () => {
				Object.assign(diffViewProvider, {
					isEditing: true,
					relPath: otherRelPath,
					editType: "modify",
					createdDirs: otherCreatedDirs,
					// open() stamps a new session on every install, so a retry is a new edit even when its target and
					// edit type are the ones already on the provider.
					editSession: diffViewProvider["editSession"] + 1,
					originalContent: "the other file's own original",
					activeDiffEditor: interloperEditor,
				})
				throw gone
			})

			await expect(diffViewProvider.attemptRollbackRecovery(recoveryContextFor(relPath, "modify"))).rejects.toBe(
				gone,
			)

			// No rollback ran for either target.
			expect(restorePreStreamBuffer).not.toHaveBeenCalled()
			expect(saveBufferClean).not.toHaveBeenCalled()
			expect(keepOrCloseEditedFile).not.toHaveBeenCalled()
			// The live edit keeps the provider it took in every respect: its own target, its own edit type,
			// its own baseline, the directories its own open() made, and the editor its own flow installed.
			// The directories are the field a failed acquisition used to put back unconditionally, and the
			// editor is the one the recovery never touched at all - both are asserted by identity so the case
			// says the other edit's state survived rather than that a slot happens to be filled.
			expect(diffViewProvider["isEditing"]).toBe(true)
			expect(diffViewProvider["relPath"]).toBe(otherRelPath)
			expect(diffViewProvider["editType"]).toBe("modify")
			expect(diffViewProvider["originalContent"]).toBe("the other file's own original")
			expect(diffViewProvider["createdDirs"]).toEqual(otherCreatedDirs)
			expect(diffViewProvider["activeDiffEditor"]).toBe(interloperEditor)
		})

		it("stops when the provider is cleared again while its editor is being acquired", async () => {
			const relPath = "mock-recovery-target.ts"
			const editor = simulateReset()
			const restorePreStreamBuffer = vi.fn().mockResolvedValue(undefined)
			const saveBufferClean = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreStreamBuffer"] = restorePreStreamBuffer
			diffViewProvider["saveBufferClean"] = saveBufferClean
			diffViewProvider["keepOrCloseEditedFile"] = vi.fn().mockResolvedValue(undefined)
			// The other way ownership goes away: something resets the provider out from under the recovery,
			// so the install this recovery made is gone by the time the acquisition settles and the rollback
			// would read a relPath and a baseline that belong to no edit at all.
			diffViewProvider["openDiffEditor"] = vi.fn(async () => {
				Object.assign(diffViewProvider, {
					isEditing: false,
					relPath: undefined,
					editType: undefined,
					createdDirs: [],
					originalContent: undefined,
				})
				return editor
			})

			await expect(diffViewProvider.attemptRollbackRecovery(recoveryContextFor(relPath, "modify"))).resolves.toBe(
				false,
			)

			expect(restorePreStreamBuffer).not.toHaveBeenCalled()
			expect(saveBufferClean).not.toHaveBeenCalled()
			expect(diffViewProvider["isEditing"]).toBe(false)
			// The editor this recovery managed to acquire is dropped rather than installed: a recovery that
			// no longer owns the edit does not steer the provider with it either.
			expect(diffViewProvider["activeDiffEditor"]).toBeUndefined()
		})
		it("leaves a retry of the same file alone when the record describes an earlier session", async () => {
			const relPath = "mock-recovery-target.ts"
			const absolutePath = `${mockCwd}/${relPath}`
			simulateReset()
			const restorePreStreamBuffer = vi.fn().mockResolvedValue(undefined)
			const saveBufferClean = vi.fn().mockResolvedValue(undefined)
			const keepOrCloseEditedFile = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreStreamBuffer"] = restorePreStreamBuffer
			diffViewProvider["saveBufferClean"] = saveBufferClean
			diffViewProvider["keepOrCloseEditedFile"] = keepOrCloseEditedFile
			// Captured while the install it describes is still the one the provider answers to.
			const record = recoveryContextFor(relPath, "modify")
			// The retry the row is about: the same file, reopened as the same kind of edit, with its own
			// baseline in its own buffer. Its target and its edit type are identical to the record's, so
			// neither of those says whether this rollback belongs to the edit in front of it.
			const retryEditor = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(absolutePath),
					getText: vi.fn().mockReturnValue("the retry's own streamed buffer"),
					isDirty: true,
				}),
			})
			const retrySession = diffViewProvider["editSession"] + 1
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath,
				editType: "modify",
				editSession: retrySession,
				createdDirs: [],
				originalContent: "the retry's own baseline",
				activeDiffEditor: retryEditor,
			})

			await expect(diffViewProvider.attemptRollbackRecovery(record)).resolves.toBe(false)

			// The caller keeps its refusal, which is the honest outcome: no rollback of the edit this record
			// describes ran. The retry keeps its own edit - its buffer was not restored from an earlier
			// attempt's baseline, nothing was saved out of it, and its own editor is still installed.
			expect(restorePreStreamBuffer).not.toHaveBeenCalled()
			expect(saveBufferClean).not.toHaveBeenCalled()
			expect(keepOrCloseEditedFile).not.toHaveBeenCalled()
			expect(diffViewProvider["isEditing"]).toBe(true)
			expect(diffViewProvider["relPath"]).toBe(relPath)
			expect(diffViewProvider["editSession"]).toBe(retrySession)
			expect(diffViewProvider["originalContent"]).toBe("the retry's own baseline")
			expect(diffViewProvider["activeDiffEditor"]).toBe(retryEditor)
		})

		it("reverts the live edit when it is the session the record describes", async () => {
			const relPath = "mock-recovery-target.ts"
			const absolutePath = `${mockCwd}/${relPath}`
			const editor = simulateReset()
			const restorePreStreamBuffer = vi.fn().mockResolvedValue(undefined)
			const saveBufferClean = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreStreamBuffer"] = restorePreStreamBuffer
			diffViewProvider["saveBufferClean"] = saveBufferClean
			diffViewProvider["keepOrCloseEditedFile"] = vi.fn().mockResolvedValue(undefined)
			// The pin the case above needs: the stamp refuses another attempt, it does not refuse the
			// rollback that was asked for. The edit is live under the session this record names.
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath,
				editType: "modify",
				createdDirs: [],
				originalContent: "on-disk original",
				activeDiffEditor: editor,
			})
			const record = recoveryContextFor(relPath, "modify")

			await expect(diffViewProvider.attemptRollbackRecovery(record)).resolves.toBe(true)

			expect(restorePreStreamBuffer).toHaveBeenCalledWith(absolutePath, editor.document, "on-disk original")
			expect(saveBufferClean).toHaveBeenCalledWith(absolutePath, editor.document)
		})

		it("stops when the same file is reopened under a newer session while its editor is being acquired", async () => {
			const relPath = "mock-recovery-target.ts"
			const absolutePath = `${mockCwd}/${relPath}`
			const editor = simulateReset()
			const restorePreStreamBuffer = vi.fn().mockResolvedValue(undefined)
			const saveBufferClean = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreStreamBuffer"] = restorePreStreamBuffer
			diffViewProvider["saveBufferClean"] = saveBufferClean
			diffViewProvider["keepOrCloseEditedFile"] = vi.fn().mockResolvedValue(undefined)
			const record = recoveryContextFor(relPath, "modify")
			const retryEditor = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(absolutePath),
					getText: vi.fn().mockReturnValue("the retry's own streamed buffer"),
					isDirty: true,
				}),
			})
			const retryCreatedDirs: string[] = []
			const retrySession = diffViewProvider["editSession"] + 1
			// The retry lands during the acquisition, which is where this recovery spends its time.
			diffViewProvider["openDiffEditor"] = vi.fn(async () => {
				Object.assign(diffViewProvider, {
					isEditing: true,
					relPath,
					editType: "modify",
					editSession: retrySession,
					createdDirs: retryCreatedDirs,
					originalContent: "the retry's own baseline",
					activeDiffEditor: retryEditor,
				})
				return editor
			})

			await expect(diffViewProvider.attemptRollbackRecovery(record)).resolves.toBe(false)

			expect(restorePreStreamBuffer).not.toHaveBeenCalled()
			expect(saveBufferClean).not.toHaveBeenCalled()
			// The retry keeps its own install: the editor this recovery acquired is dropped rather than
			// written into the slot, and the directories and baseline the retry own open() put there are
			// untouched.
			expect(diffViewProvider["activeDiffEditor"]).toBe(retryEditor)
			expect(diffViewProvider["createdDirs"]).toBe(retryCreatedDirs)
			expect(diffViewProvider["originalContent"]).toBe("the retry's own baseline")
			expect(diffViewProvider["editSession"]).toBe(retrySession)
		})

		it("rethrows a failed acquisition without putting its own install back over a newer one on the same file", async () => {
			const relPath = "mock-recovery-target.ts"
			const absolutePath = `${mockCwd}/${relPath}`
			const gone = new Error("the buffer this recovery needs cannot be reopened")
			simulateReset()
			const restorePreStreamBuffer = vi.fn().mockResolvedValue(undefined)
			const saveBufferClean = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreStreamBuffer"] = restorePreStreamBuffer
			diffViewProvider["saveBufferClean"] = saveBufferClean
			diffViewProvider["keepOrCloseEditedFile"] = vi.fn().mockResolvedValue(undefined)
			const record = recoveryContextFor(relPath, "modify")
			const retryEditor = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(absolutePath),
					getText: vi.fn().mockReturnValue("the retry's own streamed buffer"),
					isDirty: true,
				}),
			})
			const retryCreatedDirs: string[] = []
			const retrySession = diffViewProvider["editSession"] + 1
			// Same target, same edit type, newer session, and then the buffer cannot be reopened.
			diffViewProvider["openDiffEditor"] = vi.fn(async () => {
				Object.assign(diffViewProvider, {
					isEditing: true,
					relPath,
					editType: "modify",
					editSession: retrySession,
					createdDirs: retryCreatedDirs,
					originalContent: "the retry's own baseline",
					activeDiffEditor: retryEditor,
				})
				throw gone
			})

			await expect(diffViewProvider.attemptRollbackRecovery(record)).rejects.toBe(gone)

			// A rejection does not make this recovery the owner of an edit it does not answer to: the fields
			// it captured stay its own to put back, and the retry keeps every one of its own.
			expect(restorePreStreamBuffer).not.toHaveBeenCalled()
			expect(saveBufferClean).not.toHaveBeenCalled()
			expect(diffViewProvider["isEditing"]).toBe(true)
			expect(diffViewProvider["relPath"]).toBe(relPath)
			expect(diffViewProvider["editSession"]).toBe(retrySession)
			expect(diffViewProvider["createdDirs"]).toBe(retryCreatedDirs)
			expect(diffViewProvider["originalContent"]).toBe("the retry's own baseline")
			expect(diffViewProvider["activeDiffEditor"]).toBe(retryEditor)
		})
		it("never re-issues a session number after a recovery rewinds the install", async () => {
			const relPath = "mock-recovery-target.ts"
			const absolutePath = `${mockCwd}/${relPath}`
			// Stubbed the way the rest of this suite stubs it: these cases are about which install a record is
			// allowed to roll back, not about the tab plumbing or the acquisition timer. Each attempt gets its
			// own editor so an installed buffer can be told from another attempt's.
			const acquired: Array<{ editor: ReturnType<typeof makeTextEditor> }> = []
			diffViewProvider["openDiffEditor"] = vi.fn().mockImplementation(async () => {
				const editor = makeTextEditor({
					document: makeTextDocument({
						uri: makeUri(absolutePath),
						getText: vi.fn().mockReturnValue("streamed, never approved"),
						isDirty: true,
					}),
				})
				acquired.push({ editor })
				return editor
			})
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["keepOrCloseEditedFile"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreStreamBuffer"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["saveBufferClean"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider.editType = "modify"

			// Two attempts at the same file, each record captured while its own install was the live one.
			await diffViewProvider.open(relPath)
			const firstRecord = recoveryContextFor(relPath, "modify")
			const firstSession = firstRecord.editSession
			await diffViewProvider.reset()
			await diffViewProvider.open(relPath)
			const secondRecord = recoveryContextFor(relPath, "modify")
			const secondSession = secondRecord.editSession
			await diffViewProvider.reset()
			expect(secondSession).toBe(firstSession + 1)

			// The first attempt rollback runs: it installs the first attempt edit and rewinds the provider to that
			// attempt stamp.
			await expect(diffViewProvider.attemptRollbackRecovery(firstRecord)).resolves.toBe(true)
			expect(diffViewProvider["editSession"]).toBe(firstSession)
			await diffViewProvider.reset()

			// A third attempt on the same file. Allocation has to stay ahead of every stamp a retained record
			// already holds, otherwise the second record describes this install as well as it describes its own.
			await diffViewProvider.open(relPath)
			const thirdSession = diffViewProvider["editSession"]
			const thirdEditor = acquired[acquired.length - 1].editor
			expect(thirdSession).toBeGreaterThan(secondSession)
			const thirdRestore = vi.fn().mockResolvedValue(undefined)
			const thirdSave = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreStreamBuffer"] = thirdRestore
			diffViewProvider["saveBufferClean"] = thirdSave

			await expect(diffViewProvider.attemptRollbackRecovery(secondRecord)).resolves.toBe(false)

			// The second record belongs to an attempt that already finished its rollback question. The retry in
			// front of it keeps its own edit: nothing was restored, nothing was saved, and its stamp, target and
			// buffer are still what the provider answers to.
			expect(thirdRestore).not.toHaveBeenCalled()
			expect(thirdSave).not.toHaveBeenCalled()
			expect(diffViewProvider["isEditing"]).toBe(true)
			expect(diffViewProvider["relPath"]).toBe(relPath)
			expect(diffViewProvider["editSession"]).toBe(thirdSession)
			expect(diffViewProvider["activeDiffEditor"]).toBe(thirdEditor)
		})
	})
	// The acquisition inside openDiffEditor() races a ten-second timer against a showTextDocument it cannot
	// cancel. Both cases below are about what that leaves behind: a diff nobody is waiting for, and a diff
	// original side built from whatever the field holds when the callback finally runs.
	describe("openDiffEditor() gives up on a diff nobody is waiting for", () => {
		// Local to this suite on purpose: the fixture here is the real acquisition, while the recovery suite
		// above stubs openDiffEditor() out to keep its cases off the tab plumbing and the timer.
		const recoveryFor = (relPath: string, editType: "create" | "modify") => ({
			relPath,
			absolutePath: `${mockCwd}/${relPath}`,
			editType,
			createdDirs: [],
			editSession: diffViewProvider["editSession"],
			originalContent: editType === "modify" ? "captured at acquisition" : "",
		})

		const wireAcquisition = (editor: vscode.TextEditor) => {
			// A tab already open on this path takes the activate-existing-diff fast path inside
			// openDiffEditor() and skips the acquisition this suite is about, so the tab list is pinned empty
			// here instead of inherited from whichever suite ran last.
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: (): vscode.TabGroup[] => [],
				configurable: true,
			})
			let settleShow: (() => void) | undefined
			// Recorded so a case can prove the pre-open really did settle late; otherwise the assertion that
			// nothing opened would pass on an acquisition that never reached its follow-up callback.
			let showSettled = false
			const showDeferred = new Promise<vscode.TextEditor>((resolve) => {
				settleShow = () => {
					showSettled = true
					resolve(editor)
				}
			})
			vi.mocked(vscode.window.showTextDocument).mockImplementation(() => showDeferred)
			let documentOpened: ((document: vscode.TextDocument) => unknown) | undefined
			const disposeOpenDocument = vi.fn()
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				documentOpened = callback
				return { dispose: disposeOpenDocument }
			})
			const disposeVisibleEditors = vi.fn()
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: disposeVisibleEditors })
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			// Accessors rather than the values: the component fills both in after this returns, so a snapshot
			// would hand back undefined and a case would pass without ever reaching the acquisition.
			return {
				settleShow: () => settleShow?.(),
				showSettled: () => showSettled,
				documentOpened: (document: vscode.TextDocument) => documentOpened?.(document),
				registered: () => documentOpened !== undefined,
				disposeOpenDocument,
				disposeVisibleEditors,
			}
		}

		const inactiveProvider = (originalContent: string | undefined) => {
			Object.assign(diffViewProvider, {
				isEditing: false,
				relPath: undefined,
				editType: undefined,
				createdDirs: [],
				originalContent,
				activeDiffEditor: undefined,
			})
		}

		const recoveryDocument = (absolutePath: string): vscode.TextDocument =>
			makeTextDocument({
				uri: makeUri(absolutePath),
				getText: vi.fn().mockReturnValue("streamed, never approved"),
				isDirty: true,
			})

		it("does not open the diff once the acquisition has timed out on the path", async () => {
			const relPath = "mock-recovery-target.ts"
			const absolutePath = `${mockCwd}/${relPath}`
			const document = recoveryDocument(absolutePath)
			const editor = makeTextEditor({ document })
			// Nothing on screen for this path, so no listener resolves the acquisition early.
			vi.mocked(vscode.window).visibleTextEditors = []
			const wire = wireAcquisition(editor)
			inactiveProvider(undefined)
			vi.useFakeTimers()
			let failure: unknown
			try {
				// Kicked off without awaiting: the recovery awaits the acquisition, and the acquisition only
				// ever settles on the timer.
				const recovery = diffViewProvider.attemptRollbackRecovery(recoveryFor(relPath, "modify"))
				// Attached at kickoff: the timeout rejects while the clock below is being advanced, and a
				// handler fitted only afterwards would let the runtime log it as an unhandled rejection first.
				const rejection = recovery.catch((reason: unknown) => reason)
				// The pre-open starts in the same synchronous stretch that installs the edit context.
				expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1)
				expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
				expect(wire.registered()).toBe(true)
				await vi.advanceTimersByTimeAsync(10_000)
				failure = await rejection
				expect(String(failure)).toContain("Failed to open diff editor for /mock/cwd/mock-recovery-target.ts")
				expect(String(failure)).toContain("within 10 seconds")
				expect(wire.disposeOpenDocument).toHaveBeenCalledTimes(1)
				expect(wire.disposeVisibleEditors).toHaveBeenCalledTimes(1)
				expect(diffViewProvider["isEditing"]).toBe(false)
				expect(diffViewProvider["relPath"]).toBeUndefined()
				expect(diffViewProvider["originalContent"]).toBeUndefined()
				// The pre-open the timeout could not cancel settles here, so the follow-up callback runs on a
				// path whose acquisition already reported failure to its caller.
				wire.settleShow()
				expect(wire.showSettled()).toBe(true)
				await vi.advanceTimersByTimeAsync(0)
			} finally {
				vi.useRealTimers()
			}
			expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
			expect(diffViewProvider["activeDiffEditor"]).toBeUndefined()
		})
		// The reconciliation half of an abandoned acquisition: showTextDocument cannot be cancelled, so the
		// plain tab the pre-open asked for is still on screen when the follow-up callback runs on a path
		// nobody is waiting for any more. What may be done with that tab turns on what this call can prove
		// about it, and the three cases below take the three positions a late callback can find itself in.
		const wireAbandonedPreopen = (openedTab: vscode.Tab, openAtKickoff = false) => {
			const relPath = "mock-recovery-target.ts"
			const absolutePath = `${mockCwd}/${relPath}`
			const editor = makeTextEditor({ document: recoveryDocument(absolutePath) })
			vi.mocked(vscode.window).visibleTextEditors = []
			const wire = wireAcquisition(editor)
			// The tab list is a getter on purpose: it has to answer empty at kickoff, when the acquisition
			// records who brought the tab here, and answer with the tab once the pre-open settles late. With
			// openAtKickoff the tab was here before this call started, which makes it somebody else's tab.
			let shown = openAtKickoff
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: (): vscode.TabGroup[] =>
					shown
						? [
								{
									isActive: true,
									viewColumn: vscode.ViewColumn.One,
									activeTab: undefined,
									tabs: [openedTab],
								},
							]
						: [],
				configurable: true,
			})
			const closedTabs: vscode.Tab[] = []
			vi.mocked(vscode.window.tabGroups.close).mockImplementation((tab) => {
				// The close API also accepts whole groups; this suite only ever closes a tab it named.
				if ("length" in tab || "tabs" in tab) {
					throw new Error("unexpected tab group close")
				}
				closedTabs.push(tab)
				return Promise.resolve(true)
			})
			const abandon = async () => {
				inactiveProvider(undefined)
				vi.useFakeTimers()
				try {
					const recovery = diffViewProvider.attemptRollbackRecovery(recoveryFor(relPath, "modify"))
					const rejection = recovery.catch((reason: unknown) => reason)
					await vi.advanceTimersByTimeAsync(10_000)
					expect(String(await rejection)).toContain("Failed to open diff editor for")
					// The pre-open the timeout could not cancel settles here, which is when the follow-up
					// callback looks at the tab list.
					shown = true
					wire.settleShow()
					await vi.advanceTimersByTimeAsync(0)
				} finally {
					vi.useRealTimers()
				}
				expect(wire.showSettled()).toBe(true)
			}
			return { abandon, closedTabs: () => closedTabs.slice() }
		}

		it("closes the plain tab a timed-out pre-open left behind when it holds nothing unsaved", async () => {
			const openedTab = makeTab(makeTextTab(`${mockCwd}/mock-recovery-target.ts`), "mock-recovery-target.ts", {
				isPinned: true,
			})
			const { abandon, closedTabs } = wireAbandonedPreopen(openedTab)
			await abandon()
			// Every mark of the pre-open's own tab is present: nothing was open for this path when the call
			// started, the tab is the non-preview one the pre-open asked for, and nothing unsaved is in it.
			// Leaving it open shows a plain editor on a path whose edit was refused, which is the outcome
			// this row is about.
			expect(closedTabs()).toEqual([openedTab])
		})

		it("reports the failure when the tab a timed-out pre-open left behind refuses to close", async () => {
			const openedTab = makeTab(makeTextTab(`${mockCwd}/mock-recovery-target.ts`), "mock-recovery-target.ts", {
				isPinned: true,
			})
			const { abandon, closedTabs } = wireAbandonedPreopen(openedTab)
			// The close is the last thing the abandoned-pre-open callback does and nothing awaits it, so
			// a rejection has nowhere to go but the host. The tab is still standing afterwards either
			// way, which is the fact a later reader of the log needs.
			const attempts: unknown[] = []
			vi.mocked(vscode.window.tabGroups.close).mockImplementation((tab) => {
				attempts.push(tab)
				return Promise.reject(new Error("close refused: tab held by another editor"))
			})
			const logged: unknown[][] = []
			const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
				logged.push(args)
			})
			try {
				await abandon()
			} finally {
				errorSpy.mockRestore()
			}
			expect(attempts).toEqual([openedTab])
			expect(closedTabs()).toEqual([])
			expect(logged.some((args) => String(args[0]).includes("Failed to close file tab"))).toBe(true)
		})

		it("leaves a dirty tab alone when the late callback cannot tell whose typing it holds", async () => {
			const openedTab = makeTab(makeTextTab(`${mockCwd}/mock-recovery-target.ts`), "mock-recovery-target.ts", {
				isPinned: true,
				isDirty: true,
			})
			const { abandon, closedTabs } = wireAbandonedPreopen(openedTab)
			await abandon()
			// The buffer may hold streamed content nobody approved or the user's own typing, and a tab list
			// read after the fact cannot tell those two apart. Closing a dirty tab takes the path that saves
			// before closing, which would publish the unapproved content: an uncertain buffer is preserved
			// with its content instead.
			expect(closedTabs()).toEqual([])
		})

		it("leaves a tab that was already open for the path when the acquisition started", async () => {
			const openedTab = makeTab(makeTextTab(`${mockCwd}/mock-recovery-target.ts`), "mock-recovery-target.ts", {
				isPinned: true,
			})
			const { abandon, closedTabs } = wireAbandonedPreopen(openedTab, true)
			await abandon()
			// The tab belongs to whoever opened it before this call: a plain-text tab does not take the
			// activate-existing-diff fast path, so the acquisition still ran, timed out, and left a tab that
			// was on screen before it started. Closing a tab the user was looking at is not a cleanup.
			expect(closedTabs()).toEqual([])
		})

		it("builds the diff original side from the baseline the acquisition captured", async () => {
			const relPath = "mock-recovery-target.ts"
			const absolutePath = `${mockCwd}/${relPath}`
			const document = recoveryDocument(absolutePath)
			const editor = makeTextEditor({ document })
			vi.mocked(vscode.window).visibleTextEditors = [editor]
			const wire = wireAcquisition(editor)
			const restorePreStreamBuffer = vi.fn().mockResolvedValue(undefined)
			const saveBufferClean = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreStreamBuffer"] = restorePreStreamBuffer
			diffViewProvider["saveBufferClean"] = saveBufferClean
			diffViewProvider["keepOrCloseEditedFile"] = vi.fn().mockResolvedValue(undefined)
			// The original side carries the compared content base64-encoded in its query, which is the only
			// observable trace of the baseline the diff command was handed. The double provides with(), the
			// one member the acquisition reads off the parsed uri.
			const originalQueries: string[] = []
			vi.mocked(vscode.Uri.parse).mockImplementation((value: string) => {
				return {
					with: (change: { query?: string }) => {
						originalQueries.push(String(change.query))
						// Only forwarded to the doubled diff command; the double carries nothing else.
						return { fsPath: value } as unknown as vscode.Uri
					},
				} as unknown as vscode.Uri
			})
			inactiveProvider("left over from the previous edit")
			vi.useFakeTimers()
			let listenerRun: unknown
			try {
				const recovery = diffViewProvider.attemptRollbackRecovery(recoveryFor(relPath, "modify"))
				recovery.catch(() => undefined)
				// Mid-flight another flow installs a different baseline on the same provider. A callback that
				// read the field when it ran would build this diff from that other content instead.
				diffViewProvider["originalContent"] = "swapped mid-flight"
				wire.settleShow()
				// The listener awaits a tick before it looks the editor up, so the tick has to advance.
				listenerRun = wire.documentOpened(recoveryDocument(absolutePath))
				await vi.advanceTimersByTimeAsync(1)
				await listenerRun
				await expect(recovery).resolves.toBe(true)
			} finally {
				vi.useRealTimers()
			}
			// The capture is for the diff original side, which is what this row names. What the buffer restore
			// is handed is still the live field, so the mid-flight value is what the rollback writes back; that
			// half is stated here rather than changed, because widening the guard into the restore would be a
			// second decision the row did not ask for.
			expect(restorePreStreamBuffer).toHaveBeenCalledWith(absolutePath, editor.document, "swapped mid-flight")
			expect(originalQueries).toEqual([Buffer.from("captured at acquisition").toString("base64")])
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
				"vscode.diff",
				expect.anything(),
				expect.anything(),
				`mock-recovery-target.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
				{ preserveFocus: true },
			)
		})
	})
})
