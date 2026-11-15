import React from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClientProvider, type UseQueryResult } from "@tanstack/react-query"

import type { WebviewMessage } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { createTestQueryClient } from "@src/utils/test-utils"

import { requestProviderInfo } from "../requestProviderInfo"
import { useOpenRouterKeyInfo } from "../useOpenRouterKeyInfo"
import { useOpenRouterModelProviders } from "../useOpenRouterModelProviders"
import { useRequestyKeyInfo } from "../useRequestyKeyInfo"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const wrapper = ({ children }: React.PropsWithChildren) => (
	<QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
)

beforeEach(() => {
	vi.mocked(vscode.postMessage).mockReset()
})

type Reply = { data?: unknown; error?: string }

// Answers each requestProviderInfo message like the extension host and records the messages.
const stubHost = (reply: (values: Record<string, unknown>) => Reply | null) => {
	const sent: WebviewMessage[] = []

	vi.mocked(vscode.postMessage).mockImplementation((message: WebviewMessage) => {
		sent.push(message)
		const answer = reply(message.values ?? {})
		if (!answer) return
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "providerInfo",
					requestId: message.requestId,
					...(answer.error ? { error: answer.error } : { values: { data: answer.data } }),
				},
			}),
		)
	})

	return { sent }
}

describe("requestProviderInfo", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it("posts the kind and params with a request id and resolves with the reply data", async () => {
		const { sent } = stubHost(() => ({ data: { ok: true } }))

		await expect(
			requestProviderInfo("openRouterKeyInfo", { apiKey: "k", baseUrl: "https://x.test" }),
		).resolves.toEqual({
			ok: true,
		})

		expect(sent).toEqual([
			{
				type: "requestProviderInfo",
				requestId: expect.any(String),
				values: { kind: "openRouterKeyInfo", apiKey: "k", baseUrl: "https://x.test" },
			},
		])
	})

	it("rejects with the host error message", async () => {
		stubHost(() => ({ error: "Provider info request failed" }))

		await expect(requestProviderInfo("requestyKeyInfo", { apiKey: "k" })).rejects.toThrow(
			"Provider info request failed",
		)
	})

	it("ignores replies for other request ids and rejects on timeout", async () => {
		vi.useFakeTimers()
		stubHost(() => null)

		const promise = requestProviderInfo("requestyKeyInfo", { apiKey: "k" })
		const settled = expect(promise).rejects.toThrow("Provider info request timed out")

		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "providerInfo", requestId: "other", values: { data: { stolen: true } } },
			}),
		)
		await act(() => vi.advanceTimersByTimeAsync(15_000))

		await settled
	})
})

describe("provider info hooks", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it.each<[string, () => UseQueryResult<unknown>]>([
		["useOpenRouterKeyInfo", () => useOpenRouterKeyInfo(undefined)],
		["useRequestyKeyInfo", () => useRequestyKeyInfo(undefined, undefined)],
	])("%s sends nothing without an apiKey", async (_name, useHook) => {
		stubHost(() => ({ data: {} }))

		const { result } = renderHook(useHook, { wrapper })

		await waitFor(() => expect(result.current.fetchStatus).toBe("idle"))
		expect(result.current.data).toBeUndefined()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("useOpenRouterModelProviders returns an empty record without a modelId", async () => {
		stubHost(() => ({ data: { unexpected: {} } }))

		const { result } = renderHook(() => useOpenRouterModelProviders(undefined), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual({})
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it.each<[string, () => UseQueryResult<unknown>, Record<string, string>, unknown]>([
		[
			"useOpenRouterKeyInfo",
			() => useOpenRouterKeyInfo("sk-or", "https://proxy.test/api/v1"),
			{ kind: "openRouterKeyInfo", apiKey: "sk-or", baseUrl: "https://proxy.test/api/v1" },
			{ label: "abc" },
		],
		[
			"useRequestyKeyInfo",
			() => useRequestyKeyInfo("https://custom.requesty.ai/v1", "rk"),
			{ kind: "requestyKeyInfo", apiKey: "rk", baseUrl: "https://custom.requesty.ai/v1" },
			{ name: "my-key" },
		],
		[
			"useOpenRouterModelProviders",
			() => useOpenRouterModelProviders("vendor/model", "https://proxy.test/api/v1"),
			{ kind: "openRouterModelProviders", modelId: "vendor/model", baseUrl: "https://proxy.test/api/v1" },
			{ "provider-a": { label: "provider-a" } },
		],
	])("%s asks the host and returns its data", async (_name, useHook, values, data) => {
		const { sent } = stubHost(() => ({ data }))

		const { result } = renderHook(useHook, { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(data)
		expect(sent.map((message) => message.values)).toEqual([values])
	})

	it.each<[string, () => UseQueryResult<unknown>, unknown]>([
		["useOpenRouterKeyInfo", () => useOpenRouterKeyInfo("sk-or"), null],
		["useRequestyKeyInfo", () => useRequestyKeyInfo(undefined, "rk"), null],
		["useOpenRouterModelProviders", () => useOpenRouterModelProviders("vendor/model"), {}],
	])("%s falls back and logs when the host reports an error", async (_name, useHook, fallback) => {
		stubHost(() => ({ error: "Provider info request failed" }))
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		const { result } = renderHook(useHook, { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(fallback)
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining("Error fetching"),
			expect.objectContaining({ message: "Provider info request failed" }),
		)
	})
})
