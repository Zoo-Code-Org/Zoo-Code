import type { ResolvedAutocompleteConfig } from "@roo-code/types"
import * as vscode from "vscode"

import { MAX_DOCUMENT_BYTES } from "./constants"
import { prefilterDocument, shouldBailForWidget, shouldSuppressAutomaticTrigger } from "./prefilters"
import type { CompletionEngine } from "./CompletionEngine"
import type { AutocompleteLogger } from "./AutocompleteLogger"

export interface ZooInlineCompletionProviderOptions {
	getConfig: () => ResolvedAutocompleteConfig
	validateAccess: (filePath: string) => boolean
	/** The completion engine that produces ghost text; undefined during tests that only exercise prefilters. */
	engine?: CompletionEngine
	/** Optional diagnostics; omitted in tests. */
	logger?: AutocompleteLogger
}

/**
 * v1 inline completion provider.
 *
 * Prefilters (multi-cursor, disabled, language allowlist, `.rooignore`,
 * suggest-widget composition, manual trigger mode) run first; the
 * {@link CompletionEngine} then produces the ghost text. The force-flag from the
 * manual trigger command bypasses the trigger-mode gate for one request.
 */
export class ZooInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	private readonly getConfig: () => ResolvedAutocompleteConfig
	private readonly validateAccess: (filePath: string) => boolean
	private readonly engine: CompletionEngine | undefined
	private readonly logger: AutocompleteLogger | undefined
	private forceRequested = false

	constructor(options: ZooInlineCompletionProviderOptions) {
		this.getConfig = options.getConfig
		this.validateAccess = options.validateAccess
		this.engine = options.engine
		this.logger = options.logger
	}

	/**
	 * One-shot override for the manual trigger command: the next provider call is
	 * treated as user-initiated even when trigger mode is "manual".
	 */
	requestForcedTrigger(): void {
		this.forceRequested = true
	}

	provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
		const config = this.getConfig()

		// Cheap gates first.
		if (shouldBailForWidget(context, document)) {
			this.logger?.log("skipped", { reason: "suggest-widget" })
			return undefined
		}

		const force = this.forceRequested
		this.forceRequested = false

		if (!force && shouldSuppressAutomaticTrigger(context.triggerKind, config.triggerMode)) {
			return undefined
		}

		const cursorCount = this.countSelections(document)
		const prefilter = prefilterDocument(
			{ document, position, cursorCount, languageId: document.languageId },
			config,
			this.validateAccess,
		)

		if (!prefilter.ok) {
			this.logger?.log("skipped", { reason: prefilter.reason })
			return undefined
		}

		if (document.getText().length > MAX_DOCUMENT_BYTES) {
			return undefined
		}

		// No engine (prefilter-only mode, e.g. early tests) → nothing to show.
		if (!this.engine) {
			return undefined
		}

		return this.engine.provideInlineCompletionItems(document, position, context, token)
	}

	/**
	 * Counts the editor's selections. A plain cursor is exactly one collapsed
	 * selection; multi-cursor editing (Alt+Click, Cmd+D, column select) produces
	 * several, and completions are suppressed while those are active.
	 */
	private countSelections(document: vscode.TextDocument): number {
		const editor = vscode.window.activeTextEditor
		if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
			return 1
		}

		return editor.selections.length
	}
}
