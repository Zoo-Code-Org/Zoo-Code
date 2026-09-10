import { describe, expect, it, vi } from "vitest"

import { expectRequestObjectContaining, makeApiHandlerOptions, mockOpenAiResponsesClient } from "../api"

describe("API test utilities", () => {
	it("provides stable handler defaults with override support", () => {
		expect(makeApiHandlerOptions({ apiModelId: "gpt-5.6-sol" })).toMatchObject({
			apiModelId: "gpt-5.6-sol",
			openAiNativeApiKey: "test-api-key",
		})
	})

	it("creates an OpenAI Responses API client mock", () => {
		const create = vi.fn()
		const client = mockOpenAiResponsesClient(create).default()

		expect(client.responses.create).toBe(create)
	})

	it("matches only the requested request fields", () => {
		expect({ model: "gpt-4.1", stream: true }).toEqual(expectRequestObjectContaining({ model: "gpt-4.1" }))
	})
})
