import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai"
import { QdrantClientTimeoutError } from "@qdrant/js-client-rest"
import {
	classifyIndexingError,
	getIndexingErrorStatusCode,
	EmbeddingError,
	VectorStoreError,
	parseRetryAfterMs,
} from "../indexing-errors"
import { formatEmbeddingError } from "../validation-helpers"
import { IndexingRetryError } from "../indexing-errors"

vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))

describe("indexing error classification", () => {
	it.each([
		[{ status: 429 }, "rate-limit"],
		[{ status: 500 }, "server"],
		[{ statusCode: 503 }, "server"],
		[{ response: { status: 502 } }, "server"],
		[{ $metadata: { httpStatusCode: 503 } }, "server"],
		[{ status: 408 }, "permanent"],
		[{ status: 409 }, "permanent"],
		[{ status: 401 }, "permanent"],
		[{ status: "500", statusCode: 429 }, "rate-limit"],
		[{ status: 400, statusCode: 503 }, "permanent"],
		[{ status: 400, code: "ECONNRESET" }, "permanent"],
		[new Error("HTTP 503: ECONNREFUSED"), "permanent"],
		[new TypeError("validation"), "permanent"],
		[new TypeError("fetch failed", { cause: new Error("network") }), "connection"],
		[new APIConnectionError({ cause: new Error("network") }), "connection"],
		[new APIConnectionTimeoutError(), "connection"],
		[new QdrantClientTimeoutError("timeout"), "connection"],
		[{ name: "TimeoutError" }, "connection"],
		[{ name: "AbortError", status: 503 }, "permanent"],
		[new APIUserAbortError(), "permanent"],
		[{ name: "ThrottlingException" }, "permanent"],
		[undefined, "permanent"],
	] as const)("classifies %o as %s", (error, classification) => {
		expect(classifyIndexingError(error)).toBe(classification)
	})

	it.each([
		"ECONNRESET",
		"ECONNREFUSED",
		"ETIMEDOUT",
		"ENOTFOUND",
		"EAI_AGAIN",
		"EPIPE",
		"UND_ERR_SOCKET",
		"ERR_HTTP2_STREAM_CANCEL",
	])("walks causes for %s", (code) => {
		expect(classifyIndexingError(new Error("outer", { cause: { code } }))).toBe("connection")
	})

	it("handles cycles and preserves status precedence", () => {
		const error = { status: 400, cause: {} }
		error.cause = error
		expect(classifyIndexingError(error)).toBe("permanent")
		expect(getIndexingErrorStatusCode({ cause: { statusCode: 503 } })).toBe(503)
	})

	it("lets caller cancellation override structured transient errors", () => {
		const error = new EmbeddingError("server", { status: 503 })
		expect(classifyIndexingError(error, AbortSignal.abort())).toBe("permanent")
	})

	it.each([EmbeddingError, VectorStoreError])("preserves fields and the raw cause in %s", (ErrorClass) => {
		const cause = { $metadata: { httpStatusCode: 503 } }
		const error = new ErrorClass("unchanged", cause)
		expect(error.message).toBe("unchanged")
		expect(error.cause).toBe(cause)
		expect(error.statusCode).toBe(503)
		expect(error.classification).toBe("server")
		expect(classifyIndexingError(new Error("outer", { cause: error }))).toBe("server")
	})

	it("classifies raw errors before translated formatting", () => {
		const cause = new APIConnectionTimeoutError()
		const error = formatEmbeddingError(cause)
		expect(error).toBeInstanceOf(EmbeddingError)
		expect(error.message).toBe("embeddings:failedWithError")
		expect(error.cause).toBe(cause)
		expect(error.classification).toBe("connection")
	})
})

describe("parseRetryAfterMs", () => {
	const now = Date.parse("2026-11-10T12:00:00Z")
	it.each([
		[{ "Retry-After": "2" }, 2000],
		[new Headers({ "retry-after-ms": "2500", "retry-after": "60" }), 2500],
		[{ "retry-after-ms": "invalid", "retry-after": "60" }, 60_000],
		[{ "retry-after-ms": "-1", "retry-after": "61" }, 61_000],
		[{ "retry-after": new Date(now + 61_000).toUTCString() }, 61_000],
		[{ "retry-after": new Date(now - 1000).toUTCString() }, undefined],
		[{ "retry-after": "-1" }, undefined],
		[{ "retry-after": "" }, undefined],
		[{ "retry-after": "invalid" }, undefined],
		[{ "retry-after": "Infinity" }, undefined],
		[7, 7000],
		[0, 0],
		[-1, undefined],
		[Infinity, undefined],
		[undefined, undefined],
	] as const)("parses %o", (source, expected) => {
		expect(parseRetryAfterMs(source, now)).toBe(expected)
	})

	it.each([EmbeddingError, VectorStoreError])("preserves delay and explicit override in %s", (ErrorClass) => {
		const cause = { status: 429, headers: new Headers({ "retry-after": "2" }) }
		expect(new ErrorClass("limited", cause)).toMatchObject({ retryAfterMs: 2000, cause })
		expect(new ErrorClass("limited", cause, { retryAfterMs: 7000 })).toMatchObject({ retryAfterMs: 7000 })
	})
})

it.each(["2", "invalid", undefined])(
	"T33 discovers header delay once across formatting and retry wrappers: %s",
	(value) => {
		const get = vi.fn((name: string) => (name === "retry-after" ? value : undefined))
		const original = { status: 429, headers: { get } }
		const formatted = formatEmbeddingError(original)
		const retried = new IndexingRetryError(formatted, 3, "rate-limit", "embed")
		expect(retried.retryAfterMs).toBe(value === "2" ? 2000 : undefined)
		expect(formatted.retryAfterMs).toBe(retried.retryAfterMs)
		expect(get.mock.calls.filter(([name]) => name === "retry-after")).toHaveLength(1)
		get.mockClear()
		const constructed = new EmbeddingError("limited", original)
		expect(constructed.retryAfterMs).toBe(formatted.retryAfterMs)
		expect(get.mock.calls.filter(([name]) => name === "retry-after")).toHaveLength(1)
	},
)

it("T33 explicit delay wins without reading headers", () => {
	const get = vi.fn()
	const error = new VectorStoreError("limited", { status: 429, headers: { get } }, { retryAfterMs: 7000 })
	expect(error.retryAfterMs).toBe(7000)
	expect(get).not.toHaveBeenCalled()
})
