import type { ApiHandler } from "../../../api"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { summarizeConversation } from "../index"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureContextCondensed: vi.fn() } },
}))

const messages: ApiMessage[] = [
	{ role: "user", content: "Start", ts: 1 },
	{ role: "assistant", content: "Working", ts: 2 },
	{ role: "user", content: "Continue", ts: 3 },
]

function createHandler() {
	return {
		getModel: () => ({
			id: "test-model",
			info: { contextWindow: 100_000, supportsImages: false, supportsPromptCache: false },
		}),
		getModelCacheScope: () => ({ urlScoped: false, keyScoped: false, authScoped: false }),
		countTokens: vi.fn(async () => 10),
		measureInputOverageChars: vi.fn(() => 0),
		createMessage: vi.fn<ApiHandler["createMessage"]>(() =>
			(async function* () {
				yield { type: "text" as const, text: "Summary" }
			})(),
		),
	} satisfies ApiHandler
}

describe("condensation handler validation", () => {
	it("accepts a valid handler and installs its summary", async () => {
		const handler = createHandler()
		const result = await summarizeConversation({ messages, apiHandler: handler, systemPrompt: "", taskId: "test" })

		expect(result.error).toBeUndefined()
		expect(result.summary).toBe("Summary")
		expect(handler.createMessage).toHaveBeenCalledOnce()
	})

	it("rejects a handler without message creation before calling its overage probe", async () => {
		const handler = createHandler()
		const { createMessage: omittedCreateMessage, ...invalidHandler } = handler
		invalidHandler.measureInputOverageChars.mockImplementation(() => {
			throw new Error("overage probe must not run for an invalid handler")
		})

		const result = await summarizeConversation({
			messages,
			// This double provides model/count/probe methods but deliberately omits createMessage to test its guard.
			apiHandler: invalidHandler as unknown as ApiHandler,
			systemPrompt: "",
			taskId: "test",
		})

		expect(result.error).toBeTruthy()
		expect(result.summary).toBe("")
		expect(result.messages).toEqual(messages)
		expect(invalidHandler.measureInputOverageChars).not.toHaveBeenCalled()
		expect(omittedCreateMessage).not.toHaveBeenCalled()
	})
})
