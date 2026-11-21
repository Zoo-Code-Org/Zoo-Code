import {
	CommittedWriteBufferConflictError,
	DiffViewProvider,
	DIFF_VIEW_URI_SCHEME,
	DIFF_VIEW_LABEL_CHANGES,
} from "../DiffViewProvider"
import { DecorationController } from "../DecorationController"
import type { Mock } from "vitest"
import * as vscode from "vscode"
import * as path from "path"
import delay from "delay"
import { DEFAULT_WRITE_DELAY_MS } from "@roo-code/types"

import { makePosition, makeRange, makeTextDocument, makeTextEditor, makeUri } from "../../../test-utils/vscode"

import * as fs from "fs/promises"

import { computeVersionToken, versionTokenOfStat } from "../../../utils/versionToken"
import type { BigIntStats } from "fs"
import { safeWriteText } from "../../../services/file-safety/safeWriteText"
import { withFileLock } from "../../../utils/fileLock"
import { createDirectoriesForFile } from "../../../utils/fs"
import { ObservationRegistry } from "../../../core/task/observationRegistry"
import { arePathsEqual } from "../../../utils/path"
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
	open: vi.fn(async (targetPath: string) => {
		const mocked = await import("fs/promises")
		return {
			stat: (options?: Parameters<typeof mocked.stat>[1]) => mocked.stat(targetPath, options),
			close: () => Promise.resolve(),
		}
	}),
	realpath: vi.fn(async (p: string) => p),
}))

// Mock safeWriteText (used by saveDirectly)
vi.mock("../../../services/file-safety/safeWriteText", async (importOriginal) => {
	// guardedWrite matches the durability branch by name, so the class has to come from
	// the real module: a stand-in would let rows pass against a shape production does not
	// build. The publish primitive stays a stub.
	const actual = await importOriginal<typeof import("../../../services/file-safety/safeWriteText")>()
	return {
		...actual,
		safeWriteText: vi.fn(),
		resolveLockKey: vi.fn(async (p: string) => p),
	}
})

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
		mockTask = {
			...makeTaskDouble({
				// Auto-closing edited tabs is opt-in by default; the legacy
				// "close/keep behavior" suite below asserts the close path, so
				// enable it here. The opt-in default itself is covered by the
				// dedicated "auto-close settings decision table" suite.
				autoCloseZooOpenedFiles: true,
			}),
			cwd: mockCwd,
			observationRegistry: new ObservationRegistry(),
		} as unknown as Task // the double is partial; cast matches makeTaskDouble's own

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
	// Installs one of this provider's Zoo diff tabs in the mocked workbench and spies the
	// real tab-close call, optionally holding that close open on a gate. Tests use it to
	// wait for, and count, a teardown pass by the effect that matters - the tab actually
	// going away - rather than by the name of the private helper that closes it.
	const installDiffTabSpy = (absolutePath: string, hold?: Promise<void>) => {
		const tab = {
			input: {
				constructor: { name: "TabInputTextDiff" },
				original: { scheme: DIFF_VIEW_URI_SCHEME },
				modified: { fsPath: absolutePath },
			},
			label: absolutePath + ": changes (Editable)",
			isDirty: false,
		}
		Object.setPrototypeOf(tab.input, vscode.TabInputTextDiff.prototype)
		// A second, foreign diff view sits in the same workbench so a teardown that sweeps every
		// clean diff view is visible to the caller rather than invisible.
		const otherTab = {
			input: {
				constructor: { name: "TabInputTextDiff" },
				original: { scheme: DIFF_VIEW_URI_SCHEME },
				modified: { fsPath: absolutePath.replace(/([^/]+)$/, "other-task.ts") },
			},
			label: "other-task.ts: changes (Editable)",
			isDirty: false,
		}
		Object.setPrototypeOf(otherTab.input, vscode.TabInputTextDiff.prototype)
		Object.defineProperty(vscode.window.tabGroups, "all", {
			get: () => [{ tabs: [tab, otherTab] }],
			configurable: true,
		})
		const closedTabs: unknown[] = []
		vi.mocked(vscode.window.tabGroups.close).mockImplementation(async (closed) => {
			closedTabs.push(closed)
			if (hold) {
				await hold
			}
			return true
		})
		return { tab, otherTab, closedTabs }
	}

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

		// The closer has to recognise the tab the opener handed it. openDiffEditor() reuses a diff tab
		// through arePathsEqual while closeOwnDiffView() compared spellings, so on Windows the opener
		// could pick up a tab the closure then missed, leaving it open after reset() cleared the
		// provider state. Which two spellings count as one file is a property of the platform's path
		// comparison, so the expectation states agreement with that comparison rather than hard-coding
		// what Windows does: the Windows lane requires the fold, a case-sensitive lane requires the
		// closer not to be more eager than the opener.
		const targetOf = (): string => path.resolve(path.join(mockCwd, "test.ts"))
		const otherCasingOf = (p: string): string => p.replace(/([^\\/]+)$/, (last) => last.toUpperCase())
		const makeOwnDiffTabForClosure = (modifiedFsPath: string) => {
			const tab = {
				input: {
					constructor: { name: "TabInputTextDiff" },
					original: { scheme: DIFF_VIEW_URI_SCHEME },
					modified: { fsPath: modifiedFsPath },
				},
				isDirty: false,
			}
			Object.setPrototypeOf(tab.input, vscode.TabInputTextDiff.prototype)
			return tab
		}

		it("closes its own tab whichever casing of the target that tab carries", async () => {
			const target = targetOf()
			const sameSpellingTab = makeOwnDiffTabForClosure(target)
			const otherSpellingTab = makeOwnDiffTabForClosure(otherCasingOf(target))
			const otherTaskTab = makeOwnDiffTabForClosure(path.join(path.dirname(target), "other-task.ts"))
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [sameSpellingTab, otherSpellingTab, otherTaskTab] }],
				configurable: true,
			})
			const closedTabs: unknown[] = []
			vi.mocked(vscode.window.tabGroups.close).mockImplementation((closed) => {
				closedTabs.push(closed)
				return Promise.resolve(true)
			})

			await diffViewProvider["closeOwnDiffView"](path.join(mockCwd, "test.ts"))

			expect(closedTabs).toContain(sameSpellingTab)
			// Another task's file is still another task's file, casing or no casing.
			expect(closedTabs).not.toContain(otherTaskTab)
			expect(closedTabs.includes(otherSpellingTab)).toBe(
				arePathsEqual(otherSpellingTab.input.modified.fsPath, target),
			)
		})

		it("recognises the label-identified tab through the same comparison it uses for scheme tabs", async () => {
			const target = targetOf()
			const ownLabel = `${path.basename(target)}: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`
			const labelTab = {
				input: { uri: { fsPath: path.join(otherCasingOf(path.dirname(target)), path.basename(target)) } },
				label: ownLabel,
				isDirty: false,
			}
			const otherTaskLabelTab = {
				input: { uri: { fsPath: target } },
				label: `other-task.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
				isDirty: false,
			}
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [labelTab, otherTaskLabelTab] }],
				configurable: true,
			})
			const closedTabs: unknown[] = []
			vi.mocked(vscode.window.tabGroups.close).mockImplementation((closed) => {
				closedTabs.push(closed)
				return Promise.resolve(true)
			})

			await diffViewProvider["closeOwnDiffView"](path.join(mockCwd, "test.ts"))

			expect(closedTabs.includes(labelTab)).toBe(arePathsEqual(labelTab.input.uri.fsPath, target))
			// The label still gates: sharing the comparison does not turn every tab that points at the
			// target into this provider's tab.
			expect(closedTabs).not.toContain(otherTaskLabelTab)
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

	// The flow-level version of the tab-scoping check above: a rejected edit is one task's
	// business, so its teardown must not reach into another task's diff view. Asserted
	// through revertChanges() and the tabs themselves rather than through the private
	// helper the teardown now calls, so it stays true whichever helper is used.
	it("revertChanges() leaves another task's diff view open", async () => {
		const ownTab = {
			input: {
				constructor: { name: "TabInputTextDiff" },
				original: { scheme: DIFF_VIEW_URI_SCHEME },
				modified: { fsPath: `${mockCwd}/test.ts` },
			},
			label: `test.ts: changes (Editable)`,
			isDirty: false,
		}
		const otherTaskTab = {
			input: {
				constructor: { name: "TabInputTextDiff" },
				original: { scheme: DIFF_VIEW_URI_SCHEME },
				modified: { fsPath: `${mockCwd}/other-task.ts` },
			},
			label: `other-task.ts: changes (Editable)`,
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
		vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
		diffViewProvider["relPath"] = "test.ts"
		diffViewProvider["editType"] = "modify"
		diffViewProvider["originalContent"] = "original"
		diffViewProvider["activeDiffEditor"] = {
			document: {
				uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
				getText: vi.fn().mockReturnValue("content"),
				positionAt: vi.fn().mockReturnValue({ line: 0, character: 0 }),
				isDirty: false,
				save: vi.fn().mockResolvedValue(undefined),
			},
		} as unknown as vscode.TextEditor
		// The tail steps are not what this assertion is about: stub them so the spy counts
		// only the revert pass's own tab work.
		diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
		diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
		diffViewProvider["reset"] = vi.fn().mockResolvedValue(undefined)

		await diffViewProvider.revertChanges()

		expect(closedTabs).toEqual([ownTab])
	})

	// The one closeAllDiffViews() call site that survives is reset()'s fallback for when
	// the provider no longer knows which file it was editing. That site is chosen, not
	// overlooked: with no path to scope to, sweeping every clean diff view is all that is
	// left, and this test is what says so out loud.
	it("reset() without a relPath still closes every clean diff view", async () => {
		const ownTab = {
			input: {
				constructor: { name: "TabInputTextDiff" },
				original: { scheme: DIFF_VIEW_URI_SCHEME },
				modified: { fsPath: `${mockCwd}/test.ts` },
			},
			isDirty: false,
		}
		const otherTab = {
			input: {
				constructor: { name: "TabInputTextDiff" },
				original: { scheme: DIFF_VIEW_URI_SCHEME },
				modified: { fsPath: `${mockCwd}/other-task.ts` },
			},
			isDirty: false,
		}
		for (const tab of [ownTab, otherTab]) {
			Object.setPrototypeOf(tab.input, vscode.TabInputTextDiff.prototype)
		}
		Object.defineProperty(vscode.window.tabGroups, "all", {
			get: () => [{ tabs: [ownTab, otherTab] }],
			configurable: true,
		})
		const closedTabs: unknown[] = []
		vi.mocked(vscode.window.tabGroups.close).mockImplementation((tab) => {
			closedTabs.push(tab)
			return Promise.resolve(true)
		})
		diffViewProvider["relPath"] = undefined

		await diffViewProvider["reset"]()

		expect(closedTabs).toEqual([ownTab, otherTab])
	})

	describe("saveDirectly method", () => {
		beforeEach(() => {
			// Mock vscode functions
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(makeTextEditor())
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

			await diffViewProvider.saveDirectly(
				"../outside.ts",
				"new content",
				false,
				true,
				1000,
				"create",
				undefined,
				true,
				path.resolve(mockCwd, "../outside.ts"),
			)

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

		it("reconciles an already-open target document after the guarded publish", async () => {
			// guardedWrite wrote the published bytes to disk directly; the open
			// buffer still holds the pre-publish text, and its dirty state means
			// VS Code's ordinary save path would republish those stale bytes over
			// what the guard committed. saveDirectly must reconcile the buffer
			// before returning: reverting reloads the published bytes and clears
			// the dirty flag.
			const openDirtyDoc = {
				uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
				isDirty: true,
				// The buffer already holds the published content, so reloading it loses no edits.
				getText: () => "new content",
				save: vi.fn().mockResolvedValue(undefined),
			}
			const docDouble = openDirtyDoc as unknown as vscode.TextDocument // Structural double: the revert path only reads uri and dirty state.
			const documents = vscode.workspace.textDocuments as vscode.TextDocument[]
			documents.push(docDouble)
			try {
				// The revert command reloads the published bytes: the double's
				// dirty flag clears when the revert runs, as it does in the editor.
				vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command: string) => {
					if (command === "workbench.action.files.revert") {
						openDirtyDoc.isDirty = false
					}
				})

				await diffViewProvider.saveDirectly("test.ts", "new content", false, false, 0)

				expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.files.revert")
				// The reconcile is a revert, not a save: saving would republish the
				// stale buffer bytes over the publish.
				expect(openDirtyDoc.save).not.toHaveBeenCalled()
			} finally {
				documents.splice(documents.indexOf(docDouble), 1)
				vi.mocked(vscode.commands.executeCommand).mockReset()
			}
		})

		it("reconciles the file document when a virtual document with the same fsPath is listed first", async () => {
			// A diff editor lists its virtual side under the fsPath of the file it is
			// comparing, and textDocuments can report that document before the real
			// buffer. The reconciliation has to pick the file document: aimed at the
			// virtual side it reverts a document that was never stale, leaves the dirty
			// buffer holding the pre-publish bytes, and reports success - and the buffer's
			// next save republishes those stale bytes over what the guard committed.
			const virtualDoc = {
				uri: { fsPath: `${mockCwd}/test.ts`, scheme: "diff" },
				isDirty: false,
				getText: () => "virtual side of the diff",
				save: vi.fn().mockResolvedValue(undefined),
			}
			const openDirtyDoc = {
				uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
				isDirty: true,
				getText: () => "new content",
				save: vi.fn().mockResolvedValue(undefined),
			}
			const virtualDouble = virtualDoc as unknown as vscode.TextDocument // Structural double
			const fileDouble = openDirtyDoc as unknown as vscode.TextDocument // Structural double
			const documents = vscode.workspace.textDocuments as vscode.TextDocument[]
			documents.push(virtualDouble, fileDouble)
			try {
				// The revert command has no resource argument, so the document the
				// reconciliation activates is the document that gets reverted. Clearing the
				// dirty flag only for the document that was activated is what makes an aimed
				// -at-the-virtual-side reconciliation visible in the assertions below.
				const activated: unknown[] = []
				vi.mocked(vscode.window.showTextDocument).mockImplementation(async (document) => {
					activated.push(document)
					// Structural double: saveDirectly awaits the activation and never reads the
					// returned editor, so the object carries only the document it activated.
					return { document } as unknown as vscode.TextEditor
				})
				vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command: unknown) => {
					if (command === "workbench.action.files.revert" && activated[activated.length - 1] === fileDouble) {
						openDirtyDoc.isDirty = false
					}
				})

				await diffViewProvider.saveDirectly("test.ts", "new content", false, false, 0)

				expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
					fileDouble,
					expect.objectContaining({ preserveFocus: false }),
				)
				expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.files.revert")
				// The stale buffer is the one that was reconciled.
				expect(openDirtyDoc.isDirty).toBe(false)
				expect(virtualDoc.isDirty).toBe(false)
				expect(virtualDoc.save).not.toHaveBeenCalled()
				expect(openDirtyDoc.save).not.toHaveBeenCalled()
			} finally {
				documents.splice(documents.indexOf(virtualDouble), 1)
				documents.splice(documents.indexOf(fileDouble), 1)
				vi.mocked(vscode.window.showTextDocument).mockReset()
				vi.mocked(vscode.commands.executeCommand).mockReset()
			}
		})
		it("keeps a dirty buffer with different unsaved edits and reports the conflict", async () => {
			// The user has unsaved edits in the open target that differ from what the guard
			// published. Reverting would discard them, so the buffer is retained and the
			// conflict is reported instead; the published content stays on disk.
			const userEditedDoc = {
				uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
				isDirty: true,
				getText: () => "user unsaved edit",
				save: vi.fn().mockResolvedValue(undefined),
			}
			const docDouble = userEditedDoc as unknown as vscode.TextDocument
			const documents = vscode.workspace.textDocuments as vscode.TextDocument[]
			documents.push(docDouble)
			try {
				const conflict = await diffViewProvider
					.saveDirectly("test.ts", "new content", false, false, 0)
					.catch((error: unknown) => error)
				expect(conflict).toBeInstanceOf(CommittedWriteBufferConflictError)
				expect((conflict as Error).name).toBe("CommittedWriteBufferConflictError")
				// The model must be told the write is committed and must not retry the edit.
				expect((conflict as Error).message).toContain("write is already committed")
				expect((conflict as Error).message).toContain("do not retry")
				expect((conflict as Error).message).not.toContain("then retry")

				// No revert ran: the user's edits are still in the buffer.
				expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.files.revert")
				expect(documents).toContain(docDouble)
				expect(userEditedDoc.save).not.toHaveBeenCalled()
			} finally {
				documents.splice(documents.indexOf(docDouble), 1)
			}
		})

		it("fails the write when the reconcile leaves the target dirty", async () => {
			// The revert command rejects and the buffer stays dirty: reporting
			// success would leave VS Code's ordinary save path free to republish
			// the stale buffer over the guarded bytes. saveDirectly must close the
			// tab and reopen the document from disk, and when the reopened buffer
			// is still dirty it must fail instead of reporting success - the
			// diagnostics/open path must not run over a dirty target.
			const staleDoc = {
				uri: { fsPath: `${mockCwd}/test.ts`, scheme: "file" },
				isDirty: true,
				getText: () => "new content",
				save: vi.fn().mockResolvedValue(undefined),
			}
			const docDouble = staleDoc as unknown as vscode.TextDocument // Structural double: the reconcile path only reads uri and dirty state.
			const documents = vscode.workspace.textDocuments as vscode.TextDocument[]
			documents.push(docDouble)
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = closeFileTab
			try {
				vi.mocked(vscode.commands.executeCommand).mockRejectedValue(new Error("revert command failed"))

				await expect(diffViewProvider.saveDirectly("test.ts", "new content", false, false, 0)).rejects.toThrow(
					"still dirty after the guarded publish",
				)

				// The stale buffer is taken out of the save path: the tab was closed
				// and the document reopened from disk before the failure surfaced,
				// so a later save reads the published bytes, not the stale ones.
				expect(closeFileTab).toHaveBeenCalledWith(`${mockCwd}/test.ts`)
				expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
					expect.objectContaining({ fsPath: `${mockCwd}/test.ts` }),
				)
				expect(staleDoc.save).not.toHaveBeenCalled()
			} finally {
				documents.splice(documents.indexOf(docDouble), 1)
				vi.mocked(vscode.commands.executeCommand).mockReset()
			}
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
			expect(diffViewProvider.newProblemsMessage).toBe("")
			expect(diffViewProvider.userEdits).toBeUndefined()
			expect(diffViewProvider["relPath"]).toBe("test.ts")
			expect(diffViewProvider["newContent"]).toBe("new content")
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
			// The guarded publish these rows run through looks the target up in the task's
			// observation registry before writing it, so the fixture has to record the read and
			// the version token the guard recomputes. These rows are about the decisions around
			// the publish - tabs, focus, scroll, finalization - not about the guard refusing it.
			mockTask.observationRegistry.observe(`${mockCwd}/test.ts`, "v1")
			vi.mocked(computeVersionToken).mockResolvedValue("v1")
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
					callback({
						uri: { fsPath: `${mockCwd}/test.txt`, scheme: "file" },
					} as unknown as vscode.TextDocument)
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

			await expect(diffViewProvider.saveChanges(false, 0, "edit")).rejects.toThrow(/File not read yet/)
			expect(safeWriteText).not.toHaveBeenCalled()
			// The preview's authorization was withdrawn rather than left behind.
			expect(mockTask.observationRegistry.has(`${mockCwd}/test.txt`)).toBe(false)
		})

		it("withdraws the preview observation on a rejected update save once reset runs", async () => {
			// The full trigger the review row spells out: the model never read the
			// file, open() records the preview entry (complete: false), and
			// saveChanges(..., "update") is rejected as only-partially-read. The
			// discard cleanup reloads the buffer; nothing wrote, so the token is
			// unchanged and nothing forgets the entry. reset() - reached by every
			// tool catch and by revertChanges through finalizeSession - must
			// withdraw it, or a later apply_diff is authorized by a look the model
			// never made (the edit-path test above covers only the first attempt).
			mockTask.observationRegistry.clear()
			await openPreview()
			expect(mockTask.observationRegistry.has(`${mockCwd}/test.txt`)).toBe(true)

			await expect(diffViewProvider.saveChanges(false, 0, "update")).rejects.toThrow(/only partially read/)
			// Step 2 of the trigger: the rejected update leaves the preview entry in
			// place - this is the leftover the fix must catch.
			expect(mockTask.observationRegistry.has(`${mockCwd}/test.txt`)).toBe(true)

			await diffViewProvider.reset()
			expect(mockTask.observationRegistry.has(`${mockCwd}/test.txt`)).toBe(false)
		})

		it("keeps an observation the model earned at the same token after the preview", async () => {
			// A read_file after the preview records complete: true at the same
			// version token (nothing wrote in between). The withdrawal must not
			// touch it: the model did read the file, and its earned authorization
			// outlives the preview.
			mockTask.observationRegistry.clear()
			await openPreview()
			const previewEntry = mockTask.observationRegistry.get(`${mockCwd}/test.txt`)
			expect(previewEntry).toBeDefined()
			mockTask.observationRegistry.observe(`${mockCwd}/test.txt`, previewEntry!.version, true)

			await diffViewProvider.reset()
			expect(mockTask.observationRegistry.get(`${mockCwd}/test.txt`)?.complete).toBe(true)
		})

		it("keeps a model partial read that replaced the preview entry at the same token", async () => {
			// A partial read_file while the diff is open replaces the preview
			// observation with a fresh entry at the SAME token and the SAME
			// incomplete flag - indistinguishable by content, but a different
			// owner. The withdrawal is by entry identity, so the model's earned
			// partial authorization survives the reset and a later targeted edit
			// stays authorized.
			mockTask.observationRegistry.clear()
			await openPreview()
			const previewEntry = mockTask.observationRegistry.get(`${mockCwd}/test.txt`)
			expect(previewEntry).toBeDefined()
			mockTask.observationRegistry.observe(`${mockCwd}/test.txt`, previewEntry!.version, false)

			await diffViewProvider.reset()
			expect(mockTask.observationRegistry.get(`${mockCwd}/test.txt`)).toBeDefined()
		})

		it("keeps an entry whose token moved on - the preview no longer owns it", async () => {
			// A landed publish (or a later session) replaced the entry: the version
			// no longer names the preview's token, so the withdrawal leaves it
			// alone even though the flag still reads incomplete.
			mockTask.observationRegistry.clear()
			await openPreview()
			mockTask.observationRegistry.observe(`${mockCwd}/test.txt`, "landed-token", false)

			await diffViewProvider.reset()
			expect(mockTask.observationRegistry.get(`${mockCwd}/test.txt`)?.version).toBe("landed-token")
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
			// Created exclusively (#new row 4507851689): a plain write would truncate a file another
			// process created after the absence was classified.
			expect(vi.mocked(fs.open)).toHaveBeenCalledWith(`${mockCwd}/t3-create.ts`, "wx")
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

			// Created exclusively (#new row 4507851689): a plain write would truncate a file another
			// process created after the absence was classified.
			expect(vi.mocked(fs.open)).toHaveBeenCalledWith(`${mockCwd}/t3-dead-task.ts`, "wx")
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

			// Created exclusively (#new row 4507851689): a plain write would truncate a file another
			// process created after the absence was classified.
			expect(vi.mocked(fs.open)).toHaveBeenCalledWith(`${mockCwd}/contested.ts`, "wx")
			// nothing recorded, and the vanished file's prior observation was
			// not replaced with the writer's token
			expect(mockTask.observationRegistry.get(`${mockCwd}/contested.ts`)?.version).toBe("model-token")
			expect(diffViewProvider["placeholderVersion"]).toBeUndefined()
		})

		// Row 4507851689 (measured): the placeholder is a create, and the absence above is a
		// classification, not a reservation. A plain write would truncate a file that won the race,
		// and the stat-matched observation below would then describe content open() never wrote.
		it("open() creates the placeholder exclusively and reports a lost create race", async () => {
			const mockEditor = mockTextEditor(`${mockCwd}/race.ts`)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/race.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("")
			const create = vi.mocked(fs.open)
			create.mockRejectedValueOnce(
				Object.assign(new Error(`EEXIST: file already exists, open '${mockCwd}/race.ts'`), { code: "EEXIST" }),
			)
			diffViewProvider.editType = "create"
			mockTask.observationRegistry.clear()

			const failure = await diffViewProvider.open("race.ts").catch((error: unknown) => error)
			expect(create).toHaveBeenCalledWith(`${mockCwd}/race.ts`, "wx")
			expect(failure).toBeInstanceOf(Error)
			expect((failure as Error).message).toContain("another create won the race")
			// Nothing was observed and no cleanup token was taken, so a later rejected save cannot
			// unlink the winner's file.
			expect(mockTask.observationRegistry.get(`${mockCwd}/race.ts`)).toBeUndefined()
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

		it("open() records the placeholder token from the handle it created, not from the path it stats", async () => {
			// Where the identity comes from, pinned. The doubles make the two sources disagree: the handle
			// reports the identity of the file the exclusive create opened, and a path stat reports another file
			// - which is the state a rename landing between the create and the identity read produces on a real
			// filesystem. The token formula is unchanged (versionTokenOfStat over dev:ino:size:mtimeNs:ctimeNs);
			// only its source moves. Nothing here compares a path spelling, because this path hands canonical
			// paths to the lock, so a spelling pin would be a pin on the mock rather than on the file.
			const handleStats = {
				isDirectory: () => false,
				dev: BigInt(1),
				ino: BigInt(77),
				size: BigInt(0),
				mtimeNs: BigInt(4_000_000_000n),
				ctimeNs: BigInt(5_000_000_000n),
			} as unknown as BigIntStats
			const mockEditor = mockTextEditor(`${mockCwd}/handle-identity.ts`)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/handle-identity.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("")
			vi.mocked(fs.open).mockResolvedValue({
				stat: vi.fn().mockResolvedValue(handleStats),
				close: vi.fn().mockResolvedValue(undefined),
				// structural double; the cast matches the placeholder rows above it
			} as unknown as Awaited<ReturnType<typeof fs.open>>)
			diffViewProvider.editType = "create"
			mockTask.observationRegistry.clear()
			await diffViewProvider.open("handle-identity.ts")
			expect(diffViewProvider["placeholderVersion"]).toBe(versionTokenOfStat(handleStats))
			expect(diffViewProvider["placeholderVersion"]).not.toBe(versionTokenOfStat(previewStats))
			expect(vi.mocked(fs.open)).toHaveBeenCalledWith(`${mockCwd}/handle-identity.ts`, "wx")
		})

		// The control: with the handle and the path naming the same file, the token is the same one the
		// placeholder rows above already pin, so the row above is sensitive to the source of the identity and
		// not to an unrelated property of the double.
		it("the placeholder token is unchanged when the handle and the path name the same file", async () => {
			const mockEditor = mockTextEditor(`${mockCwd}/same-file.ts`)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				setTimeout(() => callback(mockTextDocument(`${mockCwd}/same-file.ts`)), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor]
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor)
			vi.mocked(fs.stat).mockResolvedValue(previewStats)
			vi.mocked(fs.readFile).mockResolvedValue("")
			vi.mocked(fs.open).mockResolvedValue({
				stat: vi.fn().mockResolvedValue(previewStats),
				close: vi.fn().mockResolvedValue(undefined),
				// structural double; the cast matches the placeholder rows above it
			} as unknown as Awaited<ReturnType<typeof fs.open>>)
			diffViewProvider.editType = "create"
			mockTask.observationRegistry.clear()
			await diffViewProvider.open("same-file.ts")
			expect(diffViewProvider["placeholderVersion"]).toBe(versionTokenOfStat(previewStats))
			expect(vi.mocked(fs.open)).toHaveBeenCalledWith(`${mockCwd}/same-file.ts`, "wx")
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
			// Deterministic: open() observed the placeholder token and
			// computeVersionToken answers the peer's token, so the guard takes the
			// stale-version branch - pin it, not the unobserved-create alternative.
			await expect(diffViewProvider.saveChanges(false)).rejects.toThrow(/^Stale version -- the file changed/)

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
			// Run the real close helpers and watch the tab itself, so the claim below does
			// not depend on which private helper the post-save cleanup happens to call. The
			// plain-file close and the preview restore are not this test's subject, so they
			// stay stubbed.
			Reflect.deleteProperty(diffViewProvider, "closeAllDiffViews")
			Reflect.deleteProperty(diffViewProvider, "closeOwnDiffView")
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
			const { tab: diffTab, closedTabs } = installDiffTabSpy(`${mockCwd}/test.ts`)
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
			// Proven on the tab itself: the diff tab this save had is gone. Asserting on the
			// close call rather than on the private helper keeps the claim true whichever
			// helper the post-save cleanup uses.
			expect(closedTabs).toEqual([diffTab])
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
		beforeEach(() => {
			// The guarded publish these rows run through looks the target up in the task's
			// observation registry before writing it, so the fixture has to record the read and
			// the version token the guard recomputes. These rows are about the decisions around
			// the publish - tabs, focus, scroll, finalization - not about the guard refusing it.
			mockTask.observationRegistry.observe(`${mockCwd}/test.txt`, "v1")
			vi.mocked(computeVersionToken).mockResolvedValue("v1")
		})

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

		beforeEach(() => {
			// The guarded publish these rows run through looks the target up in the task's
			// observation registry before writing it, so the fixture has to record the read and
			// the version token the guard recomputes. These rows are about the decisions around
			// the publish - tabs, focus, scroll, finalization - not about the guard refusing it.
			mockTask.observationRegistry.observe(`${mockCwd}/mock-target-file.ts`, "v1")
			mockTask.observationRegistry.observe(`${mockCwd}/test.txt`, "v1")
			vi.mocked(computeVersionToken).mockResolvedValue("v1")
		})

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

		it("revertChanges() holds the teardown through its finalization steps, not just the cleanup callback", async () => {
			// The guard has to stay held until the owner's finalization - the preview-tab restore
			// and reset() - settles as well. A cancellation that lands after the cleanup callback
			// but before those steps finished sees no teardown in flight and runs the whole pass a
			// second time: the document is reverted again, the same tabs are closed again, and the
			// tabs are restored and the provider reset twice.
			const applyEdit = vi.mocked(vscode.workspace.applyEdit)
			applyEdit.mockResolvedValue(true)
			const { closedTabs } = installDiffTabSpy(mockTargetPath)
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
			// The finalization is held open on a gate: that is exactly the window a real
			// cancellation lands in - the cleanup callback has settled, the tabs are not back yet.
			let releaseFinalization!: () => void
			const finalizationGate = new Promise<void>((resolve) => {
				releaseFinalization = resolve
			})
			const restorePreviewTabs = vi.fn().mockImplementation(async () => {
				await finalizationGate
			})
			const reset = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = restorePreviewTabs
			diffViewProvider["reset"] = reset

			const first = diffViewProvider.revertChanges()
			// Join only once the owner is INSIDE its finalization, so the second caller is
			// testing the window the guard used to release early on.
			for (let i = 0; i < 100 && restorePreviewTabs.mock.calls.length === 0; i++) {
				await new Promise((resolve) => setImmediate(resolve))
			}
			expect(restorePreviewTabs).toHaveBeenCalledTimes(1)
			const second = diffViewProvider.revertChanges()
			releaseFinalization()
			await Promise.all([first, second])

			expect(applyEdit).toHaveBeenCalledTimes(1)
			// One pass over the tabs across both callers: counted on the tab actually
			// closing, not on the helper the pass happens to call.
			expect(closedTabs).toHaveLength(1)
			expect(restorePreviewTabs).toHaveBeenCalledTimes(1)
			expect(reset).toHaveBeenCalledTimes(1)
		})

		it("revertChanges() does not run a second teardown while one is already in flight", async () => {
			// Cancellation can reach revertChanges() while a rejected save is still
			// discarding the same buffer. Both paths acting on the document and the same
			// tabs is duplicate cleanup, so the second caller waits for the first.
			const applyEdit = vi.mocked(vscode.workspace.applyEdit)
			applyEdit.mockResolvedValue(true)
			const { closedTabs } = installDiffTabSpy(mockTargetPath)
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

			const first = diffViewProvider.revertChanges()
			const second = diffViewProvider.revertChanges()
			await Promise.all([first, second])

			// Only this provider's tab is touched, whichever caller ran the pass.
			expect(new Set(closedTabs).size).toBe(1)
			expect(applyEdit).toHaveBeenCalledTimes(1)
		})
		// The save's post-publish cleanup touches the same buffers and tabs a cancellation's
		// teardown does, so it has to be one serialized pass - and a save whose session was torn
		// down while the guarded publish was still awaiting must not run a cleanup of its own.
		it("saveChanges() skips its post-publish cleanup when a teardown began during the publish", async () => {
			// A cancellation can reach revertChanges() while the publish is awaiting. That teardown
			// already closed the diff views and applied the auto-close preferences; a second pass
			// would close the same tabs and re-run the same document revert.
			const restorePreviewTabs = vi.fn().mockResolvedValue(undefined)
			const { closedTabs } = installDiffTabSpy(mockTargetPath)
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = restorePreviewTabs
			const applyEdit = vi.mocked(vscode.workspace.applyEdit)
			applyEdit.mockResolvedValue(true)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["newContent"] = "content"
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				}),
			})

			// The cancellation lands inside the guarded publish. The implementation has to be
			// restored afterwards: clearAllMocks() drops call records but keeps queued
			// implementations, and a leaked publish would cancel every later save in this file.
			vi.mocked(safeWriteText).mockImplementation(async () => {
				await diffViewProvider.revertChanges()
			})

			let result: Awaited<ReturnType<DiffViewProvider["saveChanges"]>> | undefined
			try {
				result = await diffViewProvider.saveChanges(false)
			} finally {
				vi.mocked(safeWriteText).mockReset()
				vi.mocked(safeWriteText).mockResolvedValue(undefined)
			}

			expect(result).toEqual({
				newProblemsMessage: undefined,
				userEdits: undefined,
				finalContent: undefined,
			})
			// Exactly one teardown ran - the cancellation's - and the save added no cleanup of its
			// own on top of it.
			expect(applyEdit).toHaveBeenCalledTimes(1)
			// Only this provider's tab is touched, by either caller.
			expect(new Set(closedTabs).size).toBe(1)
			expect(restorePreviewTabs).toHaveBeenCalledTimes(1)
		})

		it("saveChanges() serializes its post-publish cleanup with a revertChanges() that lands during it", async () => {
			// The cleanup closes the same tabs a cancellation would close. Going through the shared
			// teardown state means the cancellation waits for the save instead of racing it.
			let release: () => void = () => {}
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			const { closedTabs } = installDiffTabSpy(mockTargetPath, gate)
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
			const applyEdit = vi.mocked(vscode.workspace.applyEdit)
			applyEdit.mockResolvedValue(true)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["newContent"] = "content"
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				}),
			})

			const save = diffViewProvider.saveChanges(false)
			while (closedTabs.length === 0) {
				await new Promise((resolve) => setImmediate(resolve))
			}

			const revert = diffViewProvider.revertChanges()
			await new Promise((resolve) => setImmediate(resolve))

			// The revert has not touched the document: it is waiting for the save's cleanup.
			expect(applyEdit).not.toHaveBeenCalled()

			release()
			// The publish had already committed when this cancellation arrived, so the revert now
			// reports the committed-write conflict instead of restoring originalContent. Held rather
			// than swallowed: the serialization property below is about who touched the tabs.
			const settled = await Promise.allSettled([save, revert])
			expect(settled[0].status).toBe("fulfilled")
			expect(settled[1].status).toBe("rejected")
			const rejection = (settled[1] as PromiseRejectedResult).reason as CommittedWriteBufferConflictError
			expect(rejection).toBeInstanceOf(CommittedWriteBufferConflictError)
			// Not merely that something rejected: this is the window the row describes - a
			// cancellation that arrived after the guarded publish had committed.
			expect(rejection.message).toContain(
				"revertChanges: a cancellation arrived after the guarded publish had committed.",
			)

			// One pass over the tabs, and the cancellation did not repeat the document revert.
			// Only this provider's tab is touched, by either caller.
			expect(new Set(closedTabs).size).toBe(1)
			expect(applyEdit).not.toHaveBeenCalled()
		})

		// The pass that started the teardown owns the tab work, so a waiting caller must not
		// restore the preview tabs twice. It still has to leave the session closed: the owning
		// pass here is a save's post-publish cleanup, which has no finalize step of its own.
		it("revertChanges() restores no preview tabs twice but finalizes the session the owning pass left open", async () => {
			let release: () => void = () => {}
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			const { closedTabs } = installDiffTabSpy(mockTargetPath, gate)
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			const restorePreviewTabs = vi.fn().mockResolvedValue(undefined)
			const reset = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = restorePreviewTabs
			diffViewProvider["reset"] = reset
			const applyEdit = vi.mocked(vscode.workspace.applyEdit)
			applyEdit.mockResolvedValue(true)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["newContent"] = "content"
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				}),
			})

			const save = diffViewProvider.saveChanges(false)
			while (closedTabs.length === 0) {
				await new Promise((resolve) => setImmediate(resolve))
			}

			// The revert waits for the save's pass instead of starting one of its own.
			const revert = diffViewProvider.revertChanges()
			await new Promise((resolve) => setImmediate(resolve))
			release()
			// Same post-commit cancellation as the row above: the conflict report is awaited, not
			// swallowed, so this row keeps testing tab and reset counts on its own.
			const settled = await Promise.allSettled([save, revert])
			expect(settled[0].status).toBe("fulfilled")
			const rejection = (settled[1] as PromiseRejectedResult).reason as CommittedWriteBufferConflictError
			expect(rejection).toBeInstanceOf(CommittedWriteBufferConflictError)
			// Not merely that something rejected: this is the window the row describes - a
			// cancellation that arrived after the guarded publish had committed.
			expect(rejection.message).toContain(
				"revertChanges: a cancellation arrived after the guarded publish had committed.",
			)

			// The owning pass restored the preview tabs exactly once, and the waiting caller
			// finalized the session exactly once - the pass that ran the tabs does not reset, so
			// the cancellation that waited on it closes the session instead of leaving it active.
			expect(restorePreviewTabs).toHaveBeenCalledTimes(1)
			expect(reset).toHaveBeenCalledTimes(1)
			expect(applyEdit).not.toHaveBeenCalled()
		})

		// The pre-merge row this covers: a cancellation or disposal that lands while the save owns
		// its post-publish teardown used to leave the provider mid-edit. The save's pass closes the
		// views and restores the tabs but never resets, the waiting revertChanges() returned without
		// finalizing, and Task.disposeOnce() only awaits the reversion promise - so isEditing and the
		// active editor survived the task that owned them.
		it("saveChanges() finalizes the session when a cancellation lands during its post-publish teardown", async () => {
			let release: () => void = () => {}
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			const { closedTabs } = installDiffTabSpy(mockTargetPath, gate)
			const restorePreviewTabs = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = restorePreviewTabs
			const applyEdit = vi.mocked(vscode.workspace.applyEdit)
			applyEdit.mockResolvedValue(true)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["newContent"] = "content"
			diffViewProvider.isEditing = true
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				}),
			})
			const listener = { dispose: vi.fn() }
			diffViewProvider["activeEditorListener"] = listener
			diffViewProvider["deferredScrollTimer"] = setTimeout(() => {}, 10_000)

			const save = diffViewProvider.saveChanges(false)
			while (closedTabs.length === 0) {
				await new Promise((resolve) => setImmediate(resolve))
			}

			// Task.disposeOnce() reaches revertChanges() while the save's pass owns the session.
			const revert = diffViewProvider.revertChanges()
			await new Promise((resolve) => setImmediate(resolve))
			release()
			// The publish committed before Task.disposeOnce() reached revertChanges(), so the
			// cancellation closes the session and reports the committed-write conflict instead of
			// writing originalContent back over it.
			const settled = await Promise.allSettled([save, revert])

			// The session is closed: no edit flag, no retained editor, listeners and timer gone.
			expect(diffViewProvider.isEditing).toBe(false)
			expect(diffViewProvider["activeDiffEditor"]).toBeUndefined()
			expect(listener.dispose).toHaveBeenCalledTimes(1)
			expect(diffViewProvider["activeEditorListener"]).toBeUndefined()
			expect(diffViewProvider["deferredScrollTimer"]).toBeUndefined()

			// One pass over the tabs and buffers: the waiting cancellation repeated neither the
			// document revert nor the preview-tab restoration.
			expect(applyEdit).not.toHaveBeenCalled()
			// Both the save pass and the cancellation's session finalization close this
			// provider's own tab; what must not happen is either of them touching another
			// task's view.
			expect(new Set(closedTabs).size).toBe(1)
			expect(restorePreviewTabs).toHaveBeenCalledTimes(1)

			// A session a cancellation is closing reports no completed save, so no caller can present
			// diagnostics or user-edit output for provider state that is already gone.
			expect(settled[0].status).toBe("fulfilled")
			expect(
				(settled[0] as PromiseFulfilledResult<Awaited<ReturnType<DiffViewProvider["saveChanges"]>>>).value,
			).toEqual({
				newProblemsMessage: undefined,
				userEdits: undefined,
				finalContent: undefined,
			})
			// The caller that asked for the undo is told which of the two it got.
			expect(settled[1].status).toBe("rejected")
			const rejection = (settled[1] as PromiseRejectedResult).reason as CommittedWriteBufferConflictError
			expect(rejection).toBeInstanceOf(CommittedWriteBufferConflictError)
			// Not merely that something rejected: this is the window the row describes - a
			// cancellation that arrived after the guarded publish had committed.
			expect(rejection.message).toContain(
				"revertChanges: a cancellation arrived after the guarded publish had committed.",
			)
		})

		// Row 4507760734 (measured): the guarded path treats the commit as the point of no return,
		// which is why CommittedWriteBufferConflictError exists at all. The modify branch's
		// updatedDocument.save() is the one writer left that republishes through VS Code's unguarded
		// file service - the call the comment above saveChanges says every other path avoids - so a
		// cancellation that lands after the publish has to leave the published bytes and say so.
		it("revertChanges() after a committed publish leaves the published content and reports the conflict", async () => {
			const saveDoc = vi.fn().mockResolvedValue(undefined)
			const document = makeTextDocument({
				uri: makeUri(mockTargetPath),
				getText: vi.fn().mockReturnValue("content"),
				isDirty: false,
				save: saveDoc,
			})
			const applyEdit = vi.mocked(vscode.workspace.applyEdit)
			applyEdit.mockResolvedValue(true)
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["newContent"] = "content"
			diffViewProvider.isEditing = true
			diffViewProvider["activeDiffEditor"] = makeTextEditor({ document })

			await diffViewProvider.saveChanges(false)
			expect(diffViewProvider["committedPublish"]?.content).toBe("content")
			applyEdit.mockClear()
			vi.mocked(fs.unlink).mockClear()

			const outcome = await diffViewProvider.revertChanges().catch((error: unknown) => error)
			expect(outcome).toBeInstanceOf(CommittedWriteBufferConflictError)
			// No originalContent write, and no unguarded document.save() over the commit.
			expect(applyEdit).not.toHaveBeenCalled()
			expect(saveDoc).not.toHaveBeenCalled()
			expect(diffViewProvider.isEditing).toBe(false)
			expect(diffViewProvider["committedPublish"]).toBeUndefined()
		})

		// The other direction, without which the fix above could quietly delete the restore:
		// a cancellation that lands before any publish still puts the file back.
		it("revertChanges() before any publish still restores the original content", async () => {
			const saveDoc = vi.fn().mockResolvedValue(undefined)
			const document = makeTextDocument({
				uri: makeUri(mockTargetPath),
				getText: vi.fn().mockReturnValue("content"),
				isDirty: false,
				save: saveDoc,
			})
			const applyEdit = vi.mocked(vscode.workspace.applyEdit)
			applyEdit.mockResolvedValue(true)
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["newContent"] = "content"
			diffViewProvider.isEditing = true
			diffViewProvider["activeDiffEditor"] = makeTextEditor({ document })
			expect(diffViewProvider["committedPublish"]).toBeUndefined()

			await expect(diffViewProvider.revertChanges()).resolves.toBeUndefined()
			expect(applyEdit).toHaveBeenCalledTimes(1)
			expect(saveDoc).toHaveBeenCalledTimes(1)
			expect(diffViewProvider.isEditing).toBe(false)
		})

		// Row 4507851696 (measured): the create branch's fs.unlink is the delete that can take a
		// newly published file with it - including whatever another writer built on that path in
		// the meantime, since the unlink is not version-checked.
		it("revertChanges() after a committed create does not unlink the published file", async () => {
			const document = makeTextDocument({
				uri: makeUri(mockTargetPath),
				getText: vi.fn().mockReturnValue("content"),
				isDirty: false,
				save: vi.fn().mockResolvedValue(undefined),
			})
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "create"
			diffViewProvider["originalContent"] = ""
			diffViewProvider["newContent"] = "content"
			diffViewProvider.isEditing = true
			diffViewProvider["activeDiffEditor"] = makeTextEditor({ document })

			await diffViewProvider.saveChanges(false)
			expect(diffViewProvider["committedPublish"]?.content).toBe("content")
			vi.mocked(fs.unlink).mockClear()

			const outcome = await diffViewProvider.revertChanges().catch((error: unknown) => error)
			expect(outcome).toBeInstanceOf(CommittedWriteBufferConflictError)
			expect(fs.unlink).not.toHaveBeenCalledWith(mockTargetPath)
			expect(diffViewProvider.isEditing).toBe(false)
		})

		// Row 4507764622 (measured): the post-publish cleanup discarded revertDocument's verdict.
		// A buffer that stays dirty after the reopen still holds the bytes the guard published, so
		// the save reports the committed-write conflict instead of proceeding into the save-over
		// and returning ordinary success - the same name the no-diff path uses for the same state.
		it("saveChanges() reports the committed-write conflict when it cannot clear the buffer it published", async () => {
			const document = makeTextDocument({
				uri: makeUri(mockTargetPath),
				getText: vi.fn().mockReturnValue("content"),
				isDirty: true,
				save: vi.fn().mockResolvedValue(undefined),
			})
			const documents = vscode.workspace.textDocuments as vscode.TextDocument[]
			documents.length = 0
			documents.push(document)
			diffViewProvider["revertDocument"] = vi.fn().mockResolvedValue(false)
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["newContent"] = "content"
			diffViewProvider.isEditing = true
			diffViewProvider["activeDiffEditor"] = makeTextEditor({ document })

			const failure = await diffViewProvider.saveChanges(false).catch((error: unknown) => error)
			expect(failure).toBeInstanceOf(CommittedWriteBufferConflictError)
			// The detail names this window; the guidance is the shared one, not a new vocabulary.
			expect((failure as Error).message).toContain("saveChanges: the diff-view save committed its content")
			expect((failure as Error).message).toContain("do not retry")
			expect(diffViewProvider["committedPublish"]?.content).toBe("content")
			expect(diffViewProvider["closeFileTab"]).toHaveBeenCalledTimes(1)
			documents.length = 0
		})

		// The same verdict on the other teardown owner. This branch called revertDocument and threw the
		// answer away: a buffer that stays dirty after the revert still holds the bytes the guard
		// published, and the row below is the save teardown's version of the same state. The teardown
		// now gives the buffer the same second chance the save teardown gives - close, reopen from the
		// bytes) and reports which of the two outcomes it ended in, because the caller's next step
		// differs: settled content with a live buffer still needs the buffer saved or discarded.
		it("revertChanges() after a committed create reports the buffer it could not clear", async () => {
			// A structural double: the buffer holds exactly the bytes the guard published, and the rows
			// below make it dirty the way the state they describe does. The factory's object carries a
			// mutable isDirty; the interface declares it read-only, so the double is held under the one
			// property the rows write and cast to the interface once, at the boundary.
			const buffer: { isDirty: boolean } = makeTextDocument({
				uri: makeUri(mockTargetPath),
				getText: vi.fn().mockReturnValue("content"),
				isDirty: false,
				save: vi.fn().mockResolvedValue(undefined),
			})
			const document = buffer as unknown as vscode.TextDocument // Structural double: the teardown reads getText, isDirty and save only.
			const documents = vscode.workspace.textDocuments as vscode.TextDocument[]
			documents.length = 0
			documents.push(document)
			// The revert command ran and the buffer came back dirty: the double answers with the verdict
			// revertDocument reads off isDirty, and the fixture keeps isDirty true so the two agree.
			diffViewProvider["revertDocument"] = vi.fn().mockResolvedValue(false)
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
			const reopen = vi.mocked(vscode.workspace.openTextDocument)
			reopen.mockClear()
			reopen.mockResolvedValue(document)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "create"
			diffViewProvider["originalContent"] = ""
			diffViewProvider["newContent"] = "content"
			diffViewProvider.isEditing = true
			diffViewProvider["activeDiffEditor"] = makeTextEditor({ document })

			await diffViewProvider.saveChanges(false)
			expect(diffViewProvider["committedPublish"]?.content).toBe("content")
			// The save met a clean buffer; the cancellation meets the published bytes in a dirty one, which
			// is the state this branch is entered with.
			buffer.isDirty = true
			vi.mocked(fs.unlink).mockClear()

			const failure = await diffViewProvider.revertChanges().catch((error: unknown) => error)
			expect(failure).toBeInstanceOf(CommittedWriteBufferConflictError)
			// The detail names the state this teardown ended in; the guidance stays the shared one.
			expect((failure as Error).message).toContain("could not be cleared")
			expect((failure as Error).message).toContain("do not retry")
			// The reconciliation ran: the buffer was closed and reopened from the published bytes
			// before the teardown decided what to report.
			expect(reopen).toHaveBeenCalledTimes(1)
			expect(diffViewProvider["closeFileTab"]).toHaveBeenCalled()
			// The published file survives the cancellation, and the session still finalizes.
			expect(fs.unlink).not.toHaveBeenCalledWith(mockTargetPath)
			expect(diffViewProvider.isEditing).toBe(false)
			documents.length = 0
		})

		// The other answer the verdict can produce. The reopen came back clean, so the buffer is no
		// longer live over the published bytes and the only thing left to say is what the cancellation
		// always means after a commit: the content is on disk and the edit must not be reapplied.
		it("revertChanges() after a committed create reports the late cancellation when the reopen came back clean", async () => {
			// A structural double: the buffer holds exactly the bytes the guard published, and the rows
			// below make it dirty the way the state they describe does. The factory's object carries a
			// mutable isDirty; the interface declares it read-only, so the double is held under the one
			// property the rows write and cast to the interface once, at the boundary.
			const buffer: { isDirty: boolean } = makeTextDocument({
				uri: makeUri(mockTargetPath),
				getText: vi.fn().mockReturnValue("content"),
				isDirty: false,
				save: vi.fn().mockResolvedValue(undefined),
			})
			const document = buffer as unknown as vscode.TextDocument // Structural double: the teardown reads getText, isDirty and save only.
			const documents = vscode.workspace.textDocuments as vscode.TextDocument[]
			documents.length = 0
			documents.push(document)
			diffViewProvider["revertDocument"] = vi.fn().mockResolvedValue(false)
			// Closing the tab discards the buffer, so the reopened document is the file's own clean
			// buffer. This is the case the reconciliation exists to produce.
			const closeFileTab = vi.fn().mockImplementation(async () => {
				buffer.isDirty = false
			})
			diffViewProvider["closeFileTab"] = closeFileTab
			diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
			const reopen = vi.mocked(vscode.workspace.openTextDocument)
			reopen.mockClear()
			reopen.mockResolvedValue(document)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "create"
			diffViewProvider["originalContent"] = ""
			diffViewProvider["newContent"] = "content"
			diffViewProvider.isEditing = true
			diffViewProvider["activeDiffEditor"] = makeTextEditor({ document })

			await diffViewProvider.saveChanges(false)
			expect(diffViewProvider["committedPublish"]?.content).toBe("content")
			// The save met a clean buffer; the cancellation meets the published bytes in a dirty one.
			buffer.isDirty = true

			const failure = await diffViewProvider.revertChanges().catch((error: unknown) => error)
			expect(failure).toBeInstanceOf(CommittedWriteBufferConflictError)
			expect((failure as Error).message).toContain(
				"a cancellation arrived after the guarded publish had committed",
			)
			expect((failure as Error).message).not.toContain("could not be cleared")
			expect(reopen).toHaveBeenCalledTimes(1)
			documents.length = 0
		})

		// And the case where the verdict says the buffer is already clear. The second chance is a
		// response to a refusal, not a step every cancellation takes: nothing was closed and reopened
		// here, and the report is the ordinary one.
		it("revertChanges() does not reopen the buffer the revert already cleared", async () => {
			// A structural double: the buffer holds exactly the bytes the guard published, and the rows
			// below make it dirty the way the state they describe does. The factory's object carries a
			// mutable isDirty; the interface declares it read-only, so the double is held under the one
			// property the rows write and cast to the interface once, at the boundary.
			const buffer: { isDirty: boolean } = makeTextDocument({
				uri: makeUri(mockTargetPath),
				getText: vi.fn().mockReturnValue("content"),
				isDirty: false,
				save: vi.fn().mockResolvedValue(undefined),
			})
			const document = buffer as unknown as vscode.TextDocument // Structural double: the teardown reads getText, isDirty and save only.
			const documents = vscode.workspace.textDocuments as vscode.TextDocument[]
			documents.length = 0
			documents.push(document)
			// The revert succeeded, which in revertDocument's terms means the buffer is no longer dirty.
			diffViewProvider["revertDocument"] = vi.fn().mockImplementation(async () => {
				buffer.isDirty = false
				return true
			})
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
			const reopen = vi.mocked(vscode.workspace.openTextDocument)
			reopen.mockClear()
			reopen.mockResolvedValue(document)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "create"
			diffViewProvider["originalContent"] = ""
			diffViewProvider["newContent"] = "content"
			diffViewProvider.isEditing = true
			diffViewProvider["activeDiffEditor"] = makeTextEditor({ document })

			await diffViewProvider.saveChanges(false)
			expect(diffViewProvider["committedPublish"]?.content).toBe("content")
			// The save met a clean buffer; the cancellation meets the published bytes in a dirty one.
			buffer.isDirty = true

			const failure = await diffViewProvider.revertChanges().catch((error: unknown) => error)
			expect(failure).toBeInstanceOf(CommittedWriteBufferConflictError)
			expect(reopen).not.toHaveBeenCalled()
			expect((failure as Error).message).toContain(
				"a cancellation arrived after the guarded publish had committed",
			)
			expect((failure as Error).message).not.toContain("could not be cleared")
			documents.length = 0
		})

		// The second chance failing on its own. This is a VS Code call inside a teardown whose whole
		// job is to leave the session finalized, so a refusal here must not abort the pass. The flag is
		// set before the attempt rather than only after it: a second chance that could not run left the
		// buffer uncleared just as surely as one that ran and came back dirty.
		it("revertChanges() reports the buffer it could not clear when the reopen itself is refused", async () => {
			const buffer: { isDirty: boolean } = makeTextDocument({
				uri: makeUri(mockTargetPath),
				getText: vi.fn().mockReturnValue("content"),
				isDirty: false,
				save: vi.fn().mockResolvedValue(undefined),
			})
			const document = buffer as unknown as vscode.TextDocument // Structural double: the teardown reads getText, isDirty and save only.
			const documents = vscode.workspace.textDocuments as vscode.TextDocument[]
			documents.length = 0
			documents.push(document)
			diffViewProvider["revertDocument"] = vi.fn().mockResolvedValue(false)
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = closeFileTab
			const restorePreviewTabs = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = restorePreviewTabs
			const reopen = vi.mocked(vscode.workspace.openTextDocument)
			reopen.mockClear()
			// Once, so the module double's own default is what the rest of the file keeps getting.
			reopen.mockRejectedValueOnce(
				Object.assign(new Error("EACCES: permission denied, open 'mock-target-file.ts'"), { code: "EACCES" }),
			)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "create"
			diffViewProvider["originalContent"] = ""
			diffViewProvider["newContent"] = "content"
			diffViewProvider.isEditing = true
			diffViewProvider["activeDiffEditor"] = makeTextEditor({ document })

			await diffViewProvider.saveChanges(false)
			expect(diffViewProvider["committedPublish"]?.content).toBe("content")
			// The save met a clean buffer; the cancellation meets the published bytes in a dirty one.
			buffer.isDirty = true
			// saveChanges ran its own teardown on the way in, so the counts below are taken from the
			// point the cancellation pass starts at.
			closeFileTab.mockClear()
			restorePreviewTabs.mockClear()
			reopen.mockClear()

			const failure = await diffViewProvider.revertChanges().catch((error: unknown) => error)
			// The report is the committed-write conflict, not the reopen's refusal: the pass survived its
			// own reconciliation and still told the caller what it knows.
			expect(failure).toBeInstanceOf(CommittedWriteBufferConflictError)
			expect((failure as Error).message).toContain("could not be cleared")
			expect((failure as Error).message).not.toContain("EACCES")
			expect(reopen).toHaveBeenCalledTimes(1)
			expect(closeFileTab).toHaveBeenCalled()
			// The tab work and the finalization still ran rather than being abandoned mid-pass.
			expect(restorePreviewTabs).toHaveBeenCalledTimes(1)
			expect(diffViewProvider.isEditing).toBe(false)
			documents.length = 0
		})

		// The same gap on the other teardown owner: a rejected publish's discard cleanup never resets
		// (the tool caller's error handling owns that), so a cancellation that only waited for it left
		// the session mid-edit with nobody finalizing it.
		it("a cancellation that waits for a rejected save's discard cleanup still finalizes the session", async () => {
			let release: () => void = () => {}
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			let cleanupEntered = false
			const closeOwnDiffView = vi.fn().mockImplementation(async () => {
				cleanupEntered = true
				await gate
			})
			diffViewProvider["closeOwnDiffView"] = closeOwnDiffView
			diffViewProvider["closeAllDiffViews"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
			const applyEdit = vi.mocked(vscode.workspace.applyEdit)
			applyEdit.mockResolvedValue(true)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["newContent"] = "content"
			diffViewProvider.isEditing = true
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				}),
			})

			// Restore the publish mock afterwards: a queued rejection would fail every later save.
			vi.mocked(safeWriteText).mockRejectedValue(new Error("guard rejected for test"))
			type SaveResult = Awaited<ReturnType<DiffViewProvider["saveChanges"]>>
			let settled: PromiseSettledResult<unknown>[] | undefined
			try {
				const save: Promise<SaveResult> = diffViewProvider.saveChanges(false)
				while (!cleanupEntered) {
					await new Promise((resolve) => setImmediate(resolve))
				}
				const revert = diffViewProvider.revertChanges()
				await new Promise((resolve) => setImmediate(resolve))
				release()
				settled = await Promise.allSettled([save, revert])
			} finally {
				vi.mocked(safeWriteText).mockReset()
				vi.mocked(safeWriteText).mockResolvedValue(undefined)
			}

			// The guard verdict still surfaces...
			expect(settled?.[0].status).toBe("rejected")
			// ...and the session that cancellation was waiting on is finalized.
			expect(diffViewProvider.isEditing).toBe(false)
			expect(diffViewProvider["activeDiffEditor"]).toBeUndefined()
			// The waiting cancellation did not repeat the document revert.
			expect(applyEdit).not.toHaveBeenCalled()
		})

		// A rejected publish closes its own diff view and rethrows, so the preview tabs the diff
		// evicted are restored by that pass - and only by that pass.
		it("saveChanges() restores preview tabs when a rejected publish tears the session down", async () => {
			const restorePreviewTabs = vi.fn().mockResolvedValue(undefined)
			const closeOwnDiffView = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = restorePreviewTabs
			diffViewProvider["closeOwnDiffView"] = closeOwnDiffView
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["newContent"] = "content"
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				}),
			})

			// The publish is rejected, so the discard-only cleanup runs and the guard verdict is
			// rethrown. Restore the publish mock afterwards: a queued rejection would fail every
			// later save in this file.
			vi.mocked(safeWriteText).mockRejectedValue(new Error("guard rejected for test"))
			try {
				await expect(diffViewProvider.saveChanges(false)).rejects.toThrow("guard rejected for test")
			} finally {
				vi.mocked(safeWriteText).mockReset()
				vi.mocked(safeWriteText).mockResolvedValue(undefined)
			}

			expect(closeOwnDiffView).toHaveBeenCalledTimes(1)
			expect(restorePreviewTabs).toHaveBeenCalledTimes(1)
		})

		// The rejected save's discard cleanup restores the tabs once, and it never resets - the
		// tool caller's error handling owns that reset. A cancellation that only waited for that
		// pass still has to leave the session closed, so it performs the finalization.
		it("saveChanges() restores preview tabs once and the waiting revert finalizes the session it left open", async () => {
			let release: () => void = () => {}
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			let cleanupEntered = false
			const closeOwnDiffView = vi.fn().mockImplementation(async () => {
				cleanupEntered = true
				await gate
			})
			const restorePreviewTabs = vi.fn().mockResolvedValue(undefined)
			const reset = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeOwnDiffView"] = closeOwnDiffView
			diffViewProvider["restorePreviewTabs"] = restorePreviewTabs
			diffViewProvider["reset"] = reset
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			const applyEdit = vi.mocked(vscode.workspace.applyEdit)
			applyEdit.mockResolvedValue(true)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["newContent"] = "content"
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				}),
			})

			vi.mocked(safeWriteText).mockRejectedValue(new Error("guard rejected for test"))
			let save: Promise<unknown> = Promise.resolve()
			try {
				save = diffViewProvider.saveChanges(false)
				while (!cleanupEntered) {
					await new Promise((resolve) => setImmediate(resolve))
				}
				// The revert joins the rejected save's pass instead of starting its own.
				const revert = diffViewProvider.revertChanges()
				await new Promise((resolve) => setImmediate(resolve))
				release()
				await expect(save).rejects.toThrow("guard rejected for test")
				await revert
			} finally {
				vi.mocked(safeWriteText).mockReset()
				vi.mocked(safeWriteText).mockResolvedValue(undefined)
			}

			expect(restorePreviewTabs).toHaveBeenCalledTimes(1)
			expect(reset).toHaveBeenCalledTimes(1)
		})

		it("revertChanges() finalizes the session once when two cancellations wait on the same pass", async () => {
			let release: () => void = () => {}
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			let cleanupEntered = false
			const closeOwnDiffView = vi.fn().mockImplementation(async () => {
				cleanupEntered = true
				await gate
			})
			const restorePreviewTabs = vi.fn().mockResolvedValue(undefined)
			const reset = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeOwnDiffView"] = closeOwnDiffView
			diffViewProvider["restorePreviewTabs"] = restorePreviewTabs
			diffViewProvider["reset"] = reset
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["newContent"] = "content"
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				}),
			})

			vi.mocked(safeWriteText).mockRejectedValue(new Error("guard rejected for test"))
			let save: Promise<unknown> = Promise.resolve()
			try {
				save = diffViewProvider.saveChanges(false)
				while (!cleanupEntered) {
					await new Promise((resolve) => setImmediate(resolve))
				}
				// Two cancellations - a tool caller and a disposal, say - both join the pass that is
				// already running. Neither owns it, and the owning pass never finalizes the session,
				// so exactly one of them may close it.
				const first = diffViewProvider.revertChanges()
				const second = diffViewProvider.revertChanges()
				await new Promise((resolve) => setImmediate(resolve))
				release()
				await expect(save).rejects.toThrow("guard rejected for test")
				await Promise.all([first, second])
			} finally {
				vi.mocked(safeWriteText).mockReset()
				vi.mocked(safeWriteText).mockResolvedValue(undefined)
			}

			expect(restorePreviewTabs).toHaveBeenCalledTimes(1)
			expect(reset).toHaveBeenCalledTimes(1)
		})

		it("revertChanges() does not finalize a session a second time after the first cancellation closed it", async () => {
			const restorePreviewTabs = vi.fn().mockResolvedValue(undefined)
			const reset = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeOwnDiffView"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = restorePreviewTabs
			diffViewProvider["reset"] = reset
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				}),
			})

			// Two cancellations one after the other: the first owns its pass and closes the session,
			// the second starts a pass of its own and must still not close the session a second time.
			await diffViewProvider.revertChanges()
			await diffViewProvider.revertChanges()

			expect(restorePreviewTabs).toHaveBeenCalledTimes(2)
			expect(reset).toHaveBeenCalledTimes(1)
		})

		it("revertChanges() does not finalize a session that a direct reset already closed", async () => {
			const realReset = diffViewProvider["reset"].bind(diffViewProvider)
			let resetCalls = 0
			diffViewProvider["reset"] = async () => {
				resetCalls++
				await realReset()
			}
			diffViewProvider["closeOwnDiffView"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				}),
			})

			// A reset outside the teardown paths closes the session for everyone, so the claim has to
			// come from the reset itself and not only from the caller that went through the helper.
			await diffViewProvider["reset"]()
			await diffViewProvider.revertChanges()

			expect(resetCalls).toBe(1)
		})

		// The other direction: the rejected save is the one that joins an existing pass. It then
		// runs no cleanup of its own, and the pass that started the teardown restores the tabs once.
		it("saveChanges() restores no preview tabs when a revert already owns the teardown", async () => {
			let release: () => void = () => {}
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			const { closedTabs } = installDiffTabSpy(mockTargetPath, gate)
			const restorePreviewTabs = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = restorePreviewTabs
			// reset() also closes this provider's diff tab; stub it so the close spy counts
			// only the pass under test.
			diffViewProvider["reset"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			const applyEdit = vi.mocked(vscode.workspace.applyEdit)
			applyEdit.mockResolvedValue(true)
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["newContent"] = "content"
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				}),
			})

			// The revert starts its pass first and is held inside it.
			const revert = diffViewProvider.revertChanges()
			while (closedTabs.length === 0) {
				await new Promise((resolve) => setImmediate(resolve))
			}

			vi.mocked(safeWriteText).mockRejectedValue(new Error("guard rejected for test"))
			let save: Promise<unknown> = Promise.resolve()
			try {
				save = diffViewProvider.saveChanges(false)
				await new Promise((resolve) => setImmediate(resolve))
				release()
				await expect(save).rejects.toThrow("guard rejected for test")
				await revert
			} finally {
				vi.mocked(safeWriteText).mockReset()
				vi.mocked(safeWriteText).mockResolvedValue(undefined)
			}

			// The save's cleanup never ran, so it restored nothing; the owning revert pass did the
			// restoring exactly once.
			// The rejected save ran no cleanup of its own: the only tab close in the whole
			// exchange is the owning revert pass's own view going away.
			expect(closedTabs).toHaveLength(1)
			expect(restorePreviewTabs).toHaveBeenCalledTimes(1)
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
		// A cancellation that joins a teardown waits behind a pass it does not own. When that
		// pass's cleanup throws, the buffer can still be dirty and this provider's tab still
		// open, so the waiter has to hear about the failure instead of resuming as though the
		// session had been tidied - and it must not close a session it never tidied.
		it("revertChanges() carries a failed cleanup to the caller that joined the pass", async () => {
			const applyEdit = vi.mocked(vscode.workspace.applyEdit)
			applyEdit.mockResolvedValue(true)
			diffViewProvider["closeFileTab"] = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["restorePreviewTabs"] = vi.fn().mockResolvedValue(undefined)
			const cleanupFailure = new Error("tab close rejected mid-teardown")
			// The owning pass fails partway through its cleanup: the tab is still open and the
			// document still holds the edit when the pass ends.
			diffViewProvider["closeOwnDiffView"] = vi.fn().mockRejectedValue(cleanupFailure)
			const reset = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["reset"] = reset
			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["editType"] = "modify"
			diffViewProvider["originalContent"] = "original"
			diffViewProvider["activeDiffEditor"] = makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				}),
			})

			const owner = diffViewProvider.revertChanges()
			const joiner = diffViewProvider.revertChanges()

			await expect(owner).rejects.toThrow("tab close rejected mid-teardown")
			// The gate carries the pass's outcome, so the waiter receives the same failure the
			// owner received instead of a clean resume.
			await expect(joiner).rejects.toThrow(cleanupFailure)
			// Resetting here would clear the state of a session that is still mid-edit: the pass
			// that owns the session has to answer for it, which it does through its own caller.
			expect(reset).not.toHaveBeenCalled()
			expect(diffViewProvider["sessionFinalizationClaimed"]).toBe(false)
		})

		// A cancellation that arrives while the teardown is still running has to join that run, not
		// read the claim the teardown itself made and walk away: reset() sets
		// sessionFinalizationClaimed in its synchronous prefix, and finalizeSession calls the
		// callback before it stores the promise, so there is a window where the claim is set and the
		// run is not yet awaited. The joiner below is released inside that window.
		it("finalizeSession makes a caller that joins a running teardown wait for it", async () => {
			const events: string[] = []
			let releaseTeardown: () => void = () => {}
			const teardownHeld = new Promise<void>((resolve) => {
				releaseTeardown = resolve
			})
			const owner = diffViewProvider["finalizeSession"](async () => {
				// reset() claims the session before its first await; this callback does the same so
				// the test exercises the window the finding names rather than a hypothetical one.
				diffViewProvider["sessionFinalizationClaimed"] = true
				events.push("teardown-start")
				await teardownHeld
				events.push("teardown-end")
			})
			const joiner = diffViewProvider["finalizeSession"](async () => {
				events.push("joiner-ran-its-own-teardown")
			}).then(() => {
				events.push("joiner-resolved")
			})
			releaseTeardown()
			await Promise.all([owner, joiner])
			expect(events).toEqual(["teardown-start", "teardown-end", "joiner-resolved"])
			expect(diffViewProvider["sessionFinalizationClaimed"]).toBe(true)
		})

		// The finding's own interleaving, run through the real reset() rather than a stand-in callback:
		// reset() sets sessionFinalizationClaimed in its synchronous prefix and then awaits the tab
		// closure (closeOwnDiffView below). A second caller that arrives inside that window has to wait
		// for the closure the first caller started, and it must not run a second tab close of its own.
		it("keeps a caller that joined the claim window waiting for reset's own tab closure", async () => {
			const events: string[] = []
			let releaseTabClose: () => void = () => {}
			const tabCloseHeld = new Promise<void>((resolve) => {
				releaseTabClose = resolve
			})

			diffViewProvider["relPath"] = "mock-target-file.ts"
			diffViewProvider["closeOwnDiffView"] = vi.fn(async () => {
				events.push("tab-close-start")
				await tabCloseHeld
				events.push("tab-close-end")
			})

			const owner = diffViewProvider["finalizeSession"](() => diffViewProvider.reset())
			const joiner = diffViewProvider["finalizeSession"](() => {
				events.push("joiner-ran-reset")
				return diffViewProvider.reset()
			}).then(() => {
				events.push("joiner-resolved")
			})

			releaseTabClose()
			await Promise.all([owner, joiner])

			expect(events).toEqual(["tab-close-start", "tab-close-end", "joiner-resolved"])
			expect(diffViewProvider["closeOwnDiffView"]).toHaveBeenCalledTimes(1)
			expect(diffViewProvider["sessionFinalizationClaimed"]).toBe(true)
		})
	})

	describe("userTouchedDiffEditor keep/close behavior", () => {
		beforeEach(() => {
			// The guarded publish these rows run through looks the target up in the task's
			// observation registry before writing it, so the fixture has to record the read and
			// the version token the guard recomputes. These rows are about the decisions around
			// the publish - tabs, focus, scroll, finalization - not about the guard refusing it.
			mockTask.observationRegistry.observe(`${mockCwd}/mock-target-file.ts`, "v1")
			mockTask.observationRegistry.observe(`${mockCwd}/test.txt`, "v1")
			vi.mocked(computeVersionToken).mockResolvedValue("v1")
		})

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
			const task = {
				...makeTaskDouble(stateOverrides),
				cwd: mockCwd,
				// S4b follow-up (#44): saveChanges publishes through the guarded write,
				// which resolves the path against task.cwd and consults the task's
				// observation registry - both must be present on this suite's mock task.
				observationRegistry: new ObservationRegistry(),
			} as unknown as Task // the double is partial; cast matches makeTaskDouble's own
			const provider = new DiffViewProvider(mockCwd, task)
			// The preview observation + matching version token let the guarded save
			// proceed so these tests stay focused on the auto-close decision table.
			task.observationRegistry.observe(`${mockTargetPath}`, "v1")
			vi.mocked(computeVersionToken).mockResolvedValue("v1")
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
