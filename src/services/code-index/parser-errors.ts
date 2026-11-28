export type ParserFatalCategory = "timeout" | "crash" | "exit"

export class ParserFatalError extends Error {
	constructor(
		readonly category: ParserFatalCategory,
		readonly filePath: string,
		message?: string,
	) {
		super(message ?? category)
		this.name = "ParserFatalError"
	}
}

export function isParserAbort(error: unknown): boolean {
	return /Aborted\(|memory access out of bounds/i.test(error instanceof Error ? error.message : String(error))
}
