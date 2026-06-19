import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import * as diff from "diff"
import stripBom from "strip-bom"
import delay from "delay"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@roo-code/types"

import { createDirectoriesForFile } from "../../utils/fs"
import { arePathsEqual, getReadablePath } from "../../utils/path"
import { formatResponse } from "../../core/prompts/responses"
import { diagnosticsToProblemsString, getNewDiagnostics } from "../diagnostics"
import { Task } from "../../core/task/Task"

import { DecorationController } from "./DecorationController"

export const DIFF_VIEW_URI_SCHEME = "cline-diff"
export const DIFF_VIEW_LABEL_CHANGES = "Original ↔ Zoo's Changes"

// TODO: https://github.com/cline/cline/pull/3354
export class DiffViewProvider {
	// Properties to store the results of saveChanges
	newProblemsMessage?: string
	userEdits?: string
	editType?: "create" | "modify"
	isEditing = false
	originalContent: string | undefined
	private createdDirs: string[] = []
	private documentWasOpen = false
	// Tracks whether the target file's tab was pinned before the diff session.
	// Closing the tab to open the diff drops VS Code's pin state, so we restore
	// it when re-showing the edited file afterward.
	private documentWasPinned = false
	private relPath?: string
	private newContent?: string
	private activeDiffEditor?: vscode.TextEditor
	private fadedOverlayController?: DecorationController
	private activeLineController?: DecorationController
	private streamedLines: string[] = []
	private preDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] = []
	private preEditScrollLine: number | undefined
	// Tracks whether the user activated the target file's editor tab during the
	// diff session. When the file was not already open before the edit, we only
	// keep it open afterward if the user explicitly interacted with it.
	private userTouchedDocument = false
	// Tracks whether the user clicked or edited inside the diff editor itself.
	// A selection-change event fires on click/keyboard/edit but NOT on
	// scroll, so this reliably distinguishes interaction from passive viewing.
	// When true and the user saves (accepts) the diff, the target file tab is
	// kept open even if it was not open before the edit began.
	private userTouchedDiffEditor = false
	// Tracks the most recent scroll position seen in the diff editor. Updated
	// continuously so that when the user accepts the diff, the target file can
	// be revealed at the same line they were viewing in the diff.
	private diffScrollLine: number | undefined
	// Tracks the most recent scroll position seen in the target file's own
	// editor during the diff session. If the user opens the target file's tab
	// and scrolls there, that position overrides the diff scroll line.
	private targetFileScrollLine: number | undefined
	// Records which editor (diff or the target file itself) the user scrolled
	// most recently. The most-recently-scrolled source wins when choosing the
	// restore scroll line.
	private lastScrolledSource: "diff" | "targetFile" | undefined
	private activeEditorListener?: vscode.Disposable
	private diffEditorSelectionListener?: vscode.Disposable
	private diffScrollListener?: vscode.Disposable
	private deferredScrollTimer?: ReturnType<typeof setTimeout>
	// Snapshot of unrelated preview tabs (italicized, not-yet-edited) captured at
	// diff-open time. Opening the diff reuses the editor group's single preview
	// slot and evicts these tabs; we restore any that disappeared after the diff
	// session ends so the user's prior tab state is reconstructed.
	private snapshotPreviewTabs: Array<{
		uri: vscode.Uri
		scrollLine: number | undefined
		viewColumn: vscode.ViewColumn
	}> = []
	private taskRef: WeakRef<Task>

	constructor(
		private cwd: string,
		task: Task,
	) {
		this.taskRef = new WeakRef(task)
	}

	async open(relPath: string): Promise<void> {
		this.relPath = relPath
		const fileExists = this.editType === "modify"
		const absolutePath = path.resolve(this.cwd, relPath)
		this.isEditing = true

		// Capture the current scroll position before we close the tab so we can
		// restore it after saving/reverting.
		const existingEditor = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.scheme === "file" && arePathsEqual(e.document.uri.fsPath, absolutePath),
		)
		this.preEditScrollLine = existingEditor?.visibleRanges?.[0]?.start.line

		// If the file is already open, ensure it's not dirty before getting its
		// contents.
		if (fileExists) {
			const existingDocument = vscode.workspace.textDocuments.find(
				(doc) => doc.uri.scheme === "file" && arePathsEqual(doc.uri.fsPath, absolutePath),
			)

			if (existingDocument && existingDocument.isDirty) {
				await existingDocument.save()
			}
		}

		// Get diagnostics before editing the file, we'll compare to diagnostics
		// after editing to see if cline needs to fix anything.
		this.preDiagnostics = vscode.languages.getDiagnostics()

		if (fileExists) {
			this.originalContent = await fs.readFile(absolutePath, "utf-8")
		} else {
			this.originalContent = ""
		}

		// For new files, create any necessary directories and keep track of new
		// directories to delete if the user denies the operation.
		this.createdDirs = await createDirectoriesForFile(absolutePath)

		// Make sure the file exists before we open it.
		if (!fileExists) {
			await fs.writeFile(absolutePath, "")
		}

		// If the file was already open, close it (must happen after showing the
		// diff view since if it's the only tab the column will close).
		this.documentWasOpen = false
		this.documentWasPinned = false

		// Close the tab if it's open (it's already saved above).
		const tabs = vscode.window.tabGroups.all
			.map((tg) => tg.tabs)
			.flat()
			.filter(
				(tab) =>
					tab.input instanceof vscode.TabInputText &&
					tab.input.uri.scheme === "file" &&
					arePathsEqual(tab.input.uri.fsPath, absolutePath),
			)

		for (const tab of tabs) {
			// Remember the pin state so we can restore it after the diff closes;
			// closing the tab to open the diff would otherwise lose it.
			if (tab.isPinned) {
				this.documentWasPinned = true
			}
			if (!tab.isDirty) {
				try {
					await vscode.window.tabGroups.close(tab)
				} catch (err) {
					console.error(`Failed to close tab ${tab.label}`, err)
				}
			}
			this.documentWasOpen = true
		}

		// Snapshot unrelated preview tabs so we can restore them if opening the
		// diff evicts them (VS Code reuses the group's single preview slot).
		this.snapshotPreviewTabs = this.captureUnrelatedPreviewTabs(absolutePath)

		this.activeDiffEditor = await this.openDiffEditor()
		this.fadedOverlayController = new DecorationController("fadedOverlay", this.activeDiffEditor)
		this.activeLineController = new DecorationController("activeLine", this.activeDiffEditor)
		// Apply faded overlay to all lines initially.
		this.fadedOverlayController.addLines(0, this.activeDiffEditor.document.lineCount)
		// Do not force the viewport to the top here. Tools call scrollToFirstDiff()
		// after the final update so the diff opens on the first changed line; an
		// unconditional scroll-to-0 would override that and land off the change.
		this.streamedLines = []

		// When the file was not already open before the edit, watch for the user
		// activating the file's own editor tab. If they do, we treat the file as
		// "touched" and keep it open after accepting/denying instead of closing
		// the transiently opened tab. Activating the diff view does not count.
		this.userTouchedDocument = false
		if (!this.documentWasOpen) {
			this.activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (!editor || editor.document.uri.scheme !== "file") {
					return
				}
				if (!arePathsEqual(editor.document.uri.fsPath, absolutePath)) {
					return
				}
				// Ignore activation of the diff editor, which can share the file path.
				const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
				if (activeTab?.input instanceof vscode.TabInputTextDiff) {
					return
				}
				this.userTouchedDocument = true
			})
		}

		// Track whether the user clicks or edits inside the diff editor.
		// onDidChangeTextEditorSelection fires on click/keyboard/edit but NOT on
		// scroll. We additionally filter to Mouse and Keyboard kinds to exclude
		// programmatic selection changes (e.g. the selection anchor set by
		// revealDiffLine / scrollToFirstDiff), which VS Code reports with kind
		// undefined / Command and must not count as user interaction.
		this.userTouchedDiffEditor = false
		this.diffEditorSelectionListener = vscode.window.onDidChangeTextEditorSelection((event) => {
			if (
				this.activeDiffEditor &&
				event.textEditor.document === this.activeDiffEditor.document &&
				(event.kind === vscode.TextEditorSelectionChangeKind.Mouse ||
					event.kind === vscode.TextEditorSelectionChangeKind.Keyboard)
			) {
				this.userTouchedDiffEditor = true
			}
		})

		// Track scroll position in both the diff editor and the target file's own
		// editor. Whichever the user scrolled most recently determines the line we
		// reveal when we re-open the target file after the diff closes.
		this.diffScrollLine = undefined
		this.targetFileScrollLine = undefined
		this.lastScrolledSource = undefined
		this.diffScrollListener = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
			if (this.activeDiffEditor && event.textEditor.document === this.activeDiffEditor.document) {
				const line = event.visibleRanges[0]?.start.line
				if (line !== undefined) {
					this.diffScrollLine = line
					this.lastScrolledSource = "diff"
				}
			} else if (
				event.textEditor.document.uri.scheme === "file" &&
				arePathsEqual(event.textEditor.document.uri.fsPath, absolutePath)
			) {
				const line = event.visibleRanges[0]?.start.line
				if (line !== undefined) {
					this.targetFileScrollLine = line
					this.lastScrolledSource = "targetFile"
				}
			}
		})
	}

	async update(accumulatedContent: string, isFinal: boolean) {
		if (!this.relPath || !this.activeLineController || !this.fadedOverlayController) {
			throw new Error("Required values not set")
		}

		this.newContent = accumulatedContent
		const accumulatedLines = accumulatedContent.split("\n")

		if (!isFinal) {
			accumulatedLines.pop() // Remove the last partial line only if it's not the final update.
		}

		const diffEditor = this.activeDiffEditor
		const document = diffEditor?.document

		if (!diffEditor || !document) {
			throw new Error("User closed text editor, unable to edit file...")
		}

		// Place cursor at the beginning of the diff editor to keep it out of
		// the way of the stream animation, but do this without stealing focus
		const beginningOfDocument = new vscode.Position(0, 0)
		diffEditor.selection = new vscode.Selection(beginningOfDocument, beginningOfDocument)

		const endLine = accumulatedLines.length
		// Replace all content up to the current line with accumulated lines.
		const edit = new vscode.WorkspaceEdit()
		const rangeToReplace = new vscode.Range(0, 0, endLine, 0)
		const contentToReplace =
			accumulatedLines.slice(0, endLine).join("\n") + (accumulatedLines.length > 0 ? "\n" : "")
		edit.replace(document.uri, rangeToReplace, this.stripAllBOMs(contentToReplace))
		await vscode.workspace.applyEdit(edit)
		// Update decorations.
		this.activeLineController.setActiveLine(endLine)
		this.fadedOverlayController.updateOverlayAfterLine(endLine, document.lineCount)
		// Scroll to the current line without stealing focus.
		const ranges = this.activeDiffEditor?.visibleRanges
		if (ranges && ranges.length > 0 && ranges[0].start.line < endLine && ranges[0].end.line > endLine) {
			this.scrollEditorToLine(endLine)
		}

		// Update the streamedLines with the new accumulated content.
		this.streamedLines = accumulatedLines

		if (isFinal) {
			// Handle any remaining lines if the new content is shorter than the
			// original.
			if (this.streamedLines.length < document.lineCount) {
				const edit = new vscode.WorkspaceEdit()
				edit.delete(document.uri, new vscode.Range(this.streamedLines.length, 0, document.lineCount, 0))
				await vscode.workspace.applyEdit(edit)
			}

			// Preserve empty last line if original content had one.
			const hasEmptyLastLine = this.originalContent?.endsWith("\n")

			if (hasEmptyLastLine && !accumulatedContent.endsWith("\n")) {
				accumulatedContent += "\n"
			}

			// Apply the final content.
			const finalEdit = new vscode.WorkspaceEdit()

			finalEdit.replace(
				document.uri,
				new vscode.Range(0, 0, document.lineCount, 0),
				this.stripAllBOMs(accumulatedContent),
			)

			await vscode.workspace.applyEdit(finalEdit)

			// Clear all decorations at the end (after applying final edit).
			this.fadedOverlayController.clear()
			this.activeLineController.clear()
		}
	}

	async saveChanges(
		diagnosticsEnabled: boolean = true,
		writeDelayMs: number = DEFAULT_WRITE_DELAY_MS,
	): Promise<{
		newProblemsMessage: string | undefined
		userEdits: string | undefined
		finalContent: string | undefined
	}> {
		if (!this.relPath || !this.newContent || !this.activeDiffEditor) {
			return { newProblemsMessage: undefined, userEdits: undefined, finalContent: undefined }
		}

		const absolutePath = path.resolve(this.cwd, this.relPath)
		const updatedDocument = this.activeDiffEditor.document
		const editedContent = updatedDocument.getText()

		if (updatedDocument.isDirty) {
			await updatedDocument.save()
		}

		// Stop tracking touches and cancel any pending scroll-to-diff before any
		// programmatic editor activation below.
		this.disposeActiveEditorListener()
		this.cancelDeferredScroll()

		await this.closeAllDiffViews()

		// Read auto-close preferences from state; fall back to defaults that
		// preserve the existing behavior when unset.
		const saveTask = this.taskRef.deref()
		const saveState = await saveTask?.providerRef.deref()?.getState()

		await this.keepOrCloseEditedFile(
			absolutePath,
			this.userTouchedDiffEditor,
			saveState?.autoCloseZooOpenedFiles ?? true,
			saveState?.autoCloseZooOpenedFilesAfterUserEdited ?? false,
			saveState?.autoCloseZooOpenedNewFiles ?? false,
		)

		// Restore any preview tabs the diff evicted, reconstructing the user's
		// prior not-yet-edited tab state.
		await this.restorePreviewTabs()

		// Getting diagnostics before and after the file edit is a better approach than
		// automatically tracking problems in real-time. This method ensures we only
		// report new problems that are a direct result of this specific edit.
		// Since these are new problems resulting from Roo's edit, we know they're
		// directly related to the work he's doing. This eliminates the risk of Roo
		// going off-task or getting distracted by unrelated issues, which was a problem
		// with the previous auto-debug approach. Some users' machines may be slow to
		// update diagnostics, so this approach provides a good balance between automation
		// and avoiding potential issues where Roo might get stuck in loops due to
		// outdated problem information. If no new problems show up by the time the user
		// accepts the changes, they can always debug later using the '@problems' mention.
		// This way, Roo only becomes aware of new problems resulting from his edits
		// and can address them accordingly. If problems don't change immediately after
		// applying a fix, won't be notified, which is generally fine since the
		// initial fix is usually correct and it may just take time for linters to catch up.

		let newProblemsMessage = ""

		if (diagnosticsEnabled) {
			// Add configurable delay to allow linters time to process and clean up issues
			// like unused imports (especially important for Go and other languages)
			// Ensure delay is non-negative
			const safeDelayMs = Math.max(0, writeDelayMs)

			try {
				await delay(safeDelayMs)
			} catch (error) {
				// Log error but continue - delay failure shouldn't break the save operation
				console.warn(`Failed to apply write delay: ${error}`)
			}

			const postDiagnostics = vscode.languages.getDiagnostics()

			// Get diagnostic settings from state
			const task = this.taskRef.deref()
			const state = await task?.providerRef.deref()?.getState()
			const includeDiagnosticMessages = state?.includeDiagnosticMessages ?? true
			const maxDiagnosticMessages = state?.maxDiagnosticMessages ?? 50

			const newProblems = await diagnosticsToProblemsString(
				getNewDiagnostics(this.preDiagnostics, postDiagnostics),
				[
					vscode.DiagnosticSeverity.Error, // only including errors since warnings can be distracting (if user wants to fix warnings they can use the @problems mention)
				],
				this.cwd,
				includeDiagnosticMessages,
				maxDiagnosticMessages,
			) // Will be empty string if no errors.

			newProblemsMessage =
				newProblems.length > 0 ? `\n\nNew problems detected after saving the file:\n${newProblems}` : ""
		}

		// If the edited content has different EOL characters, we don't want to
		// show a diff with all the EOL differences.
		const newContentEOL = this.newContent.includes("\r\n") ? "\r\n" : "\n"

		// Normalize EOL characters without trimming content
		const normalizedEditedContent = editedContent.replace(/\r\n|\n/g, newContentEOL)

		// Just in case the new content has a mix of varying EOL characters.
		const normalizedNewContent = this.newContent.replace(/\r\n|\n/g, newContentEOL)

		if (normalizedEditedContent !== normalizedNewContent) {
			// User made changes before approving edit.
			const userEdits = formatResponse.createPrettyPatch(
				this.relPath.toPosix(),
				normalizedNewContent,
				normalizedEditedContent,
			)

			// Store the results as class properties for formatFileWriteResponse to use
			this.newProblemsMessage = newProblemsMessage
			this.userEdits = userEdits

			return { newProblemsMessage, userEdits, finalContent: normalizedEditedContent }
		} else {
			// No changes to Roo's edits.
			// Store the results as class properties for formatFileWriteResponse to use
			this.newProblemsMessage = newProblemsMessage
			this.userEdits = undefined

			return { newProblemsMessage, userEdits: undefined, finalContent: normalizedEditedContent }
		}
	}

	/**
	 * Formats a standardized response for file write operations
	 *
	 * @param task Task instance to get protocol info
	 * @param cwd Current working directory for path resolution
	 * @param isNewFile Whether this is a new file or an existing file being modified
	 * @returns Formatted message (JSON)
	 */
	async pushToolWriteResult(task: Task, cwd: string, isNewFile: boolean): Promise<string> {
		if (!this.relPath) {
			throw new Error("No file path available in DiffViewProvider")
		}

		// Only send user_feedback_diff if userEdits exists
		if (this.userEdits) {
			// Create say object for UI feedback
			const say: ClineSayTool = {
				tool: isNewFile ? "newFileCreated" : "editedExistingFile",
				path: getReadablePath(cwd, this.relPath),
				diff: this.userEdits,
			}

			// Send the user feedback
			await task.say("user_feedback_diff", JSON.stringify(say))
		}

		// Build notices array
		const notices = [
			"You do not need to re-read the file, as you have seen all changes",
			"Proceed with the task using these changes as the new baseline.",
			...(this.userEdits
				? [
						"If the user's edits have addressed part of the task or changed the requirements, adjust your approach accordingly.",
					]
				: []),
		]

		const result: {
			path: string
			operation: "created" | "modified"
			notice: string
			user_edits?: string
			problems?: string
		} = {
			path: this.relPath,
			operation: isNewFile ? "created" : "modified",
			notice: notices.join(" "),
		}

		if (this.userEdits) {
			result.user_edits = this.userEdits
		}

		if (this.newProblemsMessage) {
			result.problems = this.newProblemsMessage
		}

		return JSON.stringify(result)
	}

	async revertChanges(): Promise<void> {
		if (!this.relPath || !this.activeDiffEditor) {
			return
		}

		const fileExists = this.editType === "modify"
		const updatedDocument = this.activeDiffEditor.document
		const absolutePath = path.resolve(this.cwd, this.relPath)

		// Stop tracking touches and cancel any pending scroll-to-diff before any
		// programmatic editor activation below.
		this.disposeActiveEditorListener()
		this.cancelDeferredScroll()

		if (!fileExists) {
			if (updatedDocument.isDirty) {
				await updatedDocument.save()
			}

			await this.closeAllDiffViews()
			// The file was newly created for this edit; close its transiently
			// opened tab before deleting it from disk.
			await this.closeFileTab(absolutePath)
			await fs.unlink(absolutePath)

			// Remove only the directories we created, in reverse order.
			for (let i = this.createdDirs.length - 1; i >= 0; i--) {
				await fs.rmdir(this.createdDirs[i])
			}
		} else {
			// Revert document.
			const edit = new vscode.WorkspaceEdit()

			const fullRange = new vscode.Range(
				updatedDocument.positionAt(0),
				updatedDocument.positionAt(updatedDocument.getText().length),
			)

			edit.replace(updatedDocument.uri, fullRange, this.stripAllBOMs(this.originalContent ?? ""))

			// Apply the edit and save, since contents shouldn't have changed
			// this won't show in local history unless of course the user made
			// changes and saved during the edit.
			await vscode.workspace.applyEdit(edit)
			await updatedDocument.save()

			await this.closeAllDiffViews()

			// Read auto-close preferences from state; fall back to defaults that
			// preserve the existing behavior when unset.
			const revertTask = this.taskRef.deref()
			const revertState = await revertTask?.providerRef.deref()?.getState()

			await this.keepOrCloseEditedFile(
				absolutePath,
				false,
				revertState?.autoCloseZooOpenedFiles ?? true,
				revertState?.autoCloseZooOpenedFilesAfterUserEdited ?? false,
				revertState?.autoCloseZooOpenedNewFiles ?? false,
			)
		}

		// Restore any preview tabs the diff evicted, reconstructing the user's
		// prior not-yet-edited tab state.
		await this.restorePreviewTabs()

		// Edit is done.
		await this.reset()
	}

	private async closeAllDiffViews(): Promise<void> {
		const closeOps = vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.filter((tab) => {
				// Check for standard diff views with our URI scheme
				if (
					tab.input instanceof vscode.TabInputTextDiff &&
					tab.input.original.scheme === DIFF_VIEW_URI_SCHEME &&
					!tab.isDirty
				) {
					return true
				}

				// Also check by tab label for our specific diff views
				// This catches cases where the diff view might be created differently
				// when files are pre-opened as text documents
				if (tab.label.includes(DIFF_VIEW_LABEL_CHANGES) && !tab.isDirty) {
					return true
				}

				return false
			})
			.map((tab) =>
				vscode.window.tabGroups.close(tab).then(
					() => undefined,
					(err) => {
						console.error(`Failed to close diff tab ${tab.label}`, err)
					},
				),
			)

		await Promise.all(closeOps)
	}

	// Stop tracking user activation of the target file. Called before any
	// programmatic showTextDocument so our own re-show never counts as a "touch".
	private disposeActiveEditorListener(): void {
		this.activeEditorListener?.dispose()
		this.activeEditorListener = undefined
		this.diffEditorSelectionListener?.dispose()
		this.diffEditorSelectionListener = undefined
		this.diffScrollListener?.dispose()
		this.diffScrollListener = undefined
	}

	// Cancel any pending deferred scroll-to-diff. Must run as soon as the user
	// accepts/denies (before saveChanges/revertChanges restore the pre-edit
	// viewport), otherwise a late timer could fire after the scroll-restore and
	// yank the file back to the diff target. With auto-approve this window is
	// especially tight because save runs immediately after scrollToFirstDiff.
	private cancelDeferredScroll(): void {
		if (this.deferredScrollTimer !== undefined) {
			clearTimeout(this.deferredScrollTimer)
			this.deferredScrollTimer = undefined
		}
	}

	// Shared accept/deny cleanup: applies the user's auto-close preferences to
	// decide whether to keep or close the edited file's tab after the diff settles.
	//
	// Decision table (evaluated in order; first match wins):
	//   1. File was already open before the edit -> always keep (closing it would
	//      be destructive; user-opened tabs are never auto-closed).
	//   2. editType==="create" AND autoCloseZooOpenedNewFiles -> close the new file's tab.
	//   3. userTouchedDocument OR keepIfTouchedDiff -> the "keep if touched" guard
	//      applies; it is overridden (close) only when BOTH autoCloseZooOpenedFiles
	//      and autoCloseZooOpenedFilesAfterUserEdited are enabled. The override is a
	//      refinement of the base auto-close, so it has no effect when the base
	//      setting is off.
	//   4. autoCloseZooOpenedFiles=false -> keep the transiently-opened tab.
	//   5. Default -> close the transiently-opened tab (current behavior preserved).
	//
	// keepIfTouchedDiff is passed as true from saveChanges() when the user clicked
	// or typed inside the diff editor itself.
	private async keepOrCloseEditedFile(
		absolutePath: string,
		keepIfTouchedDiff = false,
		autoCloseZooOpenedFiles = true,
		autoCloseZooOpenedFilesAfterUserEdited = false,
		autoCloseZooOpenedNewFiles = false,
	): Promise<void> {
		// Files the user already had open are never auto-closed.
		if (this.documentWasOpen) {
			await this.showEditedFileWithoutDisruptingFocus(absolutePath)
			return
		}

		// New files on the accept path: close when autoCloseZooOpenedNewFiles is enabled.
		if (this.editType === "create" && autoCloseZooOpenedNewFiles) {
			await this.closeFileTab(absolutePath)
			return
		}

		const userInteracted = this.userTouchedDocument || keepIfTouchedDiff
		if (userInteracted) {
			// Override the "keep if touched" guard only when the base auto-close is
			// also enabled; the override is a refinement, not an independent toggle.
			if (autoCloseZooOpenedFiles && autoCloseZooOpenedFilesAfterUserEdited) {
				await this.closeFileTab(absolutePath)
			} else {
				await this.showEditedFileWithoutDisruptingFocus(absolutePath)
			}
			return
		}

		// Transient tab opened by Zoo: close by default, keep only when opted out.
		if (autoCloseZooOpenedFiles) {
			await this.closeFileTab(absolutePath)
		} else {
			await this.showEditedFileWithoutDisruptingFocus(absolutePath)
		}
	}

	// Re-show the edited file so it stays open after the diff closes and restore
	// its pre-edit scroll position, WITHOUT disrupting wherever the user is
	// currently looking. showTextDocument activates the target's tab in its
	// group, so if the user navigated to a different file during the diff (e.g.
	// they clicked back to file-1 while file-2 was being edited), naively showing
	// the edited file would yank the active editor onto it. We capture the user's
	// active editor first and re-activate it afterward when it differs.
	private async showEditedFileWithoutDisruptingFocus(absolutePath: string): Promise<void> {
		const userActiveEditor = vscode.window.activeTextEditor
		const userWasElsewhere =
			!!userActiveEditor &&
			!(
				userActiveEditor.document.uri.scheme === "file" &&
				arePathsEqual(userActiveEditor.document.uri.fsPath, absolutePath)
			)

		// When the tab needs re-pinning we must briefly focus it, since
		// workbench.action.pinEditor only acts on the active editor. Otherwise we
		// keep the user's focus undisturbed with preserveFocus.
		const editor = await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), {
			preview: false,
			preserveFocus: !this.documentWasPinned,
		})
		// Determine the scroll line to restore. Prefer the most-recently-scrolled
		// source: if the user scrolled in the diff, reveal that line; if they
		// scrolled in the target file's own editor, use that position; otherwise
		// fall back to the scroll position the file had before the edit began.
		const restoreScrollLine =
			this.lastScrolledSource === "targetFile"
				? this.targetFileScrollLine
				: this.lastScrolledSource === "diff"
					? this.diffScrollLine
					: this.preEditScrollLine
		if (restoreScrollLine !== undefined) {
			editor.revealRange(
				new vscode.Range(restoreScrollLine, 0, restoreScrollLine, 0),
				vscode.TextEditorRevealType.AtTop,
			)
		}

		// Restore the pin state that was dropped when the tab was closed to open
		// the diff. The edited file is active here (we focused it above), so the
		// command targets the correct tab.
		if (this.documentWasPinned) {
			try {
				await vscode.commands.executeCommand("workbench.action.pinEditor")
			} catch (err) {
				console.error(`Failed to re-pin edited file`, err)
			}
		}

		// If the user was viewing a different editor, re-activate it so the edited
		// file stays open in the background instead of stealing the foreground.
		if (userWasElsewhere && userActiveEditor) {
			try {
				await vscode.window.showTextDocument(userActiveEditor.document, {
					viewColumn: userActiveEditor.viewColumn,
					preserveFocus: false,
				})
			} catch (err) {
				console.error(`Failed to restore user's active editor`, err)
			}
		}
	}

	// Capture unrelated preview tabs (italicized, not-yet-edited) along with their
	// current scroll position and editor group. Opening the diff reuses the group's
	// single preview slot and evicts these tabs; the snapshot lets us restore them
	// in the correct group after the diff session ends. The diff target is excluded
	// since it is about to be replaced by the diff view anyway.
	private captureUnrelatedPreviewTabs(
		diffTargetPath: string,
	): Array<{ uri: vscode.Uri; scrollLine: number | undefined; viewColumn: vscode.ViewColumn }> {
		return vscode.window.tabGroups.all.flatMap((group) =>
			group.tabs
				.filter(
					(tab) =>
						tab.isPreview &&
						tab.input instanceof vscode.TabInputText &&
						tab.input.uri.scheme === "file" &&
						!arePathsEqual(tab.input.uri.fsPath, diffTargetPath),
				)
				.map((tab) => {
					const uri = (tab.input as vscode.TabInputText).uri
					const visibleEditor = vscode.window.visibleTextEditors.find(
						(e) => e.document.uri.scheme === "file" && arePathsEqual(e.document.uri.fsPath, uri.fsPath),
					)
					return {
						uri,
						scrollLine: visibleEditor?.visibleRanges?.[0]?.start.line,
						viewColumn: group.viewColumn,
					}
				}),
		)
	}

	// Restore preview tabs captured before the diff opened, but only those VS Code
	// evicted. Each is re-opened in preview mode (preserving the user's
	// not-yet-edited state) without stealing focus, and its prior scroll position
	// is reapplied.
	private async restorePreviewTabs(): Promise<void> {
		for (const snapshot of this.snapshotPreviewTabs) {
			const stillOpen = vscode.window.tabGroups.all
				.flatMap((group) => group.tabs)
				.some(
					(tab) =>
						tab.input instanceof vscode.TabInputText &&
						tab.input.uri.scheme === "file" &&
						arePathsEqual(tab.input.uri.fsPath, snapshot.uri.fsPath),
				)

			if (stillOpen) {
				continue
			}

			// The file may have been deleted, renamed, or moved during the diff
			// session. Skip restoring a tab whose underlying file no longer exists.
			try {
				await fs.access(snapshot.uri.fsPath)
			} catch {
				continue
			}

			try {
				const editor = await vscode.window.showTextDocument(snapshot.uri, {
					preview: true,
					preserveFocus: true,
					viewColumn: snapshot.viewColumn,
				})
				if (snapshot.scrollLine !== undefined) {
					editor.revealRange(
						new vscode.Range(snapshot.scrollLine, 0, snapshot.scrollLine, 0),
						vscode.TextEditorRevealType.AtTop,
					)
				}
			} catch (err) {
				console.error(`Failed to restore preview tab ${snapshot.uri.fsPath}`, err)
			}
		}
		this.snapshotPreviewTabs = []
	}

	// Close the plain (non-diff) editor tab for the target file. Used when the
	// file was opened transiently for the diff and the user never interacted
	// with it, so it should not linger after accept/deny.
	private async closeFileTab(absolutePath: string): Promise<void> {
		const tabs = vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.filter(
				(tab) =>
					tab.input instanceof vscode.TabInputText &&
					tab.input.uri.scheme === "file" &&
					arePathsEqual(tab.input.uri.fsPath, absolutePath) &&
					!tab.isDirty,
			)

		for (const tab of tabs) {
			try {
				await vscode.window.tabGroups.close(tab)
			} catch (err) {
				console.error(`Failed to close file tab ${tab.label}`, err)
			}
		}
	}

	private async openDiffEditor(): Promise<vscode.TextEditor> {
		if (!this.relPath) {
			throw new Error(
				"No file path set for opening diff editor. Ensure open() was called before openDiffEditor()",
			)
		}

		const uri = vscode.Uri.file(path.resolve(this.cwd, this.relPath))

		// If this diff editor is already open (ie if a previous write file was
		// interrupted) then we should activate that instead of opening a new
		// diff.
		const diffTab = vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.find(
				(tab) =>
					tab.input instanceof vscode.TabInputTextDiff &&
					tab.input?.original?.scheme === DIFF_VIEW_URI_SCHEME &&
					arePathsEqual(tab.input.modified.fsPath, uri.fsPath),
			)

		if (diffTab && diffTab.input instanceof vscode.TabInputTextDiff) {
			const editor = await vscode.window.showTextDocument(diffTab.input.modified, { preserveFocus: true })
			return editor
		}

		// Open new diff editor.
		return new Promise<vscode.TextEditor>((resolve, reject) => {
			const fileName = path.basename(uri.fsPath)
			const fileExists = this.editType === "modify"
			const DIFF_EDITOR_TIMEOUT = 10_000 // ms

			let timeoutId: NodeJS.Timeout | undefined
			const disposables: vscode.Disposable[] = []

			const cleanup = () => {
				if (timeoutId) {
					clearTimeout(timeoutId)
					timeoutId = undefined
				}
				disposables.forEach((d) => d.dispose())
				disposables.length = 0
			}

			// Set timeout for the entire operation
			timeoutId = setTimeout(() => {
				cleanup()
				reject(
					new Error(
						`Failed to open diff editor for ${uri.fsPath} within ${DIFF_EDITOR_TIMEOUT / 1000} seconds. The editor may be blocked or VS Code may be unresponsive.`,
					),
				)
			}, DIFF_EDITOR_TIMEOUT)

			// Listen for document open events - more efficient than scanning all tabs
			disposables.push(
				vscode.workspace.onDidOpenTextDocument(async (document) => {
					// Only match file:// scheme documents to avoid git diffs
					if (document.uri.scheme === "file" && arePathsEqual(document.uri.fsPath, uri.fsPath)) {
						// Wait a tick for the editor to be available
						await new Promise((r) => setTimeout(r, 0))

						// Find the editor for this document
						const editor = vscode.window.visibleTextEditors.find(
							(e) => e.document.uri.scheme === "file" && arePathsEqual(e.document.uri.fsPath, uri.fsPath),
						)

						if (editor) {
							cleanup()
							resolve(editor)
						}
					}
				}),
			)

			// Also listen for visible editor changes as a fallback
			disposables.push(
				vscode.window.onDidChangeVisibleTextEditors((editors) => {
					const editor = editors.find((e) => {
						const isFileScheme = e.document.uri.scheme === "file"
						const pathMatches = arePathsEqual(e.document.uri.fsPath, uri.fsPath)
						return isFileScheme && pathMatches
					})
					if (editor) {
						cleanup()
						resolve(editor)
					}
				}),
			)

			// Pre-open the file as a text document to ensure it doesn't open in preview mode
			// This fixes issues with files that have custom editor associations (like markdown preview)
			vscode.window
				.showTextDocument(uri, { preview: false, viewColumn: vscode.ViewColumn.Active, preserveFocus: true })
				.then(() => {
					// Execute the diff command after ensuring the file is open as text
					return vscode.commands.executeCommand(
						"vscode.diff",
						vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${fileName}`).with({
							query: Buffer.from(this.originalContent ?? "").toString("base64"),
						}),
						uri,
						`${fileName}: ${fileExists ? `${DIFF_VIEW_LABEL_CHANGES}` : "New File"} (Editable)`,
						{ preserveFocus: true },
					)
				})
				.then(
					() => {
						// Command executed successfully, now wait for the editor to appear
					},
					(err: any) => {
						cleanup()
						reject(new Error(`Failed to execute diff command for ${uri.fsPath}: ${err.message}`))
					},
				)
		})
	}

	private scrollEditorToLine(line: number) {
		if (this.activeDiffEditor) {
			const scrollLine = line + 4

			this.activeDiffEditor.revealRange(
				new vscode.Range(scrollLine, 0, scrollLine, 0),
				vscode.TextEditorRevealType.InCenter,
			)
		}
	}

	scrollToFirstDiff() {
		const editor = this.activeDiffEditor
		if (!editor) {
			return
		}

		const targetLine = this.findFirstDiffLine(editor)
		if (targetLine === undefined) {
			return
		}

		// Reveal on the live modified-side editor, then once more after the diff
		// editor's late layout pass settles. When the file was already open and
		// scrolled away from the top, the vscode.diff command re-lays-out the diff
		// and momentarily snaps the viewport to the top; a single synchronous
		// reveal can be overridden by that pass. The deferred reveal is gated on
		// the diff still being active so a stale timer can never act on a diff
		// opened by a later edit.
		this.revealDiffLine(this.resolveLiveEditor(editor), targetLine)

		this.cancelDeferredScroll()
		this.deferredScrollTimer = setTimeout(() => {
			this.deferredScrollTimer = undefined
			if (this.activeDiffEditor === editor) {
				this.revealDiffLine(this.resolveLiveEditor(editor), targetLine)
			}
		}, 100)
	}

	// The TextEditor reference captured when the diff opened can be a stale,
	// detached instance whose visibleRanges no longer reflect the on-screen diff
	// widget (this happens when the file was already open before the edit). A
	// revealRange on that stale editor is a silent no-op because it believes the
	// target line is already visible. Re-resolve the current modified-side editor
	// for the same document at scroll time so the reveal drives the live viewport.
	private resolveLiveEditor(editor: vscode.TextEditor): vscode.TextEditor {
		return (
			vscode.window.visibleTextEditors.find(
				(e) => e.document.uri.scheme === "file" && e.document === editor.document,
			) ?? editor
		)
	}

	// Index of the first change in the MODIFIED (right-hand) document, or
	// undefined when there is no change. For removals this is the line that now
	// occupies the position of the removed block.
	private findFirstDiffLine(editor: vscode.TextEditor): number | undefined {
		const document = editor.document
		const currentContent = document.getText()
		const diffs = diff.diffLines(this.originalContent || "", currentContent)

		let lineCount = 0

		for (const part of diffs) {
			if (part.added || part.removed) {
				// A pure removal at the end of the file leaves the first-change line
				// at (or past) the end of the modified document. Revealing a range at
				// that out-of-bounds line clamps to the last line and the composite
				// diff widget never moves. Clamp the target into the document so the
				// reveal always lands on a real line.
				const lastLine = Math.max(0, document.lineCount - 1)
				return Math.min(lineCount, lastLine)
			}

			if (!part.removed) {
				lineCount += part.count || 0
			}
		}

		return undefined
	}

	private revealDiffLine(editor: vscode.TextEditor, targetLine: number) {
		// Clamp again at reveal time: deferred reveals can run after a later edit
		// shortened the document, and an out-of-bounds selection would snap the
		// composite diff widget back to the top and leave it stuck there.
		const lastLine = Math.max(0, editor.document.lineCount - 1)
		const safeLine = Math.min(Math.max(0, targetLine), lastLine)

		// Anchor the selection on the target line before revealing. update() parks
		// the selection at (0,0) to keep it out of the stream animation; moving the
		// selection to the target first nudges the composite diff widget toward the
		// change. preserveFocus semantics are unaffected because we never activate
		// the editor here.
		const targetPosition = new vscode.Position(safeLine, 0)
		editor.selection = new vscode.Selection(targetPosition, targetPosition)

		const lineLength = editor.document.lineAt ? editor.document.lineAt(safeLine).text.length : 0
		editor.revealRange(new vscode.Range(safeLine, 0, safeLine, lineLength), vscode.TextEditorRevealType.InCenter)
	}

	private stripAllBOMs(input: string): string {
		let result = input
		let previous

		do {
			previous = result
			result = stripBom(result)
		} while (result !== previous)

		return result
	}

	async reset(): Promise<void> {
		// Dispose touch listeners and cancel any pending deferred scroll BEFORE any
		// async editor manipulation. closeAllDiffViews() awaits tab-close operations,
		// so leaving listeners/timers live across that await could let a stale handler
		// act on an editor mid-teardown. This mirrors the ordering used in
		// saveChanges()/revertChanges().
		this.disposeActiveEditorListener()
		this.cancelDeferredScroll()

		await this.closeAllDiffViews()
		this.editType = undefined
		this.isEditing = false
		this.originalContent = undefined
		this.createdDirs = []
		this.documentWasOpen = false
		this.documentWasPinned = false
		this.activeDiffEditor = undefined
		this.fadedOverlayController = undefined
		this.activeLineController = undefined
		this.streamedLines = []
		this.preDiagnostics = []
		this.preEditScrollLine = undefined
		this.diffScrollLine = undefined
		this.targetFileScrollLine = undefined
		this.lastScrolledSource = undefined
		this.userTouchedDocument = false
		this.userTouchedDiffEditor = false
		this.snapshotPreviewTabs = []
	}

	/**
	 * Directly save content to a file without showing diff view
	 * Used when preventFocusDisruption experiment is enabled
	 *
	 * @param relPath - Relative path to the file
	 * @param content - Content to write to the file
	 * @param openFile - Whether to show the file in editor (false = open in memory only for diagnostics)
	 * @returns Result of the save operation including any new problems detected
	 */
	async saveDirectly(
		relPath: string,
		content: string,
		openFile: boolean = true,
		diagnosticsEnabled: boolean = true,
		writeDelayMs: number = DEFAULT_WRITE_DELAY_MS,
	): Promise<{
		newProblemsMessage: string | undefined
		userEdits: string | undefined
		finalContent: string | undefined
	}> {
		const absolutePath = path.resolve(this.cwd, relPath)

		// Get diagnostics before editing the file
		this.preDiagnostics = vscode.languages.getDiagnostics()

		// Write the content directly to the file
		await createDirectoriesForFile(absolutePath)
		await fs.writeFile(absolutePath, content, "utf-8")

		// Open the document to ensure diagnostics are loaded
		// When openFile is false (PREVENT_FOCUS_DISRUPTION enabled), we only open in memory
		if (openFile) {
			// Show the document in the editor
			await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), {
				preview: false,
				preserveFocus: true,
			})
		} else {
			// Just open the document in memory to trigger diagnostics without showing it
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath))

			// Save the document to ensure VSCode recognizes it as saved and triggers diagnostics
			if (doc.isDirty) {
				await doc.save()
			}

			// Force a small delay to ensure diagnostics are triggered
			await new Promise((resolve) => setTimeout(resolve, 100))
		}

		let newProblemsMessage = ""

		if (diagnosticsEnabled) {
			// Add configurable delay to allow linters time to process
			const safeDelayMs = Math.max(0, writeDelayMs)

			try {
				await delay(safeDelayMs)
			} catch (error) {
				console.warn(`Failed to apply write delay: ${error}`)
			}

			const postDiagnostics = vscode.languages.getDiagnostics()

			// Get diagnostic settings from state
			const task = this.taskRef.deref()
			const state = await task?.providerRef.deref()?.getState()
			const includeDiagnosticMessages = state?.includeDiagnosticMessages ?? true
			const maxDiagnosticMessages = state?.maxDiagnosticMessages ?? 50

			const newProblems = await diagnosticsToProblemsString(
				getNewDiagnostics(this.preDiagnostics, postDiagnostics),
				[vscode.DiagnosticSeverity.Error],
				this.cwd,
				includeDiagnosticMessages,
				maxDiagnosticMessages,
			)

			newProblemsMessage =
				newProblems.length > 0 ? `\n\nNew problems detected after saving the file:\n${newProblems}` : ""
		}

		// Store the results for formatFileWriteResponse
		this.newProblemsMessage = newProblemsMessage
		this.userEdits = undefined
		this.relPath = relPath
		this.newContent = content

		return {
			newProblemsMessage,
			userEdits: undefined,
			finalContent: content,
		}
	}
}
