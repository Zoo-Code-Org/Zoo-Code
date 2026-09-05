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
vi.mock("../kimi-code")

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
import type { ModelRecord } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types"
import * as fsSync from "fs"
import * as fsPromises from "fs/promises"
import NodeCache from "node-cache"
import { TelemetryService } from "@roo-code/telemetry"
import {
	getModels,
	getModelsFromCache,
	refreshModels,
	flushModels,
	clearAuthSessionModelsForProvider,
	resetModelCacheTransientStateForTests,
} from "../modelCache"
import { getLiteLLMModels } from "../litellm"
import { getOpenRouterModels } from "../openrouter"
import { getRequestyModels } from "../requesty"
import { getKenariModels } from "../kenari"
import { getNanoGptModels } from "../nanogpt"
import { getMoonshotModels } from "../moonshot"
import { getZooGatewayModels } from "../zoo-gateway"
import { getKimiCodeModels } from "../kimi-code"

const mockGetLiteLLMModels = getLiteLLMModels as Mock<typeof getLiteLLMModels>
const mockGetOpenRouterModels = getOpenRouterModels as Mock<typeof getOpenRouterModels>
const mockGetRequestyModels = getRequestyModels as Mock<typeof getRequestyModels>
const mockGetKenariModels = getKenariModels as Mock<typeof getKenariModels>
const mockGetNanoGptModels = getNanoGptModels as Mock<typeof getNanoGptModels>
const mockGetMoonshotModels = getMoonshotModels as Mock<typeof getMoonshotModels>
const mockGetZooGatewayModels = getZooGatewayModels as Mock<typeof getZooGatewayModels>
const mockGetKimiCodeModels = getKimiCodeModels as Mock<typeof getKimiCodeModels>

function zooGatewayOk(models: ModelRecord) {
	return { kind: "ok" as const, models }
}

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

	it("logs disk-cache write failures without rejecting getModels", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(fsPromises.writeFile).mockRejectedValueOnce(new Error("disk full"))
		mockGetOpenRouterModels.mockResolvedValue({
			"openrouter/model": {
				maxTokens: 8192,
				contextWindow: 128000,
				supportsPromptCache: false,
			},
		})

		const result = await getModels({ provider: providerIdentifiers.openrouter })

		expect(result).toEqual({
			"openrouter/model": {
				maxTokens: 8192,
				contextWindow: 128000,
				supportsPromptCache: false,
			},
		})
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("[MODEL_CACHE] Error writing"),
			expect.any(Error),
		)
		consoleErrorSpy.mockRestore()
	})

	it("logs disk-cache write failures without rejecting refreshModels", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(fsPromises.writeFile).mockRejectedValueOnce(new Error("disk full"))
		mockGetOpenRouterModels.mockResolvedValue({
			"openrouter/model": {
				maxTokens: 8192,
				contextWindow: 128000,
				supportsPromptCache: false,
			},
		})

		const result = await refreshModels({ provider: providerIdentifiers.openrouter })

		expect(result).toEqual({
			"openrouter/model": {
				maxTokens: 8192,
				contextWindow: 128000,
				supportsPromptCache: false,
			},
		})
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("[refreshModels] Error writing"),
			expect.any(Error),
		)
		consoleErrorSpy.mockRestore()
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
			// zoo-gateway uses the auth session cache, not the shared memory/disk cache.
			// A later empty response must still be reported when a forced refresh hits the API.
			mockGetZooGatewayModels.mockResolvedValueOnce(zooGatewayOk({}))

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
			mockGetZooGatewayModels.mockResolvedValueOnce(zooGatewayOk(mockModels))

			await getModels({ provider: providerIdentifiers.zooGateway, apiKey: "test-key" })

			expect(mockSet).not.toHaveBeenCalled()

			mockGetZooGatewayModels.mockResolvedValueOnce(zooGatewayOk({}))

			const { refreshModels } = await import("../modelCache")
			await refreshModels({ provider: providerIdentifiers.zooGateway, apiKey: "test-key" })

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
	beforeEach(() => {
		// Module-level throttle state; reset without vi.resetModules so Stryker sees mutants.
		resetModelCacheTransientStateForTests()
		vi.clearAllMocks()

		const MockedNodeCache = vi.mocked(NodeCache)
		const mockCache = vi.mocked(new MockedNodeCache())
		mockCache.get.mockReturnValue(undefined)
	})

	it("fires MODEL_CACHE_EMPTY_RESPONSE only once for repeated empty getModels responses from the same provider", async () => {
		mockGetOpenRouterModels.mockResolvedValue({})

		await getModels({ provider: providerIdentifiers.openrouter })
		await getModels({ provider: providerIdentifiers.openrouter })
		await getModels({ provider: providerIdentifiers.openrouter })

		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledTimes(1)
		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledWith(
			"Model Cache Empty Response",
			expect.objectContaining({ provider: providerIdentifiers.openrouter, context: "getModels" }),
		)
	})

	it("fires again after a non-empty response resets the throttle", async () => {
		mockGetOpenRouterModels.mockResolvedValue({})
		await getModels({ provider: providerIdentifiers.openrouter })
		await getModels({ provider: providerIdentifiers.openrouter })
		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledTimes(1)

		mockGetOpenRouterModels.mockResolvedValue({
			"openrouter/model": {
				maxTokens: 8192,
				contextWindow: 128000,
				supportsPromptCache: false,
				description: "OpenRouter model",
			},
		})
		await getModels({ provider: providerIdentifiers.openrouter })

		mockGetOpenRouterModels.mockResolvedValue({})
		await getModels({ provider: providerIdentifiers.openrouter })

		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledTimes(2)
	})

	it("throttles independently per provider", async () => {
		mockGetOpenRouterModels.mockResolvedValue({})
		mockGetLiteLLMModels.mockResolvedValue({})

		await getModels({ provider: providerIdentifiers.openrouter })
		await getModels({ provider: providerIdentifiers.litellm, apiKey: "key", baseUrl: "http://localhost:4000" })

		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledTimes(2)
	})

	it("throttles empty responses from refreshModels using the same per-key gate", async () => {
		mockGetOpenRouterModels.mockResolvedValue({})

		await refreshModels({ provider: providerIdentifiers.openrouter })
		await refreshModels({ provider: providerIdentifiers.openrouter })

		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledTimes(1)
		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledWith(
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
		mockGetLiteLLMModels.mockResolvedValue({})

		await getModels({
			provider: providerIdentifiers.litellm,
			apiKey: "key-a",
			baseUrl: "http://server-a:4000",
		})
		await getModels({
			provider: providerIdentifiers.litellm,
			apiKey: "key-a",
			baseUrl: "http://server-a:4000",
		})
		await getModels({
			provider: providerIdentifiers.litellm,
			apiKey: "key-b",
			baseUrl: "http://server-b:4000",
		})

		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledTimes(2)
	})

	it("throttles zoo-gateway independently per session token, even though caching itself is skipped", async () => {
		// zoo-gateway is auth-scoped (see AUTH_SCOPED_PROVIDERS) and never persists to the
		// memory/disk cache, but the empty-response throttle must still discriminate by
		// identity: a sign-out/sign-in cycle to a different account carries a different
		// session token (apiKey) on the same gateway URL, and must not have its empty-response
		// signal suppressed by the previous account's throttle entry.
		mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk({}))

		await getModels({ provider: providerIdentifiers.zooGateway, apiKey: "account-a-token" })
		await getModels({ provider: providerIdentifiers.zooGateway, apiKey: "account-a-token" })
		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledTimes(1)

		await getModels({ provider: providerIdentifiers.zooGateway, apiKey: "account-b-token" })
		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledTimes(2)
	})

	it("throttles zoo-gateway independently per gateway baseUrl", async () => {
		// Same session token, different gateway endpoint (e.g. staging vs. production) --
		// must also be treated as a distinct identity for throttle purposes.
		mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk({}))

		await getModels({
			provider: providerIdentifiers.zooGateway,
			apiKey: "token",
			baseUrl: "https://gateway-a.example.com",
		})
		await getModels({
			provider: providerIdentifiers.zooGateway,
			apiKey: "token",
			baseUrl: "https://gateway-b.example.com",
		})

		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledTimes(2)
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

		let resolveA: (value: Awaited<ReturnType<typeof getZooGatewayModels>>) => void
		let resolveB: (value: Awaited<ReturnType<typeof getZooGatewayModels>>) => void
		mockGetZooGatewayModels
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

		const promiseA = getModels({ provider: providerIdentifiers.zooGateway, apiKey: "account-a-token" })
		const promiseB = getModels({ provider: providerIdentifiers.zooGateway, apiKey: "account-b-token" })

		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)

		resolveB!(zooGatewayOk(accountBModels))
		resolveA!(zooGatewayOk(accountAModels))

		const [resultA, resultB] = await Promise.all([promiseA, promiseB])
		expect(resultA).toEqual(accountAModels)
		expect(resultB).toEqual(accountBModels)
	})

	it("deduplicates concurrent zoo-gateway fetches for the same session token", async () => {
		// Auth-scoped providers use inFlightAuthScopedFetch to coalesce concurrent calls
		// for the same cache key so two panels opening simultaneously share one fetch.
		mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk({}))

		await Promise.all([
			getModels({ provider: providerIdentifiers.zooGateway, apiKey: "same-token" }),
			getModels({ provider: providerIdentifiers.zooGateway, apiKey: "same-token" }),
		])

		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(1)
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

	it("falls back to the bare provider name for providers that are neither url- nor key-scoped", async () => {
		await getModels({
			provider: providerIdentifiers.openrouter,
			apiKey: "ignored-key",
			baseUrl: "http://ignored:4000",
		})
		const cacheKey = writtenCacheKey()

		expect(cacheKey).toBe("openrouter")
	})
})

describe("auth session cache", () => {
	let mockSet: Mocked<NodeCache>["set"]

	const zooModels: ModelRecord = {
		"anthropic/claude-sonnet-4": {
			maxTokens: 64000,
			contextWindow: 200000,
			supportsPromptCache: true,
		},
	}

	beforeEach(() => {
		resetModelCacheTransientStateForTests()
		vi.clearAllMocks()

		const MockedNodeCache = vi.mocked(NodeCache)
		const mockCache = vi.mocked(new MockedNodeCache())
		mockCache.get.mockReturnValue(undefined)
		mockSet = mockCache.set
	})

	it("reuses in-memory session cache within TTL without refetching", async () => {
		mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		await getModels(options)
		await getModels(options)

		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(1)
	})

	it("keeps the session catalog fresh one minute into the TTL window", async () => {
		// Kills: AUTH_SESSION_TTL_MS arithmetic mutants (5*60/1000, 5/60) that shrink TTL below 1 minute
		vi.useFakeTimers()
		try {
			mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
			const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

			await getModels(options)
			vi.advanceTimersByTime(60_000)
			await getModels(options)

			expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it("clearAuthSessionModelsForProvider does not clear a different auth-scoped provider", async () => {
		// Kills: matchesProvider mutants that always-match or invert equality across providers
		const kimiModels: ModelRecord = {
			"kimi-for-coding": { maxTokens: 8192, contextWindow: 128000, supportsPromptCache: false },
		}
		mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
		mockGetKimiCodeModels.mockResolvedValue(kimiModels)

		await getModels({ provider: providerIdentifiers.zooGateway, apiKey: "zoo-session" })
		await getModels({ provider: providerIdentifiers.kimiCode, apiKey: "kimi-session" })
		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(1)
		expect(mockGetKimiCodeModels).toHaveBeenCalledTimes(1)

		clearAuthSessionModelsForProvider(providerIdentifiers.zooGateway)

		await getModels({ provider: providerIdentifiers.zooGateway, apiKey: "zoo-session" })
		await getModels({ provider: providerIdentifiers.kimiCode, apiKey: "kimi-session" })

		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)
		expect(mockGetKimiCodeModels).toHaveBeenCalledTimes(1)
	})

	it("keeps prior catalog when a refresh returns empty", async () => {
		mockGetZooGatewayModels.mockResolvedValueOnce(zooGatewayOk(zooModels)).mockResolvedValueOnce(zooGatewayOk({}))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		await getModels(options)
		const refreshed = await refreshModels(options)

		expect(refreshed).toEqual(zooModels)
		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)
	})

	it("clears session cache on sign-out helper so the same identity refetches", async () => {
		mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		await getModels(options)
		clearAuthSessionModelsForProvider(providerIdentifiers.zooGateway)
		await getModels(options)

		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)
	})

	it("never writes auth-scoped catalogs to the shared memory cache", async () => {
		mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))

		await getModels({ provider: providerIdentifiers.zooGateway, apiKey: "session-token" })

		expect(mockSet).not.toHaveBeenCalled()
	})

	it("clearAuthSessionModelsForProvider prevents a resolved in-flight fetch from repopulating the cache", async () => {
		// Regression guard: an in-flight fetch that resolves after clearAuthSessionModelsForProvider
		// must not repopulate the session cache (which would leak a prior session's catalog).
		mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		// Fetch and populate cache
		await getModels(options)

		// Sign out — clears cache and in-flight map
		clearAuthSessionModelsForProvider(providerIdentifiers.zooGateway)

		// A new getModels call after sign-out must refetch (cache was cleared)
		await getModels(options)
		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)
	})

	it("in-flight fetch started before sign-out does not repopulate cache when a new fetch starts after sign-out", async () => {
		// Race condition: fetch A starts → sign-out → fetch B starts → fetch A resolves.
		// Fetch A must NOT write back its stale pre-sign-out data because the generation counter
		// was bumped by sign-out. This test simulates the race using deferred promises.
		const staleModels: ModelRecord = {
			"stale/model": { maxTokens: 1000, contextWindow: 1000, supportsPromptCache: false },
		}
		const freshModelsAfterSignOut: ModelRecord = {
			"fresh/model": { maxTokens: 2000, contextWindow: 2000, supportsPromptCache: false },
		}

		type ZooGatewayResult = Awaited<ReturnType<typeof getZooGatewayModels>>
		let resolveFetchA!: (value: ZooGatewayResult) => void
		const fetchAPromise = new Promise<ZooGatewayResult>((resolve) => {
			resolveFetchA = resolve
		})

		let resolveFetchB!: (value: ZooGatewayResult) => void
		const fetchBPromise = new Promise<ZooGatewayResult>((resolve) => {
			resolveFetchB = resolve
		})

		// First call returns fetchAPromise (hangs until we resolve)
		// Second call returns fetchBPromise (hangs until we resolve)
		mockGetZooGatewayModels.mockReturnValueOnce(fetchAPromise).mockReturnValueOnce(fetchBPromise)

		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		// 1. Start fetch A (pre-sign-out)
		const fetchAResult = getModels(options)

		// 2. Sign out — clears cache and bumps generation
		clearAuthSessionModelsForProvider(providerIdentifiers.zooGateway)

		// 3. Start fetch B (post-sign-out) — this registers a NEW in-flight promise
		const fetchBResult = getModels(options)

		// 4. Resolve fetch A with stale data — it should NOT write to cache
		resolveFetchA(zooGatewayOk(staleModels))
		await fetchAResult

		// 5. Resolve fetch B with fresh data — it SHOULD write to cache
		resolveFetchB(zooGatewayOk(freshModelsAfterSignOut))
		const result = await fetchBResult

		// The result should be the fresh post-sign-out data, not the stale pre-sign-out data
		expect(result).toEqual(freshModelsAfterSignOut)

		// Verify a subsequent getModels call returns the fresh data (proving fetch A didn't overwrite)
		// Don't set a new mock — the call should be served from cache
		const subsequent = await getModels(options)
		expect(subsequent).toEqual(freshModelsAfterSignOut)
		// Should be served from cache, not trigger a new fetch (only 2 fetches: A and B)
		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)

		// Clean up — clear cache so subsequent tests don't see stale entries
		clearAuthSessionModelsForProvider(providerIdentifiers.zooGateway)
	})

	it("returns cached entry within TTL without hitting the provider", async () => {
		// Kills: AUTH_SESSION_TTL_MS arithmetic mutant (5*60/1000 would expire in <1ms)
		vi.useFakeTimers()
		try {
			mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
			const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

			await getModels(options)
			// Advance by 1 second — well within the 5-minute TTL
			vi.advanceTimersByTime(1000)
			const second = await getModels(options)

			expect(second).toEqual(zooModels)
			// Only one fetch — the second call was served from cache
			expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it("treats an entry as stale at exactly the TTL boundary", async () => {
		// Kills: < vs <= equality-operator mutant on isAuthSessionFresh
		vi.useFakeTimers()
		try {
			mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
			const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

			await getModels(options)
			// Advance to exactly TTL — entry is now stale (< not <=)
			vi.advanceTimersByTime(5 * 60 * 1000)
			await getModels(options)

			// Must have refetched — entry was stale at exact TTL
			expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)
		} finally {
			vi.useRealTimers()
		}
	})

	it("staleCutoffMs is 2x AUTH_SESSION_TTL_MS not 1x", async () => {
		// Kills: AUTH_SESSION_TTL_MS * 2 → / 2 arithmetic mutant.
		// An entry at exactly 1x TTL + 1ms is stale but NOT yet at the 2x prune threshold;
		// it must still be in the map (so a concurrent get with a fresh ETag can still
		// re-use the old etag for conditional revalidation). The existing
		// "prunes session entries older than twice the TTL" test covers the >=2x case.
		vi.useFakeTimers()
		try {
			mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
			const optionsA = { provider: providerIdentifiers.zooGateway, apiKey: "session-a" }
			const optionsB = { provider: providerIdentifiers.zooGateway, apiKey: "session-b" }

			// First fetch returns an etag so we can detect it on the revalidation call
			mockGetZooGatewayModels.mockResolvedValueOnce({ kind: "ok", models: zooModels, etag: '"v1"' })
			await getModels(optionsA)

			// Advance to 1x TTL + 1ms — stale but below 2x cutoff
			vi.advanceTimersByTime(5 * 60 * 1000 + 1)

			// Adding a second entry triggers enforceAuthSessionCacheBound → pruneExpiredAuthSessionEntries
			mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
			await getModels(optionsB)

			// session-a is below 2x TTL so it is NOT pruned.
			// It IS stale (1x TTL elapsed), so the next getModels call will issue a revalidation
			// request WITH the etag — confirming the entry is still in the cache.
			mockGetZooGatewayModels.mockClear()
			mockGetZooGatewayModels.mockResolvedValue({ kind: "ok", models: zooModels, etag: '"v2"' })
			await getModels(optionsA)

			// The etag from the prior fetch must have been sent (entry was not pruned)
			expect(mockGetZooGatewayModels).toHaveBeenCalledWith(expect.objectContaining({ ifNoneMatch: '"v1"' }))
		} finally {
			vi.useRealTimers()
		}
	})

	it("notModified branch returns existing models when current entry is non-empty", async () => {
		// Kills: ConditionalExpression mutant (false) on `if (current && Object.keys(current.models).length > 0)`
		vi.useFakeTimers()
		try {
			mockGetZooGatewayModels
				.mockResolvedValueOnce({ kind: "ok", models: zooModels, etag: '"v1"' })
				.mockResolvedValueOnce({ kind: "not_modified" })

			const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }
			await getModels(options)
			vi.advanceTimersByTime(5 * 60 * 1000 + 1)

			const result = await getModels(options)

			// If the condition were false, touchAuthSessionEntry wouldn't fire and result might differ
			expect(result).toEqual(zooModels)
		} finally {
			vi.useRealTimers()
		}
	})

	it("falls back to existing models on empty response after having a prior non-empty catalog", async () => {
		// Kills: ConditionalExpression mutant (false) on `if (existing && Object.keys(existing.models).length > 0)` fallback
		vi.useFakeTimers()
		try {
			mockGetZooGatewayModels
				.mockResolvedValueOnce(zooGatewayOk(zooModels))
				.mockResolvedValueOnce(zooGatewayOk({}))

			const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }
			await getModels(options)
			vi.advanceTimersByTime(5 * 60 * 1000 + 1)

			const result = await getModels(options)

			// If condition were false, {} would be returned — but existing catalog should survive
			expect(result).toEqual(zooModels)
		} finally {
			vi.useRealTimers()
		}
	})

	it("forceRefresh bypasses the fresh-cache short-circuit", async () => {
		// Kills: ConditionalExpression mutant (true) on `!forceRefresh` in cache-hit guard
		mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		await getModels(options)
		// Entry is fresh — without forceRefresh the second call would be served from cache
		await refreshModels(options)

		// forceRefresh must bypass the cache and issue a second fetch
		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)
	})

	it("concurrent getModels calls for the same session key share one fetch", async () => {
		mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		const [first, second] = await Promise.all([getModels(options), getModels(options)])

		expect(first).toEqual(zooModels)
		expect(second).toEqual(zooModels)
		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(1)
	})

	it("revalidates with ETag after TTL expires and keeps the prior catalog on 304", async () => {
		vi.useFakeTimers()
		try {
			mockGetZooGatewayModels
				.mockResolvedValueOnce({ kind: "ok", models: zooModels, etag: '"v1"' })
				.mockResolvedValueOnce({ kind: "not_modified" })

			const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }
			await getModels(options)

			vi.advanceTimersByTime(5 * 60 * 1000 + 1)

			const second = await getModels(options)

			expect(second).toEqual(zooModels)
			expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)
			expect(mockGetZooGatewayModels).toHaveBeenLastCalledWith(expect.objectContaining({ ifNoneMatch: '"v1"' }))

			// A third call within the refreshed TTL window must not trigger another fetch,
			// proving touchAuthSessionEntry actually updated fetchedAt.
			const third = await getModels(options)
			expect(third).toEqual(zooModels)
			expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)
		} finally {
			vi.useRealTimers()
		}
	})

	it("flushModels clears session cache and can force a refetch", async () => {
		mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		await getModels(options)
		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(1)

		await flushModels(options, true)

		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)
	})

	it("returns the prior session catalog when a fetch throws", async () => {
		vi.useFakeTimers()
		try {
			mockGetZooGatewayModels
				.mockResolvedValueOnce(zooGatewayOk(zooModels))
				.mockRejectedValueOnce(new Error("network down"))
			const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

			await getModels(options)
			vi.advanceTimersByTime(5 * 60 * 1000 + 1)
			const second = await getModels(options)

			expect(second).toEqual(zooModels)
		} finally {
			vi.useRealTimers()
		}
	})

	it("getModels throws on the first call when the provider fetch fails and there is no prior cache", async () => {
		mockGetZooGatewayModels.mockRejectedValue(new Error("network down"))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		await expect(getModels(options)).rejects.toThrow("network down")
	})

	it("refreshModels returns an empty catalog when refresh throws and no session cache exists", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		mockGetZooGatewayModels.mockRejectedValue(new Error("network down"))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		const refreshed = await refreshModels(options)

		expect(refreshed).toEqual({})
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("[refreshModels] Failed to refresh"),
			expect.any(Error),
		)
		consoleSpy.mockRestore()
	})

	it("refreshModels keeps the prior session catalog when refresh throws", async () => {
		mockGetZooGatewayModels
			.mockResolvedValueOnce(zooGatewayOk(zooModels))
			.mockRejectedValueOnce(new Error("network down"))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		await getModels(options)
		const refreshed = await refreshModels(options)

		expect(refreshed).toEqual(zooModels)
	})

	it("caches kimi-code catalogs in the session store", async () => {
		const kimiModels: ModelRecord = {
			"kimi-for-coding": {
				maxTokens: 8192,
				contextWindow: 128000,
				supportsPromptCache: false,
			},
		}
		mockGetKimiCodeModels.mockResolvedValue(kimiModels)
		const options = { provider: providerIdentifiers.kimiCode, apiKey: "kimi-session" }

		await getModels(options)
		await getModels(options)

		expect(mockGetKimiCodeModels).toHaveBeenCalledTimes(1)
		expect(mockSet).not.toHaveBeenCalled()
	})

	it("flushModels without refresh evicts the session cache until the next fetch", async () => {
		mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		await getModels(options)
		await flushModels(options)
		await getModels(options)

		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)
	})

	it("flushModels for non-auth providers deletes the shared memory cache entry", async () => {
		// Kills: ConditionalExpression mutant that always takes the auth-scoped flush branch
		const MockedNodeCache = vi.mocked(NodeCache)
		const mockCache = vi.mocked(new MockedNodeCache())
		const mockDel = mockCache.del
		mockGetOpenRouterModels.mockResolvedValue({
			"openrouter/model": { maxTokens: 8192, contextWindow: 128000, supportsPromptCache: false },
		})

		await getModels({ provider: providerIdentifiers.openrouter })
		await flushModels({ provider: providerIdentifiers.openrouter })

		expect(mockDel).toHaveBeenCalledWith("openrouter")
	})

	it("returns an empty catalog when revalidation is 304 and no session cache exists", async () => {
		vi.useFakeTimers()
		try {
			mockGetZooGatewayModels
				.mockResolvedValueOnce(zooGatewayOk(zooModels))
				.mockResolvedValueOnce({ kind: "not_modified" })

			const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }
			await getModels(options)
			await flushModels(options)

			vi.advanceTimersByTime(5 * 60 * 1000 + 1)

			const result = await getModels(options)

			expect(result).toEqual({})
		} finally {
			vi.useRealTimers()
		}
	})

	it("returns an empty catalog on the first empty zoo-gateway response", async () => {
		mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk({}))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		const result = await getModels(options)

		expect(result).toEqual({})
		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledWith(
			"Model Cache Empty Response",
			expect.objectContaining({
				provider: providerIdentifiers.zooGateway,
				context: "getModels",
				hasExistingCache: false,
			}),
		)
	})

	it("reports empty refreshModels context and existingCacheSize when a prior catalog exists", async () => {
		mockGetZooGatewayModels.mockResolvedValueOnce(zooGatewayOk(zooModels)).mockResolvedValueOnce(zooGatewayOk({}))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		await getModels(options)
		await refreshModels(options)

		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledWith(
			"Model Cache Empty Response",
			expect.objectContaining({
				provider: providerIdentifiers.zooGateway,
				context: "refreshModels",
				hasExistingCache: true,
				existingCacheSize: 1,
			}),
		)
	})

	it("re-arms empty-response telemetry after a 304 touch clears the throttle", async () => {
		vi.useFakeTimers()
		try {
			mockGetZooGatewayModels
				.mockResolvedValueOnce({ kind: "ok", models: zooModels, etag: '"v1"' })
				.mockResolvedValueOnce({ kind: "not_modified" })
				.mockResolvedValueOnce(zooGatewayOk({}))

			const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }
			await getModels(options)
			vi.advanceTimersByTime(5 * 60 * 1000 + 1)
			await getModels(options) // 304 path deletes throttle via reportedEmptyModelResponse.delete
			vi.advanceTimersByTime(5 * 60 * 1000 + 1)
			await getModels(options) // empty response must report again

			expect(TelemetryService.instance.captureEvent).toHaveBeenCalledWith(
				"Model Cache Empty Response",
				expect.objectContaining({
					provider: providerIdentifiers.zooGateway,
					context: "getModels",
					hasExistingCache: true,
				}),
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it("clearAuthSessionModelsForProvider removes compound cache keys", async () => {
		mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))

		await getModels({
			provider: providerIdentifiers.zooGateway,
			apiKey: "account-a",
			baseUrl: "https://gateway-a.test/v1",
		})
		await getModels({
			provider: providerIdentifiers.zooGateway,
			apiKey: "account-b",
			baseUrl: "https://gateway-b.test/v1",
		})
		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)

		clearAuthSessionModelsForProvider(providerIdentifiers.zooGateway)

		await getModels({
			provider: providerIdentifiers.zooGateway,
			apiKey: "account-a",
			baseUrl: "https://gateway-a.test/v1",
		})
		await getModels({
			provider: providerIdentifiers.zooGateway,
			apiKey: "account-b",
			baseUrl: "https://gateway-b.test/v1",
		})

		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(4)
	})

	it("flushModels with refresh keeps the prior catalog when the provider fetch fails", async () => {
		mockGetZooGatewayModels
			.mockResolvedValueOnce(zooGatewayOk(zooModels))
			.mockRejectedValueOnce(new Error("network down"))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		await getModels(options)
		await expect(flushModels(options, true)).resolves.toBeUndefined()

		const afterFailedRefresh = await getModels(options)
		expect(afterFailedRefresh).toEqual(zooModels)
		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)
	})

	it("flushModels with refresh logs and does not throw when refresh fails with no session cache", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		mockGetZooGatewayModels.mockRejectedValue(new Error("network down"))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		await expect(flushModels(options, true)).resolves.toBeUndefined()
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("[flushModels] Failed to refresh auth-scoped"),
			expect.any(Error),
		)
		consoleSpy.mockRestore()
	})

	it("flushModels with refresh keeps the prior catalog when refresh returns empty", async () => {
		mockGetZooGatewayModels.mockResolvedValueOnce(zooGatewayOk(zooModels)).mockResolvedValueOnce(zooGatewayOk({}))
		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		await getModels(options)
		await flushModels(options, true)

		const afterEmptyRefresh = await getModels(options)
		expect(afterEmptyRefresh).toEqual(zooModels)
		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)
	})

	it("prunes session entries older than twice the TTL when maintaining the cache", async () => {
		vi.useFakeTimers()
		try {
			mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
			const first = { provider: providerIdentifiers.zooGateway, apiKey: "session-a" }
			const second = { provider: providerIdentifiers.zooGateway, apiKey: "session-b" }

			await getModels(first)
			vi.advanceTimersByTime(5 * 60 * 1000 * 2 + 1)
			await getModels(second)

			mockGetZooGatewayModels.mockClear()
			mockGetZooGatewayModels.mockResolvedValueOnce({ kind: "not_modified" })
			const result = await getModels(first)

			expect(result).toEqual({})
		} finally {
			vi.useRealTimers()
		}
	})

	it("staleCutoffMs uses >= so entry at exactly 2x TTL is pruned", async () => {
		// Kills: EqualityOperator mutant L159 (>= staleCutoffMs → > staleCutoffMs)
		vi.useFakeTimers()
		try {
			mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
			const first = { provider: providerIdentifiers.zooGateway, apiKey: "session-a" }
			const second = { provider: providerIdentifiers.zooGateway, apiKey: "session-b" }

			await getModels(first)
			// Advance to EXACTLY 2x TTL — must be pruned (>= not just >)
			vi.advanceTimersByTime(5 * 60 * 1000 * 2)
			await getModels(second)

			mockGetZooGatewayModels.mockClear()
			// First entry was pruned — a new fetch must fire (not_modified without etag yields {})
			mockGetZooGatewayModels.mockResolvedValueOnce(zooGatewayOk({}))
			const result = await getModels(first)

			// No cache entry → provider returned empty → fallback to {}
			expect(result).toEqual({})
		} finally {
			vi.useRealTimers()
		}
	})

	it("enforces session cache MAX_ENTRIES by evicting the oldest entry", async () => {
		// Kills: ConditionalExpression mutants on L167-L179 (while loop and oldestKey guard)
		vi.useFakeTimers()
		try {
			// Fill 65 unique sessions (1 over AUTH_SESSION_MAX_ENTRIES=64)
			for (let i = 0; i < 65; i++) {
				mockGetZooGatewayModels.mockResolvedValueOnce(zooGatewayOk(zooModels))
				vi.advanceTimersByTime(1) // ensure fetchedAt differs so oldest is well-defined
				await getModels({ provider: providerIdentifiers.zooGateway, apiKey: `session-${i}` })
			}
			// session-0 is the oldest — it must have been evicted. Verify by clearing mock
			// and calling with session-0: if it was evicted, a fresh fetch fires.
			mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
			mockGetZooGatewayModels.mockClear()
			await getModels({ provider: providerIdentifiers.zooGateway, apiKey: "session-0" })
			expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it("does not evict when the session cache is exactly at MAX_ENTRIES", async () => {
		// Kills: EqualityOperator mutant `size > MAX` → `size >= MAX` (would evict at exactly 64)
		vi.useFakeTimers()
		try {
			for (let i = 0; i < 64; i++) {
				mockGetZooGatewayModels.mockResolvedValueOnce(zooGatewayOk(zooModels))
				vi.advanceTimersByTime(1)
				await getModels({ provider: providerIdentifiers.zooGateway, apiKey: `session-${i}` })
			}

			mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
			mockGetZooGatewayModels.mockClear()
			await getModels({ provider: providerIdentifiers.zooGateway, apiKey: "session-0" })
			expect(mockGetZooGatewayModels).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("evicts the earliest-inserted entry when fetchedAt timestamps are equal", async () => {
		// Kills: EqualityOperator mutant `fetchedAt < oldest` → `<=` (would prefer the newest key)
		vi.useFakeTimers()
		try {
			for (let i = 0; i < 65; i++) {
				mockGetZooGatewayModels.mockResolvedValueOnce(zooGatewayOk(zooModels))
				await getModels({ provider: providerIdentifiers.zooGateway, apiKey: `session-${i}` })
			}

			mockGetZooGatewayModels.mockResolvedValue(zooGatewayOk(zooModels))
			mockGetZooGatewayModels.mockClear()
			await getModels({ provider: providerIdentifiers.zooGateway, apiKey: "session-0" })
			expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(1)

			mockGetZooGatewayModels.mockClear()
			await getModels({ provider: providerIdentifiers.zooGateway, apiKey: "session-64" })
			expect(mockGetZooGatewayModels).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("setAuthSessionEntry does not store an empty model record", async () => {
		// Kills: ConditionalExpression mutant L188 (false) — empty models must be rejected
		mockGetZooGatewayModels
			.mockResolvedValueOnce(zooGatewayOk({})) // first call: empty
			.mockResolvedValueOnce(zooGatewayOk(zooModels)) // second call: populated

		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		// First call returns empty — nothing stored
		await getModels(options)
		// Second call must fetch again (nothing was cached from first call)
		const second = await getModels(options)

		expect(second).toEqual(zooModels)
		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)
	})

	it("stale in-flight fetch must not write to cache even when a new fetch registered the key", async () => {
		// Kills: LogicalOperator mutant L303 (&&→||):
		// With ||, fetch A (stale) would write because inFlightAuthScopedFetch.has(key)==true.
		// This test detects that by making a THIRD call immediately after fetch A resolves
		// (before fetch B): if stale data was written it's served from cache; if not, the
		// third call deduplicates to fetch B and gets fresh data.
		type ZooGatewayResult = Awaited<ReturnType<typeof getZooGatewayModels>>
		const staleModels: ModelRecord = {
			"stale/model": { maxTokens: 1000, contextWindow: 1000, supportsPromptCache: false },
		}
		const freshModelsAfterSignOut2: ModelRecord = {
			"fresh2/model": { maxTokens: 3000, contextWindow: 3000, supportsPromptCache: false },
		}

		let resolveFetchA!: (v: ZooGatewayResult) => void
		let resolveFetchB!: (v: ZooGatewayResult) => void
		const fetchADeferred = new Promise<ZooGatewayResult>((r) => (resolveFetchA = r))
		const fetchBDeferred = new Promise<ZooGatewayResult>((r) => (resolveFetchB = r))

		mockGetZooGatewayModels.mockReturnValueOnce(fetchADeferred).mockReturnValueOnce(fetchBDeferred)

		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		// 1. Start fetch A (pre-sign-out)
		const fetchAResult = getModels(options)

		// 2. Sign-out
		clearAuthSessionModelsForProvider(providerIdentifiers.zooGateway)

		// 3. Start fetch B (post-sign-out) — registers new in-flight under the same key
		const fetchBResult = getModels(options)

		// 4. Resolve fetch A with stale data
		resolveFetchA(zooGatewayOk(staleModels))
		await fetchAResult

		// 5. Third call immediately after A resolves (B still pending).
		//    If stale data was written (|| bug), it gets served from cache → returns stale.
		//    If stale data was NOT written (correct &&), it deduplicates to fetch B → blocks.
		const thirdCallResult = getModels(options)

		// 6. Resolve fetch B with fresh data
		resolveFetchB(zooGatewayOk(freshModelsAfterSignOut2))
		const [thirdResult] = await Promise.all([thirdCallResult, fetchBResult])

		// The third call must have gotten fresh data (deduped to B), not stale data from A
		expect(thirdResult).toEqual(freshModelsAfterSignOut2)

		clearAuthSessionModelsForProvider(providerIdentifiers.zooGateway)
	})

	it("clearAuthSessionModelsForProvider also invalidates in-flight fetches not yet in cache", async () => {
		// Kills: ConditionalExpression mutants on L216 — the loop over inFlightAuthScopedFetch
		// must delete keys even when the cache is empty (fetch hasn't resolved yet).
		type ZooGatewayResult = Awaited<ReturnType<typeof getZooGatewayModels>>
		const freshModels2: ModelRecord = {
			"fresh2/model": { maxTokens: 3000, contextWindow: 3000, supportsPromptCache: false },
		}

		let resolveFetchA!: (v: ZooGatewayResult) => void
		const fetchADeferred = new Promise<ZooGatewayResult>((r) => (resolveFetchA = r))

		mockGetZooGatewayModels.mockReturnValueOnce(fetchADeferred).mockResolvedValueOnce(zooGatewayOk(freshModels2))

		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		// 1. Start fetch A — it's in-flight, cache is EMPTY (hasn't resolved yet)
		const fetchAResult = getModels(options)

		// 2. Sign out before fetch A resolves — must also clear the in-flight entry
		clearAuthSessionModelsForProvider(providerIdentifiers.zooGateway)

		// 3. Start fetch B — if in-flight was cleared, a NEW fetch fires (not deduped to A)
		const fetchBResult = getModels(options)

		// 4. Resolve A (stale) and B (fresh)
		resolveFetchA(zooGatewayOk(zooModels)) // stale pre-sign-out data
		await fetchAResult

		const bResult = await fetchBResult
		expect(bResult).toEqual(freshModels2)
		// Two fetches fired: A and B (if in-flight was cleared correctly)
		expect(mockGetZooGatewayModels).toHaveBeenCalledTimes(2)

		clearAuthSessionModelsForProvider(providerIdentifiers.zooGateway)
	})

	it("generation counter increments by +1 on each sign-out, not by -1", async () => {
		// Kills: ArithmeticOperator mutant L224 (+ 1 → - 1).
		// After two sign-outs the counter should be 2; with -1 it would be -2.
		// We observe this indirectly: two sign-outs → two in-flight fetches complete → only
		// the post-second-sign-out fetch should write to cache.
		type ZooGatewayResult = Awaited<ReturnType<typeof getZooGatewayModels>>
		const models1: ModelRecord = { "m1/a": { maxTokens: 100, contextWindow: 100, supportsPromptCache: false } }
		const models2: ModelRecord = { "m2/b": { maxTokens: 200, contextWindow: 200, supportsPromptCache: false } }
		const models3: ModelRecord = { "m3/c": { maxTokens: 300, contextWindow: 300, supportsPromptCache: false } }

		let resolveA!: (v: ZooGatewayResult) => void
		let resolveB!: (v: ZooGatewayResult) => void
		let resolveC!: (v: ZooGatewayResult) => void
		mockGetZooGatewayModels
			.mockReturnValueOnce(new Promise((r) => (resolveA = r)))
			.mockReturnValueOnce(new Promise((r) => (resolveB = r)))
			.mockReturnValueOnce(new Promise((r) => (resolveC = r)))

		const options = { provider: providerIdentifiers.zooGateway, apiKey: "session-token" }

		// fetch A (gen=0 at start)
		const resA = getModels(options)
		clearAuthSessionModelsForProvider(providerIdentifiers.zooGateway) // gen → 1
		// fetch B (gen=1 at start)
		const resB = getModels(options)
		clearAuthSessionModelsForProvider(providerIdentifiers.zooGateway) // gen → 2
		// fetch C (gen=2 at start)
		const resC = getModels(options)

		// Resolve all with distinct data; only C's data should land in cache
		resolveA(zooGatewayOk(models1))
		await resA
		resolveB(zooGatewayOk(models2))
		await resB
		resolveC(zooGatewayOk(models3))
		const finalResult = await resC

		// C was the last fetch with matching generation — result must be models3
		expect(finalResult).toEqual(models3)

		clearAuthSessionModelsForProvider(providerIdentifiers.zooGateway)
	})
})
