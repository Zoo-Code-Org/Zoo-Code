// npx vitest run src/api/providers/__tests__/anthropic-adaptive-effort.spec.ts
//
// DTE series 2/5 — per-request adaptive thinking effort envelope
// (output_config.effort) on the main Anthropic handler.
//
// Kept in a dedicated file (rather than anthropic.spec.ts) so the DTE series PRs
// stay mergeable while other series PRs extend the shared spec file.

import { AnthropicHandler } from "../anthropic"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { ReasoningEffortExtended } from "@roo-code/types"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
import type { ApiHandlerCreateMessageMetadata } from "../../../api"

// Mock TelemetryService
vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: vitest.fn(),
		},
	},
}))

const mockCreate = vitest.fn()

// Same SDK mock pattern as anthropic.spec.ts: createMessage resolves to a short
// finite stream so the handler's for-await loop terminates cleanly.
vitest.mock("@anthropic-ai/sdk", () => {
	const mockAnthropicConstructor = vitest.fn().mockImplementation(function () {
		return {
			messages: {
				create: mockCreate.mockImplementation(async (options: { stream?: boolean; model?: string }) => {
					if (!options.stream) {
						return {
							id: "test-completion",
							content: [{ type: "text", text: "Test response" }],
							role: "assistant",
							model: options.model,
							usage: { input_tokens: 10, output_tokens: 5 },
						}
					}
					return asyncStreamFrom([
						{
							type: "message_start",
							message: {
								usage: {
									input_tokens: 100,
									output_tokens: 50,
									cache_creation_input_tokens: 20,
									cache_read_input_tokens: 10,
								},
							},
						},
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "Hello" },
						},
						{
							type: "content_block_delta",
							delta: { type: "text_delta", text: " world" },
						},
					])
				}),
			},
		}
	})

	return {
		Anthropic: mockAnthropicConstructor,
	}
})

const userMessage = {
	role: "user" as const,
	content: [{ type: "text" as const, text: "Hi" }],
}

/** Runs createMessage to completion and returns the request params sent to the SDK. */
async function sentRequestParams(
	handler: AnthropicHandler,
	metadata?: ApiHandlerCreateMessageMetadata,
): Promise<Record<string, unknown>> {
	const stream = handler.createMessage("system prompt", [userMessage], metadata)
	await collectStream(stream)
	const call = mockCreate.mock.calls.at(-1)
	if (!call) {
		throw new Error("Expected the SDK messages.create to have been called")
	}
	return call[0] as Record<string, unknown>
}

function makeHandler(options: {
	apiModelId?: string
	enableReasoningEffort?: boolean
	reasoningEffort?: ApiHandlerOptions["reasoningEffort"]
}): AnthropicHandler {
	return new AnthropicHandler({
		apiKey: "test-api-key",
		apiModelId: options.apiModelId ?? "claude-opus-4-7",
		enableReasoningEffort: options.enableReasoningEffort,
		reasoningEffort: options.reasoningEffort,
	})
}

describe("AnthropicHandler adaptive effort envelope (DTE series 2/5)", () => {
	beforeEach(() => {
		clearAllMocks()
	})

	describe("output_config.effort on adaptive-thinking requests", () => {
		const inRangeEfforts: ReasoningEffortExtended[] = ["low", "medium", "high", "xhigh", "max"]

		it.each(inRangeEfforts)(
			"sends the settings effort %s as output_config.effort for an adaptive model",
			async (effort) => {
				const handler = makeHandler({ enableReasoningEffort: true, reasoningEffort: effort })

				const params = await sentRequestParams(handler)

				expect(params.thinking).toEqual({ type: "adaptive" })
				expect(params.output_config).toEqual({ effort })
			},
		)

		it("sends the envelope from the first (cache-control) requestParams branch", async () => {
			// claude-opus-4-8 takes the first (cache-control) requestParams branch;
			// the default branch is covered below via an unknown model id.
			const handler = makeHandler({
				apiModelId: "claude-opus-4-8",
				enableReasoningEffort: true,
				reasoningEffort: "xhigh",
			})

			const params = await sentRequestParams(handler)

			expect(params.thinking).toEqual({ type: "adaptive" })
			expect(params.output_config).toEqual({ effort: "xhigh" })
		})

		it("sends the envelope from the default requestParams branch", async () => {
			// Unknown model id -> falls through to the default switch branch, while the
			// guessed model info (claude-opus-4-7 substring) is adaptive-capable.
			const handler = makeHandler({
				apiModelId: "claude-opus-4-7-custom",
				enableReasoningEffort: true,
				reasoningEffort: "high",
			})

			const params = await sentRequestParams(handler)

			expect(params.model).toBe("claude-opus-4-7-custom")
			expect(params.thinking).toEqual({ type: "adaptive" })
			expect(params.output_config).toEqual({ effort: "high" })
		})
	})

	describe("envelope omission (out-of-range or non-adaptive)", () => {
		const settingsEfforts: ApiHandlerOptions["reasoningEffort"][] = ["none", "minimal", "disable"]

		it.each(settingsEfforts)(
			"omits output_config when the settings effort is %s on an adaptive model",
			async (effort) => {
				const handler = makeHandler({ enableReasoningEffort: true, reasoningEffort: effort })

				const params = await sentRequestParams(handler)

				// Adaptive thinking is still requested, but no envelope is sent so the
				// API applies its own default effort.
				expect(params.thinking).toEqual({ type: "adaptive" })
				expect(params).not.toHaveProperty("output_config")
			},
		)

		it("omits output_config when no effort is set anywhere on an adaptive model", async () => {
			const handler = makeHandler({ enableReasoningEffort: true })

			const params = await sentRequestParams(handler)

			expect(params.thinking).toEqual({ type: "adaptive" })
			expect(params).not.toHaveProperty("output_config")
		})

		it("omits output_config for a non-adaptive model even with an in-range effort", async () => {
			// Budget-based extended thinking (type: "enabled") never carries the
			// adaptive envelope.
			const handler = makeHandler({
				apiModelId: "claude-sonnet-4-5",
				enableReasoningEffort: true,
				reasoningEffort: "xhigh",
			})

			const params = await sentRequestParams(handler)

			expect(params.thinking).toMatchObject({ type: "enabled" })
			expect(params).not.toHaveProperty("output_config")
		})

		it("omits output_config when adaptive thinking itself is not requested", async () => {
			// enableReasoningEffort=false -> thinking is undefined -> no envelope even
			// with an in-range settings effort.
			const handler = makeHandler({ enableReasoningEffort: false, reasoningEffort: "xhigh" })

			const params = await sentRequestParams(handler)

			expect(params.thinking).toBeUndefined()
			expect(params).not.toHaveProperty("output_config")
		})

		it("keeps the pre-DTE request shape for a plain model with no reasoning settings", async () => {
			// Guard: no reasoning settings and no metadata -> no output_config.
			const handler = makeHandler({ apiModelId: "claude-3-5-haiku-20241022" })

			const params = await sentRequestParams(handler)

			expect(params.thinking).toBeUndefined()
			expect(params).not.toHaveProperty("output_config")
		})
	})

	describe("per-request override (metadata.reasoningEffort) precedence", () => {
		const baseOptions: {
			apiModelId?: string
			enableReasoningEffort?: boolean
			reasoningEffort?: ApiHandlerOptions["reasoningEffort"]
		} = {
			apiModelId: "claude-opus-4-7",
			enableReasoningEffort: true,
		}

		it("lets metadata.reasoningEffort override the settings value", async () => {
			const handler = makeHandler({ ...baseOptions, reasoningEffort: "low" })

			const params = await sentRequestParams(handler, {
				taskId: "task-1",
				reasoningEffort: "xhigh",
			})

			expect(params.output_config).toEqual({ effort: "xhigh" })
		})

		it("suppresses the envelope when the metadata override is out-of-range", async () => {
			// Settings would send "high"; the override wins and is out-of-range, so
			// the envelope is omitted entirely.
			const handler = makeHandler({ ...baseOptions, reasoningEffort: "high" })

			const params = await sentRequestParams(handler, {
				taskId: "task-1",
				reasoningEffort: "minimal",
			})

			expect(params.thinking).toEqual({ type: "adaptive" })
			expect(params).not.toHaveProperty("output_config")
		})

		const overrideEfforts: ReasoningEffortExtended[] = ["none", "minimal"]

		it.each(overrideEfforts)(
			"suppresses the envelope for metadata override %s even with an in-range settings value",
			async (effort) => {
				const handler = makeHandler({ ...baseOptions, reasoningEffort: "max" })

				const params = await sentRequestParams(handler, {
					taskId: "task-1",
					reasoningEffort: effort,
				})

				expect(params).not.toHaveProperty("output_config")
			},
		)

		it("applies the settings value when metadata carries no override", async () => {
			const handler = makeHandler({ ...baseOptions, reasoningEffort: "medium" })

			const params = await sentRequestParams(handler, { taskId: "task-1" })

			expect(params.output_config).toEqual({ effort: "medium" })
		})

		it("keeps non-adaptive requests envelope-free even with a metadata override", async () => {
			const handler = makeHandler({
				apiModelId: "claude-sonnet-4-5",
				enableReasoningEffort: true,
				reasoningEffort: "low",
			})

			const params = await sentRequestParams(handler, {
				taskId: "task-1",
				reasoningEffort: "xhigh",
			})

			expect(params.thinking).toMatchObject({ type: "enabled" })
			expect(params).not.toHaveProperty("output_config")
		})
	})
})
