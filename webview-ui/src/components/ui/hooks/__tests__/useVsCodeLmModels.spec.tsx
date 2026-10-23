import React from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"

import { type ExtensionMessage, providerIdentifiers, VsCodeLmModelsMessageType } from "@roo-code/types"

import { createTestQueryClient } from "@src/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import { useVsCodeLmModels } from "../useVsCodeLmModels"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const send = (data: ExtensionMessage) => act(() => void window.dispatchEvent(new MessageEvent("message", { data })))
const model = {
	id: "vision",
	vendor: "other",
	family: "vision",
	modelInfo: { contextWindow: 100, supportsPromptCache: false, supportsImages: true },
}

const setup = (enabled = true) => {
	const client = createTestQueryClient()
	const wrapper = ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	)
	return renderHook(({ enabled }) => useVsCodeLmModels(enabled), { wrapper, initialProps: { enabled } })
}

describe("useVsCodeLmModels", () => {
	beforeEach(() => vi.clearAllMocks())

	it("requests generic models when enabled, leaving capabilities unknown until the reply", () => {
		const { result } = setup()
		expect(result.current.data).toBeUndefined()
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: VsCodeLmModelsMessageType.requestVsCodeLmModels,
			apiConfiguration: { apiProvider: providerIdentifiers.vscodeLm },
		})
	})

	it("updates capabilities and clears models on an empty reply", async () => {
		const { result } = setup()
		send({ type: VsCodeLmModelsMessageType.vsCodeLmModels, vsCodeLmModels: [model] })
		await waitFor(() => expect(result.current.data?.[0].modelInfo?.supportsImages).toBe(true))
		send({
			type: VsCodeLmModelsMessageType.vsCodeLmModels,
			vsCodeLmModels: [{ ...model, modelInfo: { ...model.modelInfo, supportsImages: false } }],
		})
		await waitFor(() => expect(result.current.data?.[0].modelInfo?.supportsImages).toBe(false))
		send({ type: VsCodeLmModelsMessageType.vsCodeLmModels, vsCodeLmModels: [] })
		await waitFor(() => expect(result.current.data).toEqual([]))
	})

	it.each([
		{ type: VsCodeLmModelsMessageType.githubCopilotModels, vsCodeLmModels: [model] },
		{ type: VsCodeLmModelsMessageType.githubCopilotSignInResult, vsCodeLmModels: [model] },
		{ type: VsCodeLmModelsMessageType.vsCodeLmModels },
	])("ignores non-generic or unsuccessful replies: %j", (message) => {
		const { result } = setup()
		send(message)
		expect(result.current.data).toBeUndefined()
	})

	it.each([{ models: undefined }, { models: [model] }])(
		"clears stale capabilities on an explicit error: %j",
		async ({ models }) => {
			const { result } = setup()
			send({ type: VsCodeLmModelsMessageType.vsCodeLmModels, vsCodeLmModels: [model] })
			await waitFor(() => expect(result.current.data?.[0].modelInfo?.supportsImages).toBe(true))

			send({ type: VsCodeLmModelsMessageType.vsCodeLmModels, error: "unavailable", vsCodeLmModels: models })
			await waitFor(() => expect(result.current.data).toEqual([]))

			send({ type: VsCodeLmModelsMessageType.vsCodeLmModels, vsCodeLmModels: [model] })
			await waitFor(() => expect(result.current.data?.[0].modelInfo?.supportsImages).toBe(true))
		},
	)

	it("does not request or listen when disabled, and removes its listener on unmount", () => {
		const remove = vi.spyOn(window, "removeEventListener")
		const { result, rerender, unmount } = setup(false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
		send({ type: VsCodeLmModelsMessageType.vsCodeLmModels, vsCodeLmModels: [model] })
		expect(result.current.data).toBeUndefined()
		rerender({ enabled: true })
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		rerender({ enabled: false })
		expect(remove).toHaveBeenCalledWith("message", expect.any(Function))
		rerender({ enabled: true })
		remove.mockClear()
		unmount()
		expect(remove).toHaveBeenCalledWith("message", expect.any(Function))
		remove.mockRestore()
	})
})
