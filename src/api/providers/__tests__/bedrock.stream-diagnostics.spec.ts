// Covers `messageStop.stopReason`, which used to be discarded: a stream that ends with
// zero content is otherwise indistinguishable from a truncated or filtered turn.

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: vi.fn(),
		},
	},
}))

vi.mock("@aws-sdk/credential-providers", () => ({
	fromIni: vi.fn().mockReturnValue({
		accessKeyId: "profile-access-key",
		secretAccessKey: "profile-secret-key",
	}),
}))

vi.mock("../../../utils/networkProxy", () => ({
	getSystemProxyUrl: vi.fn().mockReturnValue(undefined),
}))

vi.mock("@smithy/node-http-handler", () => ({ NodeHttpHandler: vi.fn() }))
vi.mock("http-proxy-agent", () => ({ HttpProxyAgent: vi.fn() }))
vi.mock("https-proxy-agent", () => ({ HttpsProxyAgent: vi.fn() }))

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
	BedrockRuntimeClient: vi.fn().mockImplementation(function () {
		return { send: vi.fn() }
	}),
	ConverseStreamCommand: vi.fn(),
	ConverseCommand: vi.fn(),
}))

import type { Anthropic } from "@anthropic-ai/sdk"

import { AwsBedrockHandler } from "../bedrock"
import type { ApiStreamChunk } from "../../transform/stream"
import { makeCreateMessageMetadata } from "../../../test-utils/api"
import { clearAllMocks } from "../../../test-utils/reset"

const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

function createHandler(streamEvents: unknown[]): AwsBedrockHandler {
	const handler = new AwsBedrockHandler({
		apiModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
		awsAccessKey: "test-access-key",
		awsSecretKey: "test-secret-key",
		awsRegion: "us-east-1",
	})
	handler["client"].send = vi.fn().mockResolvedValue({ stream: streamEvents })
	return handler
}

async function collect(handler: AwsBedrockHandler): Promise<ApiStreamChunk[]> {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of handler.createMessage("system", messages, makeCreateMessageMetadata())) {
		chunks.push(chunk)
	}
	return chunks
}

describe("AwsBedrockHandler stream diagnostics", () => {
	beforeEach(() => {
		clearAllMocks()
	})

	describe("messageStop.stopReason", () => {
		it("surfaces the stop reason as a dedicated chunk", async () => {
			const chunks = await collect(
				createHandler([
					{ contentBlockDelta: { delta: { text: "partial" } } },
					{ messageStop: { stopReason: "max_tokens" } },
				]),
			)

			expect(chunks).toEqual([
				{ type: "text", text: "partial" },
				{ type: "stop_reason", reason: "max_tokens" },
			])
		})

		it.each(["guardrail_intervened", "content_filtered", "malformed_tool_use"])(
			"reports %s even when the turn carried no content at all",
			async (stopReason) => {
				const chunks = await collect(
					createHandler([
						{ messageStop: { stopReason } },
						{ metadata: { usage: { inputTokens: 1200, outputTokens: 0 } } },
					]),
				)

				expect(chunks).toContainEqual({ type: "stop_reason", reason: stopReason })
				// It must not masquerade as assistant content.
				expect(chunks.some((chunk) => chunk.type === "text")).toBe(false)
			},
		)

		it("emits no stop_reason chunk when the provider omits the reason", async () => {
			const chunks = await collect(createHandler([{ messageStop: {} }]))

			expect(chunks).toEqual([])
		})
	})
})
