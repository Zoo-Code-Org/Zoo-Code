import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { FileIndexWriter } from "../../file-completion"
import { FileFailureRegistry } from "../../file-failure-registry"
import { IndexWriteGate } from "../../index-write-gate"
import { ProviderPacerRegistry } from "../../provider-pacer"
import type { CacheManager } from "../../cache-manager"
import type { GenerationAllocator } from "../../generation-allocator"
import type { IEmbedder, IVectorStore, CodeBlock } from "../../interfaces"

export function pacedTransportWriter(store?: IVectorStore) {
	const workspace = path.resolve("/workspace")
	const file = path.join(workspace, "test.ts")
	const failures = new FileFailureRegistry()
	const pacers = new ProviderPacerRegistry()
	const cache = {
		invalidateFile: vi.fn().mockResolvedValue(undefined),
		completeFile: vi.fn(),
		completeRemoval: vi.fn(),
	}
	const vectorStore: IVectorStore = store ?? {
		rateLimitScope: "qdrant:test",
		initialize: vi.fn<IVectorStore["initialize"]>().mockResolvedValue(false),
		upsertPoints: vi.fn<IVectorStore["upsertPoints"]>().mockResolvedValue(undefined),
		deletePointsByFilePath: vi.fn<IVectorStore["deletePointsByFilePath"]>().mockResolvedValue(undefined),
		deletePointsByMultipleFilePaths: vi
			.fn<IVectorStore["deletePointsByMultipleFilePaths"]>()
			.mockResolvedValue(undefined),
		countPointsForFile: vi.fn<IVectorStore["countPointsForFile"]>().mockResolvedValue({ current: 1, other: 0 }),
		search: vi.fn<IVectorStore["search"]>().mockResolvedValue([]),
		clearCollection: vi.fn<IVectorStore["clearCollection"]>().mockResolvedValue(undefined),
		deleteCollection: vi.fn<IVectorStore["deleteCollection"]>().mockResolvedValue(undefined),
		collectionExists: vi.fn<IVectorStore["collectionExists"]>().mockResolvedValue(true),
		hasIndexedData: vi.fn<IVectorStore["hasIndexedData"]>().mockResolvedValue(true),
		markIndexingComplete: vi.fn<IVectorStore["markIndexingComplete"]>().mockResolvedValue(undefined),
		markIndexingIncomplete: vi.fn<IVectorStore["markIndexingIncomplete"]>().mockResolvedValue(undefined),
	}
	const gate = new IndexWriteGate()
	// The cache supplies invalidation/completion; the allocator supplies only allocate.
	const writer = new FileIndexWriter(
		cache as unknown as CacheManager,
		vectorStore,
		gate,
		{ allocate: async () => 1 } as unknown as GenerationAllocator,
		workspace,
		failures,
		pacers,
	)
	const block: CodeBlock = {
		file_path: file,
		identifier: null,
		type: "function",
		start_line: 1,
		end_line: 1,
		content: "test",
		fileHash: "revision",
		segmentHash: "segment",
	}
	return {
		writer,
		gate,
		pacers,
		failures,
		cache,
		file,
		replace: (embedder: IEmbedder, signal = new AbortController().signal) =>
			writer.replace(file, "revision", [block], embedder, signal),
	}
}

export async function waitForTransport(assertion: () => void): Promise<void> {
	const deadline = performance.now() + 2000
	while (true) {
		try {
			assertion()
			return
		} catch (error) {
			if (performance.now() >= deadline) throw error
			await sleep(1)
		}
	}
}
