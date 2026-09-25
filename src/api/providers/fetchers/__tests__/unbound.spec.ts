// npx vitest run api/providers/fetchers/__tests__/unbound.spec.ts

import axios from "axios"

import { getUnboundModels } from "../unbound"

vi.mock("axios")
const mockAxiosGet = vi.mocked(axios.get)

it("passes the caller's abort signal to the catalog request", async () => {
	const controller = new AbortController()
	mockAxiosGet.mockResolvedValueOnce({ data: [] })

	await getUnboundModels("test-api-key", { signal: controller.signal })

	expect(mockAxiosGet).toHaveBeenCalledWith("https://api.getunbound.ai/models", {
		headers: { Authorization: "Bearer test-api-key" },
		signal: controller.signal,
	})
})

it("rejects with an AbortError when the signal aborts the pending request", async () => {
	const controller = new AbortController()
	mockAxiosGet.mockImplementation((_url, config) => {
		// Mirror the HTTP client: a request rejects when its signal fires,
		// including when the signal was already aborted when the request started.
		return new Promise<never>((_resolve, reject) => {
			if (config?.signal?.aborted) {
				reject(new Error("canceled"))
				return
			}
			config?.signal?.addEventListener?.("abort", () => reject(new Error("canceled")), { once: true })
		})
	})

	const fetchPromise = getUnboundModels(undefined, { signal: controller.signal })
	controller.abort()

	await expect(fetchPromise).rejects.toMatchObject({ name: "AbortError" })
})
