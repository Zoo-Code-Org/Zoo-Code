import type { AutocompleteConfig, AutocompleteProviderId, ResolvedAutocompleteConfig } from "@roo-code/types"
import * as vscode from "vscode"

/**
 * Everything the completion engine needs to know about one keystroke event.
 */
export interface AutocompleteInput {
	readonly document: vscode.TextDocument
	/** The position the ghost text would be inserted at. */
	readonly position: vscode.Position
	/** Cursor count in the document at request time (multi-cursor is rejected up front). */
	readonly cursorCount: number
	readonly languageId: string
}

export interface SnippetSource {
	readonly id: string
	isEnabled(config: AutocompleteConfig): boolean
	gather(input: AutocompleteInput, signal: AbortSignal): Promise<AutocompleteSnippet[]>
}

export interface AutocompleteSnippet {
	/** Relative to the workspace root, posix-separated. */
	readonly filePath: string
	readonly languageId?: string
	/** Line of source that mentions the definition, relative to `filePath`. */
	readonly line?: number
	readonly content: string
	/** Higher wins when the token budget forces a choice, and when de-duplicating. */
	readonly score?: number
	/** Id of the {@link SnippetSource} that produced this, for debug logging. */
	readonly source?: string
}

/**
 * Minimal provider surface Phase 1 ships with: a prefiltered request that the
 * engine (Phase 2) will turn into a completion. Phases 2-6 grow this interface
 * with debounce, cache, context, prompt and stream pieces.
 */
export interface FimCompletionRequest {
	readonly input: AutocompleteInput
	readonly config: ResolvedAutocompleteConfig
	readonly signal: AbortSignal
	readonly triggerKind: vscode.InlineCompletionTriggerKind
}

export interface AutocompleteServiceState {
	readonly enabled: boolean
	/** Why completions are suppressed right now, when they are. */
	readonly reason?: "disabled" | "workspace-kill-switch" | "language" | "rooignore"
}

/**
 * The one entry point the VS Code inline-completion provider and the status bar
 * share. Kept interface-first so the service itself can be swapped in tests.
 */
export interface AutocompleteServiceLike {
	getState(): AutocompleteServiceState
	getConfig(): ResolvedAutocompleteConfig
	handleSettingsChange(): void
	toggleEnabled(): void
	dispose(): void
}

export type { AutocompleteProviderId }
