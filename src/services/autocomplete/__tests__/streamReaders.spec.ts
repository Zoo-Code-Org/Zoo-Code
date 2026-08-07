import { readNdjson, readSse, readText } from "../stream/streamReaders"

/** Builds a `ReadableStream` over the given chunks, encoded as UTF-8. */
function streamOf(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()

	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
			}

			controller.close()
		},
	})
}

/** A stream whose first read rejects, for the error and abort paths. */
function failingStream(error: Error): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.error(error)
		},
	})
}

function abortError(): Error {
	const error = new Error("aborted")
	error.name = "AbortError"
	return error
}

async function collect<T>(generator: AsyncGenerator<T, void, undefined>): Promise<T[]> {
	const out: T[] = []

	for await (const item of generator) {
		out.push(item)
	}

	return out
}

describe("readText", () => {
	it("yields decoded fragments in order", async () => {
		const chunks = await collect(readText(streamOf("hello ", "world"), new AbortController().signal))

		expect(chunks.join("")).toBe("hello world")
	})

	it("skips empty chunks", async () => {
		const chunks = await collect(readText(streamOf("a", new Uint8Array(), "b"), new AbortController().signal))

		expect(chunks).toEqual(["a", "b"])
	})

	it("reassembles a multi-byte character split across chunks", async () => {
		// "é" is 0xC3 0xA9; a naive per-chunk decode emits two replacement chars.
		const chunks = await collect(
			readText(streamOf(new Uint8Array([0xc3]), new Uint8Array([0xa9])), new AbortController().signal),
		)

		expect(chunks.join("")).toBe("é")
	})

	it("returns silently when the stream aborts", async () => {
		const chunks = await collect(readText(failingStream(abortError()), new AbortController().signal))

		expect(chunks).toEqual([])
	})

	it("rethrows a non-abort error", async () => {
		await expect(collect(readText(failingStream(new Error("boom")), new AbortController().signal))).rejects.toThrow(
			"boom",
		)
	})
})

describe("readNdjson", () => {
	it("yields one parsed value per line", async () => {
		const body = streamOf('{"a":1}\n{"a":2}\n')
		const values = await collect(readNdjson(body, new AbortController().signal))

		expect(values).toEqual([{ a: 1 }, { a: 2 }])
	})

	it("joins a line split across chunk boundaries", async () => {
		const values = await collect(readNdjson(streamOf('{"a"', ":1}\n"), new AbortController().signal))

		expect(values).toEqual([{ a: 1 }])
	})

	it("flushes a trailing line that has no newline", async () => {
		const values = await collect(readNdjson(streamOf('{"a":1}'), new AbortController().signal))

		expect(values).toEqual([{ a: 1 }])
	})

	it("skips blank lines", async () => {
		const values = await collect(readNdjson(streamOf('{"a":1}\n\n\n{"a":2}\n'), new AbortController().signal))

		expect(values).toEqual([{ a: 1 }, { a: 2 }])
	})

	it("marks an unparseable line instead of throwing", async () => {
		// The caller validates with zod, so a malformed line must not kill the stream.
		const values = await collect(readNdjson(streamOf("not json\n"), new AbortController().signal))

		expect(values).toEqual([{ __parseError: true, raw: "not json" }])
	})

	it("returns silently when the stream aborts", async () => {
		const values = await collect(readNdjson(failingStream(abortError()), new AbortController().signal))

		expect(values).toEqual([])
	})

	it("rethrows a non-abort error", async () => {
		await expect(
			collect(readNdjson(failingStream(new Error("boom")), new AbortController().signal)),
		).rejects.toThrow("boom")
	})
})

describe("readSse", () => {
	it("yields the data field of each event block", async () => {
		const values = await collect(readSse(streamOf("data: one\n\ndata: two\n\n"), new AbortController().signal))

		expect(values).toEqual([
			{ event: undefined, data: "one" },
			{ event: undefined, data: "two" },
		])
	})

	it("captures the event name alongside the data", async () => {
		const values = await collect(readSse(streamOf("event: delta\ndata: hi\n\n"), new AbortController().signal))

		expect(values).toEqual([{ event: "delta", data: "hi" }])
	})

	it("concatenates repeated data fields with a newline", async () => {
		const values = await collect(readSse(streamOf("data: a\ndata: b\n\n"), new AbortController().signal))

		expect(values).toEqual([{ event: undefined, data: "a\nb" }])
	})

	it("ignores comment lines and blocks with no data field", async () => {
		const values = await collect(
			readSse(streamOf(": keep-alive\n\nevent: ping\n\ndata: real\n\n"), new AbortController().signal),
		)

		expect(values).toEqual([{ event: undefined, data: "real" }])
	})

	it("strips only a single leading space from the value", async () => {
		const values = await collect(readSse(streamOf("data:  padded\n\n"), new AbortController().signal))

		expect(values).toEqual([{ event: undefined, data: " padded" }])
	})

	it("skips a field line with no colon", async () => {
		const values = await collect(readSse(streamOf("garbage\ndata: ok\n\n"), new AbortController().signal))

		expect(values).toEqual([{ event: undefined, data: "ok" }])
	})

	it("joins a block split across chunk boundaries", async () => {
		const values = await collect(readSse(streamOf("data: sp", "lit\n\n"), new AbortController().signal))

		expect(values).toEqual([{ event: undefined, data: "split" }])
	})

	it("returns silently when the stream aborts", async () => {
		const values = await collect(readSse(failingStream(abortError()), new AbortController().signal))

		expect(values).toEqual([])
	})

	it("rethrows a non-abort error", async () => {
		await expect(collect(readSse(failingStream(new Error("boom")), new AbortController().signal))).rejects.toThrow(
			"boom",
		)
	})
})
