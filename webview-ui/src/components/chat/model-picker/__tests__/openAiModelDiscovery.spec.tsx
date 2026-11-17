import { act, renderHook } from "@testing-library/react"

import { providerIdentifiers, type ExtensionMessage, type ProviderSettings } from "@roo-code/types"

import { vscode } from "@/utils/vscode"

import { discoverOpenAiModels } from "../openAiModelDiscovery"
import { useOpenAiModelCatalog } from "../useOpenAiModelCatalog"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const first: ProviderSettings = {
	apiProvider: providerIdentifiers.openai,
	openAiBaseUrl: "https://first.test/v1",
	openAiApiKey: "first-secret",
	openAiHeaders: { Authorization: "header-secret" },
}
const second: ProviderSettings = { ...first, openAiBaseUrl: "https://second.test/v1", openAiApiKey: "second-secret" }

const flush = async () => {
	await act(async () => {
		await Promise.resolve()
	})
}
const reply = async (data: ExtensionMessage) => {
	await act(async () => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})
}
const requestId = () => vi.mocked(vscode.postMessage).mock.calls.at(-1)?.[0].requestId
const correlatedReply = (openAiModels: string[]) =>
	reply({ type: "openAiModels", requestId: requestId(), openAiModels })

describe("OpenAI model discovery", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})
	afterEach(() => vi.restoreAllMocks())

	it("sends the typed host payload and ignores mismatched correlated replies", async () => {
		const { result } = renderHook(() => useOpenAiModelCatalog(first, true))
		await flush()
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "requestOpenAiModels",
			requestId: expect.any(String),
			values: { baseUrl: first.openAiBaseUrl, apiKey: first.openAiApiKey, openAiHeaders: first.openAiHeaders },
		})
		await reply({ type: "openAiModels", requestId: "not-ours", openAiModels: ["wrong"] })
		await reply({ type: "openAiModels", openAiModels: ["legacy-settings"] })
		await reply({ type: "state", requestId: requestId() })
		expect(result.current.isLoading).toBe(true)
		await reply({ type: "openAiModels", requestId: requestId(), openAiModels: ["model", "__proto__"] })
		expect(result.current.models).toHaveProperty("model.contextWindow")
		expect(Object.hasOwn(result.current.models ?? {}, "__proto__")).toBe(true)
		expect(result.current.isError).toBe(false)
	})

	it("starts a new profile immediately and ignores the aborted profile's late response", async () => {
		const { result, rerender } = renderHook(({ config }) => useOpenAiModelCatalog(config, true), {
			initialProps: { config: first },
		})
		await flush()
		const oldRequestId = requestId()
		rerender({ config: second })
		await flush()
		expect(vscode.postMessage).toHaveBeenCalledTimes(2)
		expect(result.current.models).toBeNull()
		await reply({ type: "openAiModels", requestId: oldRequestId, openAiModels: ["first-only"] })
		expect(result.current.models).toBeNull()
		await correlatedReply(["second-only"])
		expect(Object.keys(result.current.models ?? {})).toEqual(["second-only"])
	})

	it("clears completed results immediately on credential/header changes and retries", async () => {
		const { result, rerender } = renderHook(({ config }) => useOpenAiModelCatalog(config, true), {
			initialProps: { config: first },
		})
		await flush()
		await correlatedReply(["old"])
		rerender({ config: { ...first, openAiApiKey: "rotated", openAiHeaders: { custom: "changed" } } })
		expect(result.current.models).toBeNull()
		await flush()
		await correlatedReply([])
		expect(result.current.models).toEqual({})
		expect(result.current.isError).toBe(false)
		const previousRequestId = requestId()
		act(() => result.current.refetch())
		expect(result.current.isLoading).toBe(true)
		await flush()
		await reply({ type: "openAiModels", requestId: previousRequestId, openAiModels: ["stale"] })
		expect(result.current.isLoading).toBe(true)
		await correlatedReply(["retried"])
		expect(Object.keys(result.current.models ?? {})).toEqual(["retried"])
	})

	it("does not reuse a completed catalog after disabling and re-enabling discovery", async () => {
		const { result, rerender } = renderHook(({ enabled }) => useOpenAiModelCatalog(first, enabled), {
			initialProps: { enabled: true },
		})
		await flush()
		await correlatedReply(["old"])
		rerender({ enabled: false })
		expect(result.current.models).toBeNull()
		rerender({ enabled: true })
		expect(result.current.models).toBeNull()
		expect(result.current.isLoading).toBe(true)
		await flush()
		await correlatedReply(["new"])
		expect(Object.keys(result.current.models ?? {})).toEqual(["new"])
	})

	it("removes an unmounted request's listener immediately without waiting for a reply", async () => {
		const remove = vi.spyOn(window, "removeEventListener")
		const { unmount } = renderHook(() => useOpenAiModelCatalog(first, true))
		await flush()
		unmount()
		expect(remove).toHaveBeenCalledWith("message", expect.any(Function))
	})

	it("isolates concurrent requests even when responses arrive in reverse order", async () => {
		const active = new AbortController()
		const other = new AbortController()
		const one = discoverOpenAiModels(first, active.signal)
		const firstRequestId = requestId()
		const two = discoverOpenAiModels(second, other.signal)
		expect(vscode.postMessage).toHaveBeenCalledTimes(2)
		expect(requestId()).not.toBe(firstRequestId)
		await correlatedReply(["other"])
		expect(await two).toEqual(["other"])
		await reply({ type: "openAiModels", requestId: firstRequestId, openAiModels: ["active"] })
		expect(await one).toEqual(["active"])
	})

	it.each([false, true])(
		"rejects an aborted request (already aborted: %s) and permits a fresh request",
		async (alreadyAborted) => {
			const controller = new AbortController()
			const remove = vi.spyOn(window, "removeEventListener")
			if (alreadyAborted) controller.abort()
			const aborted = discoverOpenAiModels(first, controller.signal)
			const assertion = expect(aborted).rejects.toMatchObject({ name: "AbortError" })
			controller.abort()
			await assertion
			expect(vscode.postMessage).toHaveBeenCalledTimes(alreadyAborted ? 0 : 1)
			if (!alreadyAborted) expect(remove).toHaveBeenCalledWith("message", expect.any(Function))
			const fresh = discoverOpenAiModels(second, new AbortController().signal)
			await correlatedReply(["fresh"])
			expect(await fresh).toEqual(["fresh"])
		},
	)

	it.each([
		{ type: "openAiModels" },
		{ type: "openAiModels", error: "Discovery failed", openAiModels: [] },
	] satisfies ExtensionMessage[])(
		"reports a correlated invalid/error reply and permits retry: %j",
		async (response) => {
			const { result } = renderHook(() => useOpenAiModelCatalog(first, true))
			await flush()
			await reply({ ...response, requestId: requestId() })
			expect(result.current.isError).toBe(true)
			expect(result.current.isLoading).toBe(false)
			expect(result.current.models).toBeNull()
			act(() => result.current.refetch())
			await flush()
			await correlatedReply(["valid"])
			expect(result.current.isError).toBe(false)
		},
	)

	it("times out with cleanup, ignores late responses, and retries without a reload", async () => {
		vi.useFakeTimers()
		try {
			const remove = vi.spyOn(window, "removeEventListener")
			const { result } = renderHook(() => useOpenAiModelCatalog(first, true))
			await flush()
			const timedOutId = requestId()
			await act(async () => {
				await vi.advanceTimersByTimeAsync(10_000)
			})
			expect(result.current.isError).toBe(true)
			expect(remove).toHaveBeenCalledWith("message", expect.any(Function))
			expect(vi.getTimerCount()).toBe(0)
			act(() => result.current.refetch())
			await flush()
			await reply({ type: "openAiModels", openAiModels: ["ambiguous"] })
			await reply({ type: "openAiModels", requestId: timedOutId, openAiModels: ["late"] })
			expect(result.current.models).toBeNull()
			await correlatedReply(["correlated"])
			expect(Object.keys(result.current.models ?? {})).toEqual(["correlated"])
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it.each([
		{},
		{ openAiApiKey: "key" },
		{ openAiBaseUrl: first.openAiBaseUrl },
		{ ...first, openAiApiKey: "" },
		{ ...first, openAiBaseUrl: "" },
	])("uses Settings rather than inference defaults for missing discovery configuration: %j", (config) => {
		const { result } = renderHook(() => useOpenAiModelCatalog(config, true))
		expect(result.current).toMatchObject({ models: null, isLoading: false, isError: true })
		act(() => result.current.refetch())
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("does not discover or report an error when disabled with missing configuration", () => {
		const { result } = renderHook(() => useOpenAiModelCatalog({}, false))
		expect(result.current).toMatchObject({ models: null, isLoading: false, isError: false })
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("clears a completed catalog when required configuration is removed, and discovers when restored", async () => {
		const { result, rerender } = renderHook(({ config }) => useOpenAiModelCatalog(config, true), {
			initialProps: { config: first },
		})
		await correlatedReply(["old"])
		rerender({ config: {} })
		expect(result.current).toMatchObject({ models: null, isLoading: false, isError: true })
		rerender({ config: first })
		expect(result.current).toMatchObject({ models: null, isLoading: true, isError: false })
		await correlatedReply(["new"])
		expect(Object.keys(result.current.models ?? {})).toEqual(["new"])
	})

	it("cleans up a synchronous transport failure and permits retry", async () => {
		const remove = vi.spyOn(window, "removeEventListener")
		vi.mocked(vscode.postMessage).mockImplementationOnce(() => {
			throw new Error("transport unavailable")
		})
		await expect(discoverOpenAiModels(first, new AbortController().signal)).rejects.toThrow("transport unavailable")
		expect(remove).toHaveBeenCalledWith("message", expect.any(Function))
		const retry = discoverOpenAiModels(first, new AbortController().signal)
		await correlatedReply([])
		expect(await retry).toEqual([])
	})

	it.each([{ openAiModels: null }, { openAiModels: "not-an-array" }, { openAiModels: ["model", 42] }])(
		"rejects malformed model lists: %j",
		async ({ openAiModels }) => {
			const discovery = discoverOpenAiModels(first, new AbortController().signal)
			const assertion = expect(discovery).rejects.toThrow("Invalid model discovery response")
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "openAiModels", requestId: requestId(), openAiModels },
				}),
			)
			await assertion
		},
	)

	it("listens before posting so a synchronous matching response is not lost", async () => {
		vi.mocked(vscode.postMessage).mockImplementationOnce((message) => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "openAiModels", requestId: message.requestId, openAiModels: ["immediate"] },
				}),
			)
		})
		await expect(discoverOpenAiModels(first, new AbortController().signal)).resolves.toEqual(["immediate"])
	})
})
