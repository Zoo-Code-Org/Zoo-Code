import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import { getDefaultModelId, getModelDimension } from "../../../../shared/embeddingModels"
import type { CodeIndexConfig } from "../../interfaces/config"
import { QdrantVectorStore } from "../qdrant-client"
import { VectorStoreFactory } from "../vector-store-factory"

vi.mock("../qdrant-client")
vi.mock("../../../../shared/embeddingModels", () => ({
	getDefaultModelId: vi.fn(),
	getModelDimension: vi.fn(),
}))

describe("VectorStoreFactory", () => {
	let factory: VectorStoreFactory
	let config: CodeIndexConfig

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getDefaultModelId).mockReturnValue("default-model")
		vi.mocked(getModelDimension).mockReturnValue(undefined)
		factory = new VectorStoreFactory()
		config = {
			isConfigured: true,
			embedderProvider: providerIdentifiers.openai,
			modelId: "custom-model",
			modelDimension: 512,
			qdrantUrl: "http://localhost:6333",
		}
	})

	it.each([undefined, 0])("uses the manual dimension when the built-in dimension is %s", (dimension) => {
		vi.mocked(getModelDimension).mockReturnValue(dimension)

		expect(factory.create(config, "/workspace")).toBeInstanceOf(QdrantVectorStore)
		expect(QdrantVectorStore).toHaveBeenCalledWith("/workspace", config.qdrantUrl, 512, undefined)
	})

	it("does not override an invalid negative built-in dimension with the manual dimension", () => {
		vi.mocked(getModelDimension).mockReturnValue(-1)

		expect(() => factory.create(config, "/workspace")).toThrow("serviceFactory.vectorDimensionNotDetermined")
		expect(QdrantVectorStore).not.toHaveBeenCalled()
	})

	it.each([undefined, 0, -1])("rejects an unavailable or invalid manual dimension: %s", (dimension) => {
		config.modelDimension = dimension

		expect(() => factory.create(config, "/workspace")).toThrow("serviceFactory.vectorDimensionNotDetermined")
		expect(QdrantVectorStore).not.toHaveBeenCalled()
	})

	it("rejects Semble before resolving dimensions or creating a store", () => {
		config.embedderProvider = "semble"

		expect(() => factory.create(config, "/workspace")).toThrow("Semble provider handles its own vector storage")
		expect(getModelDimension).not.toHaveBeenCalled()
		expect(getDefaultModelId).not.toHaveBeenCalled()
		expect(QdrantVectorStore).not.toHaveBeenCalled()
	})

	it("uses current configuration and workspace on every call without caching stores", () => {
		const first = factory.create(config, "/first")
		const second = factory.create({ ...config, modelDimension: 1024 }, "/second")

		expect(first).not.toBe(second)
		expect(QdrantVectorStore).toHaveBeenNthCalledWith(1, "/first", config.qdrantUrl, 512, undefined)
		expect(QdrantVectorStore).toHaveBeenNthCalledWith(2, "/second", config.qdrantUrl, 1024, undefined)
	})

	it("reports the dimension error before a missing Qdrant URL", () => {
		config.modelDimension = undefined
		config.qdrantUrl = undefined

		expect(() => factory.create(config, "/workspace")).toThrow("serviceFactory.vectorDimensionNotDetermined")
	})
})
