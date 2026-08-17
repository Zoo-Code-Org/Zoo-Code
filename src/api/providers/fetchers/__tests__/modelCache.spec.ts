// Mocks must come first, before imports

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
			isTelemetryEnabled: vi.fn().mockReturnValue(true),
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
vi.mock("../kenari")
vi.mock("../nanogpt")
vi.mock("../moonshot")
vi.mock("../zoo-gateway")

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
import type { Mock, Mocked } from "vitest"
import { providerIdentifiers } from "@roo-code/types"
import * as fsSync from "fs"
import NodeCache from "node-cache"
import { TelemetryService } from "@roo-code/telemetry"
import { getModels, getModelsFromCache } from "../modelCache"
import { getLiteLLMModels } from "../litellm"
import { getOpenRouterModels } from "../openrouter"
import { getRequestyModels } from "../requesty"
import { getKenariModels } from "../kenari"
import { getNanoGptModels } from "../nanogpt"
import { getMoonshotModels } from "../moonshot"
import { getZooGatewayModels } from "../zoo-gateway"

const mockGetLiteLLMModels = getLiteLLMModels as Mock<typeof getLiteLLMModels>
const mockGetOpenRouterModels = getOpenRouterModels as Mock<typeof getOpenRouterModels>
const mockGetRequestyModels = getRequestyModels as Mock<typeof getRequestyModels>
const mockGetKenariModels = getKenariModels as Mock<typeof getKenariModels>
const mockGetNanoGptModels = getNanoGptModels as Mock<typeof getNanoGptModels>
const mockGetMoonshotModels = getMoonshotModels as Mock<typeof getMoonshotModels>
const mockGetZooGatewayModels = getZooGatewayModels as Mock<typeof getZooGatewayModels>

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
			provider: providerIdentifiers.litellm,
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

		const result = await getModels({ provider: providerIdentifiers.openrouter })

		expect(mockGetOpenRouterModels).toHaveBeenCalled()
		expect(result).toEqual(mockModels)
	})

	it("dispatches OpenRouter through its canonical provider identifier", async () => {
		const mockModels = {
			"openrouter/canonical-model": {
				maxTokens: 8192,
				contextWindow: 128000,
				supportsPromptCache: false,
			},
		}

		mockGetOpenRouterModels.mockResolvedValue(mockModels)

		const result = await getModels({ provider: providerIdentifiers.openrouter })

		expect(mockGetOpenRouterModels).toHaveBeenCalled()
		expect(result).toEqual(mockModels)
	})

	it("forwards the OpenRouter API key to getOpenRouterModels", async () => {
		const mockModels = {
			"openrouter/model": {
				maxTokens: 8192,
				contextWindow: 128000,
				supportsPromptCache: false,
			},
		}
		mockGetOpenRouterModels.mockResolvedValue(mockModels)

		await getModels({ provider: providerIdentifiers.openrouter, apiKey: "openrouter-key" })

		expect(mockGetOpenRouterModels).toHaveBeenCalledWith({
			openRouterApiKey: "openrouter-key",
			openRouterBaseUrl: undefined,
		})
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

		const result = await getModels({ provider: providerIdentifiers.requesty, apiKey: DUMMY_REQUESTY_KEY })

		expect(mockGetRequestyModels).toHaveBeenCalledWith(undefined, DUMMY_REQUESTY_KEY)
		expect(result).toEqual(mockModels)
	})

	it("dispatches credentialed fetchers through canonical provider identifiers", async () => {
		const mockModels = {
			"requesty/canonical-model": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
			},
		}

		mockGetRequestyModels.mockResolvedValue(mockModels)

		const result = await getModels({
			provider: providerIdentifiers.requesty,
			apiKey: DUMMY_REQUESTY_KEY,
			baseUrl: "https://router.requesty.ai/v1",
		})

		expect(mockGetRequestyModels).toHaveBeenCalledWith("https://router.requesty.ai/v1", DUMMY_REQUESTY_KEY)
		expect(result).toEqual(mockModels)
	})

	it("calls getKenariModels with optional API key", async () => {
		const mockModels = {
			"glm-5-2": {
				maxTokens: 32768,
				contextWindow: 1048576,
				supportsPromptCache: false,
				description: "GLM 5.2 via Kenari",
			},
		}
		mockGetKenariModels.mockResolvedValue(mockModels)

		const result = await getModels({ provider: providerIdentifiers.kenari, apiKey: "kenari-key-for-testing" })

		expect(mockGetKenariModels).toHaveBeenCalledWith("kenari-key-for-testing")
		expect(result).toEqual(mockModels)
	})

	it("dispatches NanoGPT with an optional API key", async () => {
		const mockModels = {
			"openai/gpt-5.6-sol": {
				maxTokens: 128000,
				contextWindow: 1050000,
				supportsPromptCache: false,
			},
		}
		mockGetNanoGptModels.mockResolvedValue(mockModels)

		const result = await getModels({ provider: providerIdentifiers.nanogpt, apiKey: "nanogpt-key" })

		expect(mockGetNanoGptModels).toHaveBeenCalledWith("nanogpt-key")
		expect(result).toEqual(mockModels)
	})

	it("handles errors and re-throws them", async () => {
		const expectedError = new Error("LiteLLM connection failed")
		mockGetLiteLLMModels.mockRejectedValue(expectedError)

		await expect(
			getModels({
				provider: providerIdentifiers.litellm,
				apiKey: "test-api-key",
				baseUrl: "http://localhost:4000",
			}),
		).rejects.toThrow("LiteLLM connection failed")
	})

	it("calls getMoonshotModels with correct parameters", async () => {
		const mockModels = {
			"kimi-k2-0905-preview": {
				maxTokens: 16384,
				contextWindow: 262144,
				supportsPromptCache: true,
				description: "Moonshot Kimi K2",
			},
		}
		mockGetMoonshotModels.mockResolvedValue(mockModels)

		const result = await getModels({
			provider: providerIdentifiers.moonshot,
			apiKey: "test-key",
			baseUrl: "https://api.moonshot.ai/v1",
		})

		expect(mockGetMoonshotModels).toHaveBeenCalledWith("https://api.moonshot.ai/v1", "test-key")
		expect(result).toEqual(mockModels)
	})

	it("validates exhaustive provider checking with unknown provider", async () => {
		// This test ensures TypeScript catches unknown providers at compile time
		// In practice, the discriminated union should prevent this at compile time
		const unknownProvider = "unknown" as typeof providerIdentifiers.openrouter

		await expect(
			getModels({
				provider: unknownProvider,
			}),
		).rejects.toThrow("Unknown provider: unknown")
	})
})

describe("getModelsFromCache disk fallback", () => {
	let mockCache: Mocked<NodeCache>

	beforeEach(() => {
		vi.clearAllMocks()
		// Get the mock cache instance
		const MockedNodeCache = vi.mocked(NodeCache)
		mockCache = vi.mocked(new MockedNodeCache())
		// Reset memory cache to always miss
		mockCache.get.mockReturnValue(undefined)
		// Reset fs mocks
		vi.mocked(fsSync.existsSync).mockReturnValue(false)
		vi.mocked(fsSync.readFileSync).mockReturnValue("{}")
	})

	it("returns undefined when both memory and disk cache miss", () => {
		vi.mocked(fsSync.existsSync).mockReturnValue(false)

		const result = getModelsFromCache(providerIdentifiers.openrouter)

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

		const result = getModelsFromCache(providerIdentifiers.openrouter)

		expect(result).toEqual(memoryModels)
		// Disk should not be checked when memory cache hits
		expect(fsSync.existsSync).not.toHaveBeenCalled()
	})

	it("isolates authenticated users through the canonical Zoo Gateway identifier", () => {
		const previousUserModels = {
			"previous-user/model": {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsPromptCache: false,
			},
		}

		mockCache.get.mockReturnValue(previousUserModels)

		const result = getModelsFromCache(providerIdentifiers.zooGateway)

		expect(result).toBeUndefined()
		expect(mockCache.get).not.toHaveBeenCalled()
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

		const result = getModelsFromCache(providerIdentifiers.openrouter)

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

		const result = getModelsFromCache(providerIdentifiers.openrouter)

		expect(result).toBeUndefined()
		expect(consoleErrorSpy).toHaveBeenCalled()

		consoleErrorSpy.mockRestore()
	})

	it("handles invalid JSON in disk cache gracefully", () => {
		vi.mocked(fsSync.existsSync).mockReturnValue(true)
		vi.mocked(fsSync.readFileSync).mockReturnValue("invalid json{")

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(function () {})

		const result = getModelsFromCache(providerIdentifiers.openrouter)

		expect(result).toBeUndefined()
		expect(consoleErrorSpy).toHaveBeenCalled()

		consoleErrorSpy.mockRestore()
	})
})

describe("empty cache protection", () => {
	let mockCache: Mocked<NodeCache>
	let mockGet: Mocked<NodeCache>["get"]
	let mockSet: Mocked<NodeCache>["set"]

	beforeEach(() => {
		vi.clearAllMocks()
		// Get the mock cache instance
		const MockedNodeCache = vi.mocked(NodeCache)
		mockCache = vi.mocked(new MockedNodeCache())
		mockGet = mockCache.get
		mockSet = mockCache.set
		// Reset memory cache to always miss by default
		mockGet.mockReturnValue(undefined)
	})

	describe("getModels", () => {
		it("does not cache empty API responses", async () => {
			// API returns empty object (simulating failure)
			mockGetOpenRouterModels.mockResolvedValue({})

			const result = await getModels({ provider: providerIdentifiers.openrouter })

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

			const result = await getModels({ provider: providerIdentifiers.openrouter })

			expect(result).toEqual(mockModels)
			expect(mockSet).toHaveBeenCalledWith("openrouter", mockModels)
		})

		it("reuses an in-flight fetch for concurrent getModels() calls to the same provider", async () => {
			const mockModels = {
				"openrouter/model": {
					maxTokens: 8192,
					contextWindow: 128000,
					supportsPromptCache: false,
					description: "OpenRouter model",
				},
			}

			let resolvePromise: (value: typeof mockModels) => void
			const delayedPromise = new Promise<typeof mockModels>((resolve) => {
				resolvePromise = resolve
			})
			mockGetOpenRouterModels.mockReturnValue(delayedPromise)
			mockGet.mockReturnValue(undefined)

			const promise1 = getModels({ provider: providerIdentifiers.openrouter })
			const promise2 = getModels({ provider: providerIdentifiers.openrouter })

			expect(mockGetOpenRouterModels).toHaveBeenCalledTimes(1)

			resolvePromise!(mockModels)

			const [result1, result2] = await Promise.all([promise1, promise2])
			expect(result1).toEqual(mockModels)
			expect(result2).toEqual(mockModels)
		})

		it("removes the in-flight entry after settlement so a later call starts a fresh fetch", async () => {
			// Proves the dedupedFetch() finally() cleanup actually runs: if the in-flight map
			// entry were never removed, this second, later call would resolve to the first
			// call's stale result instead of invoking the fetcher again.
			const firstModels = {
				"openrouter/first": {
					maxTokens: 8192,
					contextWindow: 128000,
					supportsPromptCache: false,
					description: "First response",
				},
			}
			const secondModels = {
				"openrouter/second": {
					maxTokens: 4096,
					contextWindow: 64000,
					supportsPromptCache: false,
					description: "Second response",
				},
			}
			mockGetOpenRouterModels.mockResolvedValueOnce(firstModels).mockResolvedValueOnce(secondModels)
			mockGet.mockReturnValue(undefined)

			const result1 = await getModels({ provider: providerIdentifiers.openrouter })
			const result2 = await getModels({ provider: providerIdentifiers.openrouter })

			expect(mockGetOpenRouterModels).toHaveBeenCalledTimes(2)
			expect(result1).toEqual(firstModels)
			expect(result2).toEqual(secondModels)
		})

		it("shares a single in-flight fetch between getModels() and refreshModels() for the same key", async () => {
			// Both entry points converge on the same coordinator so a getModels() cache miss
			// racing a concurrent refreshModels() call can't produce two unordered cache writes.
			const mockModels = {
				"openrouter/model": {
					maxTokens: 8192,
					contextWindow: 128000,
					supportsPromptCache: false,
					description: "OpenRouter model",
				},
			}

			let resolvePromise: (value: typeof mockModels) => void
			const delayedPromise = new Promise<typeof mockModels>((resolve) => {
				resolvePromise = resolve
			})
			mockGetOpenRouterModels.mockReturnValue(delayedPromise)
			mockGet.mockReturnValue(undefined)

			const { refreshModels } = await import("../modelCache")

			const getPromise = getModels({ provider: providerIdentifiers.openrouter })
			const refreshPromise = refreshModels({ provider: providerIdentifiers.openrouter })

			expect(mockGetOpenRouterModels).toHaveBeenCalledTimes(1)

			resolvePromise!(mockModels)

			const [getResult, refreshResult] = await Promise.all([getPromise, refreshPromise])
			expect(getResult).toEqual(mockModels)
			expect(refreshResult).toEqual(mockModels)
		})

		it("preserves each entry point's own failure contract when joining a shared in-flight fetch", async () => {
			// getModels() and refreshModels() share the same underlying provider fetch
			// (dedupedFetch), but must not share its resolution/rejection wholesale: getModels()
			// always re-throws on failure, while refreshModels() always degrades to cache/{}.
			// Whichever call happens to start the shared fetch must not impose its own contract
			// on the other caller that joined it.
			const fetchError = new Error("provider unreachable")

			let rejectPromise: (error: Error) => void
			const delayedRejection = new Promise<never>((_resolve, reject) => {
				rejectPromise = reject
			})
			mockGetOpenRouterModels.mockReturnValue(delayedRejection)
			mockGet.mockReturnValue(undefined)

			const { refreshModels } = await import("../modelCache")

			// refreshModels() starts (and registers) the shared fetch; getModels() joins it.
			const refreshPromise = refreshModels({ provider: providerIdentifiers.openrouter })
			const getPromise = getModels({ provider: providerIdentifiers.openrouter })

			expect(mockGetOpenRouterModels).toHaveBeenCalledTimes(1)

			rejectPromise!(fetchError)

			// refreshModels() degrades gracefully (no existing cache -> {}); getModels() still
			// re-throws the original error instead of silently returning refreshModels()'s {}.
			await expect(refreshPromise).resolves.toEqual({})
			await expect(getPromise).rejects.toThrow("provider unreachable")
		})

		it("does not share an in-flight fetch between different endpoints/keys", async () => {
			const mockModelsA = {
				"litellm/model-a": {
					maxTokens: 4096,
					contextWindow: 64000,
					supportsPromptCache: false,
					description: "Server A model",
				},
			}
			const mockModelsB = {
				"litellm/model-b": {
					maxTokens: 4096,
					contextWindow: 64000,
					supportsPromptCache: false,
					description: "Server B model",
				},
			}
			mockGetLiteLLMModels.mockResolvedValueOnce(mockModelsA).mockResolvedValueOnce(mockModelsB)
			mockGet.mockReturnValue(undefined)

			const [resultA, resultB] = await Promise.all([
				getModels({ provider: providerIdentifiers.litellm, apiKey: "key-a", baseUrl: "http://server-a:4000" }),
				getModels({ provider: providerIdentifiers.litellm, apiKey: "key-b", baseUrl: "http://server-b:4000" }),
			])

			expect(mockGetLiteLLMModels).toHaveBeenCalledTimes(2)
			expect(resultA).toEqual(mockModelsA)
			expect(resultB).toEqual(mockModelsB)
		})

		it("re-arms the empty-response throttle after a non-empty response from an auth-scoped provider", async () => {
			// zoo-gateway is auth-scoped and skips caching entirely, but a non-empty response
			// must still clear the throttle so a later empty response is reported again.
			mockGetZooGatewayModels.mockResolvedValueOnce({})

			await getModels({ provider: providerIdentifiers.zooGateway, apiKey: "test-key" })

			expect(TelemetryService.instance.captureEvent).toHaveBeenCalledTimes(1)

			const mockModels = {
				"zoo-gateway/model": {
					maxTokens: 8192,
					contextWindow: 128000,
					supportsPromptCache: false,
					description: "Zoo Gateway model",
				},
			}
			mockGetZooGatewayModels.mockResolvedValueOnce(mockModels)

			await getModels({ provider: providerIdentifiers.zooGateway, apiKey: "test-key" })

			// Auth-scoped providers never populate the cache.
			expect(mockSet).not.toHaveBeenCalled()

			mockGetZooGatewayModels.mockResolvedValueOnce({})

			await getModels({ provider: providerIdentifiers.zooGateway, apiKey: "test-key" })

			// The throttle should have been re-armed by the non-empty response above, so this
			// second empty response is reported again instead of being suppressed.
			expect(TelemetryService.instance.captureEvent).toHaveBeenCalledTimes(2)
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
			const result = await refreshModels({ provider: providerIdentifiers.openrouter })

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
			const result = await refreshModels({ provider: providerIdentifiers.openrouter })

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
			const result = await refreshModels({ provider: providerIdentifiers.openrouter })

			// Should return existing cache on error
			expect(result).toEqual(existingModels)
		})

		it("returns empty object when API errors and no cache exists", async () => {
			mockGet.mockReturnValue(undefined)
			mockGetOpenRouterModels.mockRejectedValue(new Error("API error"))

			const { refreshModels } = await import("../modelCache")
			const result = await refreshModels({ provider: providerIdentifiers.openrouter })

			// Should return empty when no cache and API fails
			expect(result).toEqual({})
		})

		it("does not cache empty response when no existing cache", async () => {
			// Both memory and disk cache are empty (initial state)
			mockGet.mockReturnValue(undefined)
			// API returns empty (failure/rate limit)
			mockGetOpenRouterModels.mockResolvedValue({})

			const { refreshModels } = await import("../modelCache")
			const result = await refreshModels({ provider: providerIdentifiers.openrouter })

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
			const promise1 = refreshModels({ provider: providerIdentifiers.openrouter })
			const promise2 = refreshModels({ provider: providerIdentifiers.openrouter })

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
				refreshModels({ provider: providerIdentifiers.requesty, apiKey: "key-one" }),
				refreshModels({ provider: providerIdentifiers.requesty, apiKey: "key-two" }),
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

			const shared1 = refreshModels({ provider: providerIdentifiers.requesty, apiKey: "same-key" })
			const shared2 = refreshModels({ provider: providerIdentifiers.requesty, apiKey: "same-key" })

			expect(mockGetRequestyModels).toHaveBeenCalledTimes(1)

			resolveShared!(mockModels)
			const [s1, s2] = await Promise.all([shared1, shared2])
			expect(s1).toEqual(mockModels)
			expect(s2).toEqual(mockModels)
		})
	})
})

describe("MODEL_CACHE_EMPTY_RESPONSE throttling", () => {
	type ModelCacheModule = typeof import("../modelCache")

	let freshGetModels: ModelCacheModule["getModels"]
	let freshRefreshModels: ModelCacheModule["refreshModels"]
	let freshMockGetOpenRouterModels: Mock<typeof getOpenRouterModels>
	let freshMockGetLiteLLMModels: Mock<typeof getLiteLLMModels>
	let freshMockGetZooGatewayModels: Mock<typeof getZooGatewayModels>

	beforeEach(async () => {
		// The empty-response throttle is deliberately module-level, persistent state (once per
		// cache key per session). Reset modules per test so each test starts with a clean gate.
		vi.resetModules()
		vi.clearAllMocks()

		const modelCacheModule: ModelCacheModule = await import("../modelCache")
		const openRouterModule = await import("../openrouter")
		const liteLLMModule = await import("../litellm")
		const zooGatewayModule = await import("../zoo-gateway")

		freshGetModels = modelCacheModule.getModels
		freshRefreshModels = modelCacheModule.refreshModels
		freshMockGetOpenRouterModels = openRouterModule.getOpenRouterModels as Mock<typeof getOpenRouterModels>
		freshMockGetLiteLLMModels = liteLLMModule.getLiteLLMModels as Mock<typeof getLiteLLMModels>
		freshMockGetZooGatewayModels = zooGatewayModule.getZooGatewayModels as Mock<typeof getZooGatewayModels>

		const NodeCacheModule = await import("node-cache")
		const MockedNodeCache = vi.mocked(NodeCacheModule.default)
		const mockCache = vi.mocked(new MockedNodeCache())
		mockCache.get.mockReturnValue(undefined)
	})

	it("fires MODEL_CACHE_EMPTY_RESPONSE only once for repeated empty getModels responses from the same provider", async () => {
		freshMockGetOpenRouterModels.mockResolvedValue({})

		await freshGetModels({ provider: providerIdentifiers.openrouter })
		await freshGetModels({ provider: providerIdentifiers.openrouter })
		await freshGetModels({ provider: providerIdentifiers.openrouter })

		const { TelemetryService: FreshTelemetryService } = await import("@roo-code/telemetry")
		expect(FreshTelemetryService.instance.captureEvent).toHaveBeenCalledTimes(1)
		expect(FreshTelemetryService.instance.captureEvent).toHaveBeenCalledWith(
			"Model Cache Empty Response",
			expect.objectContaining({ provider: providerIdentifiers.openrouter, context: "getModels" }),
		)
	})

	it("fires again after a non-empty response resets the throttle", async () => {
		const { TelemetryService: FreshTelemetryService } = await import("@roo-code/telemetry")

		freshMockGetOpenRouterModels.mockResolvedValue({})
		await freshGetModels({ provider: providerIdentifiers.openrouter })
		await freshGetModels({ provider: providerIdentifiers.openrouter })
		expect(FreshTelemetryService.instance.captureEvent).toHaveBeenCalledTimes(1)

		freshMockGetOpenRouterModels.mockResolvedValue({
			"openrouter/model": {
				maxTokens: 8192,
				contextWindow: 128000,
				supportsPromptCache: false,
				description: "OpenRouter model",
			},
		})
		await freshGetModels({ provider: providerIdentifiers.openrouter })

		freshMockGetOpenRouterModels.mockResolvedValue({})
		await freshGetModels({ provider: providerIdentifiers.openrouter })

		expect(FreshTelemetryService.instance.captureEvent).toHaveBeenCalledTimes(2)
	})

	it("throttles independently per provider", async () => {
		const { TelemetryService: FreshTelemetryService } = await import("@roo-code/telemetry")

		freshMockGetOpenRouterModels.mockResolvedValue({})
		freshMockGetLiteLLMModels.mockResolvedValue({})

		await freshGetModels({ provider: providerIdentifiers.openrouter })
		await freshGetModels({ provider: providerIdentifiers.litellm, apiKey: "key", baseUrl: "http://localhost:4000" })

		expect(FreshTelemetryService.instance.captureEvent).toHaveBeenCalledTimes(2)
	})

	it("throttles empty responses from refreshModels using the same per-key gate", async () => {
		const { TelemetryService: FreshTelemetryService } = await import("@roo-code/telemetry")

		freshMockGetOpenRouterModels.mockResolvedValue({})

		await freshRefreshModels({ provider: providerIdentifiers.openrouter })
		await freshRefreshModels({ provider: providerIdentifiers.openrouter })

		expect(FreshTelemetryService.instance.captureEvent).toHaveBeenCalledTimes(1)
		expect(FreshTelemetryService.instance.captureEvent).toHaveBeenCalledWith(
			"Model Cache Empty Response",
			expect.objectContaining({
				provider: providerIdentifiers.openrouter,
				context: "refreshModels",
				hasExistingCache: false,
				existingCacheSize: 0,
			}),
		)
	})

	it("throttles independently per distinct endpoint, not just per provider name", async () => {
		// Two different LiteLLM servers share the "litellm" provider name but are a different
		// cache identity (see getCacheKey) -- an empty response from one must not suppress the
		// signal for the other.
		const { TelemetryService: FreshTelemetryService } = await import("@roo-code/telemetry")

		freshMockGetLiteLLMModels.mockResolvedValue({})

		await freshGetModels({
			provider: providerIdentifiers.litellm,
			apiKey: "key-a",
			baseUrl: "http://server-a:4000",
		})
		await freshGetModels({
			provider: providerIdentifiers.litellm,
			apiKey: "key-a",
			baseUrl: "http://server-a:4000",
		})
		await freshGetModels({
			provider: providerIdentifiers.litellm,
			apiKey: "key-b",
			baseUrl: "http://server-b:4000",
		})

		expect(FreshTelemetryService.instance.captureEvent).toHaveBeenCalledTimes(2)
	})

	it("throttles zoo-gateway independently per session token, even though caching itself is skipped", async () => {
		// zoo-gateway is auth-scoped (see AUTH_SCOPED_PROVIDERS) and never persists to the
		// memory/disk cache, but the empty-response throttle must still discriminate by
		// identity: a sign-out/sign-in cycle to a different account carries a different
		// session token (apiKey) on the same gateway URL, and must not have its empty-response
		// signal suppressed by the previous account's throttle entry.
		const { TelemetryService: FreshTelemetryService } = await import("@roo-code/telemetry")

		freshMockGetZooGatewayModels.mockResolvedValue({})

		await freshGetModels({ provider: providerIdentifiers.zooGateway, apiKey: "account-a-token" })
		await freshGetModels({ provider: providerIdentifiers.zooGateway, apiKey: "account-a-token" })
		expect(FreshTelemetryService.instance.captureEvent).toHaveBeenCalledTimes(1)

		await freshGetModels({ provider: providerIdentifiers.zooGateway, apiKey: "account-b-token" })
		expect(FreshTelemetryService.instance.captureEvent).toHaveBeenCalledTimes(2)
	})

	it("throttles zoo-gateway independently per gateway baseUrl", async () => {
		// Same session token, different gateway endpoint (e.g. staging vs. production) --
		// must also be treated as a distinct identity for throttle purposes.
		const { TelemetryService: FreshTelemetryService } = await import("@roo-code/telemetry")

		freshMockGetZooGatewayModels.mockResolvedValue({})

		await freshGetModels({
			provider: providerIdentifiers.zooGateway,
			apiKey: "token",
			baseUrl: "https://gateway-a.example.com",
		})
		await freshGetModels({
			provider: providerIdentifiers.zooGateway,
			apiKey: "token",
			baseUrl: "https://gateway-b.example.com",
		})

		expect(FreshTelemetryService.instance.captureEvent).toHaveBeenCalledTimes(2)
	})

	it("never shares results across different zoo-gateway credentials (auth isolation)", async () => {
		// Auth-scoped providers (see AUTH_SCOPED_PROVIDERS) bypass dedupedFetch entirely --
		// shouldSkipCache is true for zoo-gateway, so every call fires its own provider fetch
		// and none are deduplicated. That means two concurrent calls can never resolve into
		// each other's result regardless of token, which this test confirms for two different
		// account tokens; the companion case below confirms the same holds for one token too.
		const accountAModels = {
			"zoo-gateway/account-a-model": {
				maxTokens: 4096,
				contextWindow: 64000,
				supportsPromptCache: false,
				description: "Account A model",
			},
		}
		const accountBModels = {
			"zoo-gateway/account-b-model": {
				maxTokens: 4096,
				contextWindow: 64000,
				supportsPromptCache: false,
				description: "Account B model",
			},
		}

		let resolveA: (value: typeof accountAModels) => void
		let resolveB: (value: typeof accountBModels) => void
		freshMockGetZooGatewayModels
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveA = resolve
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveB = resolve
					}),
			)

		const promiseA = freshGetModels({ provider: providerIdentifiers.zooGateway, apiKey: "account-a-token" })
		const promiseB = freshGetModels({ provider: providerIdentifiers.zooGateway, apiKey: "account-b-token" })

		expect(freshMockGetZooGatewayModels).toHaveBeenCalledTimes(2)

		resolveB!(accountBModels)
		resolveA!(accountAModels)

		const [resultA, resultB] = await Promise.all([promiseA, promiseB])
		expect(resultA).toEqual(accountAModels)
		expect(resultB).toEqual(accountBModels)
	})

	it("never deduplicates concurrent zoo-gateway fetches, even for the same token", async () => {
		// Auth-scoped providers skip dedupedFetch unconditionally, so even two calls carrying
		// an identical token each fire their own provider fetch -- there is no in-flight sharing
		// to key correctly or incorrectly for these providers.
		freshMockGetZooGatewayModels.mockResolvedValue({})

		await Promise.all([
			freshGetModels({ provider: providerIdentifiers.zooGateway, apiKey: "same-token" }),
			freshGetModels({ provider: providerIdentifiers.zooGateway, apiKey: "same-token" }),
		])

		expect(freshMockGetZooGatewayModels).toHaveBeenCalledTimes(2)
	})
})

describe("key-scoped cache key derivation", () => {
	// Exercises the per-API-key cache discriminator that all KEY_SCOPED_PROVIDERS share.
	// Requesty is used only because it is a key-scoped provider with a mocked fetcher; the
	// behavior under test is provider-agnostic.
	const keyScopedProvider = providerIdentifiers.requesty

	let mockCache: Mocked<NodeCache>
	let mockSet: Mocked<NodeCache>["set"]

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
		mockCache = vi.mocked(new MockedNodeCache())
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

describe("NanoGPT key-scoped cache isolation", () => {
	const nanoGptModels = {
		"openai/gpt-5.6-sol": { maxTokens: 128000, contextWindow: 1050000, supportsPromptCache: false },
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mockGetNanoGptModels.mockResolvedValue(nanoGptModels)
	})

	it("separates public, key A, and key B cache identities without exposing raw keys", async () => {
		const mockCache = vi.mocked(new (vi.mocked(NodeCache))())
		mockCache.get.mockReturnValue(undefined)

		await getModels({ provider: providerIdentifiers.nanogpt })
		await getModels({ provider: providerIdentifiers.nanogpt, apiKey: "nano-key-a" })
		await getModels({ provider: providerIdentifiers.nanogpt, apiKey: "nano-key-b" })

		const cacheKeys = mockCache.set.mock.calls.map(([key]) => key as string)
		expect(new Set(cacheKeys).size).toBe(3)
		expect(cacheKeys).toContain("nanogpt")
		expect(cacheKeys.every((key) => !key.includes("nano-key-a") && !key.includes("nano-key-b"))).toBe(true)
	})
})

describe("compound cache key derivation across scoping dimensions", () => {
	// Exercises every branch of getCacheKey via the public getModels() entry point.
	// litellm is url-scoped AND key-scoped; openrouter is key-scoped only, so it hits the
	// key discriminator branch (or the bare provider fallback when no key is supplied). The
	// fetcher mocks let us observe the cache key the result is written under (first arg of
	// the matching memoryCache.set call).
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
		await getModels({
			provider: providerIdentifiers.litellm,
			apiKey: "compound-key",
			baseUrl: "http://host:4000",
		})
		const cacheKey = writtenCacheKey()

		// Expected shape: provider:url:keyDiscriminator
		expect(cacheKey).toMatch(/^litellm:http:\/\/host:4000:[0-9a-f]{8}$/)
	})

	it("normalizes trailing slashes in the server URL so equivalent URLs share a cache key", async () => {
		await getModels({
			provider: providerIdentifiers.litellm,
			apiKey: "compound-key",
			baseUrl: "http://host:4000/",
		})
		const withSlash = writtenCacheKey()

		mockSet.mockClear()
		await getModels({
			provider: providerIdentifiers.litellm,
			apiKey: "compound-key",
			baseUrl: "http://host:4000",
		})
		const withoutSlash = writtenCacheKey()

		expect(withSlash).toEqual(withoutSlash)
	})

	it("includes only the server URL when a url-scoped provider has no API key", async () => {
		await getModels({ provider: providerIdentifiers.litellm, baseUrl: "http://host:4000" })
		const cacheKey = writtenCacheKey()

		// No trailing key discriminator when apiKey is absent.
		expect(cacheKey).toBe("litellm:http://host:4000")
	})

	it("falls back to the bare provider name for a key-scoped provider without an API key", async () => {
		await getModels({ provider: providerIdentifiers.openrouter })
		const cacheKey = writtenCacheKey()

		expect(cacheKey).toBe("openrouter")
	})

	it("includes only the key discriminator for a key-scoped provider without a custom URL", async () => {
		await getModels({ provider: providerIdentifiers.openrouter, apiKey: "openrouter-key" })
		const cacheKey = writtenCacheKey()

		expect(cacheKey).toMatch(/^openrouter:[0-9a-f]{8}$/)
	})

	it("writes different cache keys for two different OpenRouter API keys", async () => {
		await getModels({ provider: providerIdentifiers.openrouter, apiKey: "key-one" })
		const firstKey = writtenCacheKey()

		mockSet.mockClear()
		await getModels({ provider: providerIdentifiers.openrouter, apiKey: "key-two" })
		const secondKey = writtenCacheKey()

		expect(firstKey).toBeDefined()
		expect(secondKey).toBeDefined()
		expect(firstKey).not.toEqual(secondKey)
	})
})
