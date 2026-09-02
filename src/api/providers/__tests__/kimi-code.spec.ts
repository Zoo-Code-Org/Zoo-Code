import { buildApiHandler } from "../../index"
import { KimiCodeHandler } from "../kimi-code"

import { clearAllMocks } from "../../../test-utils/reset"
import { captureError } from "../../../test-utils/errors"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

const { mockGetAccessToken, mockForceRefreshAccessToken, mockGetModels } = vi.hoisted(() => ({
	mockGetAccessToken: vi.fn(),
	mockForceRefreshAccessToken: vi.fn(),
	mockGetModels: vi.fn(),
}))

vi.mock("../../../integrations/kimi-code/oauth", () => ({
	kimiCodeOAuthManager: {
		getAccessToken: mockGetAccessToken,
		forceRefreshAccessToken: mockForceRefreshAccessToken,
	},
}))

vi.mock("../fetchers/modelCache", () => ({
	getModels: mockGetModels,
	refreshModels: mockGetModels,
}))

/**
 * Spies on the inherited OpenAI client's chat.completions.create. `client` is
 * protected on the OpenAiHandler base (not on the public interface), so it is
 * reached through a documented `as unknown as` double assertion (AGENTS.md
 * last resort; no `as any`).
 */
function completionsCreate(handler: KimiCodeHandler): ReturnType<typeof vi.fn> {
	const client = (
		handler as unknown as {
			client: { chat: { completions: Record<string, (...args: never[]) => never> } }
		}
	).client
	return vi.spyOn(client.chat.completions, "create") as unknown as ReturnType<typeof vi.fn>
}

describe("KimiCodeHandler", () => {
	beforeEach(() => {
		clearAllMocks()
		mockGetAccessToken.mockResolvedValue("oauth-token")
		mockForceRefreshAccessToken.mockResolvedValue("refreshed-token")
		mockGetModels.mockRejectedValue(new Error("offline"))
	})

	it("is dispatched separately from Moonshot and preserves an unknown selected model", () => {
		const handler = buildApiHandler({
			apiProvider: providerIdentifiers.kimiCode,
			kimiCodeAuthMethod: "api-key",
			kimiCodeApiKey: "kimi-key",
			apiModelId: "future-kimi-model",
		})
		expect(handler).toBeInstanceOf(KimiCodeHandler)
		expect(handler.getModel().id).toBe("future-kimi-model")
	})

	it("uses kimi-for-coding only when no model is selected", () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "kimi-key" })
		expect(handler.getModel().id).toBe("kimi-for-coding")
	})

	it("uses API key when auth method is api-key", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "my-api-key" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ choices: [{ message: { content: "response" }, finish_reason: "stop" }] }), {
				status: 200,
			}),
		)
		try {
			for await (const chunk of gen) {
				// consume
			}
		} catch {
			// expected - mock is incomplete
		}
		expect(mockGetAccessToken).not.toHaveBeenCalled()
	})

	it("uses OAuth token when auth method is oauth or not specified", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "oauth" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		try {
			for await (const chunk of gen) {
				// consume
			}
		} catch {
			// expected - mock will fail
		}
		expect(mockGetAccessToken).toHaveBeenCalled()
	})

	it("throws error when OAuth is required but no token available", async () => {
		mockGetAccessToken.mockResolvedValueOnce(null)
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "oauth" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		await expect(async () => {
			for await (const chunk of gen) {
				// consume
			}
		}).rejects.toThrow("Not authenticated with Kimi Code")
	})

	it("throws error when API key auth is missing the key", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		await expect(async () => {
			for await (const chunk of gen) {
				// consume
			}
		}).rejects.toThrow("Kimi Code API key is required")
	})

	it("retries with forced refresh on 401 when using OAuth", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "oauth" })
		const fetchSpy = vi.spyOn(globalThis, "fetch")
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }))
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
				status: 200,
			}),
		)
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		try {
			for await (const chunk of gen) {
				// consume
			}
		} catch {
			// expected - mock is incomplete
		}
		expect(mockForceRefreshAccessToken).toHaveBeenCalledOnce()
	})

	it("force-refreshes and retries exactly once after a non-streaming OAuth 401", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "oauth" })
		const unauthorized = Object.assign(new Error("Unauthorized"), { status: 401 })
		const createCompletion = completionsCreate(handler)
			.mockRejectedValueOnce(unauthorized)
			.mockResolvedValueOnce({ choices: [{ message: { content: "retried" } }] })

		await expect(handler.completePrompt("test")).resolves.toBe("retried")
		expect(mockForceRefreshAccessToken).toHaveBeenCalledOnce()
		expect(createCompletion).toHaveBeenCalledTimes(2)
	})

	it("does not retry on 401 when using API key auth", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 401 }))
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		await expect(async () => {
			for await (const chunk of gen) {
				// consume
			}
		}).rejects.toThrow()
		expect(mockForceRefreshAccessToken).not.toHaveBeenCalled()
	})

	it("does not force-refresh on non-401 OAuth failures", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "oauth" })
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 500 }))
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		await expect(async () => {
			for await (const chunk of gen) {
				// consume
			}
		}).rejects.toThrow()
		expect(mockForceRefreshAccessToken).not.toHaveBeenCalled()
	})

	it("fetches models during prepareRequest", async () => {
		mockGetModels.mockResolvedValueOnce({ "test-model": { maxTokens: 1000 } })
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		try {
			for await (const chunk of gen) {
				// consume
			}
		} catch {
			// expected
		}
		expect(mockGetModels).toHaveBeenCalled()
	})

	it("continues when model discovery fails", async () => {
		mockGetModels.mockRejectedValueOnce(new Error("discovery failed"))
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		try {
			for await (const chunk of gen) {
				// consume
			}
		} catch {
			// expected - different error
		}
		expect(mockGetModels).toHaveBeenCalled()
	})

	it.each([
		["failure", () => Promise.reject(new Error("offline"))],
		["empty response", () => Promise.resolve({})],
	])("does not repeatedly block requests after model discovery %s", async (_case, discovery) => {
		mockGetModels.mockImplementationOnce(discovery)
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }),
		)
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })

		await handler.completePrompt("first")
		await handler.completePrompt("second")

		expect(mockGetModels).toHaveBeenCalledOnce()
	})

	it("uses discovered model info when available", async () => {
		mockGetModels.mockResolvedValueOnce({ "kimi-for-coding": { maxTokens: 8000, contextWindow: 128000 } })
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		try {
			for await (const chunk of gen) {
				// consume
			}
		} catch {
			// expected
		}
		const model = handler.getModel()
		expect(model.info.maxTokens).toBe(8000)
	})

	it("defaults to max reasoning effort and advertises low/high/max support", () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const model = handler.getModel()
		expect(model.info.supportsReasoningEffort).toEqual(["low", "high", "max"])
		expect(model.info.requiredReasoningEffort).toBe(true)
		expect(model.reasoning).toEqual({ reasoning_effort: "max" })
	})

	it("sends the user-selected reasoning effort", () => {
		const handler = new KimiCodeHandler({
			kimiCodeAuthMethod: "api-key",
			kimiCodeApiKey: "key",
			reasoningEffort: "low",
		})
		expect(handler.getModel().reasoning).toEqual({ reasoning_effort: "low" })
	})

	it("falls back to the model default when a persisted effort from another provider is unsupported", () => {
		const handler = new KimiCodeHandler({
			kimiCodeAuthMethod: "api-key",
			kimiCodeApiKey: "key",
			reasoningEffort: "medium",
		})
		expect(handler.getModel().reasoning).toEqual({ reasoning_effort: "max" })
	})

	it("forwards the metadata abort signal to the inherited OpenAI SDK request", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const controller = new AbortController()
		const streamChunks = (async function* () {
			yield { choices: [{ delta: { content: "hi" } }] }
		})()
		const createCompletion = completionsCreate(handler).mockResolvedValueOnce(streamChunks)

		const gen = handler.createMessage("system", [{ role: "user", content: "test" }], {
			taskId: "test-task",
			abortSignal: controller.signal,
		})
		const first = await gen.next()

		expect(first.value).toEqual({ type: "text", text: "hi" })
		expect(createCompletion).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal })
	})

	it("rejects before any request when the createMessage abort signal is already aborted", async () => {
		// OAuth auth so the token assertions below are not vacuous: without the
		// cancellation guard, resolveAccessToken would invoke the OAuth mocks.
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "oauth" })
		const controller = new AbortController()
		controller.abort()
		const createCompletion = completionsCreate(handler)

		const gen = handler.createMessage("system", [{ role: "user", content: "test" }], {
			taskId: "test-task",
			abortSignal: controller.signal,
		})

		await expect(async () => {
			for await (const _ of gen) {
				// consume
			}
		}).rejects.toMatchObject({ name: "AbortError", message: "This operation was aborted" })
		expect(createCompletion).not.toHaveBeenCalled()
		// Cancellation must also skip model discovery and OAuth token work.
		expect(mockGetModels).not.toHaveBeenCalled()
		expect(mockGetAccessToken).not.toHaveBeenCalled()
		expect(mockForceRefreshAccessToken).not.toHaveBeenCalled()
	})

	it("forwards completePrompt abort options through the override on both 401 retry attempts", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "oauth" })
		const unauthorized = Object.assign(new Error("Unauthorized"), { status: 401 })
		const createCompletion = completionsCreate(handler)
			.mockRejectedValueOnce(unauthorized)
			.mockResolvedValueOnce({ choices: [{ message: { content: "retried" } }] })
		const controller = new AbortController()

		await expect(handler.completePrompt("test", { abortSignal: controller.signal })).resolves.toBe("retried")
		expect(mockForceRefreshAccessToken).toHaveBeenCalledOnce()
		expect(createCompletion).toHaveBeenCalledTimes(2)
		for (const call of createCompletion.mock.calls) {
			expect(call[1]).toEqual({ signal: controller.signal })
		}
	})

	it("rejects before any request when the completePrompt signal is already aborted", async () => {
		// OAuth auth so the token assertions below are not vacuous: without the
		// cancellation guard, resolveAccessToken would invoke the OAuth mocks.
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "oauth" })
		const controller = new AbortController()
		controller.abort()
		const createCompletion = completionsCreate(handler)

		await expect(handler.completePrompt("test", { abortSignal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
			message: "This operation was aborted",
		})
		expect(createCompletion).not.toHaveBeenCalled()
		// Cancellation must also skip model discovery and OAuth token work.
		expect(mockGetModels).not.toHaveBeenCalled()
		expect(mockGetAccessToken).not.toHaveBeenCalled()
		expect(mockForceRefreshAccessToken).not.toHaveBeenCalled()
	})

	it("surfaces a normalized AbortError when the SDK aborts a streaming request", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		// The real SDK class: this spec does not mock the openai module.
		const { APIUserAbortError } = await import("openai")
		completionsCreate(handler).mockRejectedValueOnce(new APIUserAbortError())

		const gen = handler.createMessage("system", [{ role: "user", content: "test" }], { taskId: "test-task" })
		const result = await captureError(
			(async () => {
				for await (const _ of gen) {
					// consume
				}
			})(),
		)

		expect(result.name).toBe("AbortError")
		expect(result.message).toBe("OpenAI request aborted")
	})
})
