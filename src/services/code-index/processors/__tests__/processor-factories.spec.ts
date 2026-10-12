import * as vscode from "vscode"
import ignore from "ignore"
import { makeExtensionContext } from "../../../../test-utils/vscode"
import { Package } from "../../../../shared/package"
import { CacheManager } from "../../cache-manager"
import { BATCH_SEGMENT_THRESHOLD } from "../../constants"
import { OpenAiEmbedder } from "../../embedders/openai"
import { QdrantVectorStore } from "../../vector-store/qdrant-client"
import { CodeIndexServiceFactory } from "../../service-factory"
import { CodeIndexConfigManager } from "../../config-manager"
import { EmbedderFactory } from "../../embedders/embedder-factory"
import { VectorStoreFactory } from "../../vector-store/vector-store-factory"
import type { CodeIndexConfig } from "../../interfaces/config"
import { DirectoryScannerFactory } from "../directory-scanner-factory"
import { FileWatcherFactory } from "../file-watcher-factory"
import { getEmbeddingBatchSize } from "../get-embedding-batch-size"
import { codeParser } from "../parser"
import { DirectoryScanner } from "../scanner"
import { FileWatcher } from "../file-watcher"

vi.mock("vscode", () => ({
	workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn() })) },
}))
vi.mock("../../cache-manager")
vi.mock("../../embedders/openai")
vi.mock("../../vector-store/qdrant-client")
vi.mock("../../config-manager")
vi.mock("../parser", () => ({ codeParser: { parseFile: vi.fn() } }))
vi.mock("../scanner")
vi.mock("../file-watcher")

describe("processor factories", () => {
	beforeEach(() => vi.clearAllMocks())
	afterEach(() => vi.restoreAllMocks())

	function dependencies() {
		const context = makeExtensionContext()
		return {
			context,
			workspacePath: "/workspace",
			cacheManager: new CacheManager(context, "/workspace"),
			embedder: new OpenAiEmbedder({ openAiNativeApiKey: "test-key" }),
			vectorStore: new QdrantVectorStore("/workspace", "http://localhost:6333", 512),
			parser: codeParser,
			ignoreInstance: ignore(),
		}
	}

	it.each([32, BATCH_SEGMENT_THRESHOLD])(
		"passes batch size %s and dependencies to both constructors",
		(batchSize) => {
			const configuration = vscode.workspace.getConfiguration()
			vi.mocked(configuration.get).mockReturnValue(batchSize)
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(configuration)
			const options = dependencies()

			const scanner = new DirectoryScannerFactory().create(options)
			const watcher = new FileWatcherFactory().create(options)

			expect(scanner).toBeInstanceOf(DirectoryScanner)
			expect(watcher).toBeInstanceOf(FileWatcher)
			expect(DirectoryScanner).toHaveBeenCalledWith(
				options.embedder,
				options.vectorStore,
				options.parser,
				options.cacheManager,
				options.ignoreInstance,
				batchSize,
			)
			expect(FileWatcher).toHaveBeenCalledWith(
				options.workspacePath,
				options.context,
				options.cacheManager,
				options.embedder,
				options.vectorStore,
				options.ignoreInstance,
				undefined,
				batchSize,
			)
			expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name)
			expect(configuration.get).toHaveBeenCalledWith("codeIndex.embeddingBatchSize", BATCH_SEGMENT_THRESHOLD)
		},
	)

	it("reads settings again for each creation and returns fresh instances", () => {
		const configuration = vscode.workspace.getConfiguration()
		vi.mocked(configuration.get)
			.mockReturnValueOnce(32)
			.mockReturnValueOnce(64)
			.mockReturnValueOnce(128)
			.mockReturnValueOnce(256)
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(configuration)
		const options = dependencies()
		const scanners = new DirectoryScannerFactory()
		const watchers = new FileWatcherFactory()

		expect(scanners.create(options)).not.toBe(scanners.create(options))
		expect(watchers.create(options)).not.toBe(watchers.create(options))
		expect(vi.mocked(DirectoryScanner).mock.calls.map((args) => args[5])).toEqual([32, 64])
		expect(vi.mocked(FileWatcher).mock.calls.map((args) => args[7])).toEqual([128, 256])
	})

	it("uses the fallback when retrieving configuration throws", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const error = new Error("unavailable")
		vi.mocked(vscode.workspace.getConfiguration).mockImplementationOnce(() => {
			throw error
		})
		expect(getEmbeddingBatchSize()).toBe(BATCH_SEGMENT_THRESHOLD)
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			`[getEmbeddingBatchSize] Failed to read codeIndex.embeddingBatchSize; using default ${BATCH_SEGMENT_THRESHOLD}.`,
			error,
		)
	})

	it("uses the fallback when reading the setting throws", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const error = new Error("unavailable")
		const configuration = vscode.workspace.getConfiguration()
		vi.mocked(configuration.get).mockImplementationOnce(() => {
			throw error
		})
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(configuration)
		expect(getEmbeddingBatchSize()).toBe(BATCH_SEGMENT_THRESHOLD)
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			`[getEmbeddingBatchSize] Failed to read codeIndex.embeddingBatchSize; using default ${BATCH_SEGMENT_THRESHOLD}.`,
			error,
		)
	})

	it("does not log a warning when reading the setting succeeds", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const configuration = vscode.workspace.getConfiguration()
		vi.mocked(configuration.get).mockReturnValue(32)
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(configuration)

		expect(getEmbeddingBatchSize()).toBe(32)
		expect(warn).not.toHaveBeenCalled()
	})

	it("preserves service factory wiring, including the explicitly supplied watcher cache", () => {
		const options = dependencies()
		const watcherCache = new CacheManager(options.context, "/workspace")
		const configManager = Object.create(CodeIndexConfigManager.prototype) as CodeIndexConfigManager
		const config: CodeIndexConfig = { isConfigured: true, embedderProvider: "openai-compatible" }
		Object.defineProperty(configManager, "isFeatureConfigured", { value: true })
		vi.mocked(configManager.getConfig).mockReturnValue(config)
		const createEmbedder = vi.spyOn(EmbedderFactory.prototype, "create").mockReturnValue(options.embedder)
		const createVectorStore = vi.spyOn(VectorStoreFactory.prototype, "create").mockReturnValue(options.vectorStore)
		const factory = new CodeIndexServiceFactory(configManager, options.workspacePath, options.cacheManager)

		const services = factory.createServices(options.context, watcherCache, options.ignoreInstance)

		expect(configManager.getConfig).toHaveBeenCalledTimes(1)
		expect(createEmbedder).toHaveBeenCalledExactlyOnceWith(config)
		expect(createVectorStore).toHaveBeenCalledExactlyOnceWith(config, options.workspacePath)
		expect(services).toEqual({
			embedder: options.embedder,
			vectorStore: options.vectorStore,
			parser: codeParser,
			scanner: vi.mocked(DirectoryScanner).mock.instances[0],
			fileWatcher: vi.mocked(FileWatcher).mock.instances[0],
		})
		expect(vi.mocked(DirectoryScanner).mock.calls[0][3]).toBe(options.cacheManager)
		expect(vi.mocked(FileWatcher).mock.calls[0][2]).toBe(watcherCache)
		expect(vi.mocked(FileWatcher).mock.calls[0][0]).toBe(options.workspacePath)
	})

	it("does not create services when indexing is not configured", () => {
		const options = dependencies()
		const configManager = Object.create(CodeIndexConfigManager.prototype) as CodeIndexConfigManager
		Object.defineProperty(configManager, "isFeatureConfigured", { value: false })
		const createEmbedder = vi.spyOn(EmbedderFactory.prototype, "create")
		const createVectorStore = vi.spyOn(VectorStoreFactory.prototype, "create")
		const factory = new CodeIndexServiceFactory(configManager, options.workspacePath, options.cacheManager)

		expect(() => factory.createServices(options.context, options.cacheManager, options.ignoreInstance)).toThrow(
			"serviceFactory.codeIndexingNotConfigured",
		)
		expect(configManager.getConfig).not.toHaveBeenCalled()
		expect(createEmbedder).not.toHaveBeenCalled()
		expect(createVectorStore).not.toHaveBeenCalled()
		expect(DirectoryScanner).not.toHaveBeenCalled()
		expect(FileWatcher).not.toHaveBeenCalled()
	})
})
