import { getKimiCodeModels, mapKimiCodeModel } from "../kimi-code"

describe("Kimi Code model discovery", () => {
	beforeEach(() => vi.restoreAllMocks())
	afterEach(() => vi.useRealTimers())

	it("maps official model fields", () => {
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
			supportsReasoningEffort: ["low", "high", "max"],
			requiredReasoningEffort: true,
			reasoningEffort: "max",
			supportsImages: true,
			displayName: "Kimi Test",
		})
	})

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
		expect(models["model-b"].supportsReasoningEffort).toEqual(["low", "high", "max"])
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
})
