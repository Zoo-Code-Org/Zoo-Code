import type { MockedClass, MockedFunction } from "vitest"
import { CodeIndexServiceFactory } from "../service-factory"
import { EmbedderFactory } from "../embedders/embedder-factory"
import { VectorStoreFactory } from "../vector-store/vector-store-factory"
import { OpenAiEmbedder } from "../embedders/openai"
import { CodeIndexOllamaEmbedder } from "../embedders/ollama"
import { OpenAICompatibleEmbedder } from "../embedders/openai-compatible"
import { GeminiEmbedder } from "../embedders/gemini"
import { QdrantVectorStore } from "../vector-store/qdrant-client"
import { MistralEmbedder } from "../embedders/mistral"
import { VercelAiGatewayEmbedder } from "../embedders/vercel-ai-gateway"
import { BedrockEmbedder } from "../embedders/bedrock"
import { OpenRouterEmbedder } from "../embedders/openrouter"
import type { CodeIndexConfig } from "../interfaces/config"

import { CodeIndexConfigManager } from "../config-manager"
import { CacheManager } from "../cache-manager"
import { ParseWorkerClient } from "../parse-worker-client"
import { IndexWriteGate } from "../index-write-gate"
import { GenerationAllocator } from "../generation-allocator"
import { FileFailureRegistry } from "../file-failure-registry"
import { ProviderPacerRegistry } from "../provider-pacer"
import { DirectoryScanner } from "../processors/scanner"
import { FileWatcher } from "../processors/file-watcher"
import { makeExtensionContext } from "../../../test-utils/vscode"
import ignore from "ignore"

import { clearAllMocks } from "../../../test-utils/reset"

vitest.mock("../config-manager")
vitest.mock("../cache-manager")
vitest.mock("../parse-worker-client", () => ({
	ParseWorkerClient: vitest.fn(
		class {
			parseFile = vitest.fn<ParseWorkerClient["parseFile"]>().mockResolvedValue([])
			stop = vitest.fn<ParseWorkerClient["stop"]>()
			stopped = Promise.resolve()
			logStopTimeout = vitest.fn<ParseWorkerClient["logStopTimeout"]>()
			dispose = vitest.fn<ParseWorkerClient["dispose"]>()
		},
	),
}))
vitest.mock("../processors/scanner")
vitest.mock("../processors/file-watcher")

// Mock the embedders and vector store
vitest.mock("../embedders/openai")
vitest.mock("../embedders/ollama")
vitest.mock("../embedders/openai-compatible")
vitest.mock("../embedders/gemini")
vitest.mock("../vector-store/qdrant-client")
vitest.mock("../embedders/mistral")
vitest.mock("../embedders/vercel-ai-gateway")
vitest.mock("../embedders/bedrock")
vitest.mock("../embedders/openrouter")

// Mock the embedding models module
vitest.mock("../../../shared/embeddingModels", () => ({
	getDefaultModelId: vitest.fn(),
	getModelDimension: vitest.fn(),
}))

// Mock TelemetryService
vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vitest.fn(),
		},
	},
}))

const MockedOpenAiEmbedder = OpenAiEmbedder as MockedClass<typeof OpenAiEmbedder>
const MockedCodeIndexOllamaEmbedder = CodeIndexOllamaEmbedder as MockedClass<typeof CodeIndexOllamaEmbedder>
const MockedOpenAICompatibleEmbedder = OpenAICompatibleEmbedder as MockedClass<typeof OpenAICompatibleEmbedder>
const MockedGeminiEmbedder = GeminiEmbedder as MockedClass<typeof GeminiEmbedder>
const MockedQdrantVectorStore = QdrantVectorStore as MockedClass<typeof QdrantVectorStore>
const MockedMistralEmbedder = MistralEmbedder as MockedClass<typeof MistralEmbedder>
const MockedVercelAiGatewayEmbedder = VercelAiGatewayEmbedder as MockedClass<typeof VercelAiGatewayEmbedder>
const MockedBedrockEmbedder = BedrockEmbedder as MockedClass<typeof BedrockEmbedder>
const MockedOpenRouterEmbedder = OpenRouterEmbedder as MockedClass<typeof OpenRouterEmbedder>

// Import the mocked functions
import { getDefaultModelId, getModelDimension } from "../../../shared/embeddingModels"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
const mockGetDefaultModelId = getDefaultModelId as MockedFunction<typeof getDefaultModelId>
const mockGetModelDimension = getModelDimension as MockedFunction<typeof getModelDimension>

describe("workspace service integration", () => {
	beforeEach(() => clearAllMocks())
	afterEach(() => vitest.restoreAllMocks())

	function setup(isConfigured = true) {
		const context = makeExtensionContext()
		const cache = new CacheManager(context, "/workspace")
		const watcherCache = new CacheManager(context, "/workspace")
		const configManager = Object.create(CodeIndexConfigManager.prototype) as CodeIndexConfigManager
		const config: CodeIndexConfig = { isConfigured, embedderProvider: "openai-compatible" }
		Object.defineProperty(configManager, "isFeatureConfigured", { value: isConfigured })
		vitest.mocked(configManager.getConfig).mockReturnValue(config)
		const embedder = new OpenAiEmbedder({ openAiNativeApiKey: "test-key" })
		const vectorStore = new QdrantVectorStore("/workspace", "http://localhost:6333", 512)
		const createEmbedder = vitest.spyOn(EmbedderFactory.prototype, "create").mockReturnValue(embedder)
		const createVectorStore = vitest.spyOn(VectorStoreFactory.prototype, "create").mockReturnValue(vectorStore)
		const gate = new IndexWriteGate()
		const generations = new GenerationAllocator(cache)
		const failures = new FileFailureRegistry()
		const providerPacers = new ProviderPacerRegistry()
		const parser = new ParseWorkerClient()
		const isCurrentAttempt = vitest.fn(() => true)
		const ignored = ignore()
		const createFactory = () =>
			new CodeIndexServiceFactory(
				configManager,
				"/workspace",
				cache,
				gate,
				generations,
				failures,
				parser,
				isCurrentAttempt,
				providerPacers,
			)
		return {
			context,
			cache,
			watcherCache,
			configManager,
			config,
			embedder,
			vectorStore,
			createEmbedder,
			createVectorStore,
			gate,
			generations,
			failures,
			parser,
			isCurrentAttempt,
			providerPacers,
			ignored,
			createFactory,
		}
	}

	it("injects the same workspace dependencies into both processors across service and factory recreation", () => {
		const options = setup()
		options.failures.renew("file.ts", "revision")
		const budget = options.failures.getRetryBudget("file.ts", "revision", "embed")
		budget.retriesUsed = 2
		options.failures.record("file.ts", "revision", "embed", "exhausted", 3, "exhausted", "server")
		const reset = vitest.spyOn(options.failures, "resetAllBudgets")
		const renew = vitest.spyOn(options.failures, "renew")
		const clear = vitest.spyOn(options.failures, "clear")
		const initialize = vitest.spyOn(options.generations, "initialize")
		const factory = options.createFactory()

		for (const currentFactory of [factory, factory, options.createFactory()]) {
			const services = currentFactory.createServices(options.context, options.watcherCache, options.ignored)
			const scannerArguments = vitest.mocked(DirectoryScanner).mock.lastCall!
			const watcherArguments = vitest.mocked(FileWatcher).mock.lastCall!
			expect(services).toEqual({
				embedder: options.embedder,
				vectorStore: options.vectorStore,
				parser: options.parser,
				scanner: vitest.mocked(DirectoryScanner).mock.instances.at(-1),
				fileWatcher: vitest.mocked(FileWatcher).mock.instances.at(-1),
			})
			expect(scannerArguments[2]).toBe(options.parser)
			expect(watcherArguments[8]).toBe(options.parser)
			expect(scannerArguments[3]).toBe(options.cache)
			expect(watcherArguments[2]).toBe(options.watcherCache)
			expect(scannerArguments[6]).toBe(options.gate)
			expect(watcherArguments[9]).toBe(options.gate)
			expect(scannerArguments[7]).toBe(options.generations)
			expect(watcherArguments[10]).toBe(options.generations)
			expect(scannerArguments[8]).toBe(options.failures)
			expect(watcherArguments[11]).toBe(options.failures)
			expect(scannerArguments[9]).toBe("/workspace")
			expect(scannerArguments[10]).toBe(options.isCurrentAttempt)
			expect(watcherArguments[12]).toBe(options.isCurrentAttempt)
			expect(scannerArguments[11]).toBe(options.providerPacers)
			expect(watcherArguments[13]).toBe(options.providerPacers)
			for (const current of [true, false]) {
				options.isCurrentAttempt.mockReturnValue(current)
				expect(scannerArguments[10]?.()).toBe(current)
				expect(watcherArguments[12]?.()).toBe(current)
			}
		}

		expect(options.configManager.getConfig).toHaveBeenCalledTimes(3)
		expect(options.createEmbedder).toHaveBeenCalledWith(options.config)
		expect(options.createVectorStore).toHaveBeenCalledWith(options.config, "/workspace")
		expect(options.failures.getRetryBudget("file.ts", "revision", "embed")).toBe(budget)
		expect(budget.retriesUsed).toBe(2)
		expect(options.failures.isExhausted("file.ts", "revision", "embed")).toBe(true)
		expect(reset).not.toHaveBeenCalled()
		expect(renew).not.toHaveBeenCalled()
		expect(clear).not.toHaveBeenCalled()
		expect(initialize).not.toHaveBeenCalled()
		expect(ParseWorkerClient).toHaveBeenCalledTimes(1)
		expect(options.parser.stop).not.toHaveBeenCalled()
	})

	it("preserves the first three arguments and shares defaults within one factory, not across workspaces", async () => {
		const options = setup()
		const firstFactory = new CodeIndexServiceFactory(options.configManager, "/workspace", options.cache)
		const otherFactory = new CodeIndexServiceFactory(options.configManager, "/other", options.cache)
		const first = firstFactory.createServices(options.context, options.cache, options.ignored)
		const second = firstFactory.createServices(options.context, options.cache, options.ignored)
		const other = otherFactory.createServices(options.context, options.cache, options.ignored)
		expect(first.parser).toBeInstanceOf(ParseWorkerClient)
		expect(first.parser).toBe(second.parser)
		expect(first.parser).not.toBe(other.parser)
		const scannerCalls = vitest.mocked(DirectoryScanner).mock.calls
		const watcherCalls = vitest.mocked(FileWatcher).mock.calls
		for (const [scannerPosition, watcherPosition] of [
			[6, 9],
			[7, 10],
			[8, 11],
			[11, 13],
		] as const) {
			expect(scannerCalls[0][scannerPosition]).toBe(scannerCalls[1][scannerPosition])
			expect(scannerCalls[0][scannerPosition]).toBe(watcherCalls[0][watcherPosition])
			expect(scannerCalls[0][scannerPosition]).not.toBe(scannerCalls[2][scannerPosition])
		}
		first.parser.stop()
		expect(first.parser.stop).toHaveBeenCalledOnce()
		await first.parser.stopped
		first.parser.logStopTimeout()
		first.parser.dispose()
		expect(first.parser.logStopTimeout).toHaveBeenCalledOnce()
		expect(first.parser.dispose).toHaveBeenCalledOnce()
	})

	it("rejects unconfigured indexing before constructing processors or reading configuration", () => {
		const options = setup(false)
		const factory = options.createFactory()
		expect(() => factory.createServices(options.context, options.cache, options.ignored)).toThrow(
			"serviceFactory.codeIndexingNotConfigured",
		)
		expect(options.configManager.getConfig).not.toHaveBeenCalled()
		expect(options.createEmbedder).not.toHaveBeenCalled()
		expect(options.createVectorStore).not.toHaveBeenCalled()
		expect(DirectoryScanner).not.toHaveBeenCalled()
		expect(FileWatcher).not.toHaveBeenCalled()
	})
})

describe("CodeIndexServiceFactory", () => {
	let factory: CodeIndexServiceFactory
	let embedderFactory: EmbedderFactory
	let vectorStoreFactory: VectorStoreFactory
	let mockConfigManager: any
	let mockCacheManager: any

	beforeEach(() => {
		clearAllMocks()
		embedderFactory = new EmbedderFactory()
		vectorStoreFactory = new VectorStoreFactory()

		mockConfigManager = {
			getConfig: vitest.fn(),
		}

		mockCacheManager = {}

		factory = new CodeIndexServiceFactory(mockConfigManager, "/test/workspace", mockCacheManager)
	})

	describe("createEmbedder", () => {
		it("uses the current configuration and creates a fresh embedder on every call", () => {
			const config: CodeIndexConfig = {
				isConfigured: true,
				embedderProvider: providerIdentifiers.openai,
				openAiOptions: { openAiNativeApiKey: "test-key" },
				modelId: "first-model",
			}
			mockConfigManager.getConfig.mockReturnValueOnce(config).mockReturnValueOnce({
				...config,
				modelId: "second-model",
			})

			const first = embedderFactory.create(mockConfigManager.getConfig())
			const second = embedderFactory.create(mockConfigManager.getConfig())

			expect(first).not.toBe(second)
			expect(MockedOpenAiEmbedder).toHaveBeenNthCalledWith(1, {
				openAiNativeApiKey: "test-key",
				openAiEmbeddingModelId: "first-model",
			})
			expect(MockedOpenAiEmbedder).toHaveBeenNthCalledWith(2, {
				openAiNativeApiKey: "test-key",
				openAiEmbeddingModelId: "second-model",
			})
		})

		const requiredSettings = [
			["openai", "openAiOptions", "openAiNativeApiKey", "openAiConfigMissing"],
			["ollama", "ollamaOptions", "ollamaBaseUrl", "ollamaConfigMissing"],
			["gemini", "geminiOptions", "apiKey", "geminiConfigMissing"],
			["mistral", "mistralOptions", "apiKey", "mistralConfigMissing"],
			["vercel-ai-gateway", "vercelAiGatewayOptions", "apiKey", "vercelAiGatewayConfigMissing"],
			["bedrock", "bedrockOptions", "region", "bedrockConfigMissing"],
			["openrouter", "openRouterOptions", "apiKey", "openRouterConfigMissing"],
		] as const

		it.each(requiredSettings)("rejects missing options for %s (%s.%s)", (provider, _options, _setting, error) => {
			mockConfigManager.getConfig.mockReturnValue({ embedderProvider: provider })

			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow(`serviceFactory.${error}`)
		})

		it.each(requiredSettings)("rejects empty %s setting %s.%s", (provider, options, setting, error) => {
			mockConfigManager.getConfig.mockReturnValue({
				embedderProvider: provider,
				[options]: { baseUrl: "https://example.com", apiKey: "test-key", [setting]: "" },
			})

			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow(`serviceFactory.${error}`)
		})

		it.each(["constructor", "toString", "__proto__"])("rejects prototype key %s as a provider", (provider) => {
			mockConfigManager.getConfig.mockReturnValue({ embedderProvider: provider })

			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow(
				"serviceFactory.invalidEmbedderType",
			)
		})

		it("preserves OpenAI options and overrides the embedded model without mutating config", () => {
			const openAiOptions = Object.freeze({
				openAiNativeApiKey: "test-key",
				openAiEmbeddingModelId: "old-model",
				openAiBaseUrl: "https://example.com/v1",
			})
			const config: CodeIndexConfig = Object.freeze({
				isConfigured: true,
				embedderProvider: providerIdentifiers.openai,
				modelId: "new-model",
				openAiOptions,
			})
			mockConfigManager.getConfig.mockReturnValue(config)

			const embedder = embedderFactory.create(mockConfigManager.getConfig())

			expect(embedder).toBeInstanceOf(OpenAiEmbedder)
			expect(MockedOpenAiEmbedder).toHaveBeenCalledWith({
				...openAiOptions,
				openAiEmbeddingModelId: "new-model",
			})
			expect(openAiOptions.openAiEmbeddingModelId).toBe("old-model")
		})

		it("preserves Ollama options and overrides the embedded model without mutating config", () => {
			const ollamaOptions = Object.freeze({
				ollamaBaseUrl: "http://localhost:11434",
				ollamaModelId: "old-model",
				ollamaApiKey: "test-key",
			})
			const config: CodeIndexConfig = Object.freeze({
				isConfigured: true,
				embedderProvider: providerIdentifiers.ollama,
				modelId: "new-model",
				ollamaOptions,
			})
			mockConfigManager.getConfig.mockReturnValue(config)

			const embedder = embedderFactory.create(mockConfigManager.getConfig())

			expect(embedder).toBeInstanceOf(CodeIndexOllamaEmbedder)
			expect(MockedCodeIndexOllamaEmbedder).toHaveBeenCalledWith({ ...ollamaOptions, ollamaModelId: "new-model" })
			expect(ollamaOptions.ollamaModelId).toBe("old-model")
		})

		it("should pass model ID to OpenAI embedder when using OpenAI provider", () => {
			// Arrange
			const testModelId = "text-embedding-3-large"
			const testConfig = {
				embedderProvider: providerIdentifiers.openai,
				modelId: testModelId,
				openAiOptions: {
					openAiNativeApiKey: "test-api-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert
			expect(MockedOpenAiEmbedder).toHaveBeenCalledWith({
				openAiNativeApiKey: "test-api-key",
				openAiEmbeddingModelId: testModelId,
			})
		})

		it("should pass model ID to Ollama embedder when using Ollama provider", () => {
			// Arrange
			const testModelId = "nomic-embed-text:latest"
			const testConfig = {
				embedderProvider: providerIdentifiers.ollama,
				modelId: testModelId,
				ollamaOptions: {
					ollamaBaseUrl: "http://localhost:11434",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert
			expect(MockedCodeIndexOllamaEmbedder).toHaveBeenCalledWith({
				ollamaBaseUrl: "http://localhost:11434",
				ollamaModelId: testModelId,
			})
		})

		it("should handle undefined model ID for OpenAI embedder", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.openai,
				modelId: undefined,
				openAiOptions: {
					openAiNativeApiKey: "test-api-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert
			expect(MockedOpenAiEmbedder).toHaveBeenCalledWith({
				openAiNativeApiKey: "test-api-key",
				openAiEmbeddingModelId: undefined,
			})
		})

		it("should handle undefined model ID for Ollama embedder", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.ollama,
				modelId: undefined,
				ollamaOptions: {
					ollamaBaseUrl: "http://localhost:11434",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert
			expect(MockedCodeIndexOllamaEmbedder).toHaveBeenCalledWith({
				ollamaBaseUrl: "http://localhost:11434",
				ollamaModelId: undefined,
			})
		})

		it("should throw error when OpenAI API key is missing", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.openai,
				modelId: "text-embedding-3-large",
				openAiOptions: {
					openAiNativeApiKey: undefined,
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act & Assert
			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow(
				"serviceFactory.openAiConfigMissing",
			)
		})

		it("should throw error when Ollama base URL is missing", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.ollama,
				modelId: "nomic-embed-text:latest",
				ollamaOptions: {
					ollamaBaseUrl: undefined,
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act & Assert
			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow(
				"serviceFactory.ollamaConfigMissing",
			)
		})

		it("should pass model ID to OpenAI Compatible embedder when using OpenAI Compatible provider", () => {
			// Arrange
			const testModelId = "text-embedding-3-large"
			const testConfig = {
				embedderProvider: "openai-compatible",
				modelId: testModelId,
				openAiCompatibleOptions: {
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-api-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert
			expect(MockedOpenAICompatibleEmbedder).toHaveBeenCalledWith(
				"https://api.example.com/v1",
				"test-api-key",
				testModelId,
			)
		})

		it("should handle undefined model ID for OpenAI Compatible embedder", () => {
			// Arrange
			const testConfig = {
				embedderProvider: "openai-compatible",
				modelId: undefined,
				openAiCompatibleOptions: {
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-api-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert
			expect(MockedOpenAICompatibleEmbedder).toHaveBeenCalledWith(
				"https://api.example.com/v1",
				"test-api-key",
				undefined,
			)
		})

		it.each([undefined, ""])("rejects missing or empty OpenAI Compatible base URL: %s", (baseUrl) => {
			// Arrange
			const testConfig = {
				embedderProvider: "openai-compatible",
				modelId: "text-embedding-3-large",
				openAiCompatibleOptions: {
					baseUrl,
					apiKey: "test-api-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act & Assert
			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow("validation.baseUrlRequired")
		})

		it.each([undefined, ""])("rejects missing or empty OpenAI Compatible API key: %s", (apiKey) => {
			// Arrange
			const testConfig = {
				embedderProvider: "openai-compatible",
				modelId: "text-embedding-3-large",
				openAiCompatibleOptions: {
					baseUrl: "https://api.example.com/v1",
					apiKey,
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act & Assert
			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow("validation.apiKeyRequired")
		})

		it("should throw error when OpenAI Compatible options are missing", () => {
			// Arrange
			const testConfig = {
				embedderProvider: "openai-compatible",
				modelId: "text-embedding-3-large",
				openAiCompatibleOptions: undefined,
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act & Assert
			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow("validation.baseUrlRequired")
		})

		it("should create GeminiEmbedder with default model when no modelId specified", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.gemini,
				geminiOptions: {
					apiKey: "test-gemini-api-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert
			expect(MockedGeminiEmbedder).toHaveBeenCalledWith("test-gemini-api-key", undefined)
		})

		it("should create GeminiEmbedder with specified modelId", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.gemini,
				modelId: "gemini-embedding-001",
				geminiOptions: {
					apiKey: "test-gemini-api-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert
			expect(MockedGeminiEmbedder).toHaveBeenCalledWith("test-gemini-api-key", "gemini-embedding-001")
		})

		it("should pass deprecated text-embedding-004 modelId to GeminiEmbedder (migration happens inside GeminiEmbedder)", () => {
			// Arrange - service-factory passes the config modelId directly;
			// GeminiEmbedder handles the migration internally
			const testConfig = {
				embedderProvider: providerIdentifiers.gemini,
				modelId: "text-embedding-004",
				geminiOptions: {
					apiKey: "test-gemini-api-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert - factory passes the original modelId; GeminiEmbedder migrates it internally
			expect(MockedGeminiEmbedder).toHaveBeenCalledWith("test-gemini-api-key", "text-embedding-004")
		})

		it("should throw error when Gemini API key is missing", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.gemini,
				geminiOptions: {
					apiKey: undefined,
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act & Assert
			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow(
				"serviceFactory.geminiConfigMissing",
			)
		})

		it("should throw error when Gemini options are missing", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.gemini,
				geminiOptions: undefined,
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act & Assert
			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow(
				"serviceFactory.geminiConfigMissing",
			)
		})

		it("should pass model ID to Mistral embedder when using Mistral provider", () => {
			// Arrange
			const testModelId = "mistral-embed"
			const testConfig = {
				embedderProvider: providerIdentifiers.mistral,
				modelId: testModelId,
				mistralOptions: {
					apiKey: "test-mistral-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert
			expect(MockedMistralEmbedder).toHaveBeenCalledWith("test-mistral-key", testModelId)
		})

		it("should throw error when Mistral API key is missing", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.mistral,
				modelId: "mistral-embed",
				mistralOptions: {
					apiKey: undefined,
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig)

			// Act & Assert
			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow(
				"serviceFactory.mistralConfigMissing",
			)
		})

		it("should handle undefined model ID for Mistral embedder", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.mistral,
				modelId: undefined,
				mistralOptions: {
					apiKey: "test-mistral-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert — modelId omitted so the embedder selects its documented default model.
			expect(MockedMistralEmbedder).toHaveBeenCalledWith("test-mistral-key", undefined)
		})

		it("should pass model ID to Vercel AI Gateway embedder when using Vercel AI Gateway provider", () => {
			// Arrange
			const testModelId = "vercel-embed-model"
			const testConfig = {
				embedderProvider: providerIdentifiers.vercelAiGateway,
				modelId: testModelId,
				vercelAiGatewayOptions: {
					apiKey: "test-vercel-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert
			expect(MockedVercelAiGatewayEmbedder).toHaveBeenCalledWith("test-vercel-key", testModelId)
		})

		it("should throw error when Vercel AI Gateway API key is missing", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.vercelAiGateway,
				modelId: "vercel-embed-model",
				vercelAiGatewayOptions: {
					apiKey: undefined,
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig)

			// Act & Assert
			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow(
				"serviceFactory.vercelAiGatewayConfigMissing",
			)
		})

		it("should handle undefined model ID for Vercel AI Gateway embedder", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.vercelAiGateway,
				modelId: undefined,
				vercelAiGatewayOptions: {
					apiKey: "test-vercel-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert — modelId omitted so the embedder selects its documented default model.
			expect(MockedVercelAiGatewayEmbedder).toHaveBeenCalledWith("test-vercel-key", undefined)
		})

		it("should pass region, profile and model ID to Bedrock embedder when using Bedrock provider", () => {
			// Arrange
			const testModelId = "amazon.titan-embed-text-v1"
			const testConfig = {
				embedderProvider: providerIdentifiers.bedrock,
				modelId: testModelId,
				bedrockOptions: {
					region: "eu-west-1",
					profile: "test-profile",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert
			expect(MockedBedrockEmbedder).toHaveBeenCalledWith("eu-west-1", "test-profile", testModelId)
		})

		it("should pass undefined profile to Bedrock embedder when no profile is configured", () => {
			// Arrange — Bedrock profile is optional; only region is required.
			const testModelId = "amazon.titan-embed-text-v1"
			const testConfig = {
				embedderProvider: providerIdentifiers.bedrock,
				modelId: testModelId,
				bedrockOptions: {
					region: "us-east-1",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert — profile omitted so the embedder falls back to the default credential chain.
			expect(MockedBedrockEmbedder).toHaveBeenCalledWith("us-east-1", undefined, testModelId)
		})

		it("should throw error when Bedrock region is missing", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.bedrock,
				modelId: "amazon.titan-embed-text-v1",
				bedrockOptions: {
					region: undefined,
					profile: "test-profile",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig)

			// Act & Assert
			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow(
				"serviceFactory.bedrockConfigMissing",
			)
		})

		it("should handle undefined model ID for Bedrock embedder", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.bedrock,
				modelId: undefined,
				bedrockOptions: {
					region: "us-east-1",
					profile: "test-profile",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert — modelId omitted so the embedder selects its documented default model.
			expect(MockedBedrockEmbedder).toHaveBeenCalledWith("us-east-1", "test-profile", undefined)
		})

		it("should pass API key, model ID and specific provider to OpenRouter embedder", () => {
			// Arrange
			const testModelId = "openai/text-embedding-3-large"
			const testConfig = {
				embedderProvider: providerIdentifiers.openrouter,
				modelId: testModelId,
				openRouterOptions: {
					apiKey: "test-openrouter-key",
					specificProvider: providerIdentifiers.openai,
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert
			expect(MockedOpenRouterEmbedder).toHaveBeenCalledWith(
				"test-openrouter-key",
				testModelId,
				undefined,
				"openai",
			)
		})

		it("should pass undefined specificProvider to OpenRouter embedder when no provider is selected", () => {
			// Arrange — specificProvider is optional; only apiKey is required.
			const testModelId = "openai/text-embedding-3-large"
			const testConfig = {
				embedderProvider: providerIdentifiers.openrouter,
				modelId: testModelId,
				openRouterOptions: {
					apiKey: "test-openrouter-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert — specificProvider omitted so the embedder routes to its default provider.
			expect(MockedOpenRouterEmbedder).toHaveBeenCalledWith(
				"test-openrouter-key",
				testModelId,
				undefined,
				undefined,
			)
		})

		it("should throw error when OpenRouter API key is missing", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.openrouter,
				modelId: "openai/text-embedding-3-large",
				openRouterOptions: {
					apiKey: undefined,
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig)

			// Act & Assert
			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow(
				"serviceFactory.openRouterConfigMissing",
			)
		})

		it("should handle undefined model ID for OpenRouter embedder", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.openrouter,
				modelId: undefined,
				openRouterOptions: {
					apiKey: "test-openrouter-key",
					specificProvider: providerIdentifiers.openai,
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig)

			// Act
			embedderFactory.create(mockConfigManager.getConfig())

			// Assert — modelId omitted so the embedder selects its documented default model.
			expect(MockedOpenRouterEmbedder).toHaveBeenCalledWith("test-openrouter-key", undefined, undefined, "openai")
		})

		it("should throw error for invalid embedder provider", () => {
			// Arrange
			const testConfig = {
				embedderProvider: "invalid-provider",
				modelId: "some-model",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act & Assert
			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow(
				"serviceFactory.invalidEmbedderType",
			)
		})

		it("should throw when provider is semble (semble handles its own embedding)", () => {
			const testConfig = {
				embedderProvider: "semble",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow(
				"Semble provider handles its own embedding. Do not call createEmbedder() for semble",
			)
		})
	})

	describe("createVectorStore", () => {
		beforeEach(() => {
			clearAllMocks()
			mockGetDefaultModelId.mockReturnValue("default-model")
		})

		it("should use config.modelId for OpenAI provider", () => {
			// Arrange
			const testModelId = "text-embedding-3-large"
			const testConfig = {
				embedderProvider: providerIdentifiers.openai,
				modelId: testModelId,
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			mockGetModelDimension.mockReturnValue(3072)

			// Act
			vectorStoreFactory.create(mockConfigManager.getConfig(), "/test/workspace")

			// Assert
			expect(mockGetModelDimension).toHaveBeenCalledWith("openai", testModelId)
			expect(MockedQdrantVectorStore).toHaveBeenCalledWith(
				"/test/workspace",
				"http://localhost:6333",
				3072,
				"test-key",
			)
		})

		it("should use config.modelId for Ollama provider", () => {
			// Arrange
			const testModelId = "nomic-embed-text:latest"
			const testConfig = {
				embedderProvider: providerIdentifiers.ollama,
				modelId: testModelId,
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			mockGetModelDimension.mockReturnValue(768)

			// Act
			vectorStoreFactory.create(mockConfigManager.getConfig(), "/test/workspace")

			// Assert
			expect(mockGetModelDimension).toHaveBeenCalledWith("ollama", testModelId)
			expect(MockedQdrantVectorStore).toHaveBeenCalledWith(
				"/test/workspace",
				"http://localhost:6333",
				768,
				"test-key",
			)
		})

		it("should use config.modelId for OpenAI Compatible provider", () => {
			// Arrange
			const testModelId = "text-embedding-3-large"
			const testConfig = {
				embedderProvider: "openai-compatible",
				modelId: testModelId,
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			mockGetModelDimension.mockReturnValue(3072)

			// Act
			vectorStoreFactory.create(mockConfigManager.getConfig(), "/test/workspace")

			// Assert
			expect(mockGetModelDimension).toHaveBeenCalledWith("openai-compatible", testModelId)
			expect(MockedQdrantVectorStore).toHaveBeenCalledWith(
				"/test/workspace",
				"http://localhost:6333",
				3072,
				"test-key",
			)
		})

		it("should prioritize getModelDimension over manual modelDimension for OpenAI Compatible provider", () => {
			// Arrange
			const testModelId = "custom-model"
			const manualDimension = 1024
			const modelDimension = 768
			const testConfig = {
				embedderProvider: "openai-compatible",
				modelId: testModelId,
				modelDimension: manualDimension, // This should be ignored when model has built-in dimension
				openAiCompatibleOptions: {
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-api-key",
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			mockGetModelDimension.mockReturnValue(modelDimension) // This should be used

			// Act
			vectorStoreFactory.create(mockConfigManager.getConfig(), "/test/workspace")

			// Assert
			expect(mockGetModelDimension).toHaveBeenCalledWith("openai-compatible", testModelId)
			expect(MockedQdrantVectorStore).toHaveBeenCalledWith(
				"/test/workspace",
				"http://localhost:6333",
				modelDimension, // Should use model's built-in dimension, not manual
				"test-key",
			)
		})

		it("should use manual modelDimension only when model has no built-in dimension", () => {
			// Arrange
			const testModelId = "unknown-model"
			const manualDimension = 1024
			const testConfig = {
				embedderProvider: "openai-compatible",
				modelId: testModelId,
				modelDimension: manualDimension,
				openAiCompatibleOptions: {
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-api-key",
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			mockGetModelDimension.mockReturnValue(undefined) // Model has no built-in dimension

			// Act
			vectorStoreFactory.create(mockConfigManager.getConfig(), "/test/workspace")

			// Assert
			expect(mockGetModelDimension).toHaveBeenCalledWith("openai-compatible", testModelId)
			expect(MockedQdrantVectorStore).toHaveBeenCalledWith(
				"/test/workspace",
				"http://localhost:6333",
				manualDimension, // Should use manual dimension as fallback
				"test-key",
			)
		})

		it("should fall back to getModelDimension when manual modelDimension is not set for OpenAI Compatible", () => {
			// Arrange
			const testModelId = "custom-model"
			const testConfig = {
				embedderProvider: "openai-compatible",
				modelId: testModelId,
				openAiCompatibleOptions: {
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-key",
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			mockGetModelDimension.mockReturnValue(768)

			// Act
			vectorStoreFactory.create(mockConfigManager.getConfig(), "/test/workspace")

			// Assert
			expect(mockGetModelDimension).toHaveBeenCalledWith("openai-compatible", testModelId)
			expect(MockedQdrantVectorStore).toHaveBeenCalledWith(
				"/test/workspace",
				"http://localhost:6333",
				768,
				"test-key",
			)
		})

		it("should throw error when manual modelDimension is invalid for OpenAI Compatible", () => {
			// Arrange
			const testModelId = "custom-model"
			const testConfig = {
				embedderProvider: "openai-compatible",
				modelId: testModelId,
				modelDimension: 0, // Invalid dimension
				openAiCompatibleOptions: {
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-api-key",
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			mockGetModelDimension.mockReturnValue(undefined)

			// Act & Assert
			expect(() => vectorStoreFactory.create(mockConfigManager.getConfig(), "/test/workspace")).toThrow(
				"serviceFactory.vectorDimensionNotDeterminedOpenAiCompatible",
			)
		})

		it("should throw error when both manual dimension and getModelDimension fail for OpenAI Compatible", () => {
			// Arrange
			const testModelId = "unknown-model"
			const testConfig = {
				embedderProvider: "openai-compatible",
				modelId: testModelId,
				openAiCompatibleOptions: {
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-key",
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			mockGetModelDimension.mockReturnValue(undefined)

			// Act & Assert
			expect(() => vectorStoreFactory.create(mockConfigManager.getConfig(), "/test/workspace")).toThrow(
				"serviceFactory.vectorDimensionNotDeterminedOpenAiCompatible",
			)
		})

		it("should use model-specific dimension for Gemini provider", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.gemini,
				modelId: "gemini-embedding-001",
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			mockGetModelDimension.mockReturnValue(3072)

			// Act
			vectorStoreFactory.create(mockConfigManager.getConfig(), "/test/workspace")

			// Assert
			expect(mockGetModelDimension).toHaveBeenCalledWith("gemini", "gemini-embedding-001")
			expect(MockedQdrantVectorStore).toHaveBeenCalledWith(
				"/test/workspace",
				"http://localhost:6333",
				3072,
				"test-key",
			)
		})

		it("should use default model dimension for Gemini when modelId not specified", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.gemini,
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			mockGetDefaultModelId.mockReturnValue("gemini-embedding-001")
			mockGetModelDimension.mockReturnValue(3072)

			// Act
			vectorStoreFactory.create(mockConfigManager.getConfig(), "/test/workspace")

			// Assert
			expect(mockGetDefaultModelId).toHaveBeenCalledWith("gemini")
			expect(mockGetModelDimension).toHaveBeenCalledWith("gemini", "gemini-embedding-001")
			expect(MockedQdrantVectorStore).toHaveBeenCalledWith(
				"/test/workspace",
				"http://localhost:6333",
				3072,
				"test-key",
			)
		})

		it("should use default model when config.modelId is undefined", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.openai,
				modelId: undefined,
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			mockGetModelDimension.mockReturnValue(1536)

			// Act
			vectorStoreFactory.create(mockConfigManager.getConfig(), "/test/workspace")

			// Assert
			expect(mockGetModelDimension).toHaveBeenCalledWith("openai", "default-model")
			expect(MockedQdrantVectorStore).toHaveBeenCalledWith(
				"/test/workspace",
				"http://localhost:6333",
				1536,
				"test-key",
			)
		})

		it("should throw error when vector dimension cannot be determined", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.openai,
				modelId: "unknown-model",
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			mockGetModelDimension.mockReturnValue(undefined)

			// Act & Assert
			expect(() => vectorStoreFactory.create(mockConfigManager.getConfig(), "/test/workspace")).toThrow(
				"serviceFactory.vectorDimensionNotDetermined",
			)
		})

		it("should throw error when Qdrant URL is missing", () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.openai,
				modelId: "text-embedding-3-small",
				qdrantUrl: undefined,
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			mockGetModelDimension.mockReturnValue(1536)

			// Act & Assert
			expect(() => vectorStoreFactory.create(mockConfigManager.getConfig(), "/test/workspace")).toThrow(
				"serviceFactory.qdrantUrlMissing",
			)
		})

		it("should throw when provider is semble (semble handles its own vector storage)", () => {
			const testConfig = {
				embedderProvider: "semble",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			expect(() => vectorStoreFactory.create(mockConfigManager.getConfig(), "/test/workspace")).toThrow(
				"Semble provider handles its own vector storage. Do not call createVectorStore() for semble",
			)
		})
	})

	describe("validateEmbedder", () => {
		let mockEmbedderInstance: any

		beforeEach(() => {
			mockEmbedderInstance = {
				validateConfiguration: vitest.fn(),
			}
		})

		it("should validate OpenAI embedder successfully", async () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.openai,
				modelId: "text-embedding-3-small",
				openAiOptions: {
					openAiNativeApiKey: "test-api-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			MockedOpenAiEmbedder.mockImplementation(function () {
				return mockEmbedderInstance
			})
			mockEmbedderInstance.validateConfiguration.mockResolvedValue({ valid: true })

			// Act
			const embedder = embedderFactory.create(mockConfigManager.getConfig())
			const result = await factory.validateEmbedder(embedder)

			// Assert
			expect(result).toEqual({ valid: true })
			expect(mockEmbedderInstance.validateConfiguration).toHaveBeenCalled()
		})

		it("should return validation error from OpenAI embedder", async () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.openai,
				modelId: "text-embedding-3-small",
				openAiOptions: {
					openAiNativeApiKey: "invalid-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			MockedOpenAiEmbedder.mockImplementation(function () {
				return mockEmbedderInstance
			})
			mockEmbedderInstance.validateConfiguration.mockResolvedValue({
				valid: false,
				error: "embeddings:validation.authenticationFailed",
			})

			// Act
			const embedder = embedderFactory.create(mockConfigManager.getConfig())
			const result = await factory.validateEmbedder(embedder)

			// Assert
			expect(result).toEqual({
				valid: false,
				error: "embeddings:validation.authenticationFailed",
			})
		})

		it("should validate Ollama embedder successfully", async () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.ollama,
				modelId: "nomic-embed-text",
				ollamaOptions: {
					ollamaBaseUrl: "http://localhost:11434",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			MockedCodeIndexOllamaEmbedder.mockImplementation(function () {
				return mockEmbedderInstance
			})
			mockEmbedderInstance.validateConfiguration.mockResolvedValue({ valid: true })

			// Act
			const embedder = embedderFactory.create(mockConfigManager.getConfig())
			const result = await factory.validateEmbedder(embedder)

			// Assert
			expect(result).toEqual({ valid: true })
			expect(mockEmbedderInstance.validateConfiguration).toHaveBeenCalled()
		})

		it("should validate OpenAI Compatible embedder successfully", async () => {
			// Arrange
			const testConfig = {
				embedderProvider: "openai-compatible",
				modelId: "custom-model",
				openAiCompatibleOptions: {
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-api-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			MockedOpenAICompatibleEmbedder.mockImplementation(function () {
				return mockEmbedderInstance
			})
			mockEmbedderInstance.validateConfiguration.mockResolvedValue({ valid: true })

			// Act
			const embedder = embedderFactory.create(mockConfigManager.getConfig())
			const result = await factory.validateEmbedder(embedder)

			// Assert
			expect(result).toEqual({ valid: true })
			expect(mockEmbedderInstance.validateConfiguration).toHaveBeenCalled()
		})

		it("should validate Gemini embedder successfully", async () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.gemini,
				geminiOptions: {
					apiKey: "test-gemini-api-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			MockedGeminiEmbedder.mockImplementation(function () {
				return mockEmbedderInstance
			})
			mockEmbedderInstance.validateConfiguration.mockResolvedValue({ valid: true })

			// Act
			const embedder = embedderFactory.create(mockConfigManager.getConfig())
			const result = await factory.validateEmbedder(embedder)

			// Assert
			expect(result).toEqual({ valid: true })
			expect(mockEmbedderInstance.validateConfiguration).toHaveBeenCalled()
		})

		it("should handle validation exceptions", async () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.openai,
				modelId: "text-embedding-3-small",
				openAiOptions: {
					openAiNativeApiKey: "test-api-key",
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)
			MockedOpenAiEmbedder.mockImplementation(function () {
				return mockEmbedderInstance
			})
			const networkError = new Error("Network error")
			mockEmbedderInstance.validateConfiguration.mockRejectedValue(networkError)

			// Act
			const embedder = embedderFactory.create(mockConfigManager.getConfig())
			const result = await factory.validateEmbedder(embedder)

			// Assert
			expect(result).toEqual({
				valid: false,
				error: "Network error",
			})
			expect(mockEmbedderInstance.validateConfiguration).toHaveBeenCalled()
		})

		it("should return error for invalid embedder configuration", async () => {
			// Arrange
			const testConfig = {
				embedderProvider: providerIdentifiers.openai,
				modelId: "text-embedding-3-small",
				openAiOptions: {
					openAiNativeApiKey: undefined, // Missing API key
				},
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act & Assert
			// This should throw when trying to create the embedder
			await expect(async () => {
				const embedder = embedderFactory.create(mockConfigManager.getConfig())
				await factory.validateEmbedder(embedder)
			}).rejects.toThrow("serviceFactory.openAiConfigMissing")
		})

		it("should return error for unknown embedder provider", async () => {
			// Arrange
			const testConfig = {
				embedderProvider: "unknown-provider",
				modelId: "some-model",
			}
			mockConfigManager.getConfig.mockReturnValue(testConfig as any)

			// Act & Assert
			// This should throw when trying to create the embedder
			expect(() => embedderFactory.create(mockConfigManager.getConfig())).toThrow(
				"serviceFactory.invalidEmbedderType",
			)
		})
	})
})
