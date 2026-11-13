import { FileIndexWriter } from "../file-index-writer"
import { FileFailureRegistry } from "../file-failure-registry"
import { ProviderPacerRegistry } from "../provider-pacer"
import type { CodeBlock, IEmbedder, IVectorStore } from "../interfaces"

vi.mock("../embedders/cancellation", () => ({ waitForRetry: vi.fn(() => Promise.resolve()) }))

const workspace = "/ws"
const block = (line: number): CodeBlock => ({
	file_path: "/ws/a.ts",
	identifier: null,
	type: "function",
	start_line: line,
	end_line: line + 1,
	content: `code ${line}`,
	fileHash: "h1",
	segmentHash: `s${line}`,
})
const serverError = () => Object.assign(new Error("server down"), { status: 503 })

function setup() {
	const embedder = {
		rateLimitScope: "openai:1",
		createEmbeddings: vi.fn(async (texts: string[]) => ({ embeddings: texts.map(() => [0.1]) })),
	}
	const store = {
		rateLimitScope: "qdrant:1",
		upsertPoints: vi.fn(async () => {}),
		deletePointsByFilePath: vi.fn(async () => {}),
	}
	const cache = { updateHash: vi.fn(), deleteHash: vi.fn() }
	const failures = new FileFailureRegistry()
	const pacers = new ProviderPacerRegistry()
	const run = vi.spyOn(pacers.get("openai:1"), "run")
	// The doubles provide only the embedder and store members the writer calls.
	const writer = new FileIndexWriter(
		embedder as unknown as IEmbedder,
		store as unknown as IVectorStore,
		cache,
		failures,
		pacers,
		workspace,
		1,
	)
	return { writer, embedder, store, cache, failures, run }
}

describe("FileIndexWriter", () => {
	it("CI-WR-01: success updates the hash and clears the entry", async () => {
		const { writer, cache, failures, store } = setup()
		failures.renew("a.ts", "h1")
		failures.record("a.ts", "h1", "read", "old", 1, "exhausted")
		await expect(writer.replace("/ws/a.ts", "h1", [block(1)])).resolves.toBe(true)
		expect(cache.updateHash).toHaveBeenCalledWith("/ws/a.ts", "h1")
		expect(failures.list()).toEqual([])
		const [[points]] = store.upsertPoints.mock.calls as unknown as [[Array<{ payload: { filePath: string } }>]]
		expect(points[0].payload.filePath).toBe("a.ts")
	})

	it("uses the same point id for the same path and start line", async () => {
		const { writer, store } = setup()
		await writer.replace("/ws/a.ts", "h1", [block(3)])
		await writer.replace("/ws/a.ts", "h2", [{ ...block(3), content: "changed", segmentHash: "other" }])
		const ids = (store.upsertPoints.mock.calls as unknown as Array<[Array<{ id: string }>]>).map(
			([points]) => points[0].id,
		)
		expect(ids[0]).toBe(ids[1])
	})

	it.each(["embed", "upsert"] as const)(
		"CI-WR-02: exhausted %s records the activity and keeps the hash",
		async (activity) => {
		const context = setup()
		if (activity === "embed") context.embedder.createEmbeddings.mockRejectedValue(serverError())
		else context.store.upsertPoints.mockRejectedValue(serverError())
		await expect(context.writer.replace("/ws/a.ts", "h1", [block(1)])).resolves.toBe(false)
		expect(context.cache.updateHash).not.toHaveBeenCalled()
		expect(context.failures.get("a.ts")).toMatchObject({ activity, state: "exhausted", attempt: 3 })
		},
	)

	it("CI-WR-02: removal failure is recorded as delete and keeps the hash", async () => {
		const { writer, store, cache, failures } = setup()
		store.deletePointsByFilePath.mockRejectedValue(serverError())
		await expect(writer.remove("/ws/a.ts")).resolves.toBe(false)
		expect(cache.deleteHash).not.toHaveBeenCalled()
		expect(failures.get("a.ts")).toMatchObject({ activity: "delete", state: "exhausted" })
	})

	it("CI-WR-03: each embed attempt goes through the pacer exactly once", async () => {
		const { writer, embedder, run } = setup()
		embedder.createEmbeddings.mockRejectedValueOnce(serverError())
		await writer.replace("/ws/a.ts", "h1", [block(1), block(5)])
		expect(embedder.createEmbeddings).toHaveBeenCalledTimes(3)
		expect(run).toHaveBeenCalledTimes(3)
	})

	it("CI-WR-04: writes nothing to the registry or cache after the signal aborts", async () => {
		const { writer, embedder, cache, failures } = setup()
		const controller = new AbortController()
		embedder.createEmbeddings.mockImplementation(async () => {
			controller.abort()
			throw serverError()
		})
		await expect(writer.replace("/ws/a.ts", "h1", [block(1)], controller.signal)).rejects.toBeDefined()
		expect(cache.updateHash).not.toHaveBeenCalled()
		expect(failures.list()).toEqual([])
	})

	it("removal success deletes the hash and clears prior failures", async () => {
		const { writer, cache, failures } = setup()
		failures.renew("a.ts", "h1")
		failures.record("a.ts", "h1", "embed", "old", 3, "exhausted")
		await expect(writer.remove("/ws/a.ts")).resolves.toBe(true)
		expect(cache.deleteHash).toHaveBeenCalledWith("/ws/a.ts")
		expect(failures.list()).toEqual([])
	})
})
