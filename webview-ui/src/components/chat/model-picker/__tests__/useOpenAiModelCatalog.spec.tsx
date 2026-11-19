import { act, renderHook } from "@testing-library/react"

import { discoverOpenAiModels } from "../openAiModelDiscovery"
import { useOpenAiModelCatalog } from "../useOpenAiModelCatalog"

vi.mock("../openAiModelDiscovery", () => ({ discoverOpenAiModels: vi.fn() }))

describe("useOpenAiModelCatalog cancellation", () => {
	it.each(["resolve", "reject"] as const)("ignores %s after the request is aborted", async (settlement) => {
		let resolve!: (ids: string[]) => void
		let reject!: (error: Error) => void
		vi.mocked(discoverOpenAiModels).mockImplementationOnce(
			() =>
				new Promise((yes, no) => {
					resolve = yes
					reject = no
				}),
		)
		const { result, rerender } = renderHook(
			({ enabled }) => useOpenAiModelCatalog({ openAiBaseUrl: "https://test", openAiApiKey: "secret" }, enabled),
			{
				initialProps: { enabled: true },
			},
		)
		rerender({ enabled: false })
		await act(async () => {
			if (settlement === "resolve") resolve(["stale"])
			else reject(new Error("stale"))
		})
		expect(result.current).toMatchObject({ models: null, isLoading: false, isError: false })
	})
})
