// npx vitest src/components/ui/hooks/__tests__/useVsCodeLmModels.spec.ts
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { VsCodeLmModelsMessageType } from "@roo-code/types"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

import { vscode } from "@src/utils/vscode"

import { getVsCodeLmModels, useVsCodeLmModels } from "../useVsCodeLmModels"

const wrapper = () => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	const Wrapper = ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	)
	return { queryClient, Wrapper }
}

const emitMessage = (data: unknown) => {
	window.dispatchEvent(new MessageEvent("message", { data }))
}

describe("useVsCodeLmModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useRealTimers()
	})

	it("does not post a request when disabled", async () => {
		const addSpy = vi.spyOn(window, "addEventListener")
		const { Wrapper } = wrapper()
		const { result } = renderHook(() => useVsCodeLmModels(false), { wrapper: Wrapper })

		// Give React Query a tick to settle; if the queryFn had been invoked
		// it would have synchronously posted a message and registered a listener.
		await waitFor(() => expect(result.current.fetchStatus).toBe("idle"))

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(addSpy).not.toHaveBeenCalledWith("message", expect.any(Function))

		addSpy.mockRestore()
	})

	it("posts a request when enabled and resolves with the matching response", async () => {
		const { Wrapper } = wrapper()
		const { result } = renderHook(() => useVsCodeLmModels(true), { wrapper: Wrapper })

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: VsCodeLmModelsMessageType.requestVsCodeLmModels,
		})

		emitMessage({
			type: VsCodeLmModelsMessageType.vsCodeLmModels,
			vsCodeLmModels: [{ vendor: "copilot", family: "gpt-4o" }],
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual([{ vendor: "copilot", family: "gpt-4o" }])
	})

	it("ignores unrelated messages and keeps waiting for the matching response", async () => {
		const { Wrapper } = wrapper()
		const { result } = renderHook(() => useVsCodeLmModels(true), { wrapper: Wrapper })

		emitMessage({ type: "someOtherMessage", payload: "nope" })

		await waitFor(() => expect(vscode.postMessage).toHaveBeenCalled())
		expect(result.current.isSuccess).toBe(false)

		emitMessage({
			type: VsCodeLmModelsMessageType.vsCodeLmModels,
			vsCodeLmModels: [{ vendor: "copilot", family: "gpt-4o-mini" }],
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual([{ vendor: "copilot", family: "gpt-4o-mini" }])
	})

	it("defaults to an empty array when the response omits the model list", async () => {
		const { Wrapper } = wrapper()
		const { result } = renderHook(() => useVsCodeLmModels(true), { wrapper: Wrapper })

		emitMessage({ type: VsCodeLmModelsMessageType.vsCodeLmModels })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual([])
	})

	it("removes the same window message listener it registered once the request resolves", async () => {
		const { Wrapper } = wrapper()
		const addSpy = vi.spyOn(window, "addEventListener")
		const removeSpy = vi.spyOn(window, "removeEventListener")

		renderHook(() => useVsCodeLmModels(true), { wrapper: Wrapper })

		const registeredHandler = addSpy.mock.calls.find(([eventName]) => eventName === "message")?.[1]
		expect(registeredHandler).toBeDefined()

		emitMessage({
			type: VsCodeLmModelsMessageType.vsCodeLmModels,
			vsCodeLmModels: [],
		})

		await waitFor(() => {
			expect(removeSpy).toHaveBeenCalledWith("message", registeredHandler)
		})

		addSpy.mockRestore()
		removeSpy.mockRestore()
	})

	it("rejects and removes the message listener when the query is aborted", async () => {
		const { queryClient, Wrapper } = wrapper()
		const addSpy = vi.spyOn(window, "addEventListener")
		const removeSpy = vi.spyOn(window, "removeEventListener")

		const { result } = renderHook(() => useVsCodeLmModels(true), { wrapper: Wrapper })

		const registeredHandler = addSpy.mock.calls.find(([eventName]) => eventName === "message")?.[1]
		expect(registeredHandler).toBeDefined()

		await queryClient.cancelQueries({ queryKey: ["vsCodeLmModels"] })

		await waitFor(() => {
			expect(removeSpy).toHaveBeenCalledWith("message", registeredHandler)
		})
		expect(result.current.isLoading).toBe(false)
		expect(result.current.data).toBeUndefined()

		// A later response must not populate the aborted query.
		emitMessage({
			type: VsCodeLmModelsMessageType.vsCodeLmModels,
			vsCodeLmModels: [{ vendor: "copilot", family: "gpt-4o" }],
		})
		expect(result.current.data).toBeUndefined()

		addSpy.mockRestore()
		removeSpy.mockRestore()
	})

	it("rejects with a timeout error if no response arrives within 10 seconds", async () => {
		const { Wrapper } = wrapper()
		const addSpy = vi.spyOn(window, "addEventListener")
		const removeSpy = vi.spyOn(window, "removeEventListener")

		vi.useFakeTimers()
		try {
			const { result } = renderHook(() => useVsCodeLmModels(true), { wrapper: Wrapper })

			const registeredHandler = addSpy.mock.calls.find(([eventName]) => eventName === "message")?.[1]
			expect(registeredHandler).toBeDefined()

			// Advance the fake clock that the hook's internal setTimeout depends
			// on. React Query schedules its own timers on the same clock, so we let
			// them fire as well; after 10s the request promise must be rejected with
			// the timeout error and the message listener removed.
			await vi.advanceTimersByTimeAsync(10_000)

			// Listener is cleaned up as part of the timeout path.
			expect(removeSpy).toHaveBeenCalledWith("message", registeredHandler)
			// React Query exposes the rejection as `error` on the result.
			await vi.waitFor(() => {
				expect(result.current.isError).toBe(true)
			})
			expect(result.current.error).toBeInstanceOf(Error)
			expect((result.current.error as Error).message).toBe("VS Code LM models request timed out")
		} finally {
			vi.useRealTimers()
			addSpy.mockRestore()
			removeSpy.mockRestore()
		}
	})

	it("rejects immediately when the signal is already aborted on entry", async () => {
		// The already-aborted branch must never register a window listener, never
		// start a timer and never post a request, otherwise we leak listeners when
		// React Query hands us a cancelled signal.
		const addSpy = vi.spyOn(window, "addEventListener")
		const removeSpy = vi.spyOn(window, "removeEventListener")
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout")
		const addEventListenerSpy = vi.spyOn(AbortSignal.prototype, "addEventListener")

		try {
			const controller = new AbortController()
			controller.abort()

			const aborted = await getVsCodeLmModels(controller.signal).then(
				() => undefined,
				(err: unknown) => err,
			)
			expect(aborted).toBeInstanceOf(DOMException)
			expect((aborted as DOMException).name).toBe("AbortError")

			expect(addSpy).not.toHaveBeenCalledWith("message", expect.any(Function))
			expect(removeSpy).not.toHaveBeenCalledWith("message", expect.any(Function))
			expect(vscode.postMessage).not.toHaveBeenCalled()
			expect(timeoutSpy).not.toHaveBeenCalled()
			expect(addEventListenerSpy).not.toHaveBeenCalled()
		} finally {
			addSpy.mockRestore()
			removeSpy.mockRestore()
			timeoutSpy.mockRestore()
			addEventListenerSpy.mockRestore()
		}
	})
})
