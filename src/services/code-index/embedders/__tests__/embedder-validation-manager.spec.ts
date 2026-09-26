import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import { OpenAiEmbedder } from "../openai"
import { EmbedderValidationManager } from "../embedder-validation-manager"

vi.mock("../openai")
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureEvent: vi.fn() } },
}))

describe("EmbedderValidationManager", () => {
	const manager = new EmbedderValidationManager()

	beforeEach(() => vi.clearAllMocks())

	it.each([{ valid: true }, { valid: false, error: "Invalid credentials" }])(
		"preserves the validation result %j without reporting an exception",
		async (result) => {
			const embedder = new OpenAiEmbedder({ openAiNativeApiKey: "test-key" })
			vi.mocked(embedder.validateConfiguration).mockResolvedValue(result)

			expect(await manager.validateEmbedder(embedder)).toBe(result)
			expect(embedder.validateConfiguration).toHaveBeenCalledExactlyOnceWith()
			expect(TelemetryService.instance.captureEvent).not.toHaveBeenCalled()
		},
	)

	it("preserves an exception's message and reports its stack", async () => {
		const embedder = new OpenAiEmbedder({ openAiNativeApiKey: "test-key" })
		const error = new Error("Connection failed")
		vi.mocked(embedder.validateConfiguration).mockRejectedValue(error)

		expect(await manager.validateEmbedder(embedder)).toEqual({ valid: false, error: error.message })
		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledExactlyOnceWith(
			TelemetryEventName.CODE_INDEX_ERROR,
			{ error: error.message, stack: error.stack, location: "validateEmbedder" },
		)
	})

	it.each(["unavailable", null, undefined])("handles non-Error rejection %s", async (error) => {
		const embedder = new OpenAiEmbedder({ openAiNativeApiKey: "test-key" })
		vi.mocked(embedder.validateConfiguration).mockRejectedValue(error)

		expect(await manager.validateEmbedder(embedder)).toEqual({
			valid: false,
			error: "embeddings:validation.configurationError",
		})
		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledExactlyOnceWith(
			TelemetryEventName.CODE_INDEX_ERROR,
			{ error: String(error), stack: undefined, location: "validateEmbedder" },
		)
	})
})
