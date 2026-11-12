import * as vscode from "vscode"
import ignore from "ignore"
import { makeExtensionContext } from "../../../../test-utils/vscode"
import { clearAllMocks } from "../../../../test-utils/reset"
import { Package } from "../../../../shared/package"
import { CacheManager } from "../../cache-manager"
import { BATCH_SEGMENT_THRESHOLD } from "../../constants"
import { OpenAiEmbedder } from "../../embedders/openai"
import { QdrantVectorStore } from "../../vector-store/qdrant-client"
import { ParseWorkerClient } from "../../parse-worker-client"
import { IndexWriteGate } from "../../index-write-gate"
import { GenerationAllocator } from "../../generation-allocator"
import { FileFailureRegistry } from "../../file-failure-registry"
import { ProviderPacerRegistry } from "../../provider-pacer"
import { DirectoryScannerFactory } from "../directory-scanner-factory"
import { FileWatcherFactory } from "../file-watcher-factory"
import { getEmbeddingBatchSize } from "../get-embedding-batch-size"
import { DirectoryScanner } from "../scanner"
import { FileWatcher } from "../file-watcher"

vi.mock("vscode", () => ({
	workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn() })) },
}))
vi.mock("../../cache-manager")
vi.mock("../../embedders/openai")
vi.mock("../../vector-store/qdrant-client")
vi.mock("../../parse-worker-client")
vi.mock("../scanner")
vi.mock("../file-watcher")

describe("processor factories", () => {
	beforeEach(() => clearAllMocks())
	afterEach(() => vi.restoreAllMocks())

	function dependencies() {
		const context = makeExtensionContext()
		const cacheManager = new CacheManager(context, "/workspace")
		return {
			context,
			workspacePath: "/workspace",
			cacheManager,
			embedder: new OpenAiEmbedder({ openAiNativeApiKey: "test-key" }),
			vectorStore: new QdrantVectorStore("/workspace", "http://localhost:6333", 512),
			parser: new ParseWorkerClient(),
			ignoreInstance: ignore(),
			writeGate: new IndexWriteGate(),
			generations: new GenerationAllocator(cacheManager),
			failures: new FileFailureRegistry(),
			isCurrentAttempt: vi.fn(() => true),
			providerPacers: new ProviderPacerRegistry(),
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
				options.writeGate,
				options.generations,
				options.failures,
				options.workspacePath,
				options.isCurrentAttempt,
				options.providerPacers,
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
				options.parser,
				options.writeGate,
				options.generations,
				options.failures,
				options.isCurrentAttempt,
				options.providerPacers,
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

	it("keeps shared retry budgets and current-attempt callbacks across processor recreation", () => {
		const options = dependencies()
		options.failures.renew("file.ts", "revision")
		const budget = options.failures.getRetryBudget("file.ts", "revision", "embed")
		budget.retriesUsed = 2
		const reset = vi.spyOn(options.failures, "resetAllBudgets")
		const scanners = new DirectoryScannerFactory()
		const watchers = new FileWatcherFactory()

		for (const current of [true, false]) {
			options.isCurrentAttempt.mockReturnValue(current)
			scanners.create(options)
			watchers.create(options)
			const scannerArguments = vi.mocked(DirectoryScanner).mock.lastCall!
			const watcherArguments = vi.mocked(FileWatcher).mock.lastCall!
			expect(scannerArguments[2]).toBe(options.parser)
			expect(watcherArguments[8]).toBe(options.parser)
			expect(scannerArguments[6]).toBe(options.writeGate)
			expect(watcherArguments[9]).toBe(options.writeGate)
			expect(scannerArguments[7]).toBe(options.generations)
			expect(watcherArguments[10]).toBe(options.generations)
			expect(scannerArguments[8]).toBe(options.failures)
			expect(watcherArguments[11]).toBe(options.failures)
			expect(scannerArguments[10]).toBe(options.isCurrentAttempt)
			expect(watcherArguments[12]).toBe(options.isCurrentAttempt)
			expect(scannerArguments[11]).toBe(options.providerPacers)
			expect(watcherArguments[13]).toBe(options.providerPacers)
			expect(scannerArguments[10]?.()).toBe(current)
			expect(watcherArguments[12]?.()).toBe(current)
		}

		expect(options.failures.getRetryBudget("file.ts", "revision", "embed")).toBe(budget)
		expect(budget.retriesUsed).toBe(2)
		expect(reset).not.toHaveBeenCalled()
	})

	it("preserves optional constructor defaults for standalone factory callers", () => {
		const { embedder, vectorStore, parser, cacheManager, ignoreInstance, context, workspacePath } = dependencies()
		new DirectoryScannerFactory().create({ embedder, vectorStore, parser, cacheManager, ignoreInstance })
		new FileWatcherFactory().create({ workspacePath, context, embedder, vectorStore, cacheManager, ignoreInstance })

		expect(vi.mocked(DirectoryScanner).mock.lastCall?.slice(6)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		])
		expect(vi.mocked(FileWatcher).mock.lastCall?.slice(8)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		])
	})
})
