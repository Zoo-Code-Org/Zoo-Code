export class ParserFatalError extends Error {
	constructor(
		public readonly category: "parser-abort" | "parse-timeout",
		public readonly filePath: string,
		message?: string,
	) {
		super(message ?? category)
		this.name = "ParserFatalError"
	}
}

export function abortError(): DOMException {
	return new DOMException("Indexing aborted", "AbortError")
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError()
}

export function isParserAbort(error: unknown): boolean {
	return /Aborted\(|memory access out of bounds/i.test(error instanceof Error ? error.message : String(error))
}
