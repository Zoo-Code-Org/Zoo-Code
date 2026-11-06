import { clearAllMocks } from "../../../test-utils/reset"
import { makeCreateMessageMetadata } from "../../../test-utils/api"

const { mockGetModels, mockGetKimiCodeModels } = vi.hoisted(() => ({
	mockGetModels: vi.fn(),
	mockGetKimiCodeModels: vi.fn(),
}))

vi.mock("../fetchers/modelCache", () => ({
	getModels: mockGetModels,
	refreshModels: mockGetModels,
}))

vi.mock("../fetchers/kimi-code", () => ({
	getKimiCodeModels: mockGetKimiCodeModels,
}))

import { KimiCodeHandler } from "../kimi-code"
import { kimiCodeOAuthManager } from "../../../integrations/kimi-code/oauth"

const KIMI_CODE_CREDENTIALS_KEY = "kimi-code-oauth-credentials"

describe("KimiCodeHandler OAuth cancellation", () => {
	beforeEach(() => {
		clearAllMocks()
		mockGetModels.mockRejectedValue(new Error("offline"))
		mockGetKimiCodeModels.mockResolvedValue({})
	})

	it("rejects with the AbortError contract when the caller aborts with an ordinary Error reason during the OAuth refresh", async () => {
		// Real OAuth manager with an expired credential: prepareRequest must cancel the shared
		// refresh through the provider's entry point and surface the contract AbortError, not the
		// caller's custom reason.
		const values = new Map<string, string>()
		values.set(
			KIMI_CODE_CREDENTIALS_KEY,
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 }),
		)
		const secrets = {
			get: vi.fn(async (key: string) => values.get(key)),
			store: vi.fn(async (key: string, value: string) => void values.set(key, value)),
			delete: vi.fn(async (key: string) => void values.delete(key)),
		}
		kimiCodeOAuthManager.initialize({ secrets } as never)

		vi.spyOn(globalThis, "fetch").mockImplementation(((_url, init) => {
			const signal = (init as RequestInit)?.signal as AbortSignal
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true })
			})
		}) as typeof fetch)

		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "oauth" })
		const controller = new AbortController()
		const stream = handler.createMessage(
			"system",
			[{ role: "user", content: "test" }],
			makeCreateMessageMetadata({ abortSignal: controller.signal }),
		)
		const next = stream.next()
		controller.abort(new Error("cancelled by the caller"))

		await expect(next).rejects.toMatchObject({ name: "AbortError" })
	})
})
