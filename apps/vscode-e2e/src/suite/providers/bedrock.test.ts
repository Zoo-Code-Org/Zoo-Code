import * as assert from "assert"

import { startBedrockMockServer, type BedrockMockServer } from "../../bedrock-mock-server"
import { setDefaultSuiteTimeout } from "../test-utils"
import { waitUntilCompleted } from "../utils"

const AWS_BEARER_TOKEN_BEDROCK = process.env.AWS_BEARER_TOKEN_BEDROCK
const BEDROCK_REGION = process.env.BEDROCK_REGION ?? "us-east-1"
// Use a cross-region inference profile so the token works without per-region model access.
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0"
const BEDROCK_LIVE_E2E = process.env.BEDROCK_LIVE_E2E === "true"

suite("Bedrock provider", function () {
	setDefaultSuiteTimeout(this)
	this.timeout(3 * 60_000)

	let mockServer: BedrockMockServer | undefined

	suiteSetup(async function () {
		const aimockUrl = process.env.AIMOCK_URL

		if (!aimockUrl && BEDROCK_LIVE_E2E && AWS_BEARER_TOKEN_BEDROCK) {
			// Live mode — explicitly opted into real AWS credentials, no aimock intercepting traffic.
			await globalThis.api.setConfiguration({
				apiProvider: "bedrock" as const,
				awsUseApiKey: true,
				awsApiKey: AWS_BEARER_TOKEN_BEDROCK,
				awsRegion: BEDROCK_REGION,
				apiModelId: BEDROCK_MODEL_ID,
			})
		} else {
			// Mock mode — use our custom binary-event-stream server because aimock's
			// converse-stream builder nests payloads one level too deep, causing the AWS SDK
			// deserializer to drop the delta field (take() reads top-level only).
			mockServer = await startBedrockMockServer()
			await globalThis.api.setConfiguration({
				apiProvider: "bedrock" as const,
				awsUseApiKey: true,
				awsApiKey: "mock-key",
				awsRegion: BEDROCK_REGION,
				apiModelId: BEDROCK_MODEL_ID,
				awsBedrockEndpoint: mockServer.url,
				awsBedrockEndpointEnabled: true,
			})
		}
	})

	suiteTeardown(async () => {
		// Restore the default provider first so the extension stops using the Bedrock
		// endpoint. Only then close the mock server — closing it first leaves any
		// in-flight retry loop hitting ECONNREFUSED and the after-all hook times out.
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})

		if (mockServer) {
			// Brief pause so the extension picks up the provider switch before the
			// h2c listener closes.
			await new Promise<void>((resolve) => setTimeout(resolve, 500))
			await mockServer.close()
			mockServer = undefined
		}
	})

	test("Should complete a task end-to-end via AWS Bedrock with ZooCode# user-agent", async () => {
		const api = globalThis.api
		const taskId = await api.startNewTask({
			configuration: { mode: "ask", autoApprovalEnabled: true },
			text: "bedrock-identity-smoke: what is 2+2? Reply with only the number.",
		})

		await waitUntilCompleted({ api, taskId })

		if (mockServer) {
			// Verify the AWS SDK transmitted the ZooCode# userAgentAppId.
			// In Node.js mode the SDK appends "app/<appId>" to the full sdkUserAgentValue
			// and writes it to the "user-agent" header. The "x-amz-user-agent" header only
			// carries aws-sdk-* segments and never contains the app ID.
			const userAgent = mockServer.lastRequestHeaders?.["user-agent"] as string | undefined
			assert.ok(userAgent, "Bedrock request should include user-agent header")
			assert.ok(userAgent.includes("ZooCode#"), `user-agent should contain "ZooCode#" — got: ${userAgent}`)
		} else {
			// Live mode: a successful round-trip proves the identity change didn't break
			// SDK auth or request formation. The x-amzn-user-agent header is not visible
			// to us without intercepting at the TLS layer.
			assert.ok(true, "Task completed successfully via Bedrock with ZooCode# userAgentAppId")
		}
	})
})
