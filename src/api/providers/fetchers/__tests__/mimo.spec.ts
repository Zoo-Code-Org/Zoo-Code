import { z } from "zod"

import { mimoModels, providerSettingsSchema } from "@roo-code/types"

import { getMimoModels, ALLOWED_BASE_URLS, MAX_MIMO_MODEL_ENTRIES, MAX_MIMO_MODEL_ID_LENGTH } from "../mimo"

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
				data: [{ id: "mimo-v2.6-pro" }, { id: "mimo-v2.6-flash" }, { id: "mimo-v3-future" }],
			}),
		}) as unknown as typeof fetch

		const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://token-plan-sgp.xiaomimimo.com/v1/models",
			expect.any(Object),
		)
		expect(models["mimo-v2.6-pro"]).toEqual(mimoModels["mimo-v2.6-pro"])
		expect(models["mimo-v2.6-flash"]).toEqual(mimoModels["mimo-v2.6-flash"])

		// mimo-v3-future exists only in the API response, so it must surface with
		// MiMo-family defaults: a mutation that returned the static map directly
		// (ignoring the response) would leave it undefined.
		expect(models["mimo-v3-future"]).toEqual({
			maxTokens: 16_000,
			contextWindow: 262_144,
			supportsImages: false,
			supportsPromptCache: false,
			preserveReasoning: true,
			description: "MiMo model: mimo-v3-future",
		})

		// mimo-v2.5-pro is still served today, but this mock response omits it
		// (post-EOL world): a model absent from the API response must stay absent
		// from the result, guarding against a wholesale-static-map regression.
		expect(models["mimo-v2.5-pro"]).toBeUndefined()
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

	// Regression: IDs come straight from the provider's /models response, so an ID
	// that names an Object.prototype member resolved the inherited member instead of
	// a curated spec and emitted `{}` -- a model with no metadata at all. The family
	// defaults are what an unknown ID must get.
	it.each(["constructor", "toString", "valueOf", "__proto__"])(
		"gives the prototype-key ID %s MiMo-family defaults instead of inherited metadata",
		async (prototypeKey) => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ data: [{ id: prototypeKey }] }),
			}) as unknown as typeof fetch

			const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

			expect(models[prototypeKey]).toEqual({
				maxTokens: 16_000,
				contextWindow: 262_144,
				supportsImages: false,
				supportsPromptCache: false,
				preserveReasoning: true,
				description: `MiMo model: ${prototypeKey}`,
			})
		},
	)

	it("keeps the static spec authoritative for known IDs while still surfacing API-only models", async () => {
		// Negative precedence: the /models payload may carry fields that conflict
		// with the curated static spec (stale prices, wrong windows, injected
		// text). For a known ID every emitted field must come from mimoModels,
		// never from the wire payload; an API-only ID must still appear.
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [
					{
						id: "mimo-v2.6-pro",
						description: "CONFLICTING payload description",
						contextWindow: 999,
						maxTokens: 999,
						inputPrice: 999,
						outputPrice: 999,
						supportsImages: false,
					},
					{ id: "mimo-v9-only-in-api", description: "CONFLICTING payload description", contextWindow: 12345 },
				],
			}),
		}) as unknown as typeof fetch

		const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

		expect(models["mimo-v2.6-pro"]).toEqual(mimoModels["mimo-v2.6-pro"])
		expect(models["mimo-v2.6-pro"].description).not.toContain("CONFLICTING")

		expect(models["mimo-v9-only-in-api"]).toEqual({
			maxTokens: 16_000,
			contextWindow: 262_144,
			supportsImages: false,
			supportsPromptCache: false,
			preserveReasoning: true,
			description: "MiMo model: mimo-v9-only-in-api",
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

	it("rejects a percent-encoded %40 userinfo form through the allowlist guard", async () => {
		const fetchSpy = vi.fn()
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		// containsUserinfo only scans for a literal "@", so the encoded form
		// reaches the allowlist guard, which rejects it as a non-exact match.
		await expect(
			getMimoModels("https://token-plan-sgp.xiaomimimo.com%40attacker.example/v1", "key"),
		).rejects.toThrow("not an allowed Xiaomi MiMo endpoint")
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it.each([
		["query string", "https://token-plan-sgp.xiaomimimo.com/v1?api_key=QUERYSECRET"],
		["fragment", "https://token-plan-sgp.xiaomimimo.com/v1#api_key=FRAGMENTSECRET"],
	])("never echoes a secret carried in a URL %s", async (_label, maliciousUrl) => {
		const fetchSpy = vi.fn()
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		const secret = maliciousUrl.split("=")[1]
		let thrown: unknown
		try {
			await getMimoModels(maliciousUrl, "key")
		} catch (error) {
			thrown = error
		}

		expect(thrown).toBeInstanceOf(Error)
		expect((thrown as Error).message).toContain("not an allowed Xiaomi MiMo endpoint")
		expect((thrown as Error).message).not.toContain(secret)
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

	it("pins the fetch to reject redirects so a 3xx cannot re-scope the bearer key", async () => {
		// The mocked fetch layer cannot exercise undici's real redirect handling,
		// so this pins the request init: redirect must be "error", which per the
		// fetch spec aborts the request on any 3xx instead of following it to an
		// origin the allowlist never vetted.
		const fetchSpy = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		})
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "my-secret-key")

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://token-plan-sgp.xiaomimimo.com/v1/models",
			expect.objectContaining({ redirect: "error" }),
		)
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
		// not re-exported publicly. Enumerating the union's literals and asserting
		// set equality in BOTH directions is what makes drift fail here: a
		// one-directional "every allowlisted URL parses" check still passes when a
		// fifth literal is added to the schema without an allowlist entry, and the
		// fetcher would then reject a URL the settings form accepts.
		const mimoBaseUrlField = providerSettingsSchema.shape.mimoBaseUrl

		// The field is `.optional()`, so unwrap before reaching the union. Read the
		// members off the runtime shape rather than the declared type: the declared
		// type is already the literal union, so a narrowing check on it collapses to
		// `never` and cannot guard a future change to a non-union schema.
		const union = mimoBaseUrlField.unwrap() as unknown
		if (!(union instanceof z.ZodUnion)) {
			throw new Error("Expected mimoBaseUrl to be a zod union")
		}

		const schemaUrls = union.options.map((option) => {
			if (!(option instanceof z.ZodLiteral)) {
				throw new Error("Expected every mimoBaseUrl union member to be a zod literal")
			}
			return option.value as string
		})

		expect([...schemaUrls].sort()).toEqual([...ALLOWED_BASE_URLS].sort())
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

	describe("response size caps", () => {
		// The model list is remote input: without a ceiling a hostile or broken
		// endpoint inflates the cached catalog and every picker that renders it.
		const respondWith = (data: unknown[]) => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ data }),
			}) as unknown as typeof fetch
		}

		it("caps the catalog at the entry limit", async () => {
			respondWith(
				Array.from({ length: MAX_MIMO_MODEL_ENTRIES + 50 }, (_, index) => ({ id: `mimo-model-${index}` })),
			)

			const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

			expect(Object.keys(models)).toHaveLength(MAX_MIMO_MODEL_ENTRIES)
			// The cap keeps the first entries in response order, so a truncated
			// catalog is still a prefix of what the endpoint served.
			expect(models["mimo-model-0"]).toBeDefined()
			expect(models[`mimo-model-${MAX_MIMO_MODEL_ENTRIES - 1}`]).toBeDefined()
			expect(models[`mimo-model-${MAX_MIMO_MODEL_ENTRIES}`]).toBeUndefined()
		})

		it("keeps every entry when the list is exactly at the cap", async () => {
			respondWith(Array.from({ length: MAX_MIMO_MODEL_ENTRIES }, (_, index) => ({ id: `mimo-model-${index}` })))

			const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

			expect(Object.keys(models)).toHaveLength(MAX_MIMO_MODEL_ENTRIES)
		})

		it("drops an over-long model ID instead of truncating it", async () => {
			const longId = "m" + "x".repeat(MAX_MIMO_MODEL_ID_LENGTH)
			respondWith([{ id: longId }, { id: "mimo-v2.6-pro" }])

			const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

			expect(Object.keys(models)).toEqual(["mimo-v2.6-pro"])
			// Truncating would invent an ID the provider does not serve, so no
			// shortened variant may appear either.
			expect(models[longId.slice(0, MAX_MIMO_MODEL_ID_LENGTH)]).toBeUndefined()
		})

		it("keeps an ID exactly at the length limit", async () => {
			const maxLengthId = "m" + "x".repeat(MAX_MIMO_MODEL_ID_LENGTH - 1)
			expect(maxLengthId).toHaveLength(MAX_MIMO_MODEL_ID_LENGTH)
			respondWith([{ id: maxLengthId }])

			const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

			expect(Object.keys(models)).toEqual([maxLengthId])
		})
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
