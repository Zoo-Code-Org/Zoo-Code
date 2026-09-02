import { expect, vi, type Mock } from "vitest"

import type { ApiHandlerCreateMessageMetadata } from "../api"
import type { ApiHandlerOptions } from "../shared/api"

export function makeApiHandlerOptions(overrides: Partial<ApiHandlerOptions> = {}): ApiHandlerOptions {
	return {
		apiModelId: "gpt-4.1",
		openAiNativeApiKey: "test-api-key",
		...overrides,
	}
}

/**
 * Build request-message metadata for provider tests. Defaults a taskId so tests
 * only pass the fields they care about (for example an abortSignal).
 */
export function makeCreateMessageMetadata(
	overrides: Partial<ApiHandlerCreateMessageMetadata> = {},
): ApiHandlerCreateMessageMetadata {
	return {
		taskId: "test-task",
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
