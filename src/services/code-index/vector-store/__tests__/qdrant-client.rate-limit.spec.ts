import path from "node:path"
import { QdrantClientResourceExhaustedError } from "@qdrant/js-client-rest"
import { QdrantVectorStore } from "../qdrant-client"
import { VectorStoreError } from "../../shared/indexing-errors"
import { ProviderPacerRegistry } from "../../provider-pacer"

const pacers = new ProviderPacerRegistry()

vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

function respondToUpsert(retryAfter: string | undefined) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = input instanceof Request ? input.url : String(input)
			const limited = /\/points\?/.test(url)
			return new Response(
				JSON.stringify(
					limited
						? { status: { error: "limited" }, time: 0 }
						: { result: { status: "completed" }, status: "ok" },
				),
				{
					status: limited ? 429 : 200,
					headers: {
						"content-type": "application/json",
						...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
					},
				},
			)
		}),
	)
}

const point = { id: "1", vector: [1, 0], payload: { filePath: "a.ts" } }

describe("Qdrant Retry-After (CI-QD-02)", () => {
	it.each([
		["61", 61_000],
		["120", 120_000],
	])("reads the whole %s-second header, not its first character", async (header, expected) => {
		respondToUpsert(header)
		const store = new QdrantVectorStore(
			path.resolve("/workspace"),
			"http://example.test:6333",
			2,
			undefined,
			pacers,
		)
		const error = await store.upsertPoints([point]).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(VectorStoreError)
		expect(error).toMatchObject({ classification: "rate-limit", statusCode: 429, retryAfterMs: expected })
		expect((error as VectorStoreError).cause).toBeInstanceOf(QdrantClientResourceExhaustedError)
	})

	it("classifies a 429 without a header as a rate limit with no delay", async () => {
		respondToUpsert(undefined)
		const store = new QdrantVectorStore(
			path.resolve("/workspace"),
			"http://example.test:6333",
			2,
			undefined,
			pacers,
		)
		const error = await store.upsertPoints([point]).catch((caught: unknown) => caught)
		expect(error).toMatchObject({ classification: "rate-limit" })
		expect((error as VectorStoreError).retryAfterMs).toBeUndefined()
	})

	it("scopes Qdrant by normalized URL, independently of workspace and key", () => {
		const first = new QdrantVectorStore("/first", "http://EXAMPLE.test:6333/", 2, "first-key", pacers)
		const same = new QdrantVectorStore("/second", "example.test:6333", 2, "second-key", pacers)
		const other = new QdrantVectorStore("/first", "http://example.test:6334", 2, undefined, pacers)
		expect(first.rateLimitScope).toBe(same.rateLimitScope)
		expect(first.rateLimitScope).not.toBe(other.rateLimitScope)
	})
})
