import { KIMI_CODE_OAUTH_CONFIG, KimiCodeOAuthManager } from "../oauth"

const createContext = () => {
	const values = new Map<string, string>()
	return {
		values,
		context: {
			secrets: {
				get: vi.fn(async (key: string) => values.get(key)),
				store: vi.fn(async (key: string, value: string) => void values.set(key, value)),
				delete: vi.fn(async (key: string) => void values.delete(key)),
			},
		} as any,
	}
}

describe("KimiCodeOAuthManager", () => {
	beforeEach(() => vi.restoreAllMocks())

	it("uses the official public client ID and form-encoded device request", async () => {
		const { context } = createContext()
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					device_code: "device",
					user_code: "ABCD-EFGH",
					verification_uri: "https://auth.kimi.com/device",
					expires_in: 600,
					interval: 60,
				}),
				{ status: 200 },
			),
		)

		const authorization = await manager.startAuthorization()
		expect(authorization.userCode).toBe("ABCD-EFGH")
		expect(fetch).toHaveBeenCalledWith(
			KIMI_CODE_OAUTH_CONFIG.deviceAuthorizationEndpoint,
			expect.objectContaining({ body: `client_id=${KIMI_CODE_OAUTH_CONFIG.clientId}` }),
		)
		const cancelledPolling = manager.waitForAuthorization().catch((error) => error)
		manager.cancelAuthorization()
		await expect(cancelledPolling).resolves.toMatchObject({ message: "Kimi Code authorization was cancelled" })
	})

	it("deduplicates concurrent access-token refreshes and stores refreshed credentials", async () => {
		const { context, values } = createContext()
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ access_token: "new", refresh_token: "rotated", expires_in: 3600 }), {
				status: 200,
			}),
		)

		const [first, second] = await Promise.all([manager.getAccessToken(), manager.getAccessToken()])
		expect(first).toBe("new")
		expect(second).toBe("new")
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(context.secrets.store).toHaveBeenCalledTimes(1)
	})
})
