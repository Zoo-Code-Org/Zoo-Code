// npx vitest run api/providers/fetchers/__tests__/modelEndpointCache.spec.ts

import { vi, describe, it, expect, beforeEach } from "vitest"

import * as path from "path"

import sanitize from "sanitize-filename"

import { providerIdentifiers, type ModelRecord } from "@roo-code/types"

import { getModelEndpoints } from "../modelEndpointCache"
import * as modelCache from "../modelCache"
import * as openrouter from "../openrouter"

vi.mock("../modelCache")
vi.mock("../openrouter")

const { readFileMock, fileExistsMock } = vi.hoisted(() => ({
	readFileMock: vi.fn(),
	fileExistsMock: vi.fn(),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		readFile: readFileMock,
		default: { ...actual, readFile: readFileMock },
	}
})

vi.mock("../../../../utils/fs", () => ({
	fileExistsAtPath: fileExistsMock,
}))

vi.mock("../../../../utils/storage", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../utils/storage")>()
	return { ...actual, getCacheDirectoryPath: vi.fn().mockResolvedValue("/mock/cache") }
})

vi.mock("../../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../../core/config/ContextProxy", () => ({
	ContextProxy: { instance: { globalStorageUri: { fsPath: "/mock/globalStorage" } } },
}))

describe("modelEndpointCache", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Default: no per-model file cache present; individual tests opt in.
		fileExistsMock.mockResolvedValue(false)
		readFileMock.mockResolvedValue("")
	})

	describe("getModelEndpoints", () => {
		it("should copy model-level capabilities from parent model to endpoints", async () => {
			// Mock the parent model data with capabilities
			const mockParentModels = {
				"anthropic/claude-sonnet-4": {
					maxTokens: 8192,
					contextWindow: 200000,
					supportsImages: true,
					supportsPromptCache: true,
					supportsReasoningEffort: true,
					supportedParameters: ["max_tokens", "temperature", "reasoning"] as any,
					inputPrice: 3,
					outputPrice: 15,
				},
			}

			// Mock endpoint data WITHOUT capabilities (as returned by API)
			const mockEndpoints = {
				anthropic: {
					maxTokens: 8192,
					contextWindow: 200000,
					supportsImages: true,
					supportsPromptCache: true,
					inputPrice: 3,
					outputPrice: 15,
					// Note: No supportsReasoningEffort, or supportedParameters
				},
				"amazon-bedrock": {
					maxTokens: 8192,
					contextWindow: 200000,
					supportsImages: true,
					supportsPromptCache: true,
					inputPrice: 3,
					outputPrice: 15,
				},
			}

			vi.spyOn(modelCache, "getModels").mockResolvedValue(mockParentModels as any)
			vi.spyOn(openrouter, "getOpenRouterModelEndpoints").mockResolvedValue(mockEndpoints as any)

			const result = await getModelEndpoints({
				router: providerIdentifiers.openrouter,
				modelId: "anthropic/claude-sonnet-4",
				endpoint: "anthropic",
			})

			// Verify capabilities were copied from parent to ALL endpoints
			expect(result.anthropic.supportsReasoningEffort).toBe(true)
			expect(result.anthropic.supportedParameters).toEqual(["max_tokens", "temperature", "reasoning"])

			expect(result["amazon-bedrock"].supportsReasoningEffort).toBe(true)
			expect(result["amazon-bedrock"].supportedParameters).toEqual(["max_tokens", "temperature", "reasoning"])
		})

		it("should create independent array copies to avoid shared references", async () => {
			const mockParentModels = {
				"test/model": {
					maxTokens: 1000,
					contextWindow: 10000,
					supportsPromptCache: false,
					supportsReasoningEffort: ["disable", "low", "high"],
					supportedParameters: ["max_tokens", "temperature"] as any,
				},
			}

			const mockEndpoints = {
				"endpoint-1": {
					maxTokens: 1000,
					contextWindow: 10000,
					supportsPromptCache: false,
				},
				"endpoint-2": {
					maxTokens: 1000,
					contextWindow: 10000,
					supportsPromptCache: false,
				},
			}

			vi.spyOn(modelCache, "getModels").mockResolvedValue(mockParentModels as any)
			vi.spyOn(openrouter, "getOpenRouterModelEndpoints").mockResolvedValue(mockEndpoints as any)

			const result = await getModelEndpoints({
				router: providerIdentifiers.openrouter,
				modelId: "test/model",
				endpoint: "endpoint-1",
			})

			// Modify one endpoint's arrays
			result["endpoint-1"].supportedParameters?.push("reasoning" as any)
			const endpointEffort = result["endpoint-1"].supportsReasoningEffort
			if (Array.isArray(endpointEffort)) {
				endpointEffort.push("max")
			}

			// Verify the other endpoint's arrays were NOT affected (independent copies)
			expect(result["endpoint-1"].supportedParameters).toHaveLength(3)
			expect(result["endpoint-2"].supportedParameters).toHaveLength(2)
			expect(result["endpoint-1"].supportsReasoningEffort).toEqual(["disable", "low", "high", "max"])
			expect(result["endpoint-2"].supportsReasoningEffort).toEqual(["disable", "low", "high"])
		})

		it("should handle missing parent model gracefully", async () => {
			const mockParentModels = {}
			const mockEndpoints = {
				anthropic: {
					maxTokens: 8192,
					contextWindow: 200000,
					supportsImages: true,
					supportsPromptCache: true,
				},
			}

			vi.spyOn(modelCache, "getModels").mockResolvedValue(mockParentModels as any)
			vi.spyOn(openrouter, "getOpenRouterModelEndpoints").mockResolvedValue(mockEndpoints as any)

			const result = await getModelEndpoints({
				router: providerIdentifiers.openrouter,
				modelId: "missing/model",
				endpoint: "anthropic",
			})

			// Should not crash, but copied capabilities will be undefined
			expect(result.anthropic).toBeDefined()
			expect(result.anthropic.supportedParameters).toBeUndefined()
		})

		it("should return empty object for non-openrouter providers", async () => {
			const result = await getModelEndpoints({
				router: providerIdentifiers.vercelAiGateway,
				modelId: "claude-sonnet-4",
				endpoint: "default",
			})

			expect(result).toEqual({})
		})

		it("should return empty object when modelId or endpoint is missing", async () => {
			const result1 = await getModelEndpoints({
				router: providerIdentifiers.openrouter,
				modelId: undefined,
				endpoint: "anthropic",
			})

			const result2 = await getModelEndpoints({
				router: providerIdentifiers.openrouter,
				modelId: "anthropic/claude-sonnet-4",
				endpoint: undefined,
			})

			expect(result1).toEqual({})
			expect(result2).toEqual({})
		})

		it("should fall back to the per-model file cache when the API returns no endpoints", async () => {
			const modelId = "fallback/model"
			// Same filename the write path persists: `${getCacheKey(router, modelId)}_endpoints.json`.
			const cacheKey = sanitize(`${providerIdentifiers.openrouter}_${modelId}`)
			const cachedEndpoints: ModelRecord = {
				anthropic: { maxTokens: 8192, contextWindow: 200000, supportsPromptCache: true },
			}

			vi.spyOn(modelCache, "getModels").mockResolvedValue({})
			vi.spyOn(openrouter, "getOpenRouterModelEndpoints").mockResolvedValue({})
			fileExistsMock.mockResolvedValue(true)
			readFileMock.mockResolvedValue(JSON.stringify(cachedEndpoints))

			const result = await getModelEndpoints({
				router: providerIdentifiers.openrouter,
				modelId,
				endpoint: "anthropic",
			})

			expect(readFileMock).toHaveBeenCalledWith(path.join("/mock/cache", `${cacheKey}_endpoints.json`), "utf8")
			expect(result).toEqual(cachedEndpoints)
		})
	})
})
