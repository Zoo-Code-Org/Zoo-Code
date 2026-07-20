import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../../index"
import { FakeAIHandler } from "../fake-ai"

const modelInfo = {
	contextWindow: 8192,
	maxTokens: 4096,
	supportsImages: false,
	supportsPromptCache: false,
}

describe("FakeAIHandler", () => {
	it("should delegate completePrompt with options to the cached FakeAI instance", async () => {
		const completePrompt = vitest.fn().mockResolvedValue("delegated response")
		const fakeAi: {
			id: string
			createMessage: () => AsyncGenerator<never, void, unknown>
			getModel: () => { id: string; info: typeof modelInfo }
			countTokens: ReturnType<typeof vitest.fn>
			completePrompt: typeof completePrompt
			removeFromCache?: () => void
		} = {
			id: "fake-ai-completePrompt-delegation",
			createMessage: async function* () {},
			getModel: () => ({ id: "fake-model", info: modelInfo }),
			countTokens: vitest.fn().mockResolvedValue(0),
			completePrompt,
		}
		const controller = new AbortController()
		const options: CompletePromptOptions = { abortSignal: controller.signal, timeoutMs: 1234 }

		const handler = new FakeAIHandler({ fakeAi })
		const result = await handler.completePrompt("Test prompt", options)

		expect(result).toBe("delegated response")
		expect(completePrompt).toHaveBeenCalledWith("Test prompt", options)
		fakeAi.removeFromCache?.()
	})

	it("should delegate createMessage, getModel, and countTokens to FakeAI", async () => {
		const metadata = { taskId: "task-1" } as ApiHandlerCreateMessageMetadata
		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]
		const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "Hello" }]
		const createMessage = vitest.fn(async function* () {
			yield { type: "text" as const, text: "Hello" }
		})
		const getModel = vitest.fn(() => ({ id: "fake-model", info: modelInfo }))
		const countTokens = vitest.fn().mockResolvedValue(7)
		const fakeAi: {
			id: string
			createMessage: typeof createMessage
			getModel: typeof getModel
			countTokens: typeof countTokens
			completePrompt: ReturnType<typeof vitest.fn>
			removeFromCache?: () => void
		} = {
			id: "fake-ai-handler-delegation",
			createMessage,
			getModel,
			countTokens,
			completePrompt: vitest.fn().mockResolvedValue("complete"),
		}

		const handler = new FakeAIHandler({ fakeAi })
		const chunks = []
		for await (const chunk of handler.createMessage("System", messages, metadata)) {
			chunks.push(chunk)
		}

		expect(chunks).toEqual([{ type: "text", text: "Hello" }])
		expect(createMessage).toHaveBeenCalledWith("System", messages, metadata)
		expect(handler.getModel()).toEqual({ id: "fake-model", info: modelInfo })
		expect(getModel).toHaveBeenCalledTimes(1)
		await expect(handler.countTokens(content)).resolves.toBe(7)
		expect(countTokens).toHaveBeenCalledWith(content)
		fakeAi.removeFromCache?.()
	})
})
