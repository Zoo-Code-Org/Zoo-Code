import { KIMI_CODE_OAUTH_CONFIG, KimiCodeOAuthManager, refreshKimiCodeAccessToken } from "../oauth"

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
})
