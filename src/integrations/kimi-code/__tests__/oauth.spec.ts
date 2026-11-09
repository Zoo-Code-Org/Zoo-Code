import type { ExtensionContext } from "vscode"

import {
	KIMI_CODE_OAUTH_CONFIG,
	KimiCodeOAuthManager,
	refreshKimiCodeAccessToken,
	type KimiCodeCredentials,
} from "../oauth"

const createContext = () => {
	const values = new Map<string, string>()
	return {
		values,
		// ExtensionContext double provides secrets.get/store/delete only.
		context: {
			secrets: {
				get: vi.fn(async (key: string) => values.get(key)),
				store: vi.fn(async (key: string, value: string) => void values.set(key, value)),
				delete: vi.fn(async (key: string) => void values.delete(key)),
			},
		} as unknown as ExtensionContext,
	}
}

describe("KimiCodeOAuthManager", () => {
	beforeEach(() => vi.restoreAllMocks())
	afterEach(() => vi.useRealTimers())

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

	it("returns null when not authenticated", async () => {
		const { context } = createContext()
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		expect(await manager.isAuthenticated()).toBe(false)
		expect(await manager.getAccessToken()).toBeNull()
	})

	it("returns cached access token when not expired", async () => {
		const { context, values } = createContext()
		const futureExpiry = Date.now() + 3600_000
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({
				type: "kimi-code",
				accessToken: "valid",
				refreshToken: "refresh",
				expiresAt: futureExpiry,
			}),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		const fetchSpy = vi.spyOn(globalThis, "fetch")
		expect(await manager.getAccessToken()).toBe("valid")
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("clears credentials and cancels authorization", async () => {
		const { context, values } = createContext()
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({ type: "kimi-code", accessToken: "token", refreshToken: "refresh", expiresAt: 99999 }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		await manager.clearCredentials()
		expect(values.has("kimi-code-oauth-credentials")).toBe(false)
		expect(await manager.isAuthenticated()).toBe(false)
	})

	it("does not restore credentials when sign-out races an in-flight refresh", async () => {
		const { context, values } = createContext()
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		let resolveRefresh!: (response: Response) => void
		vi.spyOn(globalThis, "fetch").mockReturnValueOnce(
			new Promise<Response>((resolve) => {
				resolveRefresh = resolve
			}),
		)

		const tokenPromise = manager.getAccessToken()
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
		const clearPromise = manager.clearCredentials()
		resolveRefresh(
			new Response(JSON.stringify({ access_token: "new", refresh_token: "rotated", expires_in: 3600 }), {
				status: 200,
			}),
		)

		await expect(tokenPromise).resolves.toBeNull()
		await clearPromise
		expect(context.secrets.store).not.toHaveBeenCalled()
		expect(values.has("kimi-code-oauth-credentials")).toBe(false)
	})

	it("bounds token refresh requests with a deadline", async () => {
		vi.useFakeTimers()
		const { context, values } = createContext()
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
			})
		})
		const tokenPromise = manager.getAccessToken()

		await vi.advanceTimersByTimeAsync(30_000)
		await expect(tokenPromise).resolves.toBeNull()
		expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true)
		expect(values.has("kimi-code-oauth-credentials")).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("keeps the newer polling lifecycle when a prior poll finishes cancellation", async () => {
		const { context } = createContext()
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						device_code: "first",
						user_code: "FIRST",
						verification_uri: "https://auth.kimi.com/device",
						expires_in: 600,
						interval: 60,
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						device_code: "second",
						user_code: "SECOND",
						verification_uri: "https://auth.kimi.com/device",
						expires_in: 600,
						interval: 60,
					}),
					{ status: 200 },
				),
			)

		await manager.startAuthorization()
		const firstPolling = manager.waitForAuthorization().catch((error) => error)
		await manager.startAuthorization()
		const secondPolling = manager.waitForAuthorization().catch((error) => error)
		await expect(firstPolling).resolves.toMatchObject({ message: "Kimi Code authorization was cancelled" })

		expect(manager.getState()).toMatchObject({ status: "polling", userCode: "SECOND" })
		expect(() => manager.waitForAuthorization()).not.toThrow()
		manager.cancelAuthorization()
		await secondPolling
	})

	it("ignores a superseded device request failure", async () => {
		const { context } = createContext()
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		let rejectFirst!: (error: Error) => void
		vi.spyOn(globalThis, "fetch")
			.mockReturnValueOnce(
				new Promise<Response>((_resolve, reject) => {
					rejectFirst = reject
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						device_code: "second",
						user_code: "SECOND",
						verification_uri: "https://auth.kimi.com/device",
						expires_in: 600,
						interval: 60,
					}),
					{ status: 200 },
				),
			)

		const first = manager.startAuthorization()
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
		await manager.startAuthorization()
		rejectFirst(new Error("stale request failed"))
		await expect(first).rejects.toThrow("stale request failed")

		expect(manager.getState()).toMatchObject({ status: "polling", userCode: "SECOND" })
		expect(() => manager.waitForAuthorization()).not.toThrow()
		const secondPolling = manager.waitForAuthorization().catch((error) => error)
		manager.cancelAuthorization()
		await secondPolling
	})

	it("handles polling completion successfully", async () => {
		const { context } = createContext()
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		const fetchSpy = vi.spyOn(globalThis, "fetch")
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					device_code: "device",
					user_code: "CODE",
					verification_uri: "https://auth.kimi.com/device",
					expires_in: 600,
					interval: 1,
				}),
				{ status: 200 },
			),
		)
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
		)
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ access_token: "new", refresh_token: "refresh", expires_in: 3600 }), {
				status: 200,
			}),
		)

		await manager.startAuthorization()
		const credentials = await manager.waitForAuthorization()
		expect(credentials.accessToken).toBe("new")
		expect(await manager.isAuthenticated()).toBe(true)
	})

	it("handles slow_down error during polling", async () => {
		const { context } = createContext()
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		const fetchSpy = vi.spyOn(globalThis, "fetch")
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					device_code: "device",
					user_code: "CODE",
					verification_uri: "https://auth.kimi.com/device",
					expires_in: 600,
					interval: 1,
				}),
				{ status: 200 },
			),
		)
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: "slow_down" }), { status: 400 }))
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ access_token: "new", refresh_token: "refresh", expires_in: 3600 }), {
				status: 200,
			}),
		)

		await manager.startAuthorization()
		const credentials = await manager.waitForAuthorization()
		expect(credentials.accessToken).toBe("new")
	})

	it("handles authorization expiration", async () => {
		const { context } = createContext()
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		const fetchSpy = vi.spyOn(globalThis, "fetch")
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					device_code: "device",
					user_code: "CODE",
					verification_uri: "https://auth.kimi.com/device",
					expires_in: 1,
					interval: 1,
				}),
				{ status: 200 },
			),
		)
		fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }))

		vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(2000)

		await manager.startAuthorization()
		await expect(manager.waitForAuthorization()).rejects.toThrow("Kimi Code authorization expired")
	})

	it("handles device authorization errors", async () => {
		const { context } = createContext()
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "invalid_request", error_description: "Bad request" }), {
				status: 400,
			}),
		)

		await expect(manager.startAuthorization()).rejects.toThrow("Bad request")
	})

	it("handles token refresh failure with invalid_grant", async () => {
		const { context, values } = createContext()
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "invalid", expiresAt: 0 }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
		)

		const token = await manager.getAccessToken()
		expect(token).toBeNull()
		expect(values.has("kimi-code-oauth-credentials")).toBe(false)
	})

	it("handles refresh errors that preserve state", async () => {
		const { context, values } = createContext()
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "server_error" }), { status: 500 }),
		)

		const token = await manager.getAccessToken()
		expect(token).toBeNull()
		expect(values.has("kimi-code-oauth-credentials")).toBe(true)
	})

	it("forces refresh even when token is not expired", async () => {
		const { context, values } = createContext()
		const futureExpiry = Date.now() + 3600_000
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: futureExpiry }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ access_token: "forced", refresh_token: "new_refresh", expires_in: 3600 }), {
				status: 200,
			}),
		)

		const token = await manager.forceRefreshAccessToken()
		expect(token).toBe("forced")
	})

	it("handles malformed OAuth error response", async () => {
		const { context } = createContext()
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("not json", { status: 400 }))

		await expect(manager.startAuthorization()).rejects.toThrow("OAuth request failed")
	})

	it("throws error when no refresh token in device token response", async () => {
		const { context } = createContext()
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		const fetchSpy = vi.spyOn(globalThis, "fetch")
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					device_code: "device",
					user_code: "CODE",
					verification_uri: "https://auth.kimi.com/device",
					expires_in: 600,
					interval: 1,
				}),
				{ status: 200 },
			),
		)
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 }),
		)

		await manager.startAuthorization()
		await expect(manager.waitForAuthorization()).rejects.toThrow("did not return a refresh token")
	})

	it("returns state correctly", async () => {
		const { context } = createContext()
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		expect(manager.getState().status).toBe("idle")
	})

	it("throws when waitForAuthorization called without active authorization", () => {
		const manager = new KimiCodeOAuthManager()
		expect(() => manager.waitForAuthorization()).toThrow("No Kimi Code authorization is in progress")
	})

	it("handles invalid stored credentials", async () => {
		const { context, values } = createContext()
		values.set("kimi-code-oauth-credentials", "invalid json")
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		expect(await manager.getAccessToken()).toBeNull()
		expect(values.has("kimi-code-oauth-credentials")).toBe(false)
	})

	it("preserves refresh token when not rotated", async () => {
		const { context, values } = createContext()
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "keep", expiresAt: 0 }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 }),
		)

		await manager.getAccessToken()
		const stored = JSON.parse(values.get("kimi-code-oauth-credentials")!)
		expect(stored.refreshToken).toBe("keep")
	})

	it("threads the caller abort signal into the token refresh request", async () => {
		const controller = new AbortController()
		controller.abort()
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			// The forwarded request signal must already be aborted when the caller cancelled.
			expect((init as RequestInit | undefined)?.signal?.aborted).toBe(true)
			throw new DOMException("This operation was aborted", "AbortError")
		})

		await expect(
			refreshKimiCodeAccessToken(
				{ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 },
				controller.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" })
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	it("reports a cancelled refresh instead of returning the not-authenticated null", async () => {
		const { context, values } = createContext()
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		const controller = new AbortController()
		controller.abort()
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("This operation was aborted", "AbortError"))

		await expect(manager.getAccessToken(false, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
		// The cancellation must not store anything or log the user out.
		expect(context.secrets.store).not.toHaveBeenCalled()
		expect(context.secrets.delete).not.toHaveBeenCalled()

		// forceRefreshAccessToken forwards the same caller signal.
		await expect(manager.forceRefreshAccessToken(controller.signal)).rejects.toMatchObject({ name: "AbortError" })
	})

	it("lets one caller cancel its wait without aborting a shared refresh another waiter needs", async () => {
		const { context, values } = createContext()
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		let resolveFetch: ((response: Response) => void) | undefined
		let fetchedSignal: AbortSignal | undefined
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(((_url, init) => {
			fetchedSignal = (init as RequestInit)?.signal as AbortSignal
			return new Promise<Response>((resolve) => {
				resolveFetch = resolve
			})
		}) as typeof fetch)

		const first = new AbortController()
		const second = new AbortController()
		const firstResult = manager.getAccessToken(false, first.signal).then(
			() => "resolved",
			(error: Error) => error.name,
		)
		const secondResult = manager.getAccessToken(false, second.signal)
		await vi.waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledTimes(1)
		})

		first.abort()

		await expect(firstResult).resolves.toBe("AbortError")
		// The shared POST is still alive for the second caller.
		expect(fetchedSignal?.aborted).toBe(false)

		resolveFetch?.(
			new Response(JSON.stringify({ access_token: "new", refresh_token: "rotated", expires_in: 3600 }), {
				status: 200,
			}),
		)
		await expect(secondResult).resolves.toBe("new")
	})

	it("aborts the shared refresh POST once every waiter cancelled", async () => {
		const { context, values } = createContext()
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		let fetchedSignal: AbortSignal | undefined
		vi.spyOn(globalThis, "fetch").mockImplementation(((_url, init) => {
			const signal = (init as RequestInit)?.signal as AbortSignal
			fetchedSignal = signal
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true })
			})
		}) as typeof fetch)

		const first = new AbortController()
		const second = new AbortController()
		const firstResult = manager.getAccessToken(false, first.signal).catch((error: Error) => error.name)
		const secondResult = manager.getAccessToken(false, second.signal).catch((error: Error) => error.name)
		await vi.waitFor(() => {
			expect(fetchedSignal).toBeDefined()
		})

		first.abort()
		expect(fetchedSignal?.aborted).toBe(false)
		second.abort()

		await expect(firstResult).resolves.toBe("AbortError")
		await expect(secondResult).resolves.toBe("AbortError")
		await vi.waitFor(() => {
			expect(fetchedSignal?.aborted).toBe(true)
		})
		// A fully cancelled refresh never stores or deletes credentials.
		expect(context.secrets.store).not.toHaveBeenCalled()
		expect(context.secrets.delete).not.toHaveBeenCalled()
	})

	it("joins a signal-less waiter when a signaled caller aborts", async () => {
		const { context, values } = createContext()
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		let fetchedSignal: AbortSignal | undefined
		let resolveFetch!: (response: Response) => void
		vi.spyOn(globalThis, "fetch").mockImplementation(((_url, init) => {
			fetchedSignal = (init as RequestInit)?.signal as AbortSignal
			return new Promise<Response>((resolve) => {
				resolveFetch = resolve
			})
		}) as typeof fetch)

		// The signal-less caller is the one that must keep the shared POST alive; the signaled
		// caller joins and then detaches without cancelling it.
		const signalLessResult = manager.getAccessToken(false)
		const controller = new AbortController()
		const signaledResult = manager.getAccessToken(false, controller.signal).catch((error: Error) => error.name)
		await vi.waitFor(() => expect(fetchedSignal).toBeDefined())

		controller.abort()

		await expect(signaledResult).resolves.toBe("AbortError")
		expect(fetchedSignal?.aborted).toBe(false)

		resolveFetch(
			new Response(JSON.stringify({ access_token: "new", refresh_token: "rotated", expires_in: 3600 }), {
				status: 200,
			}),
		)
		await expect(signalLessResult).resolves.toBe("new")
	})

	it("normalizes a caller abort that lands after the token POST started", async () => {
		let startedResolve!: () => void
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve
		})
		let fetchedSignal: AbortSignal | undefined
		vi.spyOn(globalThis, "fetch").mockImplementation(((_url, init) => {
			const signal = (init as RequestInit)?.signal as AbortSignal
			fetchedSignal = signal
			startedResolve()
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true })
			})
		}) as typeof fetch)

		const controller = new AbortController()
		const result = refreshKimiCodeAccessToken(
			{ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 },
			controller.signal,
		).catch((error: Error) => error)
		await started

		controller.abort(new Error("cancelled by the caller"))

		const error = await result
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).name).toBe("AbortError")
		expect(fetchedSignal?.aborted).toBe(true)
	})

	it("preserves an independent fetch failure that races an aborted caller signal", async () => {
		let rejectFetch!: (error: Error) => void
		let startedResolve!: () => void
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve
		})
		vi.spyOn(globalThis, "fetch").mockImplementation((() => {
			startedResolve()
			return new Promise<Response>((_resolve, reject) => {
				rejectFetch = reject
			})
		}) as typeof fetch)

		const controller = new AbortController()
		const result = refreshKimiCodeAccessToken(
			{ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 },
			controller.signal,
		).catch((error: Error) => error)
		await started

		controller.abort(new Error("cancelled by the caller"))
		const independent = new Error("network exploded")
		rejectFetch(independent)

		// The independent failure is not the caller's abort: it must be preserved unchanged.
		await expect(result).resolves.toBe(independent)
	})

	it("normalizes a caller abort with an ordinary-Error reason to AbortError", async () => {
		const { context, values } = createContext()
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		vi.spyOn(globalThis, "fetch").mockImplementation(((_url, init) => {
			const signal = (init as RequestInit)?.signal as AbortSignal
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true })
			})
		}) as typeof fetch)

		const controller = new AbortController()
		const result = manager.getAccessToken(false, controller.signal)
		controller.abort(new Error("cancelled by the caller"))
		await expect(result).rejects.toMatchObject({ name: "AbortError" })
	})

	it("a sign-in that completes inside a parked sign-out delete leaves no credentials behind", async () => {
		const { context, values } = createContext()
		const key = "kimi-code-oauth-credentials"
		values.set(
			key,
			JSON.stringify({
				type: "kimi-code",
				accessToken: "old",
				refreshToken: "refresh",
				expiresAt: 0,
				tokenType: "Bearer",
			}),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		const order: string[] = []
		let releaseDelete: () => void = () => {}
		const store = vi.mocked(context.secrets.store)
		const remove = vi.mocked(context.secrets.delete)
		store.mockImplementation(async (k: string, v: string) => {
			order.push("store")
			values.set(k, v)
		})
		remove.mockImplementation(
			(k: string) =>
				new Promise<void>((resolve) => {
					order.push("delete:start")
					releaseDelete = () => {
						order.push("delete:end")
						values.delete(k)
						resolve()
					}
				}),
		)
		const signingOut = manager.clearCredentials()
		await new Promise((resolve) => setImmediate(resolve))
		// The sign-out is held inside its own delete, which is the window the row asks about.
		expect(manager["clearingCredentials"], "sign-out holds its fence across the parked delete").toBe(true)
		expect(order).toEqual(["delete:start"])

		// A full sign-in - device authorization plus the token poll - completes inside the park.
		const fetchSpy = vi.spyOn(globalThis, "fetch")
		fetchSpy
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						device_code: "device",
						user_code: "ABCD-EFGH",
						verification_uri: "https://auth.kimi.com/device",
						expires_in: 600,
						// The schema requires a positive interval; one second is the shortest the endpoint accepts.
						interval: 1,
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						access_token: "fresh",
						refresh_token: "fresh-refresh",
						expires_in: 3_600_000,
						token_type: "Bearer",
					}),
					{ status: 200 },
				),
			)
		await manager.startAuthorization()
		const signedIn = await manager.waitForAuthorization()

		expect(signedIn.accessToken).toBe("fresh")
		// The exact credentials the sign-in stored, character for character.
		expect(store).toHaveBeenCalledWith(key, JSON.stringify(signedIn))
		expect(manager.getState()).toEqual({ status: "authenticated" })

		releaseDelete()
		await signingOut

		// The delete the sign-out was holding lands after the sign-in's write, so the sign-out
		// wins the key, the in-memory credentials and the state.
		expect(order).toEqual(["delete:start", "store", "delete:end"])
		expect(remove).toHaveBeenCalledTimes(1)
		expect(values.has(key)).toBe(false)
		expect(manager["credentials"]).toBeNull()
		expect(manager.getState()).toEqual({ status: "idle" })
		expect(manager["clearingCredentials"]).toBe(false)
	})

	it("a sign-out that lands while a sign-in is storing rejects that write instead of installing it", async () => {
		const { context, values } = createContext()
		const key = "kimi-code-oauth-credentials"
		values.set(
			key,
			JSON.stringify({
				type: "kimi-code",
				accessToken: "old",
				refreshToken: "refresh",
				expiresAt: 0,
				tokenType: "Bearer",
			}),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		let releaseStore: () => void = () => {}
		const store = vi.mocked(context.secrets.store)
		const remove = vi.mocked(context.secrets.delete)
		const deletes: string[] = []
		store.mockImplementation(
			(k: string, v: string) =>
				new Promise<void>((resolve) => {
					releaseStore = () => {
						values.set(k, v)
						resolve()
					}
				}),
		)
		remove.mockImplementation(async (k: string) => {
			deletes.push(k)
			values.delete(k)
		})
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						device_code: "device",
						user_code: "ABCD-EFGH",
						verification_uri: "https://auth.kimi.com/device",
						expires_in: 600,
						// The schema requires a positive interval; one second is the shortest the endpoint accepts.
						interval: 1,
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						access_token: "late",
						refresh_token: "late-refresh",
						expires_in: 3_600_000,
						token_type: "Bearer",
					}),
					{ status: 200 },
				),
			)
		// The token poll sleeps for the endpoint's interval, so the clock is taken over
		// before the poll starts and then advanced: the write is reached deterministically
		// instead of by wall-clock luck.
		vi.useFakeTimers()
		await manager.startAuthorization()
		const signingIn = manager.waitForAuthorization()
		await vi.advanceTimersByTimeAsync(1_000)
		await vi.advanceTimersByTimeAsync(1)
		expect(store.mock.calls.length, "the sign-in reached the credential write").toBe(1)

		// Sign-out lands while that write is parked, which makes the write stale before it commits.
		const signingOut = manager.clearCredentials()
		await vi.advanceTimersByTimeAsync(1)
		releaseStore()

		await expect(signingIn).rejects.toMatchObject({ message: "Kimi Code authorization was cancelled" })
		await signingOut

		// The parked write never becomes the stored state: it is removed and nothing is installed.
		expect(manager["credentials"]).toBeNull()
		expect(manager.getState()).toEqual({ status: "idle" })
		expect(values.has(key)).toBe(false)
		// Once for the sign-out and once for the stale write's own cleanup.
		expect(deletes.length).toBe(2)
		expect(manager["clearingCredentials"]).toBe(false)
	})
	it("a delayed invalid_grant from a stale refresh keeps credentials a newer sign-in saved", async () => {
		const { context, values } = createContext()
		const key = "kimi-code-oauth-credentials"
		values.set(
			key,
			JSON.stringify({
				type: "kimi-code",
				accessToken: "old",
				refreshToken: "old-rotating",
				expiresAt: 0,
				tokenType: "Bearer",
			}),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		// The refresh POST is parked: its invalid_grant verdict - and the credential
		// clearing that follows it - lands only after the newer sign-in below.
		let releaseRefresh: (response: Response) => void = () => {}
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
			() =>
				new Promise<Response>((resolve) => {
					releaseRefresh = resolve
				}),
		)
		const stale = manager.getAccessToken(false)
		// Let the refresh POST actually start first: it captures its generation at POST start,
		// and the interleaving under test is the stale verdict arriving after a newer install.
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))
		expect(manager["refreshPromise"] !== null, "refresh started before the sign-in").toBe(true)
		// A newer sign-in installs fresh credentials while the old POST is still in flight.
		await manager["saveCredentials"]({
			type: "kimi-code",
			accessToken: "new",
			refreshToken: "new-rotating",
			expiresAt: Date.now() + 3_600_000,
			tokenType: "Bearer",
		})
		releaseRefresh(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }))
		// The stale refresh's own caller still settles (null: its generation lost the save
		// race), but the verdict must not touch what the newer save installed.
		await expect(stale).resolves.toBeNull()
		expect(manager["credentials"]?.accessToken).toBe("new")
		expect(manager.getState().status).toBe("authenticated")
		expect(values.has(key)).toBe(true)
		// The fresh token is served without a new POST: the newer credentials survived.
		await expect(manager.getAccessToken(false)).resolves.toBe("new")
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	it("drains an in-flight refresh before sign-out deletes credentials and refuses a re-install", async () => {
		const { context, values } = createContext()
		const key = "kimi-code-oauth-credentials"
		values.set(
			key,
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		const writes: string[] = []
		const store = vi.mocked(context.secrets.store)
		const remove = vi.mocked(context.secrets.delete)
		store.mockImplementation(async (k: string, v: string) => {
			writes.push("store")
			values.set(k, v)
		})
		remove.mockImplementation(async (k: string) => {
			writes.push("delete")
			values.delete(k)
		})
		let resolveRefresh!: (response: Response) => void
		let posts = 0
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
			posts++
			if (posts === 1) {
				return new Promise<Response>((resolve) => {
					resolveRefresh = resolve
				})
			}
			return Promise.resolve(
				new Response(JSON.stringify({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 }), {
					status: 200,
				}),
			)
		})
		const tokenPromise = manager.getAccessToken(false)
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
		const clearPromise = manager.clearCredentials()
		// While the clear holds its fence a new caller has no token to be served and must not start
		// the network work the sign-out is draining.
		await expect(manager.getAccessToken(false)).resolves.toBeNull()
		// The 401-retry path is fenced the same way: it is offered no token and starts no POST while
		// the sign-out is still draining.
		await expect(manager.forceRefreshAccessToken()).resolves.toBeNull()
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		resolveRefresh(
			new Response(JSON.stringify({ access_token: "stale", refresh_token: "rotated", expires_in: 3600 }), {
				status: 200,
			}),
		)
		await clearPromise
		await expect(tokenPromise).resolves.toBeNull()
		// The delete is the last write: the refresh that resolved after sign-out began was drained
		// first, and its save was refused by the generation the clear moved past.
		expect(writes).toEqual(["delete"])
		expect(values.has(key)).toBe(false)
		// The fence is released with the clear: a later caller with expired credentials gets its own
		// POST and its save is installed.
		values.set(
			key,
			JSON.stringify({ type: "kimi-code", accessToken: "mid", refreshToken: "refresh", expiresAt: 0 }),
		)
		await expect(manager.getAccessToken(false)).resolves.toBe("fresh")
		expect(writes).toEqual(["delete", "store"])
		expect(fetchSpy).toHaveBeenCalledTimes(2)
	})

	it("cancels a token exchange whose response body stalls after the caller aborts", async () => {
		const controller = new AbortController()
		const bodyReads: string[] = []
		const stalledResponse = {
			ok: true,
			status: 200,
			json: () => {
				bodyReads.push("json")
				return new Promise<unknown>(() => {})
			},
		} as unknown as Response
		vi.spyOn(globalThis, "fetch").mockResolvedValue(stalledResponse)
		// The token refresher takes the credentials record by its declared shape, so the double is
		// annotated rather than asserted: an unannotated literal widens `type` to string.
		const credentials: KimiCodeCredentials = {
			type: "kimi-code",
			accessToken: "old",
			refreshToken: "refresh",
			expiresAt: 0,
		}
		const pending = refreshKimiCodeAccessToken(credentials, controller.signal)
		await vi.waitFor(() => expect(bodyReads).toEqual(["json"]))
		controller.abort()
		await expect(pending).rejects.toMatchObject({ name: "AbortError" })
		// An already-cancelled caller must not even start the body read.
		const aborted = new AbortController()
		aborted.abort()
		await expect(refreshKimiCodeAccessToken(credentials, aborted.signal)).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(bodyReads).toEqual(["json"])
	})

	it("cancels the underlying response when the caller aborts during the token body read", async () => {
		// The wrapper rejection alone is not cancellation: the fetch signal that carries the POST must
		// still be armed while the body is pending, or a replacement refresh can start on top of a
		// response this caller has already given up on.
		let fetchedSignal: AbortSignal | undefined
		const bodyReads: string[] = []
		const bodyPending = new Promise<unknown>(() => {})
		vi.spyOn(globalThis, "fetch").mockImplementation(((_url: unknown, init?: RequestInit) => {
			fetchedSignal = init?.signal as AbortSignal | undefined
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => {
					bodyReads.push("json")
					return bodyPending
				},
			} as unknown as Response)
		}) as typeof fetch)
		const controller = new AbortController()
		const credentials: KimiCodeCredentials = {
			type: "kimi-code",
			accessToken: "old",
			refreshToken: "refresh",
			expiresAt: 0,
		}
		const pending = refreshKimiCodeAccessToken(credentials, controller.signal)
		await vi.waitFor(() => expect(bodyReads).toEqual(["json"]))
		expect(fetchedSignal?.aborted, "the POST signal stays live while the body is pending").toBe(false)
		controller.abort()
		await expect(pending).rejects.toMatchObject({ name: "AbortError" })
		expect(fetchedSignal?.aborted, "the abort reached the underlying response").toBe(true)
	})

	it("cancels the underlying response when the caller aborts during a stalled OAuth error body", async () => {
		// The failure path reads a body too. An error body that stalls must be cancelled the same way,
		// or the rejected refresh still holds the response open after the caller is gone.
		let fetchedSignal: AbortSignal | undefined
		const bodyReads: string[] = []
		const bodyPending = new Promise<unknown>(() => {})
		vi.spyOn(globalThis, "fetch").mockImplementation(((_url: unknown, init?: RequestInit) => {
			fetchedSignal = init?.signal as AbortSignal | undefined
			return Promise.resolve({
				ok: false,
				status: 400,
				statusText: "Bad Request",
				text: () => {
					bodyReads.push("text")
					return bodyPending
				},
			} as unknown as Response)
		}) as typeof fetch)
		const controller = new AbortController()
		const credentials: KimiCodeCredentials = {
			type: "kimi-code",
			accessToken: "old",
			refreshToken: "refresh",
			expiresAt: 0,
		}
		const pending = refreshKimiCodeAccessToken(credentials, controller.signal)
		await vi.waitFor(() => expect(bodyReads).toEqual(["text"]))
		expect(fetchedSignal?.aborted, "the POST signal stays live while the error body is pending").toBe(false)
		controller.abort()
		await expect(pending).rejects.toMatchObject({
			name: "AbortError",
			message: "The Kimi Code OAuth request was aborted",
		})
		expect(fetchedSignal?.aborted, "the abort reached the underlying error-body response").toBe(true)
	})
	it("never aborts a replacement refresh on behalf of a waiter enrolled in the previous one", async () => {
		const { context, values } = createContext()
		values.set(
			"kimi-code-oauth-credentials",
			JSON.stringify({ type: "kimi-code", accessToken: "old", refreshToken: "refresh", expiresAt: 0 }),
		)
		const manager = new KimiCodeOAuthManager()
		manager.initialize(context)
		let resolveFirst!: (response: Response) => void
		let resolveSecond!: (response: Response) => void
		let firstSignal: AbortSignal | undefined
		let secondSignal: AbortSignal | undefined
		let posts = 0
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
			posts++
			const signal = (init as RequestInit)?.signal as AbortSignal
			if (posts === 1) {
				firstSignal = signal
				return new Promise<Response>((resolve) => {
					resolveFirst = resolve
				})
			}
			secondSignal = signal
			return new Promise<Response>((resolve) => {
				resolveSecond = resolve
			})
		})
		const leaving = new AbortController()
		const leavingWaiter = manager.getAccessToken(false, leaving.signal)
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
		const staying = new AbortController()
		const stayingWaiter = manager.getAccessToken(false, staying.signal)
		// Both callers must be enrolled in the shared POST before anybody leaves it, so the enrollment
		// is not racing the abort.
		await vi.waitFor(() => expect(manager["refreshWaiters"]?.size).toBe(2))
		// One waiter detaching while another still needs the shared POST must not cancel that POST.
		leaving.abort()
		await expect(leavingWaiter).rejects.toMatchObject({ name: "AbortError" })
		expect(firstSignal?.aborted).toBe(false)
		// The POST this waiter enrolled in then dies on its own lifecycle, and a replacement takes
		// its place before the remaining waiter detaches. That waiter must cancel the POST it joined,
		// which is already dead, and leave the replacement it never enrolled in alone.
		manager["refreshController"]?.abort()
		const replacement = manager.getAccessToken(false)
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
		staying.abort()
		await expect(stayingWaiter).rejects.toMatchObject({ name: "AbortError" })
		expect(firstSignal?.aborted).toBe(true)
		expect(secondSignal?.aborted).toBe(false)
		resolveSecond(
			new Response(JSON.stringify({ access_token: "new", refresh_token: "rotated", expires_in: 3600 }), {
				status: 200,
			}),
		)
		await expect(replacement).resolves.toBe("new")
		// The stalled POST the cancelled waiters were enrolled in resolves last, with a controller
		// that no longer owns the refresh state, so its save must not install over the replacement's.
		resolveFirst(
			new Response(JSON.stringify({ access_token: "late", refresh_token: "rotated", expires_in: 3600 }), {
				status: 200,
			}),
		)
		await vi.waitFor(() => expect(context.secrets.store).toHaveBeenCalledTimes(1))
		expect(context.secrets.store).toHaveBeenCalledWith(
			"kimi-code-oauth-credentials",
			expect.stringContaining("new"),
		)
		void values
	})
})
