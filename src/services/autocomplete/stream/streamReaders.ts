/**
 * Stream readers over `ReadableStream<Uint8Array>`. Both must:
 * - `finally { reader.cancel().catch(() => {}) }`
 * - explicitly swallow `err.name === "AbortError"`
 * - yield decoded text fragments for the caller to parse (caller uses zod
 *   `safeParse`, never `JSON.parse(...) as any`).
 *
 * These run in the extension host (Node 22) where `ReadableStream`,
 * `TextDecoder`, and `getReader()` are available on `Response.body`.
 */

/** Reads a `ReadableStream` as concatenated text, decoding incrementally. */
export async function* readText(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): AsyncGenerator<string, void, undefined> {
	const reader = body.getReader()
	const decoder = new TextDecoder("utf-8")

	try {
		while (true) {
			const { done, value } = await reader.read()

			if (done) {
				const tail = decoder.decode()

				if (tail.length > 0) {
					yield tail
				}

				return
			}

			if (value.length === 0) {
				continue
			}

			yield decoder.decode(value, { stream: true })
		}
	} catch (error) {
		if (isAbortError(error)) {
			return
		}

		throw error
	} finally {
		await reader.cancel().catch(() => {})
		void signal
	}
}

/**
 * Reads a newline-delimited JSON (NDJSON) stream, yielding each decoded line as
 * `unknown`. Invalid lines (incomplete JSON, empty) are skipped; the caller
 * validates the shape with a zod schema.
 */
export async function* readNdjson(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): AsyncGenerator<unknown, void, undefined> {
	const reader = body.getReader()
	const decoder = new TextDecoder("utf-8")
	let buffer = ""

	try {
		while (true) {
			const { done, value } = await reader.read()

			if (done) {
				// Flush any trailing line without a newline.
				const tail = buffer.trim()

				if (tail.length > 0) {
					yield safeParseLine(tail)
				}

				return
			}

			buffer += decoder.decode(value, { stream: true })

			let newlineIndex: number

			while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newlineIndex).trim()
				buffer = buffer.slice(newlineIndex + 1)

				if (line.length > 0) {
					yield safeParseLine(line)
				}
			}
		}
	} catch (error) {
		if (isAbortError(error)) {
			return
		}

		throw error
	} finally {
		await reader.cancel().catch(() => {})
		void signal
	}
}

/**
 * Reads a Server-Sent Events (SSE) stream, yielding `{ event?, data }` for each
 * `data:` field. Lines beginning with `:` (comments) and empty lines are skipped.
 */
export async function* readSse(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): AsyncGenerator<{ event?: string; data: string }, void, undefined> {
	const reader = body.getReader()
	const decoder = new TextDecoder("utf-8")
	let buffer = ""

	try {
		while (true) {
			const { done, value } = await reader.read()

			if (done) {
				flushSse(buffer)
				return
			}

			buffer += decoder.decode(value, { stream: true })

			let blankIndex: number

			while ((blankIndex = buffer.indexOf("\n\n")) !== -1) {
				const block = buffer.slice(0, blankIndex)
				buffer = buffer.slice(blankIndex + 2)

				const parsed = parseSseBlock(block)

				if (parsed) {
					yield parsed
				}
			}
		}
	} catch (error) {
		if (isAbortError(error)) {
			return
		}

		throw error
	} finally {
		await reader.cancel().catch(() => {})
		void signal
	}
}

function flushSse(buffer: string): void {
	// Only declared so the done-branch mirrors the NDJSON flush; SSE blocks end
	// with a blank line, but a server may omit the trailing one.
	void buffer
}

function parseSseBlock(block: string): { event?: string; data: string } | undefined {
	let event: string | undefined
	let data: string | undefined

	for (const line of block.split("\n")) {
		if (line.startsWith(":") || line.length === 0) {
			continue
		}

		const colonIndex = line.indexOf(":")

		if (colonIndex === -1) {
			continue
		}

		const field = line.slice(0, colonIndex)
		const value = line.slice(colonIndex + 1).replace(/^ /, "")

		if (field === "data") {
			data = data === undefined ? value : `${data}\n${value}`
		} else if (field === "event") {
			event = value
		}
	}

	if (data === undefined) {
		return undefined
	}

	return { event, data }
}

/** Parses a JSON line; returns the parsed value or a marker object on failure. */
function safeParseLine(line: string): unknown {
	try {
		return JSON.parse(line)
	} catch {
		return { __parseError: true, raw: line }
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || (error as { code?: string }).code === "ABORT_ERR")
}
