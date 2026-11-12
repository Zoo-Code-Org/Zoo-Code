import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"
import path from "node:path"
import nock from "nock"
import { QdrantClientResourceExhaustedError } from "@qdrant/js-client-rest"
import { QdrantVectorStore } from "../qdrant-client"
import { VectorStoreError } from "../../shared/indexing-errors"
import { retryWithPolicy, type RetryFailure } from "../../shared/retry-policy"
import { waitForRetry } from "../../embedders/cancellation"

vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("../../code-index-log", () => ({
	codeIndexLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("../../embedders/cancellation", () => ({ waitForRetry: vi.fn().mockResolvedValue(undefined) }))

let server: Server
let store: QdrantVectorStore
let responseStatus: number
let retryAfter: string | undefined
let requests: Array<{ method: string | undefined; url: string; body: unknown }>
const workspacePath = path.resolve("qdrant-contract-workspace")

beforeEach(async () => {
	vi.clearAllMocks()
	nock.enableNetConnect("127.0.0.1")
	responseStatus = 200
	retryAfter = undefined
	requests = []
	server = createServer((incoming, outgoing) => {
		const chunks: Buffer[] = []
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
		incoming.on("end", () => {
			const body = Buffer.concat(chunks).toString()
			const url = incoming.url ?? ""
			if (url === "/") {
				outgoing.writeHead(200, { "content-type": "application/json" })
				outgoing.end(JSON.stringify({ title: "qdrant", version: "1.20.0" }))
				return
			}
			requests.push({ method: incoming.method, url, body: body ? JSON.parse(body) : undefined })
			outgoing.writeHead(responseStatus, {
				"content-type": "application/json",
				...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
			})
			const result = url.includes("/count") ? { count: 2 } : { status: "completed", operation_id: 1 }
			outgoing.end(
				JSON.stringify({ result, status: responseStatus === 200 ? "ok" : { error: "failure" }, time: 0 }),
			)
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	if (!address || typeof address === "string") throw new Error("Expected a TCP test listener")
	store = new QdrantVectorStore(workspacePath, `http://127.0.0.1:${address.port}`, 2)
})

afterEach(async () => {
	vi.restoreAllMocks()
	server.closeAllConnections()
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

function operation(activity: "upsert" | "delete" | "verify"): Promise<unknown> {
	if (activity === "upsert") {
		return store.upsertPoints([
			{ id: "00000000-0000-4000-8000-000000000001", vector: [1, 0], payload: { filePath: "file.ts" } },
		])
	}
	if (activity === "delete") return store.deletePointsByFilePath("file.ts", 2)
	return store.countPointsForFile("file.ts", 2)
}

it("runs the exact pinned package rather than a stale install", () => {
	const require = createRequire(import.meta.url)
	const installed: unknown = require(
		path.resolve(path.dirname(require.resolve("@qdrant/js-client-rest")), "../../package.json"),
	)
	expect(installed).toMatchObject({ version: "1.20.0" })
})

it.each([
	["upsert", 60],
	["delete", 60],
	["verify", 60],
	["upsert", 61],
	["delete", 61],
	["verify", 61],
] as const)("%s preserves the complete Retry-After %s header through real HTTP", async (activity, seconds) => {
	responseStatus = 429
	retryAfter = String(seconds)
	const failures: RetryFailure[] = []
	const budget = { retriesUsed: 2 }
	const error: unknown = await retryWithPolicy(() => operation(activity), {
		activity,
		budget,
		onFailure: (failure) => failures.push(failure),
	}).catch((failure: unknown) => failure)
	expect(waitForRetry).not.toHaveBeenCalled()
	expect(failures).toEqual([])
	expect(budget.retriesUsed).toBe(2)
	expect(error).toBeInstanceOf(VectorStoreError)
	if (!(error instanceof VectorStoreError)) throw new Error("Expected a classified vector-store error")
	expect(error).toMatchObject({ retryAfterMs: seconds * 1000, classification: "rate-limit", statusCode: 429 })
	expect(error.cause).toBeInstanceOf(QdrantClientResourceExhaustedError)
	expect(error.cause).toMatchObject({ retry_after: seconds })
	expect(requests).toHaveLength(activity === "verify" ? 2 : 1)
})

it.each(["upsert", "delete", "verify"] as const)("%s is a single attempt without the policy", async (activity) => {
	responseStatus = 503
	await expect(operation(activity)).rejects.toMatchObject({ classification: "server", statusCode: 503 })
	expect(requests).toHaveLength(activity === "verify" ? 2 : 1)
	expect(waitForRetry).not.toHaveBeenCalled()
})

it.each([400, 401, 403, 408, 409])("HTTP %s is permanent and never retried", async (status) => {
	responseStatus = status
	await expect(retryWithPolicy(() => operation("upsert"))).rejects.toMatchObject({
		classification: "permanent",
		attempts: 1,
		statusCode: status,
	})
	expect(requests).toHaveLength(1)
	expect(waitForRetry).not.toHaveBeenCalled()
})

it("deletes exact file paths only below the generation cutoff", async () => {
	await store.deletePointsByMultipleFilePaths([path.join(workspacePath, "file.ts"), "other.ts"], 2)
	expect(requests).toHaveLength(1)
	expect(requests[0].body).toEqual({
		filter: {
			must: [
				{ key: "filePath", match: { any: ["file.ts", "other.ts"] } },
				{ should: [{ key: "generation", range: { lt: 2 } }, { is_empty: { key: "generation" } }] },
			],
		},
	})
	expect(requests[0].url).toContain("wait=true")
})

it("counts the exact current generation separately from all other points", async () => {
	await expect(store.countPointsForFile(path.join(workspacePath, "file.ts"), 2)).resolves.toEqual({
		current: 2,
		other: 2,
	})
	expect(requests.map(({ body }) => body)).toEqual([
		{
			filter: {
				must: [
					{ key: "filePath", match: { value: "file.ts" } },
					{ key: "generation", match: { value: 2 } },
				],
			},
			exact: true,
		},
		{
			filter: {
				must: [{ key: "filePath", match: { value: "file.ts" } }],
				must_not: [{ key: "generation", match: { value: 2 } }],
			},
			exact: true,
		},
	])
})

it.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
	"rejects unsafe generation %s before either delete entry point",
	async (generation) => {
		await expect(store.deletePointsByFilePath("file.ts", generation)).rejects.toThrow("generation cutoff")
		await expect(store.deletePointsByMultipleFilePaths(["file.ts"], generation)).rejects.toThrow(
			"generation cutoff",
		)
		expect(requests).toHaveLength(0)
	},
)

it("accepts generation zero through both delete entry points and skips an empty file list", async () => {
	await store.deletePointsByFilePath("file.ts", 0)
	await store.deletePointsByMultipleFilePaths(["file.ts"], 0)
	await store.deletePointsByMultipleFilePaths([], 0)
	expect(requests).toHaveLength(2)
})

it("creates the required verification indexes before the optional indexes", async () => {
	await store["_createPayloadIndexes"]()
	expect(requests.slice(0, 2).map(({ body }) => body)).toEqual([
		{ field_name: "filePath", field_schema: "keyword" },
		{ field_name: "generation", field_schema: "integer" },
	])
	expect(requests).toHaveLength(8)
	expect(requests.every(({ url }) => url.includes("wait=true"))).toBe(true)
})

it.each(["filePath", "generation"])("does not swallow a required %s index failure", async (fieldName) => {
	const createIndex = vi.spyOn(store["client"], "createPayloadIndex")
	if (fieldName === "generation") createIndex.mockResolvedValueOnce({ status: "completed", operation_id: 1 })
	const error = new Error("required index failed")
	createIndex.mockRejectedValueOnce(error)
	await expect(store["_createPayloadIndexes"]()).rejects.toBe(error)
	expect(createIndex).toHaveBeenCalledTimes(fieldName === "generation" ? 2 : 1)
})
