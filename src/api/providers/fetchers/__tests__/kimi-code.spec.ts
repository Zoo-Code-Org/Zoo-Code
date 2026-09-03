import { getKimiCodeModels, kimiCodeModelSchema, mapKimiCodeModel } from "../kimi-code"

describe("Kimi Code model discovery", () => {
	beforeEach(() => vi.restoreAllMocks())
	afterEach(() => vi.useRealTimers())

	it("maps server-reported capacity and display fields without guessing an unknown reasoning protocol", () => {
		expect(
			mapKimiCodeModel({
				id: "kimi-test",
				context_length: 131072,
				supports_reasoning: true,
				supports_image_in: true,
				display_name: "Kimi Test",
			}),
		).toMatchObject({
			contextWindow: 131072,
			supportsReasoningEffort: false,
			requiredReasoningEffort: false,
			supportsImages: true,
			displayName: "Kimi Test",
		})
	})

	it.each(["k3", "k3-256k"])("applies the K3 reasoning-effort profile to %s", (modelId) => {
		const mapped = mapKimiCodeModel({ id: modelId, supports_reasoning: true })

		expect(mapped).toMatchObject({
			maxTokens: 131_072,
			supportsReasoningEffort: ["low", "high", "max"],
			requiredReasoningEffort: true,
			reasoningEffort: "high",
			supportsTemperature: false,
			preserveReasoning: true,
		})
	})

	it.each(["kimi-for-coding", "kimi-for-coding-highspeed"])(
		"applies the K2.7 preserved-thinking profile to %s",
		(modelId) => {
			const mapped = mapKimiCodeModel({ id: modelId, supports_reasoning: true })

			expect(mapped).toMatchObject({
				maxTokens: 131_072,
				supportsReasoningEffort: false,
				requiredReasoningEffort: false,
				supportsTemperature: false,
				preserveReasoning: true,
			})
			expect(mapped.reasoningEffort).toBeUndefined()
		},
	)

	it("uses bearer auth for GET /models", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ data: [{ id: "kimi-for-coding", context_length: 262144 }] }), {
				status: 200,
			}),
		)
		const models = await getKimiCodeModels("secret-token")
		expect(models).toHaveProperty("kimi-for-coding")
		expect(fetch).toHaveBeenCalledWith(
			"https://api.kimi.com/coding/v1/models",
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret-token" }) }),
		)
	})

	it("applies default values when optional fields are missing", () => {
		const mapped = mapKimiCodeModel({
			id: "basic-model",
		})
		expect(mapped.supportsReasoningEffort).toBe(false)
		expect(mapped.requiredReasoningEffort).toBe(false)
		expect(mapped.reasoningEffort).toBeUndefined()
		expect(mapped.supportsImages).toBe(false)
		expect(mapped.contextWindow).toBeGreaterThan(0)
	})

	it("throws error when apiKey is missing", async () => {
		await expect(getKimiCodeModels()).rejects.toThrow("Kimi Code authentication is required")
	})

	it("throws error with status code on failed request", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
		)
		try {
			await getKimiCodeModels("bad-token")
			expect.fail("should have thrown")
		} catch (error: any) {
			expect(error.message).toContain("401")
			expect(error.status).toBe(401)
		}
	})

	it("returns multiple models as a record", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [
						{ id: "model-a", context_length: 100000 },
						{ id: "model-b", context_length: 200000, supports_reasoning: true },
					],
				}),
				{ status: 200 },
			),
		)
		const models = await getKimiCodeModels("token")
		expect(Object.keys(models)).toHaveLength(2)
		expect(models["model-a"].contextWindow).toBe(100000)
		expect(models["model-b"].supportsReasoningEffort).toBe(false)
	})

	it("aborts model discovery after its deadline", async () => {
		vi.useFakeTimers()
		vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
			})
		})
		const result = expect(getKimiCodeModels("token")).rejects.toThrow("timed out")

		await vi.advanceTimersByTimeAsync(10_000)
		await result
		expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("overrides maxTokens from server max_tokens in mapKimiCodeModel", () => {
		const mapped = mapKimiCodeModel({
			id: "kimi-for-coding",
			max_tokens: 200_000,
		})
		expect(mapped.maxTokens).toBe(200_000)
	})

	it("overrides maxTokens from server max_tokens at fetcher level in getKimiCodeModels", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [{ id: "kimi-for-coding", context_length: 262144, max_tokens: 200_000 }],
				}),
				{ status: 200 },
			),
		)
		const models = await getKimiCodeModels("token")
		expect(models["kimi-for-coding"].maxTokens).toBe(200_000)
	})

	it("falls back to per-model defaults for known model ids", () => {
		const expected: Record<string, number> = {
			k3: 131_072,
			"k3-256k": 131_072,
			"kimi-for-coding": 131_072,
			"kimi-for-coding-highspeed": 131_072,
		}
		for (const [modelId, maxTokens] of Object.entries(expected)) {
			const mapped = mapKimiCodeModel({ id: modelId })
			expect(mapped.maxTokens).toBe(maxTokens)
		}
	})

	it("falls back to kimiCodeDefaultModelInfo.maxTokens for unknown model ids", () => {
		const mapped = mapKimiCodeModel({ id: "unknown-model" })
		expect(mapped.maxTokens).toBe(131_072)
	})

	it("rejects fractional max_tokens from server response", () => {
		const mapped = mapKimiCodeModel({
			id: "kimi-for-coding",
			max_tokens: 131072.5,
		})
		// Zod .int() would reject at schema level, but mapKimiCodeModel receives
		// already-parsed data. Verify the schema rejects fractional values.
		const result = kimiCodeModelSchema.safeParse({
			id: "kimi-for-coding",
			max_tokens: 131072.5,
		})
		expect(result.success).toBe(false)
	})
})
