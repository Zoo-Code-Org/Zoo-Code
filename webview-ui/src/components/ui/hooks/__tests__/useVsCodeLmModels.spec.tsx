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

import { useVsCodeLmModels } from "../useVsCodeLmModels"

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
		const { Wrapper } = wrapper()
		renderHook(() => useVsCodeLmModels(false), { wrapper: Wrapper })

		await waitFor(() => {
			expect(vscode.postMessage).not.toHaveBeenCalled()
		})
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
})
