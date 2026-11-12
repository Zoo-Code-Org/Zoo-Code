import "../../__tests__/mock-code-index-log"
import path from "node:path"
import { QdrantClientResourceExhaustedError } from "@qdrant/js-client-rest"
import { QdrantVectorStore } from "../qdrant-client"
import { pacedTransportWriter } from "../../embedders/__tests__/paced-transport-writer"
import { VectorStoreError } from "../../shared/indexing-errors"
import type { IEmbedder } from "../../interfaces"
import { LATE_WRITE_GRACE_MS } from "../../index-write-gate"

vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))
const now = Date.parse("2026-11-11T12:00:00Z")
beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(now)
	vi.spyOn(Math, "random").mockReturnValue(0)
})
afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

const operations = ["upsert", "delete", "verify"] as const
const matchesOperation = (url: string, operation: (typeof operations)[number]) =>
	operation === "verify"
		? url.includes("/count")
		: operation === "delete"
			? url.includes("/delete")
			: /\/points\?/.test(url)

function installTransport(activity: (typeof operations)[number], header: string | undefined, limitedAttempts = 1) {
	const requests = vi.fn()
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input)
			const matches = matchesOperation(url, activity)
			if (matches) requests()
			const limited = matches && requests.mock.calls.length <= limitedAttempts * (activity === "verify" ? 2 : 1)
			const body = input instanceof Request ? await input.clone().text() : String(options?.body ?? "{}")
			const count = url.includes("/count") ? (JSON.parse(body).filter.must.length === 2 ? 1 : 0) : undefined
			return new Response(
				JSON.stringify(
					limited
						? { status: { error: "limited" }, time: 0 }
						: url.endsWith("/")
							? { title: "qdrant", version: "1.15.0" }
							: {
									result: count === undefined ? { status: "completed", operation_id: 1 } : { count },
									status: "ok",
									time: 0,
								},
				),
				{
					status: limited ? 429 : 200,
					headers: {
						"content-type": "application/json",
						...(header === undefined ? {} : { "retry-after": header }),
					},
				},
			)
		}),
	)
	return requests
}

const embedder = () =>
	({
		rateLimitScope: "embedder:test",
		createEmbeddings: vi.fn<IEmbedder["createEmbeddings"]>().mockResolvedValue({ embeddings: [[1, 0]] }),
		validateConfiguration: vi.fn<IEmbedder["validateConfiguration"]>().mockResolvedValue({ valid: true }),
		embedderInfo: { name: "openai" },
	}) satisfies IEmbedder

describe.each(operations)("T26 Qdrant %s pacing", (activity) => {
	it.each([7, 60, 61, 120])(
		"honors %s seconds across four limits and completes without failures",
		async (seconds) => {
			const requests = installTransport(activity, String(seconds), 4)
			const store = new QdrantVectorStore(path.resolve("/workspace"), "http://example.test:6333", 2)
			const { replace, failures, cache } = pacedTransportWriter(store)
			const embedding = embedder()
			const pending = replace(embedding)
			await vi.advanceTimersByTimeAsync(0)
			const perAttempt = activity === "verify" ? 2 : 1
			for (const index of [0, 1, 2, 3]) {
				expect(requests).toHaveBeenCalledTimes((index + 1) * perAttempt)
				expect(failures.list()).toEqual([])
				expect(cache.completeFile).not.toHaveBeenCalled()
				await vi.advanceTimersByTimeAsync(seconds * 1000 - 1)
				expect(requests).toHaveBeenCalledTimes((index + 1) * perAttempt)
				await vi.advanceTimersByTimeAsync(1)
			}
			await vi.advanceTimersByTimeAsync(LATE_WRITE_GRACE_MS)
			await pending
			expect(requests).toHaveBeenCalledTimes(5 * perAttempt)
			expect(failures.list()).toEqual([])
			expect(cache.completeFile).toHaveBeenCalledOnce()
			expect(embedding.createEmbeddings).toHaveBeenCalledOnce()
		},
	)
})

it.each([
	{ scenario: "HTTP date 7 seconds ahead", header: new Date(now + 7000).toUTCString(), delay: 7000 },
	{ scenario: "HTTP date 120 seconds ahead", header: new Date(now + 120_000).toUTCString(), delay: 120_000 },
	{ scenario: "past HTTP date", header: new Date(now - 7000).toUTCString(), delay: undefined },
	{ scenario: "numeric 61 seconds", header: "61", delay: 61_000 },
	{ scenario: "missing header", header: undefined, delay: undefined },
])("T32 $scenario preserves the raw error and waits without a cap", async ({ header, delay }) => {
	const requests = installTransport("upsert", header)
	const store = new QdrantVectorStore(path.resolve("/workspace"), "http://example.test:6333", 2)
	const upsert = vi.spyOn(store, "upsertPoints")
	const { replace, failures, cache } = pacedTransportWriter(store)
	const pending = replace(embedder())
	await vi.advanceTimersByTimeAsync(0)
	const result = upsert.mock.results[0]
	const error = (await result.value.catch((error: unknown) => error)) as VectorStoreError
	expect(error).toBeInstanceOf(VectorStoreError)
	expect(error).toMatchObject({ classification: "rate-limit", statusCode: 429 })
	expect(error.retryAfterMs).toBe(delay)
	if (header === "61") {
		expect(error.cause).toBeInstanceOf(QdrantClientResourceExhaustedError)
		expect(error.cause).toMatchObject({ retry_after: 61 })
	} else {
		const rawError = error.cause as Error & { status: number; headers: Headers }
		expect(rawError).toMatchObject({ name: "Error", status: 429 })
		expect(rawError.headers.get("retry-after")).toBe(header ?? null)
	}
	expect(requests).toHaveBeenCalledOnce()
	expect(failures.list()).toEqual([])
	await vi.advanceTimersByTimeAsync((delay ?? 500) - 1)
	expect(requests).toHaveBeenCalledOnce()
	await vi.advanceTimersByTimeAsync(1)
	await vi.advanceTimersByTimeAsync(LATE_WRITE_GRACE_MS)
	await pending
	expect(requests).toHaveBeenCalledTimes(2)
	expect(failures.list()).toEqual([])
	expect(cache.completeFile).toHaveBeenCalledOnce()
})

it("scopes Qdrant by normalized URL, independently of workspace and key", () => {
	installTransport("upsert", undefined, 0)
	const first = new QdrantVectorStore("/first", "http://EXAMPLE.test:6333/", 2, "first-key")
	const same = new QdrantVectorStore("/second", "example.test:6333", 2, "second-key")
	const other = new QdrantVectorStore("/first", "http://example.test:6334", 2)
	expect(first.rateLimitScope).toBe(same.rateLimitScope)
	expect(first.rateLimitScope).not.toBe(other.rateLimitScope)
	expect(first.rateLimitScope).toMatch(/^qdrant:[a-f0-9]{64}$/)
})
