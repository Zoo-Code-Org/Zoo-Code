// npx vitest run src/api/providers/__tests__/aetherapi.spec.ts

import OpenAI from "openai"

import { type AetherapiModelId, type ProviderSettings, aetherapiDefaultModelId, aetherapiModels } from "@roo-code/types"

import { buildApiHandler } from "../../index"
import { AetherapiHandler } from "../aetherapi"

const mockCreate = vi.fn()

vi.mock("openai", () => ({
	default: vi.fn(() => ({
		chat: {
			completions: {
				create: mockCreate,
			},
		},
	})),
}))

describe("AetherapiHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("uses the default AetherAPI base URL", () => {
		new AetherapiHandler({ aetherapiApiKey: "test-aetherapi-api-key" })

		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://api.aetherapi.dev/v1",
			}),
		)
	})

	it("uses a configured AetherAPI base URL", () => {
		new AetherapiHandler({
			aetherapiApiKey: "test-aetherapi-api-key",
			aetherapiBaseUrl: "https://gateway.example.test/v1",
		})

		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://gateway.example.test/v1",
			}),
		)
	})

	it("uses the AetherAPI API key", () => {
		new AetherapiHandler({ aetherapiApiKey: "test-aetherapi-api-key" })

		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "test-aetherapi-api-key",
			}),
		)
	})

	it("throws when the AetherAPI API key is missing", () => {
		expect(() => new AetherapiHandler({})).toThrow("API key is required")
	})

	it("returns the default AetherAPI model when no model is specified", () => {
		const handler = new AetherapiHandler({ aetherapiApiKey: "test-aetherapi-api-key" })

		expect(handler.getModel()).toEqual({
			id: aetherapiDefaultModelId,
			info: aetherapiModels[aetherapiDefaultModelId],
		})
	})

	it("returns a configured AetherAPI model", () => {
		const modelId: AetherapiModelId = "gpt-5.4"
		const handler = new AetherapiHandler({
			apiModelId: modelId,
			aetherapiApiKey: "test-aetherapi-api-key",
		})

		expect(handler.getModel()).toEqual({
			id: modelId,
			info: aetherapiModels[modelId],
		})
	})
})

describe("buildApiHandler AetherAPI routing", () => {
	it("builds an AetherAPI handler for the aetherapi provider", () => {
		const handler = buildApiHandler({
			apiProvider: "aetherapi",
			aetherapiApiKey: "test-aetherapi-api-key",
			apiModelId: "gpt-5.4",
		} as ProviderSettings)

		expect(handler).toBeInstanceOf(AetherapiHandler)
		expect(handler.getModel()).toEqual({
			id: "gpt-5.4",
			info: aetherapiModels["gpt-5.4"],
		})
	})
})
