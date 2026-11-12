import "../../__tests__/mock-code-index-log"
import { createServer } from "node:http"
import path from "node:path"
import type { AddressInfo } from "node:net"
import nock from "nock"
import { QdrantClientResourceExhaustedError } from "@qdrant/js-client-rest"
import { QdrantVectorStore } from "../qdrant-client"
import { VectorStoreError } from "../../shared/indexing-errors"
import { pacedTransportWriter, waitForTransport } from "../../embedders/__tests__/paced-transport-writer"
import type { IEmbedder } from "../../interfaces"
import { LATE_WRITE_GRACE_MS } from "../../index-write-gate"

vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))
const now = Date.parse("2026-11-11T12:00:00Z")
const operations = ["upsert", "delete", "verify"] as const
const matchesOperation = (url: string, operation: (typeof operations)[number]) =>
	operation === "verify"
		? url.includes("/count")
		: operation === "delete"
			? url.includes("/delete")
			: /\/points\?/.test(url)

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
	vi.setSystemTime(now)
	vi.spyOn(Math, "random").mockReturnValue(0)
	nock.enableNetConnect("127.0.0.1")
})
afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	nock.disableNetConnect()
})

const scenarios = [
	...operations.flatMap((activity) =>
		[7, 60, 61, 120].map((seconds) => ({
			activity,
			scenario: `numeric ${seconds} seconds, four limits`,
			header: String(seconds) as string | undefined,
			delay: seconds * 1000,
			limits: 4,
		})),
	),
	{
		activity: "upsert",
		scenario: "HTTP date 7 seconds ahead",
		header: new Date(now + 7000).toUTCString(),
		delay: 7000,
		limits: 1,
	},
	{
		activity: "upsert",
		scenario: "HTTP date 120 seconds ahead",
		header: new Date(now + 120_000).toUTCString(),
		delay: 120_000,
		limits: 1,
	},
	{
		activity: "upsert",
		scenario: "past date",
		header: new Date(now - 7000).toUTCString(),
		delay: undefined,
		limits: 1,
	},
	{ activity: "upsert", scenario: "numeric 61 seconds", header: "61", delay: 61_000, limits: 1 },
	{ activity: "upsert", scenario: "missing header", header: undefined, delay: undefined, limits: 1 },
] as const

it.each(scenarios)("T26/T32 HTTP $activity $scenario", async ({ activity, header, delay, limits }) => {
	let requests = 0
	let healthComplete!: () => void
	const health = new Promise<void>((resolve) => {
		healthComplete = resolve
	})
	const perAttempt = activity === "verify" ? 2 : 1
	const server = createServer((request, response) => {
		response.setHeader("content-type", "application/json")
		if (request.url === "/") {
			response.end(JSON.stringify({ title: "qdrant", version: "1.15.0" }), healthComplete)
			return
		}
		const matches = matchesOperation(request.url!, activity)
		if (matches) requests++
		let body = ""
		request.on("data", (chunk) => {
			body += chunk
		})
		request.on("end", () => {
			if (matches && requests <= limits * perAttempt) {
				response.writeHead(429, header === undefined ? {} : { "retry-after": header })
				response.end(JSON.stringify({ status: { error: "limited" }, time: 0 }))
			} else {
				const count = request.url!.includes("/count")
					? JSON.parse(body).filter.must.length === 2
						? 1
						: 0
					: undefined
				response.end(
					JSON.stringify({
						result: count === undefined ? { status: "completed", operation_id: 1 } : { count },
						status: "ok",
						time: 0,
					}),
				)
			}
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	const store = new QdrantVectorStore(path.resolve("/workspace"), endpoint, 2)
	await health
	const method =
		activity === "verify" ? "countPointsForFile" : activity === "delete" ? "deletePointsByFilePath" : "upsertPoints"
	const operation = vi.spyOn(store, method)
	const { replace, failures, cache, pacers, gate } = pacedTransportWriter(store)
	const grace = vi.spyOn(gate, "waitForGrace")
	const controller = new AbortController()
	const embedding = {
		rateLimitScope: "embedder:test",
		createEmbeddings: vi.fn<IEmbedder["createEmbeddings"]>().mockResolvedValue({ embeddings: [[1, 0]] }),
		validateConfiguration: vi.fn<IEmbedder["validateConfiguration"]>().mockResolvedValue({ valid: true }),
		embedderInfo: { name: "openai" },
	} satisfies IEmbedder
	const pending = replace(embedding, controller.signal).catch((error: unknown) => error)
	try {
		for (const index of Array.from({ length: limits }, (_, index) => index)) {
			await waitForTransport(() => {
				expect(operation).toHaveBeenCalledTimes(index + 1)
				expect(pacers.get(store.rateLimitScope).state().pausedUntil).toBe(Date.now() + (delay ?? 500))
				expect(pacers.get(store.rateLimitScope).state().waitingPaths).toEqual(["test.ts"])
			})
			await waitForTransport(() => expect(requests).toBe((index + 1) * perAttempt))
			const error = (await operation.mock.results[index].value.catch(
				(error: unknown) => error,
			)) as VectorStoreError
			expect(error).toBeInstanceOf(VectorStoreError)
			expect(error).toMatchObject({ classification: "rate-limit", statusCode: 429 })
			if (index === 0) {
				expect(error.retryAfterMs).toBe(delay)
				if (header !== undefined && /^\d+$/.test(header)) {
					expect(error.cause).toBeInstanceOf(QdrantClientResourceExhaustedError)
					expect(error.cause).toMatchObject({ retry_after: Number(header) })
				} else {
					const rawError = error.cause as Error & { status: number; headers: Headers }
					expect(rawError).toMatchObject({ name: "Error", status: 429 })
					expect(rawError.headers.get("retry-after")).toBe(header ?? null)
				}
			}
			expect(failures.list()).toEqual([])
			expect(cache.completeFile).not.toHaveBeenCalled()
			vi.advanceTimersByTime((delay ?? 500) - 1)
			expect(requests).toBe((index + 1) * perAttempt)
			vi.advanceTimersByTime(1)
		}
		await waitForTransport(() => expect(requests).toBe((limits + 1) * perAttempt))
		await operation.mock.results[limits].value
		// Successful probes stage subsequent cleanup and verification requests.
		await waitForTransport(() => {
			if (cache.completeFile.mock.calls.length + grace.mock.calls.length === 0) {
				vi.advanceTimersByTime(125)
			}
			expect(cache.completeFile.mock.calls.length + grace.mock.calls.length).toBe(1)
		})
		await vi.advanceTimersByTimeAsync(LATE_WRITE_GRACE_MS)
		await waitForTransport(() => expect(cache.completeFile).toHaveBeenCalledOnce())
		await pending
		expect(requests).toBe((limits + 1) * perAttempt)
		expect(failures.list()).toEqual([])
		expect(cache.completeFile).toHaveBeenCalledOnce()
		expect(embedding.createEmbeddings).toHaveBeenCalledOnce()
	} finally {
		controller.abort()
		await pending
		server.closeAllConnections()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
})
