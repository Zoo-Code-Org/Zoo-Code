import { expect, vi, type Mock } from "vitest"

import type { ApiHandlerOptions } from "../shared/api"

export function makeApiHandlerOptions(overrides: Partial<ApiHandlerOptions> = {}): ApiHandlerOptions {
	return {
		apiModelId: "gpt-4.1",
		openAiNativeApiKey: "test-api-key",
		...overrides,
	}
}

export function mockOpenAiResponsesClient(create: Mock) {
	return {
		__esModule: true,
		default: vi.fn().mockImplementation(function () {
			return {
				responses: { create },
			}
		}),
	}
}

type ObjectContainingInput = Parameters<typeof expect.objectContaining>[0]

export function expectRequestObjectContaining(value: ObjectContainingInput) {
	return expect.objectContaining(value)
}
