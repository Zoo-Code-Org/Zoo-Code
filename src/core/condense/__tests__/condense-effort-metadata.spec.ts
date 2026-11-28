// npx vitest run src/core/condense/__tests__/condense-effort-metadata.spec.ts
//
// The summarizer boundary: Task hands the task-local thinking effort override to
// to summarizeConversation inside request metadata. This checks the other half of that hand-off:
// the real summarizer forwards the metadata to the handler's createMessage instead of dropping
// the effort. The Task-side tests cover Task-to-summarizer propagation only.

import { Anthropic } from "@anthropic-ai/sdk"
import type { ModelInfo, ReasoningEffortExtended } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import type { ApiHandlerCreateMessageMetadata } from "../../../api"
import { BaseProvider } from "../../../api/providers/base-provider"
import { ApiStream, ApiStreamChunk } from "../../../api/transform/stream"
import { ApiMessage } from "../../task-persistence/apiMessages"
import { summarizeConversation } from "../index"

const OVERRIDE_EFFORT: ReasoningEffortExtended = "xhigh"
const TASK_ID = "dte-condense-task"

class RecordingApiHandler extends BaseProvider {
	/** The metadata of the last request this handler was asked to make. */
	public requestedMetadata: ApiHandlerCreateMessageMetadata | undefined

	override createMessage(
		_systemPrompt: string,
		_messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		this.requestedMetadata = metadata
		return (async function* (): AsyncGenerator<ApiStreamChunk> {
			yield { type: "text", text: "summary of the conversation" }
			yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0.01 }
		})()
	}

	override getModel(): { id: string; info: ModelInfo } {
		return {
			id: "dte-condense-model",
			info: { contextWindow: 100_000, maxTokens: 5_000, supportsPromptCache: false, supportsImages: false },
		}
	}
}

// Three messages with no summary in them: getMessagesSinceLastSummary returns all of them, so
// summarizeConversation gets past its "not enough messages" guard and issues the request.
function conversationHistory(): ApiMessage[] {
	return [
		{ role: "user", content: [{ type: "text", text: "read the failing test" }], ts: 1 },
		{ role: "assistant", content: [{ type: "text", text: "the assertion drifted" }], ts: 2 },
		{ role: "user", content: [{ type: "text", text: "fix it" }], ts: 3 },
	]
}

describe("summarizeConversation reasoning-effort forwarding", () => {
	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
	})

	it("forwards an active override to the handler request", async () => {
		const handler = new RecordingApiHandler()

		const result = await summarizeConversation({
			messages: conversationHistory(),
			apiHandler: handler,
			systemPrompt: "system prompt",
			taskId: TASK_ID,
			isAutomaticTrigger: false,
			metadata: { mode: "code", taskId: TASK_ID, reasoningEffort: OVERRIDE_EFFORT },
			environmentDetails: "environment details",
			cwd: "/workspace",
		})

		expect(result.error).toBeUndefined()
		expect(result.summary).toBe("summary of the conversation")
		expect(handler.requestedMetadata?.reasoningEffort).toBe(OVERRIDE_EFFORT)
	})

	it("omits the key when the caller hands no override", async () => {
		const handler = new RecordingApiHandler()

		const result = await summarizeConversation({
			messages: conversationHistory(),
			apiHandler: handler,
			systemPrompt: "system prompt",
			taskId: TASK_ID,
			isAutomaticTrigger: false,
			metadata: { mode: "code", taskId: TASK_ID },
			environmentDetails: "environment details",
			cwd: "/workspace",
		})

		expect(result.summary).toBe("summary of the conversation")
		expect(handler.requestedMetadata).not.toHaveProperty("reasoningEffort")
	})
})
