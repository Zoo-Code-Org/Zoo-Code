import type { AutocompleteConfig } from "@roo-code/types"
import * as vscode from "vscode"

import { DEFAULT_DISABLED_LANGUAGES, MAX_CURSORS } from "./constants"
import type { AutocompleteInput } from "./types"

export type PrefilterResult =
	| { ok: true }
	| { ok: false; reason: "disabled" | "language" | "rooignore" | "multi-cursor" }

/**
 * Checks the document-level gates that apply regardless of how the suggestion
 * was triggered. Order matters: cheapest checks first.
 */
export function prefilterDocument(
	input: AutocompleteInput,
	config: AutocompleteConfig,
	validateAccess: (filePath: string) => boolean,
): PrefilterResult {
	if (input.cursorCount > MAX_CURSORS) {
		return { ok: false, reason: "multi-cursor" }
	}

	if (!config.enabled) {
		return { ok: false, reason: "disabled" }
	}

	if (isLanguageDisabled(input.languageId, config)) {
		return { ok: false, reason: "language" }
	}

	if (!validateAccess(input.document.uri.fsPath)) {
		return { ok: false, reason: "rooignore" }
	}

	return { ok: true }
}

/**
 * Whether to skip because VS Code's suggest widget is showing a selection.
 *
 * Bailing on *any* `selectedCompletionInfo` suppresses ghost text almost
 * permanently in languages with an eager language server (Python, TypeScript),
 * because the widget re-opens on nearly every keystroke. That is the difference
 * between "no suggestions ever" and a working feature.
 *
 * Instead, only bail when the widget's selected text genuinely conflicts: the
 * widget will replace `range` with `text`, so a completion computed for the
 * pre-widget document would duplicate or contradict it. When the selected item
 * merely echoes what the user already typed (the common case — `number` while
 * `number` is on screen), there is nothing to conflict with and ghost text is
 * both safe and wanted.
 */
export function shouldBailForWidget(context: vscode.InlineCompletionContext, document: vscode.TextDocument): boolean {
	const selected = context.selectedCompletionInfo

	if (!selected) {
		return false
	}

	// The widget would insert something beyond what is already in the document,
	// so a completion built on the current text is stale.
	return document.getText(selected.range) !== selected.text
}

/**
 * In manual mode suggestions are only requested on demand; the automatic trigger
 * (typing) is ignored.
 */
export function shouldSuppressAutomaticTrigger(
	triggerKind: vscode.InlineCompletionTriggerKind,
	triggerMode: AutocompleteConfig["triggerMode"],
): boolean {
	return triggerKind === vscode.InlineCompletionTriggerKind.Automatic && triggerMode === "manual"
}

/** Language gate: built-in always-off list plus the user's overridable list. */
export function isLanguageDisabled(languageId: string, config: AutocompleteConfig): boolean {
	return (
		(DEFAULT_DISABLED_LANGUAGES as readonly string[]).includes(languageId) ||
		(config.disabledLanguages ?? []).includes(languageId)
	)
}
