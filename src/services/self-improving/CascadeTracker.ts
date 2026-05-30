import { ErrorCategory } from "./ErrorClassifier"

interface ErrorEvent {
	timestamp: number
	toolName: string
	category: ErrorCategory
	message: string
}

interface CascadeChain {
	rootError: ErrorEvent
	chain: ErrorEvent[]
	isActive: boolean
}

export class CascadeTracker {
	private recentErrors: ErrorEvent[] = []
	private activeCascade: CascadeChain | null = null
	private readonly CASCADE_WINDOW_MS = 30_000 // 30 seconds
	private readonly MAX_CHAIN_LENGTH = 10

	recordError(toolName: string, category: ErrorCategory, message: string): void {
		const event: ErrorEvent = {
			timestamp: Date.now(),
			toolName,
			category,
			message,
		}

		this.recentErrors.push(event)
		this.pruneOldErrors()
		this.detectCascade(event)
	}

	private detectCascade(event: ErrorEvent): void {
		if (!this.activeCascade) {
			// Start a new cascade
			this.activeCascade = {
				rootError: event,
				chain: [event],
				isActive: true,
			}
			return
		}

		const timeSinceRoot = event.timestamp - this.activeCascade.rootError.timestamp

		if (
			timeSinceRoot < this.CASCADE_WINDOW_MS &&
			this.activeCascade.chain.length < this.MAX_CHAIN_LENGTH
		) {
			this.activeCascade.chain.push(event)
		} else {
			// Cascade expired or too long — archive and start new
			this.activeCascade.isActive = false
			this.activeCascade = {
				rootError: event,
				chain: [event],
				isActive: true,
			}
		}
	}

	getActiveCascade(): CascadeChain | null {
		if (this.activeCascade && this.activeCascade.isActive) {
			const age = Date.now() - this.activeCascade.rootError.timestamp
			if (age < this.CASCADE_WINDOW_MS) {
				return this.activeCascade
			}
			this.activeCascade.isActive = false
		}
		return null
	}

	getRecentErrors(toolName?: string, count: number = 5): ErrorEvent[] {
		const filtered = toolName
			? this.recentErrors.filter((e) => e.toolName === toolName)
			: this.recentErrors
		return filtered.slice(-count)
	}

	getCascadeSuggestion(): string | null {
		const cascade = this.getActiveCascade()
		if (!cascade || cascade.chain.length < 2) {
			return null
		}

		const uniqueTools = [...new Set(cascade.chain.map((e) => e.toolName))]

		if (cascade.chain.some((e) => e.category === ErrorCategory.TOOL_NOT_FOUND)) {
			return `⚠️ Cascade failure detected: ${cascade.chain.length} errors in ${uniqueTools.join(", ")}. Tool not available. Use alternative approach.`
		}

		if (cascade.chain.some((e) => e.category === ErrorCategory.DIRECTORY_CONFUSION)) {
			return `⚠️ Cascade failure detected: repeatedly trying to read directories as files. Use list_files first.`
		}

		if (cascade.chain.some((e) => e.category === ErrorCategory.MODEL_THOUGHT_FAILURE)) {
			return `⚠️ Cascade failure detected: model struggling. Break down the task into smaller steps.`
		}

		if (cascade.chain.some((e) => e.category === ErrorCategory.FILE_NOT_FOUND)) {
			return `⚠️ Cascade failure detected: ${cascade.chain.length} file-not-found errors. Verify paths before reading.`
		}

		return `⚠️ ${cascade.chain.length} consecutive errors detected. Consider changing approach.`
	}

	private pruneOldErrors(): void {
		const cutoff = Date.now() - 300_000 // 5 minutes
		this.recentErrors = this.recentErrors.filter((e) => e.timestamp > cutoff)
	}

	reset(): void {
		this.recentErrors = []
		this.activeCascade = null
	}
}
