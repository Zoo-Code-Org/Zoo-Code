import React from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"

import { VsCodeLmModelsMessageType } from "@roo-code/types"

import { createTestQueryClient } from "@src/utils/test-utils"

import { useGitHubCopilotModels } from "../useGitHubCopilotModels"

const model = (id: string) => ({ id, vendor: "copilot", family: id, version: "1" })

const send = (data: object) => act(() => void window.dispatchEvent(new MessageEvent("message", { data })))

const setup = (enabled = true) => {
	const client = createTestQueryClient()
	const wrapper = ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	)
	return renderHook(({ on }) => useGitHubCopilotModels(on), { wrapper, initialProps: { on: enabled } })
}

describe("useGitHubCopilotModels", () => {
	it("has no models until the extension reports some", () => {
		const { result } = setup()
		expect(result.current.data).toBeUndefined()
	})

	it("holds the list the extension pushes", async () => {
		const { result } = setup()

		send({ type: VsCodeLmModelsMessageType.githubCopilotModels, vsCodeLmModels: [model("a"), model("b")] })

		await waitFor(() => expect(result.current.data?.map((m) => m.id)).toEqual(["a", "b"]))
	})

	it("takes the list delivered with a completed sign-in", async () => {
		const { result } = setup()

		send({
			type: VsCodeLmModelsMessageType.githubCopilotSignInResult,
			githubCopilotAccount: "Test User",
			vsCodeLmModels: [model("signed-in")],
		})

		await waitFor(() => expect(result.current.data?.map((m) => m.id)).toEqual(["signed-in"]))
	})

	it("treats an empty list as the truth, since an account may genuinely have no models", async () => {
		const { result } = setup()
		send({ type: VsCodeLmModelsMessageType.githubCopilotModels, vsCodeLmModels: [model("a")] })
		await waitFor(() => expect(result.current.data).toHaveLength(1))

		send({ type: VsCodeLmModelsMessageType.githubCopilotModels, vsCodeLmModels: [] })

		await waitFor(() => expect(result.current.data).toEqual([]))
	})

	it("keeps the last list through an error, an account-only update, or an unrelated message", async () => {
		const { result } = setup()
		send({ type: VsCodeLmModelsMessageType.githubCopilotModels, vsCodeLmModels: [model("kept")] })
		await waitFor(() => expect(result.current.data).toHaveLength(1))

		send({ type: VsCodeLmModelsMessageType.githubCopilotModels, error: "host busy" })
		send({ type: VsCodeLmModelsMessageType.githubCopilotModels, githubCopilotAccount: "Test User" })
		send({ type: VsCodeLmModelsMessageType.vsCodeLmModels, vsCodeLmModels: [model("legacy")] })
		send({ type: VsCodeLmModelsMessageType.githubCopilotSignInResult, error: "cancelled" })

		expect(result.current.data?.map((m) => m.id)).toEqual(["kept"])
	})

	it("ignores messages while Copilot is not the active provider", async () => {
		const { result } = setup(false)

		send({ type: VsCodeLmModelsMessageType.githubCopilotModels, vsCodeLmModels: [model("a")] })
		await new Promise((resolve) => setTimeout(resolve, 20))

		expect(result.current.data).toBeUndefined()
	})

	it("stops listening when disabled or unmounted", async () => {
		const remove = vi.spyOn(window, "removeEventListener")
		const { rerender, unmount } = setup()

		rerender({ on: false })
		expect(remove).toHaveBeenCalledWith("message", expect.any(Function))

		remove.mockClear()
		rerender({ on: true })
		unmount()
		expect(remove).toHaveBeenCalledWith("message", expect.any(Function))
		remove.mockRestore()
	})
})
