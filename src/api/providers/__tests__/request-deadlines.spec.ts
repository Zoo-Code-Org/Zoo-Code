// npx vitest run api/providers/__tests__/request-deadlines.spec.ts

// Capture undici Agent constructions: the deadline factory must hand each
// OpenAI-compatible client a dispatcher whose idle deadlines (headers/body)
// equal the configured request budget instead of undici's hidden 300s
// defaults (issue #1407).
const agentConstructor = vitest.fn()

vitest.mock("undici", () => ({
	Agent: vitest.fn().mockImplementation(function (options: Record<string, number>) {
		agentConstructor(options)
		return { __mockDispatcher: true }
	}),
}))

vitest.mock("../../../utils/networkProxy", () => ({
	isProxyEnabled: vitest.fn(),
}))

import { isProxyEnabled } from "../../../utils/networkProxy"
import { createIdleDeadlineDispatcher, createRequestDeadlineFetchOptions } from "../utils/request-deadlines"
import { clearAllMocks } from "../../../test-utils/reset"

function lastAgentOptions(): Record<string, number> | null {
	const call = agentConstructor.mock.calls.at(-1)
	return (call?.[0] ?? null) as Record<string, number> | null
}

describe("createRequestDeadlineFetchOptions", () => {
	beforeEach(() => {
		clearAllMocks()
		vitest.mocked(isProxyEnabled).mockReturnValue(false)
	})

	it("wires a dispatcher whose idle deadlines equal the request budget", () => {
		const fetchOptions = createRequestDeadlineFetchOptions(600000)

		expect(Object.keys(fetchOptions)).toStrictEqual(["fetchOptions"])
		expect(agentConstructor).toHaveBeenCalledTimes(1)
		expect(lastAgentOptions()).toStrictEqual({ headersTimeout: 600000, bodyTimeout: 600000 })
		expect(fetchOptions.fetchOptions).toBeDefined()
	})

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"wires no dispatcher for a non-positive or non-finite budget (%s)",
		(budget) => {
			expect(createRequestDeadlineFetchOptions(budget)).toStrictEqual({})
			expect(createIdleDeadlineDispatcher(budget)).toBeUndefined()
			expect(agentConstructor).not.toHaveBeenCalled()
		},
	)

	it("wires no dispatcher while the debug proxy is active", () => {
		vitest.mocked(isProxyEnabled).mockReturnValue(true)

		const fetchOptions = createRequestDeadlineFetchOptions(600000)

		expect(fetchOptions).toStrictEqual({})
		expect(agentConstructor).not.toHaveBeenCalled()
	})
})
