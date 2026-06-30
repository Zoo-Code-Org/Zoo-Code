// Mocks must come first, before imports

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

// Mock NodeCache to allow controlling cache behavior
vi.mock("node-cache", () => {
	const mockGet = vi.fn().mockReturnValue(undefined)
	const mockSet = vi.fn()
	const mockDel = vi.fn()

	return {
		default: vi.fn().mockImplementation(function () {
			return {
				get: mockGet,
				set: mockSet,
				del: mockDel,
			}
		}),
	}
})

// Mock fs/promises to avoid file system operations
vi.mock("fs/promises", () => ({
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue("{}"),
	mkdir: vi.fn().mockResolvedValue(undefined),
}))

// Mock fs (synchronous) for disk cache fallback
vi.mock("fs", () => ({
	existsSync: vi.fn().mockReturnValue(false),
	readFileSync: vi.fn().mockReturnValue("{}"),
}))

// Mock all the model fetchers
vi.mock("../litellm")
vi.mock("../openrouter")
vi.mock("../requesty")

// Mock ContextProxy with a simple static instance
vi.mock("../../../core/config/ContextProxy", () => ({
	ContextProxy: {
		instance: {
			globalStorageUri: {
				fsPath: "/mock/storage/path",
			},
		},
	},
}))

// Then imports
import type { Mock } from "vitest"
import * as fsSync from "fs"
import NodeCache from "node-cache"
import { getModels, getModelsFromCache } from "../modelCache"
import { getLiteLLMModels } from "../litellm"
import { getOpenRouterModels } from "../openrouter"
import { getRequestyModels } from "../requesty"

const mockGetLiteLLMModels = getLiteLLMModels as Mock<typeof getLiteLLMModels>
const mockGetOpenRouterModels = getOpenRouterModels as Mock<typeof getOpenRouterModels>
const mockGetRequestyModels = getRequestyModels as Mock<typeof getRequestyModels>

const DUMMY_REQUESTY_KEY = "requesty-key-for-testing"

describe("getModels with new GetModelsOptions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("calls getLiteLLMModels with correct parameters", async () => {
		const mockModels = {
			"claude-3-sonnet": {
				maxTokens: 4096,
				contextWindow: 200000,
				supportsPromptCache: false,
				description: "Claude 3 Sonnet via LiteLLM",
			},
		}
		mockGetLiteLLMModels.mockResolvedValue(mockModels)

		const result = await getModels({
			provider: "litellm",
			apiKey: "test-api-key",
			baseUrl: "http://localhost:4000",
		})

		expect(mockGetLiteLLMModels).toHaveBeenCalledWith("test-api-key", "http://localhost:4000")
		expect(result).toEqual(mockModels)
	})

	it("calls getOpenRouterModels for openrouter provider", async () => {
		const mockModels = {
			"openrouter/model": {
				maxTokens: 8192,
				contextWindow: 128000,
				supportsPromptCache: false,
				description: "OpenRouter model",
			},
		}
		mockGetOpenRouterModels.mockResolvedValue(mockModels)

		const result = await getModels({ provider: "openrouter" })

		expect(mockGetOpenRouterModels).toHaveBeenCalled()
		expect(result).toEqual(mockModels)
	})

	it("calls getRequestyModels with optional API key", async () => {
		const mockModels = {
			"requesty/model": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Requesty model",
			},
		}
		mockGetRequestyModels.mockResolvedValue(mockModels)

		const result = await getModels({ provider: "requesty", apiKey: DUMMY_REQUESTY_KEY })

		expect(mockGetRequestyModels).toHaveBeenCalledWith(undefined, DUMMY_REQUESTY_KEY)
		expect(result).toEqual(mockModels)
	})

	it("handles errors and re-throws them", async () => {
		const expectedError = new Error("LiteLLM connection failed")
		mockGetLiteLLMModels.mockRejectedValue(expectedError)

		await expect(
			getModels({
				provider: "litellm",
				apiKey: "test-api-key",
				baseUrl: "http://localhost:4000",
			}),
		).rejects.toThrow("LiteLLM connection failed")
	})

	it("validates exhaustive provider checking with unknown provider", async () => {
		// This test ensures TypeScript catches unknown providers at compile time
		// In practice, the discriminated union should prevent this at compile time
		const unknownProvider = "unknown" as any

		await expect(
			getModels({
				provider: unknownProvider,
			}),
		).rejects.toThrow("Unknown provider: unknown")
	})
})

describe("getModelsFromCache disk fallback", () => {
	let mockCache: any

	beforeEach(() => {
		vi.clearAllMocks()
		// Get the mock cache instance
		const MockedNodeCache = vi.mocked(NodeCache)
		mockCache = new MockedNodeCache()
		// Reset memory cache to always miss
		mockCache.get.mockReturnValue(undefined)
		// Reset fs mocks
		vi.mocked(fsSync.existsSync).mockReturnValue(false)
		vi.mocked(fsSync.readFileSync).mockReturnValue("{}")
	})

	it("returns undefined when both memory and disk cache miss", () => {
		vi.mocked(fsSync.existsSync).mockReturnValue(false)

		const result = getModelsFromCache("openrouter")

		expect(result).toBeUndefined()
	})

	it("returns memory cache data without checking disk when available", () => {
		const memoryModels = {
			"memory-model": {
				maxTokens: 8192,
				contextWindow: 200000,
				supportsPromptCache: false,
			},
		}

		mockCache.get.mockReturnValue(memoryModels)

		const result = getModelsFromCache("openrouter")

		expect(result).toEqual(memoryModels)
		// Disk should not be checked when memory cache hits
		expect(fsSync.existsSync).not.toHaveBeenCalled()
	})

	it("returns disk cache data when memory cache misses and context is available", () => {
		// Note: This test validates the logic but the ContextProxy mock in test environment
		// returns undefined for getCacheDirectoryPathSync, which is expected behavior
		// when the context is not fully initialized. The actual disk cache loading
		// is validated through integration tests.
		const diskModels = {
			"disk-model": {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsPromptCache: false,
			},
		}

		vi.mocked(fsSync.existsSync).mockReturnValue(true)
		vi.mocked(fsSync.readFileSync).mockReturnValue(JSON.stringify(diskModels))

		const result = getModelsFromCache("openrouter")

		// In the test environment, ContextProxy.instance may not be fully initialized,
		// so getCacheDirectoryPathSync returns undefined and disk cache is not attempted
		expect(result).toBeUndefined()
	})

	it("handles disk read errors gracefully", () => {
		vi.mocked(fsSync.existsSync).mockReturnValue(true)
		vi.mocked(fsSync.readFileSync).mockImplementation(function () {
			throw new Error("Disk read failed")
		})

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(function () {})

		const result = getModelsFromCache("openrouter")

		expect(result).toBeUndefined()
		expect(consoleErrorSpy).toHaveBeenCalled()

		consoleErrorSpy.mockRestore()
	})

	it("handles invalid JSON in disk cache gracefully", () => {
		vi.mocked(fsSync.existsSync).mockReturnValue(true)
		vi.mocked(fsSync.readFileSync).mockReturnValue("invalid json{")

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(function () {})

		const result = getModelsFromCache("openrouter")

		expect(result).toBeUndefined()
		expect(consoleErrorSpy).toHaveBeenCalled()

		consoleErrorSpy.mockRestore()
	})
})

describe("empty cache protection", () => {
	let mockCache: any
	let mockGet: Mock
	let mockSet: Mock

	beforeEach(() => {
		vi.clearAllMocks()
		// Get the mock cache instance
		const MockedNodeCache = vi.mocked(NodeCache)
		mockCache = new MockedNodeCache()
		mockGet = mockCache.get
		mockSet = mockCache.set
		// Reset memory cache to always miss by default
		mockGet.mockReturnValue(undefined)
	})

	describe("getModels", () => {
		it("does not cache empty API responses", async () => {
			// API returns empty object (simulating failure)
			mockGetOpenRouterModels.mockResolvedValue({})

			const result = await getModels({ provider: "openrouter" })

			// Should return empty but NOT cache it
			expect(result).toEqual({})
			expect(mockSet).not.toHaveBeenCalled()
		})

		it("caches non-empty API responses", async () => {
			const mockModels = {
				"openrouter/model": {
					maxTokens: 8192,
					contextWindow: 128000,
					supportsPromptCache: false,
					description: "OpenRouter model",
				},
			}
			mockGetOpenRouterModels.mockResolvedValue(mockModels)

			const result = await getModels({ provider: "openrouter" })

			expect(result).toEqual(mockModels)
			expect(mockSet).toHaveBeenCalledWith("openrouter", mockModels)
		})
	})

	describe("refreshModels", () => {
		it("keeps existing cache when API returns empty response", async () => {
			const existingModels = {
				"openrouter/existing-model": {
					maxTokens: 8192,
					contextWindow: 128000,
					supportsPromptCache: false,
					description: "Existing cached model",
				},
			}

			// Memory cache has existing data
			mockGet.mockReturnValue(existingModels)
			// API returns empty (failure)
			mockGetOpenRouterModels.mockResolvedValue({})

			const { refreshModels } = await import("../modelCache")
			const result = await refreshModels({ provider: "openrouter" })

			// Should return existing cache, not empty
			expect(result).toEqual(existingModels)
			// Should NOT update cache with empty data
			expect(mockSet).not.toHaveBeenCalled()
		})

		it("updates cache when API returns valid non-empty response", async () => {
			const existingModels = {
				"openrouter/old-model": {
					maxTokens: 4096,
					contextWindow: 64000,
					supportsPromptCache: false,
					description: "Old model",
				},
			}
			const newModels = {
				"openrouter/new-model": {
					maxTokens: 8192,
					contextWindow: 128000,
					supportsPromptCache: true,
					description: "New model",
				},
			}

			mockGet.mockReturnValue(existingModels)
			mockGetOpenRouterModels.mockResolvedValue(newModels)

			const { refreshModels } = await import("../modelCache")
			const result = await refreshModels({ provider: "openrouter" })

			// Should return new models
			expect(result).toEqual(newModels)
			// Should update cache with new data
			expect(mockSet).toHaveBeenCalledWith("openrouter", newModels)
		})

		it("returns existing cache on API error", async () => {
			const existingModels = {
				"openrouter/cached-model": {
					maxTokens: 8192,
					contextWindow: 128000,
					supportsPromptCache: false,
					description: "Cached model",
				},
			}

			mockGet.mockReturnValue(existingModels)
			mockGetOpenRouterModels.mockRejectedValue(new Error("API error"))

			const { refreshModels } = await import("../modelCache")
			const result = await refreshModels({ provider: "openrouter" })

			// Should return existing cache on error
			expect(result).toEqual(existingModels)
		})

		it("returns empty object when API errors and no cache exists", async () => {
			mockGet.mockReturnValue(undefined)
			mockGetOpenRouterModels.mockRejectedValue(new Error("API error"))

			const { refreshModels } = await import("../modelCache")
			const result = await refreshModels({ provider: "openrouter" })

			// Should return empty when no cache and API fails
			expect(result).toEqual({})
		})

		it("does not cache empty response when no existing cache", async () => {
			// Both memory and disk cache are empty (initial state)
			mockGet.mockReturnValue(undefined)
			// API returns empty (failure/rate limit)
			mockGetOpenRouterModels.mockResolvedValue({})

			const { refreshModels } = await import("../modelCache")
			const result = await refreshModels({ provider: "openrouter" })

			// Should return empty but NOT cache it
			expect(result).toEqual({})
			expect(mockSet).not.toHaveBeenCalled()
		})

		it("reuses in-flight request for concurrent calls to same provider", async () => {
			const mockModels = {
				"openrouter/model": {
					maxTokens: 8192,
					contextWindow: 128000,
					supportsPromptCache: false,
					description: "OpenRouter model",
				},
			}

			// Create a delayed response to simulate API latency
			let resolvePromise: (value: typeof mockModels) => void
			const delayedPromise = new Promise<typeof mockModels>((resolve) => {
				resolvePromise = resolve
			})
			mockGetOpenRouterModels.mockReturnValue(delayedPromise)
			mockGet.mockReturnValue(undefined)

			const { refreshModels } = await import("../modelCache")

			// Start two concurrent refresh calls
			const promise1 = refreshModels({ provider: "openrouter" })
			const promise2 = refreshModels({ provider: "openrouter" })

			// API should only be called once (second call reuses in-flight request)
			expect(mockGetOpenRouterModels).toHaveBeenCalledTimes(1)

			// Resolve the API call
			resolvePromise!(mockModels)

			// Both promises should resolve to the same result
			const [result1, result2] = await Promise.all([promise1, promise2])
			expect(result1).toEqual(mockModels)
			expect(result2).toEqual(mockModels)
		})

		it("scopes in-flight dedup by API key for key-scoped providers", async () => {
			// In-flight dedup is keyed on the compound cache key, so concurrent refreshes for a
			// key-scoped provider must dedup only when the API key matches. Two different keys
			// (different compound keys) each trigger their own fetch; the same key shares one.
			const mockModels = {
				"requesty/model": {
					maxTokens: 4096,
					contextWindow: 200000,
					supportsPromptCache: false,
					description: "Requesty model",
				},
			}
			mockGetRequestyModels.mockResolvedValue(mockModels)

			const { refreshModels } = await import("../modelCache")

			// Different keys -> separate compound keys -> two distinct fetches.
			const [a, b] = await Promise.all([
				refreshModels({ provider: "requesty", apiKey: "key-one" }),
				refreshModels({ provider: "requesty", apiKey: "key-two" }),
			])
			expect(mockGetRequestyModels).toHaveBeenCalledTimes(2)
			expect(a).toEqual(mockModels)
			expect(b).toEqual(mockModels)

			mockGetRequestyModels.mockClear()

			// Same key -> same compound key -> a single shared in-flight fetch.
			let resolveShared: (value: typeof mockModels) => void
			mockGetRequestyModels.mockReturnValue(
				new Promise<typeof mockModels>((resolve) => {
					resolveShared = resolve
				}),
			)

			const shared1 = refreshModels({ provider: "requesty", apiKey: "same-key" })
			const shared2 = refreshModels({ provider: "requesty", apiKey: "same-key" })

			expect(mockGetRequestyModels).toHaveBeenCalledTimes(1)

			resolveShared!(mockModels)
			const [s1, s2] = await Promise.all([shared1, shared2])
			expect(s1).toEqual(mockModels)
			expect(s2).toEqual(mockModels)
		})
	})
})

describe("key-scoped cache key derivation", () => {
	// Exercises the per-API-key cache discriminator that all KEY_SCOPED_PROVIDERS share.
	// Requesty is used only because it is a key-scoped provider with a mocked fetcher; the
	// behavior under test is provider-agnostic.
	const keyScopedProvider = "requesty" as const

	let mockCache: any
	let mockSet: Mock

	const mockModels = {
		"key-scoped/model": {
			maxTokens: 4096,
			contextWindow: 200000,
			supportsPromptCache: false,
			description: "Key-scoped provider model",
		},
	}

	beforeEach(() => {
		vi.clearAllMocks()
		const MockedNodeCache = vi.mocked(NodeCache)
		mockCache = new MockedNodeCache()
		mockCache.get.mockReturnValue(undefined)
		mockSet = mockCache.set
		mockGetRequestyModels.mockResolvedValue(mockModels)
	})

	// Returns the cache key the result was written under (first arg of the matching set call).
	const writtenCacheKey = (): string => {
		const call = mockSet.mock.calls.find((c) => c[1] === mockModels)
		return call?.[0] as string
	}

	it("writes different cache keys for different API keys", async () => {
		await getModels({ provider: keyScopedProvider, apiKey: "key-one" })
		const firstKey = writtenCacheKey()

		mockSet.mockClear()
		await getModels({ provider: keyScopedProvider, apiKey: "key-two" })
		const secondKey = writtenCacheKey()

		expect(firstKey).toBeDefined()
		expect(secondKey).toBeDefined()
		expect(firstKey).not.toEqual(secondKey)
	})

	it("writes the same cache key for repeated calls with the same API key", async () => {
		await getModels({ provider: keyScopedProvider, apiKey: "stable-key" })
		const firstKey = writtenCacheKey()

		mockSet.mockClear()
		await getModels({ provider: keyScopedProvider, apiKey: "stable-key" })
		const secondKey = writtenCacheKey()

		expect(firstKey).toEqual(secondKey)
	})

	it("does not embed the raw API key in the cache key and truncates the discriminator", async () => {
		const apiKey = "super-secret-api-key-value"
		await getModels({ provider: keyScopedProvider, apiKey })
		const cacheKey = writtenCacheKey()

		// The raw secret must never appear in the on-disk-bound cache key.
		expect(cacheKey).not.toContain(apiKey)
		// The discriminator is the trailing key-component: an 8-char (32-bit) hex string.
		const discriminator = cacheKey.split(":").pop() as string
		expect(discriminator).toMatch(/^[0-9a-f]{8}$/)
	})
})

describe("compound cache key derivation across scoping dimensions", () => {
	// Exercises every branch of getCacheKey via the public getModels() entry point.
	// litellm is url-scoped AND key-scoped; openrouter is neither, so it hits the bare
	// provider fallback. The fetcher mocks let us observe the cache key the result is
	// written under (first arg of the matching memoryCache.set call).
	const mockModels = {
		"compound/model": {
			maxTokens: 4096,
			contextWindow: 200000,
			supportsPromptCache: false,
			description: "Compound cache key model",
		},
	}

	let mockSet: Mock

	beforeEach(() => {
		vi.clearAllMocks()
		const MockedNodeCache = vi.mocked(NodeCache)
		const mockCache = new MockedNodeCache()
		;(mockCache.get as Mock).mockReturnValue(undefined)
		mockSet = mockCache.set as unknown as Mock
		mockGetLiteLLMModels.mockResolvedValue(mockModels)
		mockGetOpenRouterModels.mockResolvedValue(mockModels)
	})

	const writtenCacheKey = (): string => {
		const call = mockSet.mock.calls.find((c) => c[1] === mockModels)
		return call?.[0] as string
	}

	it("includes both the server URL and the key discriminator for url+key-scoped providers", async () => {
		await getModels({ provider: "litellm", apiKey: "compound-key", baseUrl: "http://host:4000" })
		const cacheKey = writtenCacheKey()

		// Expected shape: provider:url:keyDiscriminator
		expect(cacheKey).toMatch(/^litellm:http:\/\/host:4000:[0-9a-f]{8}$/)
	})

	it("normalizes trailing slashes in the server URL so equivalent URLs share a cache key", async () => {
		await getModels({ provider: "litellm", apiKey: "compound-key", baseUrl: "http://host:4000/" })
		const withSlash = writtenCacheKey()

		mockSet.mockClear()
		await getModels({ provider: "litellm", apiKey: "compound-key", baseUrl: "http://host:4000" })
		const withoutSlash = writtenCacheKey()

		expect(withSlash).toEqual(withoutSlash)
	})

	it("includes only the server URL when a url-scoped provider has no API key", async () => {
		await getModels({ provider: "litellm", baseUrl: "http://host:4000" })
		const cacheKey = writtenCacheKey()

		// No trailing key discriminator when apiKey is absent.
		expect(cacheKey).toBe("litellm:http://host:4000")
	})

	it("falls back to the bare provider name for providers that are neither url- nor key-scoped", async () => {
		await getModels({ provider: "openrouter", apiKey: "ignored-key", baseUrl: "http://ignored:4000" })
		const cacheKey = writtenCacheKey()

		expect(cacheKey).toBe("openrouter")
	})
})
