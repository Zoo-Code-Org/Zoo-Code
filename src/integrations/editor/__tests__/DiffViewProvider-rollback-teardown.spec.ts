// The rollback and teardown tests below are the #1931 unit's own tests, kept out of
// DiffViewProvider.spec.ts so that file carries only main's tests plus this unit's edits to them.
// They were children of describe("DiffViewProvider") inside describe("userTouchedDocument
// close/keep behavior") before and stay in that nesting here, so every full test name is
// unchanged. The prelude below is a copy of that spec's module setup and describe-level doubles,
// pruned to what these tests use. No suppression and no Stryker directive appears in this file.

import * as fs from "fs/promises"
import { DiffViewProvider, DIFF_VIEW_URI_SCHEME } from "../DiffViewProvider"
import * as vscode from "vscode"
import { makePosition, makeTextDocument, makeTextEditor, makeUri } from "../../../test-utils/vscode"
import { DecorationController } from "../DecorationController"
import type { Task } from "../../../core/task/Task"
import type { Mock } from "vitest"

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
	// directories the edit created. stat lets the editorless rollback check the placeholder
	// is still empty before unlinking it (default: an empty placeholder).
	stat: vi.fn().mockResolvedValue({ size: 0 }),
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
	const makeDiffTabInput = (originalScheme: string, modifiedFsPath: string): vscode.TabInputTextDiff =>
		Object.assign(new vscode.TabInputTextDiff(makeUri(modifiedFsPath), makeUri(modifiedFsPath)), {
			original: { scheme: originalScheme },
			modified: makeUri(modifiedFsPath),
		})

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

	describe("userTouchedDocument close/keep behavior", () => {
		const mockTargetPath = `${mockCwd}/mock-target-file.ts`

		// Both the approved save (saveChanges) and the existing-file rollback (revertChanges) read
		// the save result, so the shared double reports a save that landed; an undefined-
		// resolving double would read as a refused save.
		const buildActiveDiffEditor = (docOverrides: { isDirty?: boolean } = {}) =>
			makeTextEditor({
				document: makeTextDocument({
					uri: makeUri(mockTargetPath),
					getText: vi.fn().mockReturnValue("content"),
					isDirty: docOverrides.isDirty ?? false,
					save: vi.fn().mockResolvedValue(true),
					positionAt: vi.fn().mockReturnValue(makePosition()),
				}),
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

		it("revertChanges() keeps a file another process filled before the editorless rollback", async () => {
			// open() failed before the diff editor existed, but another process wrote the path
			// after the empty placeholder landed. An inode check cannot catch an in-place write,
			// so the rollback inspects the size and must leave non-empty content alone.
			const createdDirs = [`${mockCwd}/new-parent`]
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs,
			})
			vi.mocked(fs.stat).mockResolvedValueOnce({ size: 12 } as Awaited<ReturnType<typeof fs.stat>>)

			await diffViewProvider.revertChanges()

			expect(fs.unlink).not.toHaveBeenCalledWith(`${mockCwd}/mock-target-file.ts`)
			expect(fs.rmdir).toHaveBeenCalledWith(createdDirs[0])
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

			await expect(diffViewProvider.revertChanges()).resolves.toBeUndefined()

			// The rollback still attempted the delete - the tolerance is about not
			// aborting the rest of the cleanup, not about skipping it.
			expect(fs.unlink).toHaveBeenCalledWith(`${mockCwd}/mock-target-file.ts`)
		})

		it("revertChanges() stands down after saveChanges() recorded the commit", async () => {
			// The commit point is recorded on the provider, not only in the tool's local flag:
			// an abort-driven teardown that reaches revertChanges() after the diagnostics delay
			// must not restore the old content over the approved write or unlink a new file.
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs: [],
				writeCommitted: true,
			})

			await diffViewProvider.revertChanges()

			expect(fs.unlink).not.toHaveBeenCalled()
			expect(vscode.workspace.applyEdit).not.toHaveBeenCalled()
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

			await expect(diffViewProvider.revertChanges()).resolves.toBeUndefined()

			expect(vscode.workspace.applyEdit).not.toHaveBeenCalled()
			expect(fs.unlink).not.toHaveBeenCalled()
			expect(fs.rmdir).not.toHaveBeenCalled()
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

			await expect(diffViewProvider.revertChanges()).resolves.toBeUndefined()

			expect(fs.rmdir).toHaveBeenCalledTimes(2)
			expect(fs.rmdir).toHaveBeenNthCalledWith(1, createdDirs[1])
			expect(fs.rmdir).toHaveBeenNthCalledWith(2, createdDirs[0])
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

			await diffViewProvider.revertChanges()

			expect(fs.unlink).not.toHaveBeenCalled()
			expect(fs.rmdir).not.toHaveBeenCalled()
		})

		it("reset() clears relPath so a later teardown cannot reuse a stale target", async () => {
			Object.assign(diffViewProvider, { isEditing: true, relPath: "mock-target-file.ts" })

			await diffViewProvider.reset()

			expect(diffViewProvider["relPath"]).toBeUndefined()
		})

		it("reset() drops adopted directories so a later transaction cannot remove a previous one's", async () => {
			// Adoption is per transaction: a stale list would make the next rollback rmdir
			// directories belonging to a file the user has since accepted.
			diffViewProvider.adoptCreatedDirs([`${mockCwd}/new-parent`])

			await diffViewProvider.reset()

			expect(diffViewProvider["adoptedCreatedDirs"]).toEqual([])
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
			// The revert path reaches the close only if the workspace edit applies. In
			// DiffViewProvider.spec.ts that default came from an earlier test in the file; here the
			// module mock is untouched, so this test sets it itself rather than inheriting it.
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)

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

		it("revertChanges() fails the rollback when the pre-stream restore edit is not applied", async () => {
			// applyEdit() resolves false when the workspace refuses the edit. Dropping that boolean let
			// the rollback save and close a buffer that still held the unapproved streamed content, and
			// report success for a restore that never happened.
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
			const close = vi.fn().mockResolvedValue(true)
			Object.defineProperty(vscode.window.tabGroups, "close", {
				value: close,
				configurable: true,
			})
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(false)
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "create",
				createdDirs: [],
				originalContent: "",
			})

			try {
				await expect(diffViewProvider.revertChanges()).rejects.toThrow(
					"could not restore the pre-stream buffer",
				)
				// The buffer never came back, so nothing may be saved, closed, or deleted on the
				// assumption that it did. Counts, not call shapes: save, close, and unlink each have
				// exactly one legitimate caller on this path, and all of them sit behind the restore.
				expect(editor.document.save).toHaveBeenCalledTimes(0)
				expect(close).toHaveBeenCalledTimes(0)
				expect(fs.unlink).toHaveBeenCalledTimes(0)
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

		it("revertChanges() keeps the workspace rejection as the cause of a failed restore", async () => {
			// A restore that fails because the workspace rejected the edit keeps its reason: the
			// rollback error carries the rejection as its cause, the shape the refused close uses.
			const editor = buildActiveDiffEditor({ isDirty: true })
			const rejection = new Error("edit rejected by the workspace")
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
			const close = vi.fn().mockResolvedValue(true)
			Object.defineProperty(vscode.window.tabGroups, "close", {
				value: close,
				configurable: true,
			})
			vi.mocked(vscode.workspace.applyEdit).mockRejectedValue(rejection)
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: editor,
				editType: "create",
				createdDirs: [],
				originalContent: "",
			})

			let restoreFailure: unknown
			try {
				await diffViewProvider.revertChanges()
			} catch (error) {
				restoreFailure = error
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

			expect(restoreFailure).toBeInstanceOf(Error)
			if (restoreFailure instanceof Error) {
				expect(restoreFailure.message).toContain("could not restore the pre-stream buffer")
				expect(restoreFailure.cause).toBe(rejection)
			}
			expect(editor.document.save).toHaveBeenCalledTimes(0)
			expect(close).toHaveBeenCalledTimes(0)
			expect(fs.unlink).toHaveBeenCalledTimes(0)
		})

		it("revertChanges() restores, saves and closes when the restore edit is applied", async () => {
			// Guard for the fix itself: an applied edit keeps the restore-save-close-delete flow
			// exactly as it was; only a refused edit changes behaviour.
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
			const close = vi.fn().mockResolvedValue(true)
			Object.defineProperty(vscode.window.tabGroups, "close", {
				value: close,
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
				await expect(diffViewProvider.revertChanges()).resolves.toBeUndefined()
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

			// The restore edit carried the pre-stream content, and the full flow ran exactly once.
			expect(mockWorkspaceEdit.replace).toHaveBeenCalledTimes(1)
			expect(mockWorkspaceEdit.replace.mock.calls[0]?.[2]).toBe("pre-stream content")
			// The replacement text alone does not say where the text went: a restore aimed at another
			// document, or at only part of this one, passes on content alone. The uri is the target
			// the rollback located through textDocuments, and the extent is whatever positionAt
			// answered with 0 and the full text length - the two offsets the impl hands to Range -
			// so both halves of the claim are asserted through members the doubles actually carry.
			expect((mockWorkspaceEdit.replace.mock.calls[0]?.[0] as { fsPath?: string }).fsPath).toBe(mockTargetPath)
			expect(editor.document.positionAt).toHaveBeenCalledWith(0)
			expect(editor.document.positionAt).toHaveBeenLastCalledWith(editor.document.getText().length)
			expect(editor.document.save).toHaveBeenCalledTimes(1)
			expect(close).toHaveBeenCalledTimes(1)
			expect(fs.unlink).toHaveBeenCalledTimes(1)
		})

		it("revertChanges() reports a restored-buffer save that did not land instead of closing the dirty tab", async () => {
			// Ordering, not severity: close() has no force-discard parameter, so a tab that is still
			// dirty goes to the editor, which prompts or refuses. The teardown used to run the save,
			// drop its boolean, attempt the close anyway, and then either report nothing (a close that
			// went through despite the dirty buffer) or report a close failure for what was a failed
			// save. The order is now save result first, report on false, close only after a save that
			// landed - so the tab is left open on restored-but-unsaved content and the created file is
			// never unlinked underneath it. Red on the previous shape: the close ran and no failure was
			// reported at all.
			const editor = buildActiveDiffEditor({ isDirty: true })
			editor.document.save = vi.fn().mockResolvedValue(false)
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
			const close = vi.fn().mockResolvedValue(true)
			Object.defineProperty(vscode.window.tabGroups, "close", {
				value: close,
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
				const failure = await diffViewProvider.revertChanges().then(
					() => undefined,
					(error: unknown): Error => (error instanceof Error ? error : new Error(String(error))),
				)
				// Only this attempt is described: the message says where the rollback stopped and makes
				// no promise about the buffer or the tab afterwards, because a later retry may close it.
				expect(failure?.message).toContain("could not save the restored buffer")
				expect(failure?.message).toContain("this attempt stopped before closing the tab")
				expect(failure?.message).not.toMatch(/still dirty|left open/)
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

			// The restore landed first, so the failure being reported is the save and not the edit; the
			// save was asked once; and nothing that follows a successful save ran.
			expect(mockWorkspaceEdit.replace).toHaveBeenCalledTimes(1)
			expect(editor.document.save).toHaveBeenCalledTimes(1)
			expect(close).not.toHaveBeenCalled()
			expect(fs.unlink).not.toHaveBeenCalled()
		})

		it("revertChanges() leaves a retained file and surfaces the occupied directory it cannot remove", async () => {
			// The geometry the rollback is actually in: a non-empty file inside a directory this edit
			// created. The retained file must survive, and the directory cannot go - a real rmdir on
			// a non-empty directory fails with ENOTEMPTY, which removeCreatedDir tolerates only for
			// ENOENT. Asserting the rejection is what stops the rollback from reporting a completed
			// cleanup while a directory the user can still see is left behind.
			//
			// Honest about what this fixture can and cannot show: the rmdir rejection below is scripted
			// once, so it rejects whatever the contents are and does not derive the failure from
			// occupancy. The geometry - the retained file living inside the directory the rollback is
			// removing - is therefore the only part of the case that carries the occupancy claim, and
			// it is asserted below rather than left to the comment. A stateful filesystem double that
			// rejects rmdir only for a non-empty directory is the fuller version of this test.
			const occupiedDir = `${mockCwd}/new-parent/nested`
			const retainedFile = `${occupiedDir}/mock-target-file.ts`
			const createdDirs = [`${mockCwd}/new-parent`, occupiedDir]
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "new-parent/nested/mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs,
			})
			vi.mocked(fs.stat).mockResolvedValueOnce({ size: 12 } as Awaited<ReturnType<typeof fs.stat>>)
			vi.mocked(fs.rmdir).mockRejectedValueOnce(
				Object.assign(new Error("ENOTEMPTY: directory not empty, rmdir"), { code: "ENOTEMPTY" }),
			)

			await expect(diffViewProvider.revertChanges()).rejects.toThrow("ENOTEMPTY")

			expect(fs.unlink).not.toHaveBeenCalledWith(retainedFile)
			expect(fs.rmdir).toHaveBeenCalledTimes(1)
			expect(fs.rmdir).toHaveBeenCalledWith(createdDirs[1])
			// The occupancy the case claims: the directory rmdir was asked to remove is the directory
			// the retained file is in. Without this the two fixture halves could name unrelated paths
			// and the case would still pass on the scripted rejection.
			expect(createdDirs.at(-1)).toBe(retainedFile.slice(0, retainedFile.lastIndexOf("/")))
		})

		it("revertChanges() skips the unlink when stat cannot answer about the placeholder", async () => {
			// stat is the only evidence the editorless rollback has that the path is still the empty
			// placeholder this edit created. A stat that cannot answer is read as do-not-delete, and
			// the directory cleanup this edit owns still runs.
			const createdDirs = [`${mockCwd}/new-parent`]
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				activeDiffEditor: undefined,
				editType: "create",
				createdDirs,
			})
			vi.mocked(fs.stat).mockRejectedValueOnce(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)

			await expect(diffViewProvider.revertChanges()).resolves.toBeUndefined()

			expect(fs.stat).toHaveBeenCalledWith(`${mockCwd}/mock-target-file.ts`)
			expect(fs.unlink).not.toHaveBeenCalledWith(`${mockCwd}/mock-target-file.ts`)
			expect(fs.rmdir).toHaveBeenCalledWith(createdDirs[0])
		})

		it("revertChanges() restores and closes a dirty diff tab before unlinking the created file", async () => {
			// The shape the text-only filter used to miss: the plain tab is gone and only the
			// composite diff tab is left, holding the unapproved streamed content. TabInputTextDiff
			// is not a TabInputText, and closeAllDiffViews() skips dirty tabs, so nothing used to
			// close it and the unlink ran underneath it.
			const editor = buildActiveDiffEditor({ isDirty: true })
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			const originalDocs = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			const closeSpy = vi.spyOn(vscode.window.tabGroups, "close").mockResolvedValue(true)
			const diffTab = {
				input: makeDiffTabInput(DIFF_VIEW_URI_SCHEME, mockTargetPath),
				isDirty: true,
				label: "mock-target-file.ts (Changes)",
			}
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [diffTab] }],
				configurable: true,
			})
			Object.defineProperty(vscode.workspace, "textDocuments", {
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
				originalContent: "",
				writeCommitted: false,
			})
			try {
				await expect(diffViewProvider.revertChanges()).resolves.toBeUndefined()
			} finally {
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
				if (originalDocs) {
					Object.defineProperty(vscode.workspace, "textDocuments", originalDocs)
				}
			}
			expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1)
			expect(editor.document.save).toHaveBeenCalledTimes(1)
			expect(closeSpy).toHaveBeenCalledTimes(1)
			expect(fs.unlink).toHaveBeenCalledTimes(1)
			expect(closeSpy.mock.invocationCallOrder[0]).toBeLessThan(
				(fs.unlink as unknown as Mock).mock.invocationCallOrder[0],
			)
		})

		it("revertChanges() closes every matching target tab in a mixed tab set before unlinking the created file", async () => {
			// The mixed set the single-tab fixtures cannot express: an unrelated dirty tab for another
			// file, the composite diff tab for the target, and a plain tab for the target, interleaved
			// across two groups. A sweep that stopped at the first match would close one of the two
			// target tabs and unlink the file underneath the other, and each single-tab row passes on
			// its own either way.
			const editor = buildActiveDiffEditor({ isDirty: true })
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			const originalDocs = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			// tabGroups.close() is declared to take a tab, a tab group, or a group list. The sweep under
			// test hands it tabs; the collector takes the type close() itself declares, so the recorded
			// objects need no cast before the assertions below name them.
			const closedTargets: (vscode.Tab | vscode.TabGroup | readonly vscode.TabGroup[])[] = []
			const closeSpy = vi.spyOn(vscode.window.tabGroups, "close").mockImplementation(async (target) => {
				closedTargets.push(target)
				return true
			})
			// Both target tabs are dirty, which is what keeps closeAllDiffViews() out of the way: it
			// skips dirty tabs, so the only sweep that can close them is this one.
			const diffTab = {
				input: makeDiffTabInput(DIFF_VIEW_URI_SCHEME, mockTargetPath),
				isDirty: true,
				label: "mock-target-file.ts (Changes)",
			}
			const targetPlainTab = {
				input: Object.assign(new vscode.TabInputText(makeUri(mockTargetPath)), {
					uri: makeUri(mockTargetPath),
				}),
				isDirty: true,
				label: "mock-target-file.ts",
			}
			const unrelatedDirtyTab = {
				input: Object.assign(new vscode.TabInputText(makeUri(`${mockCwd}/unrelated-dirty.ts`)), {
					uri: makeUri(`${mockCwd}/unrelated-dirty.ts`),
				}),
				isDirty: true,
				label: "unrelated-dirty.ts",
			}
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [unrelatedDirtyTab, diffTab] }, { tabs: [targetPlainTab] }],
				configurable: true,
			})
			Object.defineProperty(vscode.workspace, "textDocuments", {
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
				originalContent: "",
				writeCommitted: false,
			})
			try {
				await expect(diffViewProvider.revertChanges()).resolves.toBeUndefined()
			} finally {
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
				if (originalDocs) {
					Object.defineProperty(vscode.workspace, "textDocuments", originalDocs)
				}
			}
			// The complete closed set: both target tabs, in either order, and nothing else.
			expect(closedTargets.length).toBe(2)
			expect(closedTargets).toContainEqual(diffTab)
			expect(closedTargets).toContainEqual(targetPlainTab)
			expect(closedTargets).not.toContainEqual(unrelatedDirtyTab)
			expect(closeSpy).toHaveBeenCalledTimes(2)
			expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(2)
			expect(fs.unlink).toHaveBeenCalledTimes(1)
			expect(fs.unlink).toHaveBeenCalledWith(mockTargetPath)
			// Both closes, not merely one of them, precede the unlink.
			expect(Math.max(...closeSpy.mock.invocationCallOrder)).toBeLessThan(
				(fs.unlink as unknown as Mock).mock.invocationCallOrder[0],
			)
		})

		it("revertChanges() keeps the created file when the dirty diff tab refuses to close", async () => {
			// Fail closed: a refused close means unapproved content is still on screen, so the
			// unlink must not run. Deleting the file under a tab the user has not dismissed loses
			// the content this rollback exists to preserve.
			const editor = buildActiveDiffEditor({ isDirty: true })
			const originalTabs = Object.getOwnPropertyDescriptor(vscode.window.tabGroups, "all")
			const originalDocs = Object.getOwnPropertyDescriptor(vscode.workspace, "textDocuments")
			vi.spyOn(vscode.window.tabGroups, "close").mockResolvedValue(false)
			const diffTab = {
				input: makeDiffTabInput(DIFF_VIEW_URI_SCHEME, mockTargetPath),
				isDirty: true,
				label: "mock-target-file.ts (Changes)",
			}
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [{ tabs: [diffTab] }],
				configurable: true,
			})
			Object.defineProperty(vscode.workspace, "textDocuments", {
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
				originalContent: "",
				writeCommitted: false,
			})
			let failure: unknown
			try {
				await diffViewProvider.revertChanges()
			} catch (error: unknown) {
				failure = error
			} finally {
				if (originalTabs) {
					Object.defineProperty(vscode.window.tabGroups, "all", originalTabs)
				}
				if (originalDocs) {
					Object.defineProperty(vscode.workspace, "textDocuments", originalDocs)
				}
			}
			expect(failure).toBeInstanceOf(Error)
			expect((failure as Error).message).toContain("could not close the restored buffer")
			expect(fs.unlink).not.toHaveBeenCalledWith(mockTargetPath)
		})

		it("revertChanges() fails the existing-file rollback when the revert edit is not applied", async () => {
			// applyEdit() resolves false when the workspace refuses the edit. Dropping that boolean let
			// the rollback save anyway and report a completed rollback for a restore that never
			// happened: the document could still hold the unapproved content, and the caller's
			// failure reporting - the whole point of the revertDiffChangesBeforeReset return value -
			// was skipped. The edit result is validated before the save runs.
			const editor = buildActiveDiffEditor()
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(false)
			const closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeAllDiffViews"] = closeAllDiffViews
			diffViewProvider["closeFileTab"] = closeFileTab
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				editType: "modify",
				originalContent: "original",
				documentWasOpen: false,
				userTouchedDocument: false,
				preEditScrollLine: undefined,
				activeDiffEditor: editor,
			})

			await expect(diffViewProvider.revertChanges()).rejects.toThrow("could not restore the original content")

			// Counts, not call shapes: the save and both close paths each have exactly one legitimate
			// caller on this branch, and all of them sit behind the edit check.
			expect(editor.document.save).toHaveBeenCalledTimes(0)
			expect(closeAllDiffViews).toHaveBeenCalledTimes(0)
			expect(closeFileTab).toHaveBeenCalledTimes(0)
		})

		it("revertChanges() keeps the workspace rejection as the cause of a failed existing-file revert", async () => {
			// A revert that fails because the workspace rejected the edit keeps its reason: the
			// rollback error carries the rejection as its cause, the shape the refused close and the
			// pre-stream restore use.
			const editor = buildActiveDiffEditor()
			const rejection = new Error("edit rejected by the workspace")
			vi.mocked(vscode.workspace.applyEdit).mockRejectedValue(rejection)
			const closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeAllDiffViews"] = closeAllDiffViews
			diffViewProvider["closeFileTab"] = closeFileTab
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				editType: "modify",
				originalContent: "original",
				documentWasOpen: false,
				userTouchedDocument: false,
				preEditScrollLine: undefined,
				activeDiffEditor: editor,
			})

			let revertFailure: unknown
			try {
				await diffViewProvider.revertChanges()
			} catch (error) {
				revertFailure = error
			}

			expect(revertFailure).toBeInstanceOf(Error)
			if (revertFailure instanceof Error) {
				expect(revertFailure.message).toContain("could not restore the original content")
				expect(revertFailure.cause).toBe(rejection)
			}
			expect(editor.document.save).toHaveBeenCalledTimes(0)
			expect(closeAllDiffViews).toHaveBeenCalledTimes(0)
			expect(closeFileTab).toHaveBeenCalledTimes(0)
		})

		it("revertChanges() fails the existing-file rollback when the restored document save reports false", async () => {
			// The double resolves an explicit false, not undefined: a bare await would let a double
			// resolving undefined pass by accident, so the reported-failure contract is pinned with a
			// real false. A refused save means the restored original content never reached disk; the
			// rollback must fail before the close and tab bookkeeping assume it did.
			const editor = buildActiveDiffEditor()
			editor.document.save = vi.fn().mockResolvedValue(false)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			const closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeAllDiffViews"] = closeAllDiffViews
			diffViewProvider["closeFileTab"] = closeFileTab
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				editType: "modify",
				originalContent: "original",
				documentWasOpen: false,
				userTouchedDocument: false,
				preEditScrollLine: undefined,
				activeDiffEditor: editor,
			})

			await expect(diffViewProvider.revertChanges()).rejects.toThrow("could not save the restored document")

			expect(editor.document.save).toHaveBeenCalledTimes(1)
			// Throw before any later bookkeeping: the diff views stay open and the tab decision
			// never runs on a document whose restored content may not be on disk.
			expect(closeAllDiffViews).toHaveBeenCalledTimes(0)
			expect(closeFileTab).toHaveBeenCalledTimes(0)
		})

		it("revertChanges() keeps the save rejection as the cause of a failed existing-file revert", async () => {
			// Same shape as the edit rejection: a save that rejects is a failed rollback, and the
			// rejection is kept as the cause rather than ending up as a reported success.
			const editor = buildActiveDiffEditor()
			const rejection = new Error("save refused by the editor host")
			editor.document.save = vi.fn().mockRejectedValue(rejection)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			const closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeAllDiffViews"] = closeAllDiffViews
			diffViewProvider["closeFileTab"] = closeFileTab
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				editType: "modify",
				originalContent: "original",
				documentWasOpen: false,
				userTouchedDocument: false,
				preEditScrollLine: undefined,
				activeDiffEditor: editor,
			})

			let revertFailure: unknown
			try {
				await diffViewProvider.revertChanges()
			} catch (error) {
				revertFailure = error
			}

			expect(revertFailure).toBeInstanceOf(Error)
			if (revertFailure instanceof Error) {
				expect(revertFailure.message).toContain("could not save the restored document")
				expect(revertFailure.cause).toBe(rejection)
			}
			expect(closeAllDiffViews).toHaveBeenCalledTimes(0)
			expect(closeFileTab).toHaveBeenCalledTimes(0)
		})

		it("revertChanges() reverts, saves and closes when the edit is applied and the save reports true", async () => {
			// Guard for the fix itself: an applied edit plus a save that reports true keeps the
			// revert-save-close flow exactly as it was; only a refused edit or refused save changes
			// behaviour.
			const editor = buildActiveDiffEditor()
			editor.document.save = vi.fn().mockResolvedValue(true)
			vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true)
			const closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			const closeFileTab = vi.fn().mockResolvedValue(undefined)
			diffViewProvider["closeAllDiffViews"] = closeAllDiffViews
			diffViewProvider["closeFileTab"] = closeFileTab
			Object.assign(diffViewProvider, {
				isEditing: true,
				relPath: "mock-target-file.ts",
				editType: "modify",
				originalContent: "original",
				documentWasOpen: false,
				userTouchedDocument: false,
				preEditScrollLine: undefined,
				activeDiffEditor: editor,
			})

			await expect(diffViewProvider.revertChanges()).resolves.toBeUndefined()

			// The revert edit carried the original content back, the save ran once, and the full
			// close and tab flow proceeded exactly as before the fix. closeAllDiffViews also runs
			// inside the trailing reset(), so the success evidence is "at least once, before the
			// tab decision", not an exact count.
			expect(mockWorkspaceEdit.replace).toHaveBeenCalledTimes(1)
			expect(mockWorkspaceEdit.replace.mock.calls[0]?.[2]).toBe("original")
			// Same reasoning as the pre-stream restore above: content is not evidence about the target.
			expect((mockWorkspaceEdit.replace.mock.calls[0]?.[0] as { fsPath?: string }).fsPath).toBe(mockTargetPath)
			expect(editor.document.positionAt).toHaveBeenCalledWith(0)
			expect(editor.document.positionAt).toHaveBeenLastCalledWith(editor.document.getText().length)
			expect(editor.document.save).toHaveBeenCalledTimes(1)
			expect(closeAllDiffViews.mock.calls.length).toBeGreaterThanOrEqual(1)
			expect(closeAllDiffViews.mock.invocationCallOrder[0]).toBeLessThan(closeFileTab.mock.invocationCallOrder[0])
			expect(closeFileTab).toHaveBeenCalledTimes(1)
		})
	})
})
