import { act, waitFor } from "@testing-library/react"

import { providerIdentifiers, type ProviderSettings, type WebviewMessage } from "@roo-code/types"

import { createTestQueryClient, renderWithExtensionState } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"

import { useProfileModelCatalog } from "../useProfileModelCatalog"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const first: ProviderSettings = {
	apiProvider: providerIdentifiers.litellm,
	litellmBaseUrl: "https://first.test/v1",
	litellmApiKey: "first-secret",
}
const second: ProviderSettings = { ...first, litellmBaseUrl: "https://second.test/v1", litellmApiKey: "second-secret" }
const requests = () =>
	vi
		.mocked(vscode.postMessage)
		.mock.calls.map(([request]) => request)
		.filter(({ type }) => type === "requestRouterModels")
const reply = async (request: WebviewMessage, id: string) => {
	await act(async () => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "routerModels",
					requestId: request.requestId,
					values: { provider: request.values?.provider },
					routerModels: { litellm: { [id]: { contextWindow: 1000, supportsPromptCache: false } } },
				},
			}),
		)
	})
}

describe("profile-owned router catalogs", () => {
	beforeEach(() => vi.clearAllMocks())
	afterEach(() => vi.restoreAllMocks())

	it.each([second, { ...first, litellmApiKey: "second-secret" }])(
		"isolates endpoint/account changes from cached catalogs and late responses",
		async (next) => {
			const client = createTestQueryClient()
			client.setQueryData(["routerModels", "litellm"], { litellm: { genericStale: {} } })
			let catalog!: ReturnType<typeof useProfileModelCatalog>
			const Catalog = ({ config }: { config: ProviderSettings }) => {
				catalog = useProfileModelCatalog(config)
				return null
			}
			const result = {
				get current() {
					return catalog
				},
			}
			const view = renderWithExtensionState(<Catalog config={first} />, { queryClient: client })
			const rerender = ({ config }: { config: ProviderSettings }) => view.rerender(<Catalog config={config} />)
			expect(result.current.models).toBeNull()
			await waitFor(() => expect(requests()).toHaveLength(1))
			const a = requests()[0]
			expect(a.apiConfiguration).toEqual(first)
			await reply(a, "a-only")
			await waitFor(() => expect(result.current.models).toHaveProperty("a-only"))
			rerender({ config: { ...first } })
			expect(requests()).toHaveLength(1)
			expect(result.current.models).toHaveProperty("a-only")
			act(() => result.current.refetch())
			await waitFor(() => expect(requests()).toHaveLength(2))
			const oldInFlight = requests()[1]
			rerender({ config: next })
			expect(result.current.models).toBeNull()
			expect(result.current.isLoading).toBe(true)
			await waitFor(() => expect(requests()).toHaveLength(3))
			const b = requests()[2]
			expect(b.apiConfiguration).toEqual(next)
			expect(b.requestId).not.toBe(oldInFlight.requestId)
			await reply(oldInFlight, "late-a-only")
			await reply({ ...b, requestId: undefined }, "uncorrelated")
			expect(result.current.models).toBeNull()
			await reply(b, "b-only")
			await waitFor(() => expect(Object.keys(result.current.models ?? {})).toEqual(["b-only"]))
			const keys = JSON.stringify(
				client
					.getQueryCache()
					.getAll()
					.map(({ queryKey }) => queryKey),
			)
			for (const secret of ["first-secret", "second-secret", "first.test", "second.test"])
				expect(keys).not.toContain(secret)
			rerender({ config: first })
			expect(result.current.models).toBeNull()
			await waitFor(() => expect(requests()).toHaveLength(4))
			await reply(b, "late-b-only")
			expect(result.current.models).toBeNull()
			await reply(requests()[3], "fresh-a-only")
			await waitFor(() => expect(Object.keys(result.current.models ?? {})).toEqual(["fresh-a-only"]))
			view.unmount()
			client.clear()
		},
	)
})
