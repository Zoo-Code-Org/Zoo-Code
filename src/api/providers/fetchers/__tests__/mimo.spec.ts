import { mimoModels, providerSettingsSchema } from "@roo-code/types"

import { getMimoModels, ALLOWED_BASE_URLS } from "../mimo"

describe("getMimoModels", () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	it("merges API response with static model specs for known models", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [{ id: "mimo-v2.6-pro" }, { id: "mimo-v2.6-flash" }],
			}),
		}) as unknown as typeof fetch

		const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://token-plan-sgp.xiaomimimo.com/v1/models",
			expect.any(Object),
		)
		expect(models["mimo-v2.6-pro"]).toEqual(mimoModels["mimo-v2.6-pro"])
		expect(models["mimo-v2.6-flash"]).toEqual(mimoModels["mimo-v2.6-flash"])
	})

	it("provides MiMo-family defaults for unknown model IDs without pricing", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [{ id: "mimo-v3-future" }],
			}),
		}) as unknown as typeof fetch

		const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

		expect(models["mimo-v3-future"]).toEqual({
			maxTokens: 16_000,
			contextWindow: 262_144,
			supportsImages: false,
			supportsPromptCache: false,
			preserveReasoning: true,
			description: "MiMo model: mimo-v3-future",
		})
	})

	it("throws for HTTP errors", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
			text: vi.fn().mockResolvedValue('{"error":{"message":"Invalid API key"}}'),
		}) as unknown as typeof fetch

		await expect(getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "invalid-key")).rejects.toThrow(
			"HTTP 401: Unauthorized",
		)
	})

	it("uses default Singapore base URL when none provided", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		}) as unknown as typeof fetch

		await getMimoModels(undefined, "mock-key")

		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://token-plan-sgp.xiaomimimo.com/v1/models",
			expect.any(Object),
		)
	})

	it("keeps /v1 in base URL and strips trailing slash", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		}) as unknown as typeof fetch

		await getMimoModels("https://token-plan-cn.xiaomimimo.com/v1/", "mock-key")

		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://token-plan-cn.xiaomimimo.com/v1/models",
			expect.any(Object),
		)
	})

	it("throws when response data is not an array", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: "not-an-array" }),
		}) as unknown as typeof fetch

		await expect(getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")).rejects.toThrow(
			"Unexpected response format",
		)
	})

	it("skips models with empty or non-string ID", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [{ id: "" }, { id: 123 }, { id: null }, { id: "mimo-v2.6-pro" }],
			}),
		}) as unknown as typeof fetch

		const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

		expect(Object.keys(models)).toHaveLength(1)
		expect(models["mimo-v2.6-pro"]).toBeDefined()
	})

	it("includes Authorization header when apiKey provided", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		}) as unknown as typeof fetch

		await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "my-secret-key")

		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://token-plan-sgp.xiaomimimo.com/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer my-secret-key",
				}),
			}),
		)
	})

	it("omits the Authorization header when no apiKey is provided", async () => {
		const fetchSpy = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		})
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1")

		const fetchInit = fetchSpy.mock.calls[0]?.[1] as RequestInit
		expect(fetchInit.headers).not.toHaveProperty("Authorization")
	})

	it("mixes known and unknown models in same response", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [{ id: "mimo-v2.6-pro" }, { id: "some-new-model" }],
			}),
		}) as unknown as typeof fetch

		const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

		expect(models["mimo-v2.6-pro"]).toEqual(mimoModels["mimo-v2.6-pro"])
		expect(models["some-new-model"]).toEqual({
			maxTokens: 16_000,
			contextWindow: 262_144,
			supportsImages: false,
			supportsPromptCache: false,
			preserveReasoning: true,
			description: "MiMo model: some-new-model",
		})
	})

	it("throws when the base URL is not https and never sends the request", async () => {
		const fetchSpy = vi.fn()
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		// An http:// endpoint fails the exact-match allowlist, which subsumes the
		// previous scheme-only guard.
		await expect(getMimoModels("http://token-plan-sgp.xiaomimimo.com/v1", "my-secret-key")).rejects.toThrow(
			"not an allowed Xiaomi MiMo endpoint",
		)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("rejects an arbitrary https URL outside the allowlist and never sends the bearer key", async () => {
		const fetchSpy = vi.fn()
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		await expect(getMimoModels("https://attacker.example/v1", "my-secret-key")).rejects.toThrow(
			"not an allowed Xiaomi MiMo endpoint",
		)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("rejects an allowed host reached through userinfo authority-confusion before any request", async () => {
		const fetchSpy = vi.fn()
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		// classic authority trick: credentials make everything before the last @
		// the userinfo, so the real host is attacker.example.
		await expect(getMimoModels("https://token-plan-sgp.xiaomimimo.com@attacker.example/v1", "key")).rejects.toThrow(
			"must not contain credentials",
		)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("rejects embedded credentials on an allowed endpoint and never echoes the secret", async () => {
		const fetchSpy = vi.fn()
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		const error = await getMimoModels(
			"https://user:hunter2@token-plan-sgp.xiaomimimo.com/v1",
			"my-secret-key",
		).catch((thrown: unknown) => (thrown instanceof Error ? thrown : new Error(String(thrown))))

		expect(error.message).toContain("must not contain credentials")
		expect(error.message).not.toContain("hunter2")
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("rejects embedded credentials on an arbitrary host and never echoes the secret", async () => {
		const fetchSpy = vi.fn()
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		const error = await getMimoModels("https://user:hunter2@attacker.example/v1", "my-secret-key").catch(
			(thrown: unknown) => (thrown instanceof Error ? thrown : new Error(String(thrown))),
		)

		expect(error.message).toContain("must not contain credentials")
		expect(error.message).not.toContain("hunter2")
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	// Regression guard for the security gate: every legitimate endpoint must keep
	// working exactly as before the allowlist was introduced.
	it.each([...ALLOWED_BASE_URLS])("fetches /models normally for allowed endpoint %s", async (allowedUrl) => {
		const fetchSpy = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		})
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		await expect(getMimoModels(allowedUrl, "mock-key")).resolves.toEqual({})

		expect(fetchSpy).toHaveBeenCalledWith(`${allowedUrl}/models`, expect.any(Object))
	})

	it("accepts every independently defined persisted Xiaomi endpoint", async () => {
		// Independent literal list (NOT iterated from ALLOWED_BASE_URLS) so the
		// test fails if a legitimate endpoint is ever removed from the allowlist.
		const expectedAllowedUrls = [
			"https://api.xiaomimimo.com/v1",
			"https://token-plan-cn.xiaomimimo.com/v1",
			"https://token-plan-sgp.xiaomimimo.com/v1",
			"https://token-plan-ams.xiaomimimo.com/v1",
		]

		expect([...ALLOWED_BASE_URLS].sort()).toEqual([...expectedAllowedUrls].sort())

		const fetchSpy = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		})
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		for (const baseUrl of expectedAllowedUrls) {
			await expect(getMimoModels(baseUrl, "mock-key")).resolves.toEqual({})
		}

		expect(fetchSpy).toHaveBeenCalledTimes(expectedAllowedUrls.length)
		for (const baseUrl of expectedAllowedUrls) {
			expect(fetchSpy).toHaveBeenCalledWith(`${baseUrl}/models`, expect.any(Object))
		}
	})

	it("keeps the fetcher allowlist in sync with the persisted settings schema", () => {
		// The fetcher mirrors the zod literal union from
		// packages/types/src/provider-settings/mimo.ts because the definition is
		// not re-exported publicly. If the schema ever rejects one of the fetcher's
		// URLs, the two sources have drifted and this test must fail.
		const mimoBaseUrlField = providerSettingsSchema.shape.mimoBaseUrl

		for (const allowedUrl of ALLOWED_BASE_URLS) {
			expect(mimoBaseUrlField.safeParse(allowedUrl).success).toBe(true)
		}
		expect(mimoBaseUrlField.safeParse("https://attacker.example/v1").success).toBe(false)
	})

	it("skips null and non-object entries in the model list", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [null, "mimo-v2.6-pro", 42, { id: "mimo-v2.6-pro" }],
			}),
		}) as unknown as typeof fetch

		const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

		expect(Object.keys(models)).toEqual(["mimo-v2.6-pro"])
	})

	it("excludes ASR and TTS model families from the catalog", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [
					{ id: "mimo-v2.6-pro" },
					{ id: "mimo-v2.5-asr" },
					{ id: "mimo-v2.5-tts" },
					{ id: "mimo-v2.5-tts-voiceclone" },
					{ id: "mimo-v2.5-tts-voicedesign" },
				],
			}),
		}) as unknown as typeof fetch

		const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

		expect(Object.keys(models)).toEqual(["mimo-v2.6-pro"])
	})

	it("strips multiple trailing slashes from the base URL", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		}) as unknown as typeof fetch

		await getMimoModels("https://token-plan-cn.xiaomimimo.com/v1///", "mock-key")

		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://token-plan-cn.xiaomimimo.com/v1/models",
			expect.any(Object),
		)
	})

	it("passes the caller's abort signal to the request", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))
		const controller = new AbortController()

		await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key", { signal: controller.signal })

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://token-plan-sgp.xiaomimimo.com/v1/models",
			expect.objectContaining({ signal: controller.signal }),
		)
	})
})
