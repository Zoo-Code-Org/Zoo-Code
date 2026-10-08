import { DiffViewProvider, DIFF_VIEW_URI_SCHEME, DIFF_VIEW_LABEL_CHANGES } from "../DiffViewProvider"
import * as vscode from "vscode"
import * as path from "path"
import delay from "delay"

import { makeRange, makeTextDocument, makeTextEditor, makeUri } from "../../../test-utils/vscode"

import * as fs from "fs/promises"

import { computeVersionToken, versionTokenOfStat } from "../../../utils/versionToken"
import type { BigIntStats } from "fs"
import { safeWriteText } from "../../../services/file-safety/safeWriteText"
import { withFileLock } from "../../../utils/fileLock"
import { createDirectoriesForFile } from "../../../utils/fs"
import { ObservationRegistry } from "../../../core/task/observationRegistry"
import type { Task } from "../../../core/task/Task"

// Mock delay
vi.mock("delay", () => ({
	default: vi.fn().mockResolvedValue(undefined),
}))

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn().mockResolvedValue("file content"),
	writeFile: vi.fn().mockResolvedValue(undefined),
	access: vi.fn().mockResolvedValue(undefined),
	// The S4b follow-up (#44) preview observation stats the target before and
	// after reading it; undefined stats leave the target unobserved (fail closed).
	stat: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined),
	rename: vi.fn().mockResolvedValue(undefined),
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
	// guardedWrite resolves the workspace root (and the nearest existing ancestor of the
	// target) before publishing. The double returns the path unchanged so the containment
	// check sees the same spelling the rest of the test uses.
	realpath: vi.fn(async (p: string) => p),
}))

// Mock safeWriteText (used by saveDirectly)
vi.mock("../../../services/file-safety/safeWriteText", () => ({
	safeWriteText: vi.fn().mockResolvedValue(undefined),
	resolveLockKey: vi.fn(async (p: string) => p),
}))

// Mock the S1 version token (used by the S4 guarded write); the real
// computeVersionToken needs fs.stat, which is not part of the fs/promises mock above.
// Keep the real versionTokenOfStat: DiffViewProvider.open() (S4b follow-up #44)
// derives the preview token from its synthetic stat mock with that pure function.
vi.mock("../../../utils/versionToken", async () => {
	const actual = await vi.importActual<typeof import("../../../utils/versionToken")>("../../../utils/versionToken")
	return {
		computeVersionToken: vi.fn(),
		versionTokenOfStat: actual.versionTokenOfStat,
	}
})

// Mock utils
// Mock the shared advisory lock that the guarded-write path uses; the real
// proper-lockfile would try to create a lock directory on the mocked fs.
vi.mock("../../../utils/fileLock", () => ({
	withFileLock: vi.fn(async (filePath: string, operation: (p: string) => Promise<void>) => operation(filePath)),
}))

vi.mock("../../../utils/fs", () => ({
	createDirectoriesForFile: vi.fn().mockResolvedValue([]),
}))

// Mock path
vi.mock("path", () => ({
	resolve: vi.fn((cwd: string, relPath?: string) => (relPath === undefined ? cwd : `${cwd}/${relPath}`)),
	isAbsolute: vi.fn((p: string) => p.startsWith("/")),
	basename: vi.fn((path) => path.split("/").pop()),
	dirname: vi.fn((path) => path.split("/").slice(0, -1).join("/") || "/"),
	join: (...args: string[]) => args.join("/"),
	sep: "/",
	// guardedWrite's workspace containment compares paths lexically, so the double needs
	// a POSIX relative() that matches the resolve()/join() doubles above.
	relative: (from: string, to: string) => {
		const f = from.split("/").filter(Boolean)
		const t = to.split("/").filter(Boolean)
		let i = 0
		while (i < f.length && i < t.length && f[i] === t[i]) i++
		return [...Array.from({ length: f.length - i }, () => ".."), ...t.slice(i)].join("/")
	},
}))

// Mock vscode
vi.mock("vscode", () => ({
	workspace: {
		applyEdit: vi.fn(),
		// VS Code's own codec. The double returns bytes that differ from the plain
		// UTF-8 encoding of the same text, so an assertion can prove the publish
		// writes the codec's output rather than re-encoding the string itself.
		encode: vi.fn((content: string, options: { encoding: string }) =>
			Promise.resolve(
				options.encoding === "utf8bom"
					? Buffer.concat([Buffer.from("\uFEFF"), Buffer.from(content)])
					: Buffer.from(content),
			),
		),
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
		activeTextEditor: undefined as unknown,
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

		// Create a mock Task instance. The guarded write (S4b) consults the task's
		// S2 observation registry, so the mock carries a real (in-memory) instance.
		mockTask = {
			cwd: mockCwd,
			observationRegistry: new ObservationRegistry(),
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						includeDiagnosticMessages: true,
						maxDiagnosticMessages: 50,
						// Auto-closing edited tabs is opt-in by default; the legacy
						// "close/keep behavior" suite below asserts the close path, so
						// enable it here. The opt-in default itself is covered by the
						// dedicated "auto-close settings decision table" suite.
						autoCloseZooOpenedFiles: true,
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

		// S4b follow-up (#44): saveChanges publishes the accepted diff through the
		// guarded write, which requires the target to be observed at the previewed
		// on-disk version. Seed the preconditions for the relPaths the suites below
		// use; the guarded-write suites override or clear as needed.
		mockTask.observationRegistry.observe(`${mockCwd}/test.txt`, "v1")
		mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, "v1")
		mockTask.observationRegistry.observe(`${mockCwd}/mock-target-file.ts`, "v1")
		vi.mocked(computeVersionToken).mockResolvedValue("v1")
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
			const document = makeTextDocument({
				uri: makeUri(`${mockCwd}/mock-file-target.txt`),
				getText: vi.fn().mockReturnValue(currentContent),
			})
			const editor = makeTextEditor({
				document,
				visibleRanges: [makeRange()],
				revealRange,
			})
			;(diffViewProvider as any).activeDiffEditor = editor
			// Register the editor as the live modified-side editor so resolveLiveEditor
			// finds it by document identity, mirroring the runtime path.
			vi.mocked(vscode.window).visibleTextEditors = [editor]
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

	// A rejected save belongs to one task. closeAllDiffViews() closes every clean
	// diff tab in the workbench, so it would close another task's diff view while
	// that task's provider still holds its activation listener and deferred scroll
	// timer against a tab that is gone.
	describe("closeOwnDiffView method", () => {
		it("closes only this provider's tab and leaves another task's diff view open", async () => {
			const ownTab = {
				input: {
					constructor: { name: "TabInputTextDiff" },
					original: { scheme: DIFF_VIEW_URI_SCHEME },
					modified: { fsPath: `${mockCwd}/test.ts` },
				},
				isDirty: false,
			}
			const otherTaskTab = {
				input: {
					constructor: { name: "TabInputTextDiff" },
					original: { scheme: DIFF_VIEW_URI_SCHEME },
					modified: { fsPath: `${mockCwd}/other-task.ts` },
				},
				isDirty: false,
			}
			for (const tab of [ownTab, otherTaskTab]) {
				Object.setPrototypeOf(tab.input, vscode.TabInputTextDiff.prototype)
			}
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [ownTab, otherTaskTab] }],
				configurable: true,
			})
			const closedTabs: unknown[] = []
			vi.mocked(vscode.window.tabGroups.close).mockImplementation((tab) => {
				closedTabs.push(tab)
				return Promise.resolve(true)
			})

			await diffViewProvider["closeOwnDiffView"](path.join(mockCwd, "test.ts"))

			expect(closedTabs).toEqual([ownTab])
		})

		it("leaves another task's tab when the same basename sits in another directory", async () => {
			// Two tasks can edit files with the same name. Matching by basename alone
			// would close the other task's clean tab, so the tab's own URI has to decide.
			const ownTab = {
				input: {
					constructor: { name: "TabInputTextDiff" },
					original: { scheme: DIFF_VIEW_URI_SCHEME },
					modified: { fsPath: `${mockCwd}/test.ts` },
				},
				label: `test.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
				isDirty: false,
			}
			const sameNameOtherDir = {
				input: {
					constructor: { name: "TabInputTextDiff" },
					original: { scheme: DIFF_VIEW_URI_SCHEME },
					modified: { fsPath: "/other-cwd/test.ts" },
				},
				label: `test.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
				isDirty: false,
			}
			// A pre-opened file's tab is identified by its label, so the URI check is the
			// only thing that can tell the two apart here.
			const labelOnlyOtherDir = {
				input: { uri: { fsPath: "/other-cwd/test.ts" } },
				label: `test.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
				isDirty: false,
			}
			const labelOnlyOwn = {
				input: { uri: { fsPath: `${mockCwd}/test.ts` } },
				label: `test.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
				isDirty: false,
			}
			for (const tab of [ownTab, sameNameOtherDir]) {
				Object.setPrototypeOf(tab.input, vscode.TabInputTextDiff.prototype)
			}
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [ownTab, sameNameOtherDir, labelOnlyOtherDir, labelOnlyOwn] }],
				configurable: true,
			})
			const closedTabs: unknown[] = []
			vi.mocked(vscode.window.tabGroups.close).mockImplementation((tab) => {
				closedTabs.push(tab)
				return Promise.resolve(true)
			})

			await diffViewProvider["closeOwnDiffView"](path.join(mockCwd, "test.ts"))

			expect(closedTabs).toEqual([ownTab, labelOnlyOwn])
		})

		it("leaves a Source Control diff the user has open for the same file", async () => {
			// A git diff of the same file is the user's tab, not this task's, so a reset
			// must not close it.
			const ownTab = {
				input: {
					constructor: { name: "TabInputTextDiff" },
					original: { scheme: DIFF_VIEW_URI_SCHEME },
					modified: { fsPath: `${mockCwd}/test.ts` },
				},
				isDirty: false,
			}
			const gitDiffTab = {
				input: {
					constructor: { name: "TabInputTextDiff" },
					original: { scheme: "git" },
					modified: { fsPath: `${mockCwd}/test.ts` },
				},
				isDirty: false,
			}
			for (const tab of [ownTab, gitDiffTab]) {
				Object.setPrototypeOf(tab.input, vscode.TabInputTextDiff.prototype)
			}
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [ownTab, gitDiffTab] }],
				configurable: true,
			})
			const closedTabs: unknown[] = []
			vi.mocked(vscode.window.tabGroups.close).mockImplementation((tab) => {
				closedTabs.push(tab)
				return Promise.resolve(true)
			})

			await diffViewProvider["closeOwnDiffView"](path.join(mockCwd, "test.ts"))

			expect(closedTabs).toEqual([ownTab])
		})
	})

	it("reset() closes only this provider's tab, not another task's", async () => {
		// A guard rejection belongs to one task, and every tool caller resets that
		// task's provider in its catch block, so the teardown must stay inside this
		// provider's view.
		const ownTab = {
			input: {
				constructor: { name: "TabInputTextDiff" },
				original: { scheme: DIFF_VIEW_URI_SCHEME },
				modified: { fsPath: `${mockCwd}/test.ts` },
			},
			label: `test.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
			isDirty: false,
		}
		const otherTaskTab = {
			input: {
				constructor: { name: "TabInputTextDiff" },
				original: { scheme: DIFF_VIEW_URI_SCHEME },
				modified: { fsPath: `${mockCwd}/other-task.ts` },
			},
			label: `other-task.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
			isDirty: false,
		}
		for (const tab of [ownTab, otherTaskTab]) {
			Object.setPrototypeOf(tab.input, vscode.TabInputTextDiff.prototype)
		}
		Object.defineProperty(vscode.window.tabGroups, "all", {
			get: () => [{ tabs: [ownTab, otherTaskTab] }],
			configurable: true,
		})
		const closedTabs: unknown[] = []
		vi.mocked(vscode.window.tabGroups.close).mockImplementation((tab) => {
			closedTabs.push(tab)
			return Promise.resolve(true)
		})

		diffViewProvider["relPath"] = "test.ts"
		await diffViewProvider.reset()

		expect(closedTabs).toEqual([ownTab])
	})

	describe("saveDirectly method", () => {
		beforeEach(() => {
			// Mock vscode functions
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])

			// Baseline for the single-writer flow these tests encode: the file was read
			// before the write, so the observation registry holds the version token the
			// guarded write recomputes and compares, and the target exists on disk.
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, "v1")
			vi.mocked(computeVersionToken).mockResolvedValue("v1")
			vi.mocked(fs.access).mockResolvedValue(undefined)
		})

		it("should write content directly to file without opening diff view", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			const result = await diffViewProvider.saveDirectly("test.ts", "new content", true, true, 2000)

			// Verify file was written via safeWriteText
			const { safeWriteText } = await import("../../../services/file-safety/safeWriteText")
			expect(safeWriteText).toHaveBeenCalledWith(`${mockCwd}/test.ts`, "new content")

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

			// Verify file was written via safeWriteText
			const { safeWriteText } = await import("../../../services/file-safety/safeWriteText")
			expect(safeWriteText).toHaveBeenCalledWith(`${mockCwd}/test.ts`, "new content")

			// Verify file was NOT opened
			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		})

		it("publishes an approved outside-workspace target", async () => {
			// The tool layer classified this path as outside every workspace folder, put it in
			// front of the user, and the user approved. The guard must not then reject the
			// write it was told about.
			vi.mocked(fs.access).mockRejectedValue({ code: "ENOENT" })
			vi.mocked(computeVersionToken).mockResolvedValue("v1")

			await diffViewProvider.saveDirectly("../outside.ts", "new content", false, true, 1000, "create", undefined, true)

			const { safeWriteText } = await import("../../../services/file-safety/safeWriteText")
			expect(safeWriteText).toHaveBeenCalledWith(`${mockCwd}/../outside.ts`, "new content")
		})

		it("rejects the same escape when no approval was obtained", async () => {
			// The flag is what carries the approval; without it the containment line inside the
			// publish helper still holds.
			vi.mocked(fs.access).mockRejectedValue({ code: "ENOENT" })
			const { safeWriteText } = await import("../../../services/file-safety/safeWriteText")

			await expect(
				diffViewProvider.saveDirectly("../outside.ts", "new content", false, true, 1000, "create"),
			).rejects.toThrow("Path resolves outside the workspace")

			expect(safeWriteText).not.toHaveBeenCalled()
		})

		it("does not save a dirty buffer in the memory-only diagnostics path", async () => {
			// The guarded publish already committed the accepted content. Saving a dirty
			// buffer here would republish its stale bytes through VS Code's unguarded save
			// path, over what the guard wrote.
			const dirtyDoc = {
				isDirty: true,
				save: vi.fn().mockResolvedValue(undefined),
			} as unknown as vscode.TextDocument
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(dirtyDoc)

			await diffViewProvider.saveDirectly("test.ts", "new content", false, true, 0)

			expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: `${mockCwd}/test.ts` }),
			)
			expect(dirtyDoc.save).not.toHaveBeenCalled()
		})

		it("should skip diagnostics when diagnosticsEnabled is false", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()
			vi.mocked(vscode.languages.getDiagnostics).mockClear()

			await diffViewProvider.saveDirectly("test.ts", "new content", true, false, 1000)

			// Verify file was written via safeWriteText
			const { safeWriteText } = await import("../../../services/file-safety/safeWriteText")
			expect(safeWriteText).toHaveBeenCalledWith(`${mockCwd}/test.ts`, "new content")

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

		describe("guarded write (S4b, epic #1375)", () => {
			const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })

			it("rejects an unobserved write to an existing file with the read-first remediation", async () => {
				mockTask.observationRegistry.clear()

				await expect(diffViewProvider.saveDirectly("test.ts", "new content", true, false, 0)).rejects.toThrow(
					"File already exists at test.ts and was not read before this write -- read the file first, then retry.",
				)
				expect(safeWriteText).not.toHaveBeenCalled()
			})

			it("creates an unobserved file when the target is absent", async () => {
				mockTask.observationRegistry.clear()
				vi.mocked(fs.access).mockRejectedValue(enoent())

				await diffViewProvider.saveDirectly("test.ts", "new content", true, false, 0)

				expect(safeWriteText).toHaveBeenCalledWith(`${mockCwd}/test.ts`, "new content")
			})

			it("leaves no directories behind when the guard rejects the write", async () => {
				// A rejected guard must not touch the filesystem at all. Creating the parent
				// directories before the guard runs would leave empty directories behind - and
				// for an outside-workspace target, outside the workspace. safeWriteText creates
				// missing parents itself at publish time.
				mockTask.observationRegistry.clear()
				vi.mocked(createDirectoriesForFile).mockClear()

				await expect(
					diffViewProvider.saveDirectly("nested/dir/test.ts", "new content", true, false, 0),
				).rejects.toThrow("File already exists at nested/dir/test.ts")

				expect(createDirectoriesForFile).not.toHaveBeenCalled()
				expect(safeWriteText).not.toHaveBeenCalled()
			})

			it("rejects an observed write whose version token is stale", async () => {
				// The file changed on disk after the read that recorded "v1".
				vi.mocked(computeVersionToken).mockResolvedValue("v2")

				const result = diffViewProvider.saveDirectly("test.ts", "new content", true, false, 0)

				await expect(result).rejects.toThrow("Stale version")
				await expect(result).rejects.toThrow("re-read the file, then retry.")
				expect(safeWriteText).not.toHaveBeenCalled()
			})

			it("rejects an unobserved edit-kind write before any I/O", async () => {
				mockTask.observationRegistry.clear()

				await expect(
					diffViewProvider.saveDirectly("test.ts", "new content", true, false, 0, "edit"),
				).rejects.toThrow("File not read yet -- read the file, then retry.")
				expect(safeWriteText).not.toHaveBeenCalled()
				expect(fs.access).not.toHaveBeenCalled()
			})

			it("recreates an observed file that vanished after the read", async () => {
				vi.mocked(fs.access).mockRejectedValue(enoent())

				await diffViewProvider.saveDirectly("test.ts", "new content", true, false, 0)

				expect(safeWriteText).toHaveBeenCalledWith(`${mockCwd}/test.ts`, "new content")
			})

			it("fails closed when the owning task has been collected", async () => {
				// A real WeakRef cannot be forced to deref to undefined deterministically
				// (GC timing), so a structural stub stands in for the collected reference.
				diffViewProvider["taskRef"] = { deref: () => undefined } as unknown as WeakRef<Task>

				await expect(diffViewProvider.saveDirectly("test.ts", "new content", true, false, 0)).rejects.toThrow(
					"Cannot guard the write: the owning task is no longer available",
				)
				expect(safeWriteText).not.toHaveBeenCalled()
			})
		})
	})

	describe("saveChanges guarded publish (S4b follow-up #44)", () => {
		// Synthetic stat the preview observation tokenizes with the real (unmocked)
		// versionTokenOfStat. Cast: the mock only implements the members the tool
		// and versionToken read.
		const previewStats = {
			isDirectory: () => false,
			dev: BigInt(1),
			ino: BigInt(2),
			size: BigInt(300),
			mtimeNs: BigInt(4_000_000_000n),
			ctimeNs: BigInt(5_000_000_000n),
		} as unknown as BigIntStats

		// Structural TextEditor double for the open()/saveChanges flow: only the
		// members they touch. One documented unknown cast stands in for the full
		// vscode.TextEditor type (avoids any casts; see AGENTS.md).
		const mockTextEditor = (fsPath: string, text = ""): vscode.TextEditor =>
			({
				document: {
					uri: { fsPath, scheme: "file" },
					getText: vi.fn().mockReturnValue(text),
					lineCount: 0,
					encoding: "utf8",
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			}) as unknown as vscode.TextEditor

		// Structural TextDocument double for the onDidOpenTextDocument callback.
		const mockTextDocument = (fsPath: string): vscode.TextDocument =>
			({ uri: { fsPath, scheme: "file" } }) as unknown as vscode.TextDocument
		// The workbench revert clears the model's dirty flag; the double must model
		// that so the cleanup can tell a completed discard from a failed one.
		const revertClearsDirty = (document: { isDirty: boolean }, onRevert?: () => void): void => {
			vi.mocked(vscode.commands.executeCommand).mockImplementation((command: string) => {
				if (command === "workbench.action.files.revert") {
					document.isDirty = false
					onRevert?.()
				}
				return Promise.resolve(undefined)
			})
		}

		beforeEach(() => {
			// Private members are set via bracket notation (spec convention).
			// Reset the focus the revert helper reads: a test that sets it must not leak
			// into the next one, where cleanup could restore a stale editor.
			vi.mocked(vscode.window).activeTextEditor = undefined
			diffViewProvider["relPath"] = "test.ts"
			diffViewProvider["newContent"] = "new content"
			diffViewProvider["activeDiffEditor"] = mockTextEditor(`${mockCwd}/test.ts`, "new content")
			diffViewProvider["preDiagnostics"] = []
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeOwnDiffView"] = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockTextEditor(`${mockCwd}/test.ts`))
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
		})

		it("open() observes the previewed version of an existing file as a partial read, not a model read", async () => {
			const mockEditor = mockTextEditor(`${mockCwd}/observed.ts`)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/observed.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			diffViewProvider.editType = "modify"
			mockTask.observationRegistry.clear()

			await diffViewProvider.open("observed.ts")

			const obs = mockTask.observationRegistry.get(`${mockCwd}/observed.ts`)
			expect(obs).toBeDefined()
			expect(obs!.version).toBe(versionTokenOfStat(previewStats))
			// The preview is the tool's own read, not a read the model made, so it must
			// not claim completeness for content the model never saw.
			expect(obs!.complete).toBe(false)
			expect(vi.mocked(fs.stat)).toHaveBeenNthCalledWith(1, `${mockCwd}/observed.ts`, { bigint: true })
			expect(vi.mocked(fs.stat)).toHaveBeenNthCalledWith(2, `${mockCwd}/observed.ts`, { bigint: true })
		})

		it("open() records no observation when the post-read stat rejects", async () => {
			const mockEditor = mockTextEditor(`${mockCwd}/observed.ts`)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/observed.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat)
				.mockResolvedValueOnce(previewStats)
				.mockRejectedValueOnce(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))
			diffViewProvider.editType = "modify"
			mockTask.observationRegistry.clear()

			await diffViewProvider.open("observed.ts")

			expect(mockTask.observationRegistry.has(`${mockCwd}/observed.ts`)).toBe(false)
			// The accepted save is a full-file replacement, so an unobserved target still
			// fails closed instead of publishing content built on a preview that could not
			// be tied to a version token.
			await expect(
				diffViewProvider.saveDirectly("observed.ts", "new content", false, false, 0, "update"),
			).rejects.toThrow(
				"File already exists at observed.ts and was not read before this write -- read the file first, then retry.",
			)
		})
		it("open() observes the empty placeholder of a new file so the accepted save can be guarded", async () => {
			const mockEditor = mockTextEditor(`${mockCwd}/brand-new.ts`)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/brand-new.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("")
			diffViewProvider.editType = "create"
			mockTask.observationRegistry.clear()

			await diffViewProvider.open("brand-new.ts")

			const obs = mockTask.observationRegistry.get(`${mockCwd}/brand-new.ts`)
			expect(obs).toBeDefined()
			expect(obs!.version).toBe(versionTokenOfStat(previewStats))
			expect(obs!.complete).toBe(true)
			// The create path stat-matches the placeholder (pre + post read), so
			// both calls carry the bigint requirement, and the verification read
			// uses utf-8.
			expect(vi.mocked(fs.stat)).toHaveBeenNthCalledWith(1, `${mockCwd}/brand-new.ts`, { bigint: true })
			expect(vi.mocked(fs.stat)).toHaveBeenNthCalledWith(2, `${mockCwd}/brand-new.ts`, { bigint: true })
			expect(vi.mocked(fs.stat)).toHaveBeenCalledTimes(2)
			expect(vi.mocked(fs.readFile)).toHaveBeenCalledWith(`${mockCwd}/brand-new.ts`, "utf-8")
		})

		it("open() leaves the target unobserved when the pre/post stat mismatch (mid-preview mutation)", async () => {
			const mutatedStats = {
				isDirectory: () => false,
				dev: BigInt(1),
				ino: BigInt(2),
				size: BigInt(301),
				mtimeNs: BigInt(4_000_000_001n),
				ctimeNs: BigInt(5_000_000_000n),
			} as unknown as BigIntStats
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/mutated.ts`)), 0)
				return { dispose: vi.fn() }
			})
			const mockEditor = mockTextEditor(`${mockCwd}/mutated.ts`)
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat).mockResolvedValueOnce(previewStats).mockResolvedValueOnce(mutatedStats)
			diffViewProvider.editType = "modify"
			mockTask.observationRegistry.clear()

			await diffViewProvider.open("mutated.ts")

			expect(mockTask.observationRegistry.get(`${mockCwd}/mutated.ts`)).toBeUndefined()
			expect(vi.mocked(fs.stat)).toHaveBeenNthCalledWith(1, `${mockCwd}/mutated.ts`, { bigint: true })
			expect(vi.mocked(fs.stat)).toHaveBeenNthCalledWith(2, `${mockCwd}/mutated.ts`, { bigint: true })
		})

		it("open() leaves the target unobserved when the pre-read stat fails (stat gap)", async () => {
			const mockEditor = mockTextEditor(`${mockCwd}/gap.ts`)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/gap.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			// The pre-read stat fails and only the post-read stat resolves: the
			// on-disk version the preview is built on is unproven, so open() must
			// leave the target unobserved even though a post stat is available.
			vi.mocked(fs.stat)
				.mockRejectedValueOnce(new Error("EPERM: operation not permitted"))
				.mockResolvedValueOnce(previewStats)
			diffViewProvider.editType = "modify"
			mockTask.observationRegistry.clear()

			await diffViewProvider.open("gap.ts")

			expect(mockTask.observationRegistry.get(`${mockCwd}/gap.ts`)).toBeUndefined()
		})

		it("open() leaves a new file unobserved when the placeholder stat fails", async () => {
			const mockEditor = mockTextEditor(`${mockCwd}/gap-create.ts`)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/gap-create.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat).mockRejectedValue(new Error("EPERM: operation not permitted"))
			diffViewProvider.editType = "create"
			mockTask.observationRegistry.clear()

			await diffViewProvider.open("gap-create.ts")

			expect(mockTask.observationRegistry.get(`${mockCwd}/gap-create.ts`)).toBeUndefined()
		})

		it("publishes the accepted content through the guarded write (safeWriteText)", async () => {
			const { safeWriteText } = await import("../../../services/file-safety/safeWriteText")

			const result = await diffViewProvider.saveChanges(false)

			expect(safeWriteText).toHaveBeenCalledWith(`${mockCwd}/test.ts`, Buffer.from("new content"))
			expect(result.newProblemsMessage).toBe("")
		})

		const openPreview = async () => {
			// Enough of the editor double for open() to find the diff editor again.
			const editor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.txt`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 1,
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			}
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(editor as unknown as vscode.TextEditor)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.window).visibleTextEditors = [editor as unknown as vscode.TextEditor]
			// openDiffEditor resolves from the document-open event, so fire it.
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => {
					callback({ uri: { fsPath: `${mockCwd}/test.txt`, scheme: "file" } } as unknown as vscode.TextDocument)
				}, 0)
				return { dispose: vi.fn() }
			})
			// fs/promises is mocked; open() only reads these BigIntStats fields when it
			// stat-matches the preview read.
			vi.mocked(fs.stat).mockResolvedValue({
				dev: 1n,
				ino: 2n,
				size: 5n,
				mtimeNs: 100n,
				ctimeNs: 100n,
			} as unknown as BigIntStats)
			;(diffViewProvider as unknown as { editType: string }).editType = "modify"
			await diffViewProvider.open("test.txt")
			;(diffViewProvider as unknown as { newContent?: string }).newContent = "new content"
		}

		it("does not let the preview's own observation authorize a targeted edit", async () => {
			// The tool read never observed this path, so the only entry the save could
			// point at is the one open() records for the preview. Authorizing from that
			// entry publishes the tool's content over anything that changed between the
			// read and the preview, so the save must fall back to the unobserved-edit
			// guard and be rejected with the re-read remediation.
			mockTask.observationRegistry.clear()
			await openPreview()
			// The preview did record an observation - that is the entry under test.
			expect(mockTask.observationRegistry.has(`${mockCwd}/test.txt`)).toBe(true)

			await expect(diffViewProvider.saveChanges(false, 0, "edit")).rejects.toThrow(
				/File not read yet/,
			)
			expect(safeWriteText).not.toHaveBeenCalled()
			// The preview's authorization was withdrawn rather than left behind.
			expect(mockTask.observationRegistry.has(`${mockCwd}/test.txt`)).toBe(false)
		})

		it("still publishes a targeted edit authorized by a pre-preview observation", async () => {
			// The same preview must not break the legitimate case: the model read the
			// file (partially) and nothing changed before the preview, so the restored
			// pre-open observation authorizes the targeted edit.
			mockTask.observationRegistry.observe(`${mockCwd}/test.txt`, "v1", false)
			await openPreview()

			await diffViewProvider.saveChanges(false, 0, "edit")
			expect(safeWriteText).toHaveBeenCalledWith(`${mockCwd}/test.txt`, Buffer.from("new content"))
		})


		it("does not let a denied preview authorize the retry of an unread edit", async () => {
			// The model never read this file. open() records the preview token so the accept-time
			// CAS has an entry to compare against; when the user denies, that entry must not
			// survive into the next attempt - otherwise the retry publishes against a version the
			// model never read, the exact invariant the save above enforces.
			mockTask.observationRegistry.clear()
			await openPreview()
			expect(mockTask.observationRegistry.has(`${mockCwd}/test.txt`)).toBe(true)

			// A denial ends in reset() (revertChanges() then reset()); the revoke lives in
			// reset() so every path that ends without a save is covered.
			await diffViewProvider.reset()
			expect(mockTask.observationRegistry.has(`${mockCwd}/test.txt`)).toBe(false)

			// The retry is still an edit of a file that was never read.
			await openPreview()
			await expect(diffViewProvider.saveChanges(false, 0, "edit")).rejects.toThrow(/File not read yet/)
			expect(safeWriteText).not.toHaveBeenCalled()
		})
		it("publishes the accepted content in the document's own encoding", async () => {
			// A utf8bom document: getText() returns the text without the BOM, so the
			// publish must go through VS Code's codec for the document's own
			// encoding rather than re-encoding the text as plain UTF-8.
			const bomEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8bom",
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = bomEditor

			await diffViewProvider.saveChanges(false)

			expect(vi.mocked(vscode.workspace.encode)).toHaveBeenCalledWith("new content", {
				encoding: "utf8bom",
			})
			expect(safeWriteText).toHaveBeenCalledWith(
				`${mockCwd}/test.ts`,
				Buffer.concat([Buffer.from("\uFEFF"), Buffer.from("new content")]),
			)
		})

		it("rejects the accepted save when the file changed after the preview (stale version)", async () => {
			vi.mocked(computeVersionToken).mockResolvedValue("v2")
			const { safeWriteText } = await import("../../../services/file-safety/safeWriteText")

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow(
				"Stale version -- the file changed since you read it (expected v1, current v2); re-read the file, then retry.",
			)
			expect(safeWriteText).not.toHaveBeenCalled()
		})

		it("rejects the accepted save when the target was never observed (fail closed)", async () => {
			mockTask.observationRegistry.clear()
			const { safeWriteText } = await import("../../../services/file-safety/safeWriteText")

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow(
				"File already exists at test.ts and was not read before this write -- read the file first, then retry.",
			)
			expect(safeWriteText).not.toHaveBeenCalled()
		})

		it("rejects the accepted save when the observation was only a partial read", async () => {
			// A partial observation (slice/range/truncated/indentation read) must not
			// authorize the full-file replacement the accept path performs, even when
			// the version is current.
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, "v1", false)
			const { safeWriteText } = await import("../../../services/file-safety/safeWriteText")

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow(
				"File was only partially read (line slice, range, truncated view, or indentation block) -- " +
					"a full-file replacement needs the complete content; re-read the whole file, then retry.",
			)
			expect(safeWriteText).not.toHaveBeenCalled()
		})
		it("publishes a targeted edit that a partial observation authorizes", async () => {
			// The same partial observation rejects a full-file replacement but
			// authorizes the targeted edit the tool performed, so the write kind
			// the tool passed must reach the guard.
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, "v1", false)
			const { safeWriteText } = await import("../../../services/file-safety/safeWriteText")

			await diffViewProvider.saveChanges(false, 0, "edit")

			expect(safeWriteText).toHaveBeenCalledWith(`${mockCwd}/test.ts`, Buffer.from("new content"))
		})

		it("fails closed when the owning task has been collected", async () => {
			// A real WeakRef cannot be forced to deref to undefined deterministically
			// (GC timing), so a structural stub stands in for the collected reference.
			diffViewProvider["taskRef"] = { deref: () => undefined } as unknown as WeakRef<Task>

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow(
				"Cannot guard the write: the owning task is no longer available",
			)

			// Nothing may be published for a collected task, and the discard-only
			// cleanup still runs before the error is rethrown.
			const { safeWriteText } = await import("../../../services/file-safety/safeWriteText")
			expect(safeWriteText).not.toHaveBeenCalled()
			expect(diffViewProvider["closeOwnDiffView"]).toHaveBeenCalledTimes(1)
		})

		it("open() keeps the model's existing observation instead of replacing it with the preview token", async () => {
			const mockEditor = mockTextEditor(`${mockCwd}/t3-modify.ts`)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/t3-modify.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			diffViewProvider.editType = "modify"
			mockTask.observationRegistry.clear()
			// The model read the file before the preview: its observation must
			// survive so the accept-time guard compares against the version the
			// model's content was built on, not the on-disk version at preview
			// time.
			mockTask.observationRegistry.observe(`${mockCwd}/t3-modify.ts`, "model-token", true)

			await diffViewProvider.open("t3-modify.ts")

			const obs = mockTask.observationRegistry.get(`${mockCwd}/t3-modify.ts`)
			expect(obs?.version).toBe("model-token")
			expect(obs?.version).not.toBe(versionTokenOfStat(previewStats))
			// the stat-matched pair is still taken; only the observation is kept
			expect(vi.mocked(fs.stat)).toHaveBeenCalledTimes(2)
		})

		it("open() records the placeholder token for a create even when the model read the file before it vanished", async () => {
			// The vanished file's old observation must NOT win here: it describes
			// a file that no longer exists, and keeping it would make the
			// accept-time CAS (placeholder token on disk vs. the vanished file's
			// token) fail every time, so recreating the file would always fail
			// and the placeholder would leak. The placeholder token is the
			// correct baseline for the new file.
			const mockEditor = mockTextEditor(`${mockCwd}/t3-create.ts`)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/t3-create.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("")
			diffViewProvider.editType = "create"
			mockTask.observationRegistry.clear()
			mockTask.observationRegistry.observe(`${mockCwd}/t3-create.ts`, "model-token", true)

			await diffViewProvider.open("t3-create.ts")

			const placeholderToken = versionTokenOfStat(previewStats)
			// the placeholder is written, stat-matched, observed (replacing the
			// vanished file's stale token), and remembered for cleanup
			expect(vi.mocked(fs.writeFile)).toHaveBeenCalledWith(`${mockCwd}/t3-create.ts`, "")
			expect(vi.mocked(fs.stat)).toHaveBeenCalledTimes(2)
			expect(mockTask.observationRegistry.get(`${mockCwd}/t3-create.ts`)?.version).toBe(placeholderToken)
			expect(diffViewProvider["placeholderVersion"]).toBe(placeholderToken)
		})

		it("open() on a create with a collected task writes the placeholder but tracks nothing", async () => {
			// The task has been collected (dead WeakRef): the placeholder is still
			// written (the file must exist to open the diff), but there is no live
			// task to observe - the later save fails closed through the taskRef
			// fail-closed path.
			const mockEditor = mockTextEditor(`${mockCwd}/t3-dead-task.ts`)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/t3-dead-task.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("")
			diffViewProvider.editType = "create"
			mockTask.observationRegistry.clear()
			diffViewProvider["taskRef"] = { deref: () => undefined } as unknown as WeakRef<Task>

			await diffViewProvider.open("t3-dead-task.ts")

			expect(vi.mocked(fs.writeFile)).toHaveBeenCalledWith(`${mockCwd}/t3-dead-task.ts`, "")
			// no live task: nothing observed, but the cleanup token is still
			// captured (provider state) so the fail-closed save rejection can
			// remove the placeholder instead of leaking it
			expect(mockTask.observationRegistry.get(`${mockCwd}/t3-dead-task.ts`)).toBeUndefined()
			expect(diffViewProvider["placeholderVersion"]).toBe(versionTokenOfStat(previewStats))
		})

		it("open() does not record a placeholder another writer touched after the write", async () => {
			// CR d037753 finding: a writer that touched the placeholder between
			// open()'s fs.writeFile() and the observation would have its token
			// recorded as a complete observation of content open() never read.
			// The stat-matched verification must reject it: no observation (the
			// prior observation stays untouched), no cleanup token (so a rejected
			// save cannot unlink the writer's file), and the save fails closed.
			const mockEditor = mockTextEditor(`${mockCwd}/contested.ts`)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/contested.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("external content")
			diffViewProvider.editType = "create"
			mockTask.observationRegistry.clear()
			mockTask.observationRegistry.observe(`${mockCwd}/contested.ts`, "model-token", true)

			await diffViewProvider.open("contested.ts")

			expect(vi.mocked(fs.writeFile)).toHaveBeenCalledWith(`${mockCwd}/contested.ts`, "")
			// nothing recorded, and the vanished file's prior observation was
			// not replaced with the writer's token
			expect(mockTask.observationRegistry.get(`${mockCwd}/contested.ts`)?.version).toBe("model-token")
			expect(diffViewProvider["placeholderVersion"]).toBeUndefined()
		})

		it("open() does not record the placeholder when the post-stat fails after the write", async () => {
			// The bracketing stats must both succeed: a failed post-stat means
			// the read is not trustworthy, so nothing is recorded.
			const mockEditor = mockTextEditor(`${mockCwd}/statfail.ts`)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/statfail.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat)
				.mockResolvedValueOnce(previewStats)
				.mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }))
			vi.mocked(fs.readFile).mockResolvedValue("")
			diffViewProvider.editType = "create"
			mockTask.observationRegistry.clear()

			await diffViewProvider.open("statfail.ts")

			expect(mockTask.observationRegistry.get(`${mockCwd}/statfail.ts`)).toBeUndefined()
			expect(diffViewProvider["placeholderVersion"]).toBeUndefined()
		})

		it("open() does not record the placeholder when the bracketing stats disagree (mid-preview mutation)", async () => {
			// A token change between the bracketing stats means the placeholder
			// was replaced or rewritten while open() was reading it - same S2
			// rule as the modify branch: nothing is recorded.
			const mutatedStats = {
				isDirectory: () => false,
				dev: BigInt(1),
				ino: BigInt(2),
				size: BigInt(301),
				mtimeNs: BigInt(4_000_000_001n),
				ctimeNs: BigInt(5_000_000_000n),
			} as unknown as BigIntStats
			const mockEditor = mockTextEditor(`${mockCwd}/mutated-new.ts`)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/mutated-new.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat).mockResolvedValueOnce(previewStats).mockResolvedValueOnce(mutatedStats)
			vi.mocked(fs.readFile).mockResolvedValue("")
			diffViewProvider.editType = "create"
			mockTask.observationRegistry.clear()

			await diffViewProvider.open("mutated-new.ts")

			expect(mockTask.observationRegistry.get(`${mockCwd}/mutated-new.ts`)).toBeUndefined()
			expect(diffViewProvider["placeholderVersion"]).toBeUndefined()
		})

		it("saveChanges() accepts a recreate after a prior read - the accept-time CAS checks the placeholder token", async () => {
			// The exact recreate-always-failed trace: the model read the file
			// (observed "v1" by the outer beforeEach), the file then vanished,
			// open() wrote the placeholder, and the accept must succeed against
			// the placeholder token (not the vanished file's stale token).
			const mockEditor = mockTextEditor(`${mockCwd}/test.ts`, "new content")
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/test.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("")
			diffViewProvider.editType = "create"
			// prior read observation (the file has since vanished)
			expect(mockTask.observationRegistry.get(`${mockCwd}/test.ts`)?.version).toBe("v1")

			await diffViewProvider.open("test.ts")

			// the placeholder is untouched on disk: the accept-time token matches
			// the placeholder token open() recorded
			vi.mocked(computeVersionToken).mockResolvedValue(versionTokenOfStat(previewStats))

			const result = await diffViewProvider.saveChanges(false)

			expect(safeWriteText).toHaveBeenCalledWith(`${mockCwd}/test.ts`, Buffer.from("new content"))
			expect(result.newProblemsMessage).toBe("")
		})

		it("saveChanges() checks the placeholder token and unlinks inside the same lock", async () => {
			// A peer writer that commits between the token check and the unlink would lose
			// its write, so the cleanup runs under the same resolved-path advisory lock every
			// other writer to this file uses. A token that moved inside the lock window means
			// the file is no longer the placeholder and must be left in place.
			const mockEditor = mockTextEditor(`${mockCwd}/test.ts`, "new content")
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/test.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("")
			diffViewProvider.editType = "create"

			await diffViewProvider.open("test.ts")

			const lockKeys: string[] = []
			vi.mocked(withFileLock).mockImplementation(async (lockKey, operation) => {
				lockKeys.push(lockKey)
				if (lockKeys.length === 2) {
					// the peer committed while the cleanup waited for the lock
					vi.mocked(fs.stat).mockResolvedValue({ ...previewStats, size: 9999n, mtimeNs: 5n, ctimeNs: 6n })
				}
				return operation(lockKey)
			})

			// The publish is rejected against the peer's token, so the discard cleanup runs.
			vi.mocked(computeVersionToken).mockResolvedValue("peer-token")
			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow(
				/Stale version|not read before this write/,
			)

			// One acquisition for the guarded publish, one for the cleanup.
			expect(lockKeys).toEqual([`${mockCwd}/test.ts`, `${mockCwd}/test.ts`])
			expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled()
		})

		it("clears the dirty buffer via a disk revert after a successful guarded publish", async () => {
			// The user edited the buffer before accepting, so the document is
			// dirty: the publish wrote the exact buffer content, and the dirty
			// flag must be cleared by reverting from disk rather than saving the
			// buffer (which would republish through the unguarded file service).
			const dirtyEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = dirtyEditor
			revertClearsDirty(dirtyEditor.document)

			const result = await diffViewProvider.saveChanges(false)

			expect(safeWriteText).toHaveBeenCalledWith(`${mockCwd}/test.ts`, Buffer.from("new content"))
			// the revert activates the exact document with the exact options:
			// preserveFocus keeps the user's focus, preview: false pins the tab
			// the target is activated so the revert command is scoped to this document
			// (no active editor to restore in this case)
			expect(vi.mocked(vscode.window.showTextDocument)).toHaveBeenCalledWith(dirtyEditor.document, {
				preserveFocus: false,
				preview: false,
			})
			expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith("workbench.action.files.revert")
			expect(dirtyEditor.document.save).not.toHaveBeenCalled()
			expect(result.newProblemsMessage).toBe("")
		})

		it("discards the dirty buffer and removes the new-file placeholder after a guarded rejection, then rethrows", async () => {
			const dirtyEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = dirtyEditor
			revertClearsDirty(dirtyEditor.document)
			diffViewProvider.editType = "create"
			// open() wrote and observed the empty placeholder; the on-disk token
			// then moved past it, so the guard rejects the publish.
			const placeholderToken = versionTokenOfStat(previewStats)
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, placeholderToken, true)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(computeVersionToken).mockResolvedValue("moved-past-placeholder")
			diffViewProvider["placeholderVersion"] = placeholderToken

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")

			expect(safeWriteText).not.toHaveBeenCalled()
			// discard-only cleanup: the newer disk content is reloaded into the
			// buffer (never re-saved from originalContent), and the placeholder
			// is unlinked while it is still exactly the file open() wrote
			expect(vi.mocked(vscode.window.showTextDocument)).toHaveBeenCalledWith(dirtyEditor.document, {
				preserveFocus: false,
				preview: false,
			})
			expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith("workbench.action.files.revert")
			// the placeholder stat uses the bigint stat options (the version
			// token requires the full-precision fields)
			// The read must be attributed to the bigint stat that produced the token:
			expect(vi.mocked(fs.stat).mock.calls[0][1]).toEqual({ bigint: true })
			expect(fs.unlink).toHaveBeenCalledWith(`${mockCwd}/test.ts`)
			expect(diffViewProvider["closeOwnDiffView"]).toHaveBeenCalled()
		})

		it("disposes the active-editor listener before the programmatic revert", async () => {
			// showTextDocument can change the active editor even with
			// preserveFocus, so the listener must be gone before the revert
			// activates the document: otherwise this programmatic activation is
			// recorded as a user touch and the auto-close preference is overridden.
			const order: string[] = []
			const dirtyEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = dirtyEditor
			diffViewProvider["disposeActiveEditorListener"] = vi.fn(() => {
				order.push("dispose")
			})
			revertClearsDirty(dirtyEditor.document, () => order.push("revert"))

			await diffViewProvider.saveChanges(false)

			expect(order).toEqual(["dispose", "revert"])
		})

		it("disposes the listener before the discard revert and closes the deleted file's tab after a successful unlink", async () => {
			const order: string[] = []
			const dirtyEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = dirtyEditor
			revertClearsDirty(dirtyEditor.document)
			diffViewProvider.editType = "create"
			const placeholderToken = versionTokenOfStat(previewStats)
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, placeholderToken, true)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(computeVersionToken).mockResolvedValue("moved-past-placeholder")
			diffViewProvider["placeholderVersion"] = placeholderToken
			diffViewProvider["disposeActiveEditorListener"] = vi.fn(() => {
				order.push("dispose")
			})
			diffViewProvider["cancelDeferredScroll"] = vi.fn(() => {
				order.push("cancel")
			})
			diffViewProvider["closeFileTab"] = vi.fn().mockImplementation(() => {
				order.push("closeTab")
				return Promise.resolve()
			})
			revertClearsDirty(dirtyEditor.document, () => order.push("revert"))

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")

			// The tab for the file that was just unlinked is closed, and only
			// after the revert; closing only the diff views would leave a clean
			// plain-text tab for a deleted file behind.
			expect(order).toEqual(["dispose", "cancel", "revert", "closeTab"])
		})

		it("does not close the file tab when the placeholder unlink fails", async () => {
			const dirtyEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = dirtyEditor
			revertClearsDirty(dirtyEditor.document)
			diffViewProvider.editType = "create"
			const placeholderToken = versionTokenOfStat(previewStats)
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, placeholderToken, true)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(computeVersionToken).mockResolvedValue("moved-past-placeholder")
			diffViewProvider["placeholderVersion"] = placeholderToken
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = closeFileTab
			vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("EACCES: permission denied, unlink"))

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")

			// Nothing was deleted, so there is no deleted-file tab to close.
			expect(closeFileTab).not.toHaveBeenCalled()
		})

		it("removes the directories open() created, innermost first, after the placeholder unlink", async () => {
			const order: string[] = []
			const dirtyEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = dirtyEditor
			revertClearsDirty(dirtyEditor.document)
			diffViewProvider.editType = "create"
			const placeholderToken = versionTokenOfStat(previewStats)
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, placeholderToken, true)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(computeVersionToken).mockResolvedValue("moved-past-placeholder")
			diffViewProvider["placeholderVersion"] = placeholderToken
			diffViewProvider["createdDirs"] = [`${mockCwd}/new`, `${mockCwd}/new/dir`]
			diffViewProvider["closeFileTab"] = vi.fn().mockImplementation(() => {
				order.push("closeTab")
				return Promise.resolve()
			})
			vi.mocked(fs.rmdir).mockImplementation(async (p) => {
				order.push("rmdir:" + p)
			})

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")

			// The empty directories open() made for the rejected new file go with the
			// placeholder, innermost first, and only after the unlink succeeded.
			expect(order).toEqual(["closeTab", "rmdir:" + `${mockCwd}/new/dir`, "rmdir:" + `${mockCwd}/new`])
		})

		it("stops removing created directories when one cannot be removed", async () => {
			const dirtyEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = dirtyEditor
			revertClearsDirty(dirtyEditor.document)
			diffViewProvider.editType = "create"
			const placeholderToken = versionTokenOfStat(previewStats)
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, placeholderToken, true)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(computeVersionToken).mockResolvedValue("moved-past-placeholder")
			diffViewProvider["placeholderVersion"] = placeholderToken
			diffViewProvider["createdDirs"] = [`${mockCwd}/a`, `${mockCwd}/a/b`, `${mockCwd}/a/b/c`]
			vi.mocked(fs.rmdir).mockRejectedValueOnce(new Error("ENOTEMPTY: directory not empty"))

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")

			// A directory another writer populated in the meantime must not be removed,
			// and the best-effort cleanup must still finish so the guard verdict stays
			// the outcome.
			expect(fs.rmdir).toHaveBeenCalledTimes(1)
			expect(fs.rmdir).toHaveBeenCalledWith(`${mockCwd}/a/b/c`)
			expect(diffViewProvider["closeOwnDiffView"]).toHaveBeenCalled()
		})

		it("does not revert a buffer the user changed during the publish", async () => {
			// The publish captured the buffer text before awaiting the write; a keystroke
			// typed during that wait is newer than the published bytes, so the buffer must
			// stay dirty instead of being reverted to disk.
			const getText = vi.fn()
			getText.mockReturnValueOnce("new content").mockReturnValueOnce("new content typed during the publish")
			const dirtyEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText,
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = dirtyEditor
			revertClearsDirty(dirtyEditor.document)

			await diffViewProvider.saveChanges(false)

			expect(safeWriteText).toHaveBeenCalledWith(`${mockCwd}/test.ts`, Buffer.from("new content"))
			expect(vi.mocked(vscode.commands.executeCommand)).not.toHaveBeenCalledWith("workbench.action.files.revert")
			expect(vi.mocked(vscode.window.showTextDocument)).not.toHaveBeenCalled()
		})

		it("activates the document before the revert so the command is scoped to it, then restores the focus", async () => {
			// workbench.action.files.revert takes no resource argument: with the Open
			// Editors view focused it force-reverts every selected editor, otherwise the
			// active editor. Activating the target keeps the revert scoped to this
			// document, and the user's previous focus is given back afterwards.
			const previousEditor = mockTextEditor(`${mockCwd}/other.ts`, "other")
			vi.mocked(vscode.window).activeTextEditor = previousEditor
			const dirtyEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = dirtyEditor
			revertClearsDirty(dirtyEditor.document)

			await diffViewProvider.saveChanges(false)

			const calls = vi.mocked(vscode.window.showTextDocument).mock.calls
			expect(calls[0]).toEqual([dirtyEditor.document, { preserveFocus: false, preview: false }])
			expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith("workbench.action.files.revert")
			expect(calls[1]).toEqual([previousEditor.document, { preserveFocus: false, preview: false }])
		})

		it("does not restore focus when the user had no active editor", async () => {
			vi.mocked(vscode.window).activeTextEditor = undefined
			const dirtyEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = dirtyEditor
			revertClearsDirty(dirtyEditor.document)

			await diffViewProvider.saveChanges(false)

			// Only the activation happened; there was no focus to give back.
			expect(vi.mocked(vscode.window.showTextDocument).mock.calls).toEqual([
				[dirtyEditor.document, { preserveFocus: false, preview: false }],
			])
			expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith("workbench.action.files.revert")
		})

		it("does not restore focus when the active editor is already the target document", async () => {
			// The user was already looking at this document, so there is nothing to give
			// back: re-showing it would be a redundant activation.
			const editor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			vi.mocked(vscode.window).activeTextEditor = editor
			diffViewProvider["activeDiffEditor"] = editor
			revertClearsDirty(editor.document)

			await diffViewProvider.saveChanges(false)

			// Only the activation happened: the focus was already on the target, so there
			// was nothing to give back.
			expect(vi.mocked(vscode.window.showTextDocument).mock.calls).toEqual([
				[editor.document, { preserveFocus: false, preview: false }],
			])
			expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith("workbench.action.files.revert")
		})
		it("keeps the placeholder when the discard fails, so a later save cannot recreate the rejected content", async () => {
			// The revert command can fail (a locked or orphaned model). While the buffer
			// is still dirty, VS Code's ordinary file service can save it back to the path,
			// so the placeholder open() wrote must survive and the tab must stay open.
			const dirtyEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = dirtyEditor
			vi.mocked(vscode.commands.executeCommand).mockRejectedValue(new Error("revert failed"))
			diffViewProvider.editType = "create"
			const placeholderToken = versionTokenOfStat(previewStats)
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, placeholderToken, true)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(computeVersionToken).mockResolvedValue("moved-past-placeholder")
			diffViewProvider["placeholderVersion"] = placeholderToken
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = closeFileTab

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")

			expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith("workbench.action.files.revert")
			expect(fs.unlink).not.toHaveBeenCalled()
			expect(closeFileTab).not.toHaveBeenCalled()
		})

		it("does not reload a clean buffer when the guard rejects - only dirty buffers are discarded", async () => {
			// The buffer was never touched (isDirty is falsy): there is nothing
			// to discard, so the failure cleanup must not activate the document
			// or run the revert command.
			const cleanEditor = mockTextEditor(`${mockCwd}/test.ts`, "new content")
			diffViewProvider["activeDiffEditor"] = cleanEditor
			vi.mocked(computeVersionToken).mockResolvedValue("v2")
			// The placeholder on disk is still exactly what open() wrote, so the cleanup
			// can still remove it.
			diffViewProvider.editType = "create"
			const placeholderToken = versionTokenOfStat(previewStats)
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, placeholderToken, true)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			diffViewProvider["placeholderVersion"] = placeholderToken

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")

			expect(safeWriteText).not.toHaveBeenCalled()
			expect(vi.mocked(vscode.window.showTextDocument)).not.toHaveBeenCalled()
			expect(vi.mocked(vscode.commands.executeCommand)).not.toHaveBeenCalled()
			// A clean buffer has nothing that can be saved back, so the placeholder
			// cleanup still runs even though no revert was needed.
			expect(fs.unlink).toHaveBeenCalledWith(`${mockCwd}/test.ts`)
			expect(diffViewProvider["closeOwnDiffView"]).toHaveBeenCalled()
		})

		it("does not unlink the placeholder when the edit type is not create - the outer gate short-circuits", async () => {
			// placeholderVersion is remembered (open() took the placeholder path)
			// but the edit type is not create: the outer gate must short-circuit
			// before statting or unlinking, so the placeholder on disk is left
			// untouched.
			const dirtyEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = dirtyEditor
			revertClearsDirty(dirtyEditor.document)
			diffViewProvider.editType = "modify"
			const placeholderToken = versionTokenOfStat(previewStats)
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, placeholderToken, true)
			vi.mocked(fs.stat).mockResolvedValue(previewStats) // placeholder still on disk
			vi.mocked(computeVersionToken).mockResolvedValue("moved") // stale rejection
			diffViewProvider["placeholderVersion"] = placeholderToken

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")

			expect(fs.stat).not.toHaveBeenCalled()
			expect(fs.unlink).not.toHaveBeenCalled()
			// the dirty discard and the view close still ran
			expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith("workbench.action.files.revert")
			expect(diffViewProvider["closeOwnDiffView"]).toHaveBeenCalled()
		})

		it("adopts content autosave already published instead of reporting a stale rejection", async () => {
			// Autosave wrote the buffer before acceptance: the document is clean and the
			// disk already holds exactly the bytes this save intended, but the version
			// token moved, so the compare-and-swap still rejects.
			const cleanEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = cleanEditor
			diffViewProvider.editType = "modify"
			// A partial observation must stay partial: adopting content that is already on
			// disk cannot upgrade it into authority for a full-file replacement.
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, versionTokenOfStat(previewStats), false)
			vi.mocked(computeVersionToken).mockResolvedValue("moved")
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("new content")

			await expect(diffViewProvider.saveChanges(false)).resolves.toMatchObject({ newProblemsMessage: "" })

			// The observation now points at the state that already matches, keeping the
			// completeness of the original read.
			const observation = mockTask.observationRegistry.get(`${mockCwd}/test.ts`)
			expect(observation?.version).toBe(versionTokenOfStat(previewStats))
			expect(observation?.complete).toBe(false)
			// Nothing was clobbered, so the buffer is not reloaded and no placeholder is
			// unlinked; the normal post-save close flow still ran.
			expect(fs.unlink).not.toHaveBeenCalled()
			expect(vi.mocked(vscode.window.showTextDocument)).not.toHaveBeenCalled()
			expect(diffViewProvider["closeAllDiffViews"]).toHaveBeenCalled()
		})

		it("does not adopt an autosaved match for an edit that was never authorized", async () => {
			// Same autosave shape, different verdict: with no observation from before open()
			// the guard rejects for AUTHORIZATION. Adopting the byte match would report a
			// modified result and record a partial observation for a file the model never
			// read, which would then authorize a later targeted publish.
			const cleanEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = cleanEditor
			diffViewProvider.editType = "modify"
			diffViewProvider["preOpenObservation"] = null
			mockTask.observationRegistry.clear()
			vi.mocked(computeVersionToken).mockResolvedValue("moved")
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("new content")

			await expect(diffViewProvider.saveChanges(false, 0, "edit")).rejects.toThrow(/File not read yet/)

			// No adoption read, and no observation granted.
			expect(fs.readFile).not.toHaveBeenCalled()
			expect(mockTask.observationRegistry.get(`${mockCwd}/test.ts`)).toBeUndefined()
		})

		it("still rejects when the disk content does not match what the save intended", async () => {
			// Same autosave shape, different bytes: the guard verdict stands.
			const cleanEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = cleanEditor
			diffViewProvider.editType = "modify"
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, versionTokenOfStat(previewStats), true)
			vi.mocked(computeVersionToken).mockResolvedValue("moved")
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("someone else")

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")
			// The observation is left at the state the read saw, not upgraded to the
			// autosaved content the save did not author.
			expect(mockTask.observationRegistry.get(`${mockCwd}/test.ts`)?.version).toBe(
				versionTokenOfStat(previewStats),
			)
			// The rejection still stands: the buffer is discarded and the views close,
			// so the caller sees the guard verdict, not a silent success.
			expect(diffViewProvider["closeOwnDiffView"]).toHaveBeenCalled()
		})
		it("keeps the rejection when the buffer is still dirty even though the disk matches", async () => {
			// A dirty buffer means the disk content came from someone else, so the
			// discard cleanup is still the outcome even when the bytes happen to match.
			// Without the clean-document gate this test would adopt the match and skip
			// the discard.
			const editor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = editor
			diffViewProvider.editType = "modify"
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, versionTokenOfStat(previewStats), true)
			vi.mocked(computeVersionToken).mockResolvedValue("moved")
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("new content")

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")
			expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith("workbench.action.files.revert")
			// The clean-document gate short-circuits before the adoption check, so the
			// rejection path never stats or reads the file.
			expect(fs.stat).not.toHaveBeenCalled()
			expect(fs.readFile).not.toHaveBeenCalled()
		})

		it("keeps the rejection when the file moved between the stat and the read", async () => {
			// Same bytes, but the second stat differs: the read is not attributable to
			// the state the token describes, so a match cannot be adopted.
			const movedStats = {
				isDirectory: () => false,
				dev: BigInt(1),
				ino: BigInt(9),
				size: BigInt(300),
				mtimeNs: BigInt(4_000_000_001n),
				ctimeNs: BigInt(5_000_000_000n),
			} as unknown as BigIntStats
			const editor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = editor
			diffViewProvider.editType = "modify"
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, versionTokenOfStat(previewStats), true)
			vi.mocked(computeVersionToken).mockResolvedValue("moved")
			vi.mocked(fs.stat).mockResolvedValueOnce(previewStats).mockResolvedValueOnce(movedStats)
			vi.mocked(fs.readFile).mockResolvedValue("new content")

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")
			expect(mockTask.observationRegistry.get(`${mockCwd}/test.ts`)?.version).toBe(
				versionTokenOfStat(previewStats),
			)
		})

		it("keeps a complete observation complete when adopting an autosaved match", async () => {
			// The completeness of the original read must survive the adoption unchanged:
			// a complete read stays complete, so the fallback default must not silently
			// downgrade it.
			const editor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = editor
			diffViewProvider.editType = "modify"
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, versionTokenOfStat(previewStats), true)
			vi.mocked(computeVersionToken).mockResolvedValue("moved")
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("new content")

			await expect(diffViewProvider.saveChanges(false)).resolves.toMatchObject({ newProblemsMessage: "" })
			const observation = mockTask.observationRegistry.get(`${mockCwd}/test.ts`)
			expect(observation?.version).toBe(versionTokenOfStat(previewStats))
			expect(observation?.complete).toBe(true)
			// The stat that pairs with the read must be the bigint form, otherwise the
			// token is built from truncated fields.
			expect(fs.stat).toHaveBeenCalledWith(`${mockCwd}/test.ts`, { bigint: true })
		})

		it("keeps the rejection when the stat paired with the read is unavailable", async () => {
			// There is no version to attribute the read to, so a match cannot be adopted.
			const editor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = editor
			diffViewProvider.editType = "modify"
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, versionTokenOfStat(previewStats), true)
			vi.mocked(computeVersionToken).mockResolvedValue("moved")
			vi.mocked(fs.stat).mockRejectedValueOnce(new Error("stat failed"))
			vi.mocked(fs.readFile).mockResolvedValue("new content")

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")
			expect(mockTask.observationRegistry.get(`${mockCwd}/test.ts`)?.version).toBe(
				versionTokenOfStat(previewStats),
			)
		})

		it("keeps the rejection when the paired read fails", async () => {
			// The bytes cannot be compared, so a match cannot be assumed.
			const editor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = editor
			diffViewProvider.editType = "modify"
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, versionTokenOfStat(previewStats), true)
			vi.mocked(computeVersionToken).mockResolvedValue("moved")
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockRejectedValueOnce(new Error("read failed"))

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")
		})

		it("records an incomplete observation when the path was never observed", async () => {
			// Nothing was read in full, so the adopted state must be recorded as an
			// incomplete observation rather than dereferencing a missing entry. A path the
			// registry has never seen keeps the case independent of earlier tests.
			const editor = {
				document: {
					uri: { fsPath: `${mockCwd}/never-observed.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = editor
			diffViewProvider.editType = "modify"
			diffViewProvider["relPath"] = "never-observed.ts"
			vi.mocked(computeVersionToken).mockResolvedValue("moved")
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("new content")

			await expect(diffViewProvider.saveChanges(false)).resolves.toMatchObject({ newProblemsMessage: "" })
			const freshObservation = mockTask.observationRegistry.get(`${mockCwd}/never-observed.ts`)
			expect(freshObservation?.version).toBe(versionTokenOfStat(previewStats))
			expect(freshObservation?.complete).toBe(false)
		})
		it("keeps a non-guard write failure a failure even when the disk already matches", async () => {
			// The guard passed and the write itself failed. The disk happens to hold the
			// same bytes, but this save did not publish them, so the failure must not be
			// reinterpreted as a success.
			const cleanEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = cleanEditor
			diffViewProvider.editType = "modify"
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, versionTokenOfStat(previewStats), true)
			vi.mocked(computeVersionToken).mockResolvedValue(versionTokenOfStat(previewStats))
			const { safeWriteText } = await import("../../../services/file-safety/safeWriteText")
			vi.mocked(safeWriteText).mockRejectedValueOnce(new Error("EACCES: permission denied"))
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("new content")

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("EACCES: permission denied")
			// No adoption read, so the guard verdict is the outcome.
			expect(fs.readFile).not.toHaveBeenCalled()
			expect(diffViewProvider["closeOwnDiffView"]).toHaveBeenCalled()
		})
		it("does not adopt content when the failure is not a guard verdict", async () => {
			// The bytes match and the buffer is clean, but the failure is the dead-task
			// error, not a guard rejection: adoption must not turn an unrelated failure
			// into a success.
			const editor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = editor
			diffViewProvider.editType = "modify"
			diffViewProvider["taskRef"] = { deref: () => undefined } as unknown as WeakRef<Task>
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, versionTokenOfStat(previewStats), true)
			vi.mocked(computeVersionToken).mockResolvedValue("moved")
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("new content")

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow(
				"Cannot guard the write: the owning task is no longer available",
			)
			// The adoption check never runs, so the file is neither stat-ed nor read.
			expect(fs.stat).not.toHaveBeenCalled()
			expect(fs.readFile).not.toHaveBeenCalled()
		})

		it("pairs the read with the bigint form on both sides of the comparison", async () => {
			// A non-bigint stat truncates the fields the version token is built from, so
			// both stats around the read must request the bigint form.
			const editor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = editor
			diffViewProvider.editType = "modify"
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, versionTokenOfStat(previewStats), true)
			vi.mocked(computeVersionToken).mockResolvedValue("moved")
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("new content")

			await expect(diffViewProvider.saveChanges(false)).resolves.toMatchObject({ newProblemsMessage: "" })
			expect(vi.mocked(fs.stat).mock.calls.map((call) => call[1])).toEqual([{ bigint: true }, { bigint: true }])
		})
		it("does not unlink when the placeholder stat is unavailable and still closes the diff views", async () => {
			// The placeholder vanished between open() and the rejected save: the
			// stat guard must short-circuit BEFORE the token comparison (no
			// unlink) and the best-effort cleanup must not skip the view close.
			const dirtyEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = dirtyEditor
			revertClearsDirty(dirtyEditor.document)
			diffViewProvider.editType = "create"
			const placeholderToken = versionTokenOfStat(previewStats)
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, placeholderToken, true)
			// the placeholder vanished: stat rejects and the guard's .catch
			// normalizes it to undefined stats
			vi.mocked(fs.stat).mockRejectedValue(new Error("ENOENT: no such file or directory"))
			vi.mocked(computeVersionToken).mockResolvedValue("moved") // stale rejection
			diffViewProvider["placeholderVersion"] = placeholderToken

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")

			expect(fs.unlink).not.toHaveBeenCalled()
			expect(diffViewProvider["closeOwnDiffView"]).toHaveBeenCalled()
		})

		it("does not unlink a placeholder whose content changed after open() - the token gate refuses", async () => {
			// The placeholder is still on disk, but its stats no longer match the
			// token open() recorded: another writer touched the file, so the
			// cleanup must refuse to unlink (it would destroy the other
			// writer's content).
			const dirtyEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
					getText: vi.fn().mockReturnValue("new content"),
					lineCount: 0,
					encoding: "utf8",
					isDirty: true,
					save: vi.fn().mockResolvedValue(undefined),
				},
				selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			} as unknown as vscode.TextEditor
			diffViewProvider["activeDiffEditor"] = dirtyEditor
			revertClearsDirty(dirtyEditor.document)
			diffViewProvider.editType = "create"
			const placeholderToken = versionTokenOfStat(previewStats)
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, placeholderToken, true)
			// the on-disk placeholder moved on since open(): same identity, new
			// size -> a different token than the one open() recorded
			const movedStats = { ...previewStats, size: BigInt(301) } as unknown as BigIntStats
			vi.mocked(fs.stat).mockResolvedValue(movedStats)
			vi.mocked(computeVersionToken).mockResolvedValue("moved") // stale rejection
			diffViewProvider["placeholderVersion"] = placeholderToken

			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("Stale version")

			expect(fs.stat).toHaveBeenCalledWith(`${mockCwd}/test.ts`, { bigint: true })
			// token mismatch -> the placeholder is NOT ours anymore: no unlink
			expect(fs.unlink).not.toHaveBeenCalled()
			expect(diffViewProvider["closeOwnDiffView"]).toHaveBeenCalled()
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

		it("revertChanges() does not run a second teardown while one is already in flight", async () => {
			// Cancellation can reach revertChanges() while a rejected save is still
			// discarding the same buffer. Both paths acting on the document and the same
			// tabs is duplicate cleanup, so the second caller waits for the first.
			const applyEdit = vi.mocked(vscode.workspace.applyEdit)
			applyEdit.mockResolvedValue(true)
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			const editor = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				}),
			})
			diffViewProvider["activeDiffEditor"] = editor
			// The tail of revertChanges() - restoring the preview tabs the diff evicted and
			// resetting the provider - belongs to the teardown, not to every caller.
			const restorePreviewTabs = vi.fn().mockResolvedValue(undefined)
			const reset = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = restorePreviewTabs
			diffViewProvider["reset"] = reset

			const first = diffViewProvider.revertChanges()
			const second = diffViewProvider.revertChanges()
			await Promise.all([first, second])

			expect(applyEdit).toHaveBeenCalledTimes(1)
			expect(restorePreviewTabs).toHaveBeenCalledTimes(1)
			expect(reset).toHaveBeenCalledTimes(1)
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
				cwd: mockCwd,
				// S4b follow-up (#44): saveChanges publishes through the guarded write,
				// which resolves the path against task.cwd and consults the task's
				// observation registry — both must be present on this suite's mock task.
				observationRegistry: new ObservationRegistry(),
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
			// The preview observation + matching version token let the guarded save
			// proceed so these tests stay focused on the auto-close decision table.
			task.observationRegistry.observe(`${mockTargetPath}`, "v1")
			vi.mocked(computeVersionToken).mockResolvedValue("v1")
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

		it("transient tab is kept by default when autoCloseZooOpenedFiles is unset (opt-in)", async () => {
			// Empty state -> autoCloseZooOpenedFiles is undefined and falls back to the
			// centralized default (false), so an untouched transient tab is kept.
			const provider = setupProvider({})
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

		it("transient tab is closed when autoCloseZooOpenedFiles is true", async () => {
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
			// The after-edit override only closes when the base auto-close is also
			// enabled, so set both (the base default is now opt-in/false).
			const provider = setupProvider({
				autoCloseZooOpenedFiles: true,
				autoCloseZooOpenedFilesAfterUserEdited: true,
			})
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

		it("defaults keep the transient tab open when all settings are unset", async () => {
			// No auto-close settings in state: auto-closing is opt-in, so an
			// untouched transient tab is kept and re-shown (long-standing behavior).
			const provider = setupProvider({})
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
	})
})
