import { ErrorClassifier, ClassifiedError, ErrorCategory } from "./ErrorClassifier"
import { ToolCallValidator, ValidationResult } from "./ToolCallValidator"
import { CascadeTracker } from "./CascadeTracker"
import type { CodeIndexAdapter } from "./CodeIndexAdapter"
import type { VectorStoreSearchResult } from "../code-index/interfaces/vector-store"

export interface PreventionContext {
	preValidation: ValidationResult
	cascadeWarning: string | null
	preventionHints: string[]
	recentErrors: Array<{ toolName: string; category: string }>
}

export class PreventionEngine {
	private errorClassifier: ErrorClassifier
	private toolCallValidator: ToolCallValidator
	private cascadeTracker: CascadeTracker
	private codeIndexAdapter: CodeIndexAdapter | undefined

	constructor(codeIndexAdapter?: CodeIndexAdapter) {
		this.errorClassifier = new ErrorClassifier()
		this.toolCallValidator = new ToolCallValidator()
		this.cascadeTracker = new CascadeTracker()
		this.codeIndexAdapter = codeIndexAdapter
	}

	setCodeIndexAdapter(adapter: CodeIndexAdapter | undefined): void {
		this.codeIndexAdapter = adapter
	}

	/**
	 * Format a single VectorStoreSearchResult into a human-readable context line.
	 */
	private formatSearchResult(result: VectorStoreSearchResult): string {
		const filePath = result.payload?.filePath ?? String(result.id)
		const startLine = result.payload?.startLine
		const endLine = result.payload?.endLine
		const snippet = result.payload?.codeChunk
		const lineRange = startLine !== undefined && endLine !== undefined
			? ` (lines ${startLine}-${endLine})`
			: startLine !== undefined
				? ` (line ${startLine})`
				: ""
		const snippetStr = snippet ? `: ${snippet.slice(0, 200).replace(/\n/g, " ")}` : ""
		return `- ${filePath}${lineRange}${snippetStr}`
	}

	/**
	 * Enrich a user message with relevant code index search results.
	 * Non-blocking — returns original message on any error or empty results.
	 * Gated behind selfImprovingCodeIndex experiment flag.
	 */
	async enrichContextWithCodeIndex(userMessage: string): Promise<string> {
		if (!this.codeIndexAdapter || !this.codeIndexAdapter.isAvailable()) {
			return userMessage
		}

		try {
			const results = await this.codeIndexAdapter.searchVectorStore(userMessage)
			if (!results || results.length === 0) {
				return userMessage
			}

			const contextLines = results.map((r) => this.formatSearchResult(r))
			const contextBlock = [
				"Relevant existing code from codebase:",
				...contextLines,
			].join("\n")

			return `${userMessage}\n\n${contextBlock}`
		} catch (error) {
			// Graceful fallback — log and return original message
			return userMessage
		}
	}

	/**
	 * Called BEFORE every tool call to get prevention context.
	 * Returns validation warnings, cascade warnings, and hints
	 * that can be injected into the model's context.
	 */
	getPreventionContext(
		toolName: string,
		params: Record<string, unknown>,
	): PreventionContext {
		const preValidation = this.toolCallValidator.validate(toolName, params)
		const cascadeWarning = this.cascadeTracker.getCascadeSuggestion()
		const recentErrors = this.cascadeTracker.getRecentErrors(toolName, 3)
		const preventionHints = this.toolCallValidator.getPreventionHints(
			toolName,
			recentErrors.map((e) => ({ toolName: e.toolName, category: e.category })),
		)

		return {
			preValidation,
			cascadeWarning,
			preventionHints,
			recentErrors: recentErrors.map((e) => ({
				toolName: e.toolName,
				category: e.category,
			})),
		}
	}

	/**
	 * Called AFTER every tool call to record the result.
	 * Returns a ClassifiedError if there was an error, or null on success.
	 */
	recordToolResult(
		toolName: string,
		error: string | null,
		_params: Record<string, unknown>,
	): ClassifiedError | null {
		if (!error) {
			// Success — check if we were in a cascade and can clear it
			this.cascadeTracker.reset()
			return null
		}

		const classified = this.errorClassifier.classify(error, toolName)
		this.cascadeTracker.recordError(toolName, classified.category, error)
		return classified
	}

	/**
	 * Generate a prevention message to inject into the model's context.
	 * Returns a formatted string or null if nothing to report.
	 */
	generatePreventionMessage(context: PreventionContext): string | null {
		const parts: string[] = []

		if (context.cascadeWarning) {
			parts.push(context.cascadeWarning)
		}

		if (context.preValidation.warnings.length > 0) {
			parts.push(
				`⚠️ Pre-validation warnings: ${context.preValidation.warnings.join("; ")}`,
			)
		}

		if (context.preValidation.suggestions.length > 0) {
			parts.push(
				`💡 Suggestions: ${context.preValidation.suggestions.join("; ")}`,
			)
		}

		if (context.preventionHints.length > 0) {
			parts.push(...context.preventionHints)
		}

		return parts.length > 0 ? parts.join("\n") : null
	}

	getCascadeTracker(): CascadeTracker {
		return this.cascadeTracker
	}

	getErrorClassifier(): ErrorClassifier {
		return this.errorClassifier
	}

	getToolCallValidator(): ToolCallValidator {
		return this.toolCallValidator
	}
}
