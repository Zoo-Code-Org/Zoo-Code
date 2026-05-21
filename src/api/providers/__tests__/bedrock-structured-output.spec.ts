// Mock AWS SDK credential providers
vi.mock("@aws-sdk/credential-providers", () => {
	const mockFromIni = vi.fn().mockReturnValue({
		accessKeyId: "profile-access-key",
		secretAccessKey: "profile-secret-key",
	})
	return { fromIni: mockFromIni }
})

// Mock BedrockRuntimeClient and ConverseStreamCommand
const mockSend = vi.fn()

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	return {
		BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
			send: mockSend,
			config: { region: "us-east-1" },
		})),
		ConverseStreamCommand: vi.fn((params) => ({
			...params,
			input: params,
		})),
		ConverseCommand: vi.fn(),
	}
})

import { AwsBedrockHandler } from "../bedrock"
import { ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime"
import type { ApiHandlerCreateMessageMetadata } from "../../index"

const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)

const sampleTools = [
	{
		type: "function" as const,
		function: {
			name: "read_file",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	},
]

function buildHandler(overrides: Partial<ConstructorParameters<typeof AwsBedrockHandler>[0]> = {}) {
	return new AwsBedrockHandler({
		apiModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
		awsAccessKey: "test-access-key",
		awsSecretKey: "test-secret-key",
		awsRegion: "us-east-1",
		...overrides,
	} as any)
}

async function drain(stream: AsyncGenerator<any>): Promise<any[]> {
	const out: any[] = []
	for await (const chunk of stream) {
		out.push(chunk)
	}
	return out
}

function makeValidationError(message: string, httpStatus: number = 400): Error {
	const err: any = new Error(message)
	err.name = "ValidationException"
	err.$metadata = { httpStatusCode: httpStatus }
	return err
}

describe("AwsBedrockHandler structured output", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockSend.mockResolvedValue({ stream: [] })
	})

	describe("convertToolsForBedrock strict flag", () => {
		it("omits strict when opts.strict is false or not passed", () => {
			const handler = buildHandler()
			const convertTools = (handler as any).convertToolsForBedrock.bind(handler)
			const withoutFlag = convertTools(sampleTools)
			const withFalse = convertTools(sampleTools, { strict: false })
			expect(withoutFlag[0].toolSpec.strict).toBeUndefined()
			expect(withFalse[0].toolSpec.strict).toBeUndefined()
		})

		it("sets strict: true on every toolSpec when opts.strict is true", () => {
			const handler = buildHandler()
			const convertTools = (handler as any).convertToolsForBedrock.bind(handler)
			const result = convertTools(sampleTools, { strict: true })
			expect(result[0].toolSpec.strict).toBe(true)
		})

		it("strips Bedrock-incompatible numeric constraints when strict is enabled", () => {
			// Mirrors the real schema in edit_file.ts (expected_replacements: minimum 1)
			const handler = buildHandler()
			const convertTools = (handler as any).convertToolsForBedrock.bind(handler)
			const toolsWithMinimum = [
				{
					type: "function" as const,
					function: {
						name: "edit_file",
						description: "Edit a file",
						parameters: {
							type: "object",
							properties: {
								expected_replacements: {
									type: "integer",
									description: "How many times to replace",
									minimum: 1,
								},
							},
						},
					},
				},
			]
			const result = convertTools(toolsWithMinimum, { strict: true })
			const paramsSchema = result[0].toolSpec.inputSchema.json as any
			expect(paramsSchema.properties.expected_replacements.minimum).toBeUndefined()
			expect(paramsSchema.properties.expected_replacements.description).toContain("minimum=1")
		})

		it("strips maxItems / minItems > 1 on arrays when strict is enabled", () => {
			// Mirrors the real schema in ask_followup_question.ts (follow_up: minItems 1, maxItems 4)
			const handler = buildHandler()
			const convertTools = (handler as any).convertToolsForBedrock.bind(handler)
			const toolsWithArrayBounds = [
				{
					type: "function" as const,
					function: {
						name: "ask_followup_question",
						parameters: {
							type: "object",
							properties: {
								follow_up: {
									type: "array",
									minItems: 1,
									maxItems: 4,
									items: { type: "object" },
								},
							},
						},
					},
				},
			]
			const result = convertTools(toolsWithArrayBounds, { strict: true })
			const schema = result[0].toolSpec.inputSchema.json as any
			expect(schema.properties.follow_up.maxItems).toBeUndefined()
			expect(schema.properties.follow_up.minItems).toBe(1)
			expect(schema.properties.follow_up.description).toContain("maxItems=4")
		})

		it("preserves numeric constraints when strict is disabled", () => {
			const handler = buildHandler()
			const convertTools = (handler as any).convertToolsForBedrock.bind(handler)
			const toolsWithMinimum = [
				{
					type: "function" as const,
					function: {
						name: "n",
						parameters: {
							type: "object",
							properties: { x: { type: "integer", minimum: 1 } },
						},
					},
				},
			]
			const result = convertTools(toolsWithMinimum, { strict: false })
			const schema = result[0].toolSpec.inputSchema.json as any
			expect(schema.properties.x.minimum).toBe(1)
		})
	})

	describe("createMessage strict payload gating", () => {
		it("enables strict by default when profile flag is unset and tools are present", async () => {
			const handler = buildHandler()
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "t1",
				tools: sampleTools,
			}
			await handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata).next()
			const payload = mockConverseStreamCommand.mock.calls[0][0] as any
			expect(payload.toolConfig.tools[0].toolSpec.strict).toBe(true)
		})

		it("omits strict when awsBedrockStructuredOutput is explicitly false", async () => {
			const handler = buildHandler({ awsBedrockStructuredOutput: false } as any)
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "t1",
				tools: sampleTools,
			}
			await handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata).next()
			const payload = mockConverseStreamCommand.mock.calls[0][0] as any
			expect(payload.toolConfig.tools[0].toolSpec.strict).toBeUndefined()
		})

		it("omits strict when no native tools are present", async () => {
			const handler = buildHandler()
			const metadata: ApiHandlerCreateMessageMetadata = { taskId: "t1" }
			await handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata).next()
			const payload = mockConverseStreamCommand.mock.calls[0][0] as any
			expect(payload.toolConfig.tools).toHaveLength(0)
		})

		it("omits strict when metadata.isModelStructuredOutputUnsupported returns true", async () => {
			const handler = buildHandler()
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "t1",
				tools: sampleTools,
				isModelStructuredOutputUnsupported: () => true,
				markModelStructuredOutputUnsupported: vi.fn(),
			}
			await handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata).next()
			const payload = mockConverseStreamCommand.mock.calls[0][0] as any
			expect(payload.toolConfig.tools[0].toolSpec.strict).toBeUndefined()
		})
	})

	describe("STRUCTURED_OUTPUT_UNSUPPORTED fallback", () => {
		it("marks model unsupported, yields notice, and retries once without strict", async () => {
			const handler = buildHandler()
			const markUnsupported = vi.fn()
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "t1",
				tools: sampleTools,
				isModelStructuredOutputUnsupported: () => false,
				markModelStructuredOutputUnsupported: markUnsupported,
			}

			const verbatimErr = "Model does not support strict schema for tool inputs"
			mockSend.mockReset()
			mockSend.mockRejectedValueOnce(makeValidationError(verbatimErr))
			mockSend.mockResolvedValueOnce({ stream: [] })

			const chunks = await drain(handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata))

			expect(mockSend).toHaveBeenCalledTimes(2)
			expect(markUnsupported).toHaveBeenCalledWith("anthropic.claude-3-5-sonnet-20241022-v2:0")

			// First send had strict: true, second did not
			const firstPayload = mockConverseStreamCommand.mock.calls[0][0] as any
			const secondPayload = mockConverseStreamCommand.mock.calls[1][0] as any
			expect(firstPayload.toolConfig.tools[0].toolSpec.strict).toBe(true)
			expect(secondPayload.toolConfig.tools[0].toolSpec.strict).toBeUndefined()

			// User sees a text chunk containing the verbatim Bedrock error
			const noticeChunks = chunks.filter((c) => c.type === "text" && c.text?.includes(verbatimErr))
			expect(noticeChunks.length).toBeGreaterThan(0)
		})

		it("does not mark model unsupported when strict was already disabled", async () => {
			const handler = buildHandler({ awsBedrockStructuredOutput: false } as any)
			const markUnsupported = vi.fn()
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "t1",
				tools: sampleTools,
				markModelStructuredOutputUnsupported: markUnsupported,
			}

			mockSend.mockReset()
			mockSend.mockRejectedValue(makeValidationError("does not support strict"))

			await expect(
				drain(handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata)),
			).rejects.toThrow()
			expect(markUnsupported).not.toHaveBeenCalled()
		})
	})

	describe("STRUCTURED_OUTPUT_COMPILING poll loop", () => {
		it("waits, yields a progress chunk, and retries on compiling error", async () => {
			vi.useFakeTimers()
			try {
				const handler = buildHandler()
				const metadata: ApiHandlerCreateMessageMetadata = {
					taskId: "t1",
					tools: sampleTools,
				}

				mockSend.mockReset()
				mockSend.mockRejectedValueOnce(makeValidationError("Schema is being compiled"))
				mockSend.mockResolvedValueOnce({ stream: [] })

				const gen = handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata)
				const collectPromise = drain(gen as any)

				// First tick — allow the rejection to propagate and the setTimeout to arm
				await vi.runOnlyPendingTimersAsync()
				// Drain the backoff delay
				await vi.advanceTimersByTimeAsync(60_000)

				const chunks = await collectPromise
				const progress = chunks.find(
					(c) => c.type === "text" && typeof c.text === "string" && c.text.includes("compiling"),
				)
				expect(progress).toBeDefined()
				expect(mockSend).toHaveBeenCalledTimes(2)
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("getErrorType classification", () => {
		it("classifies strict-rejection messages as STRUCTURED_OUTPUT_UNSUPPORTED only on 400", () => {
			const handler = buildHandler()
			const getErrorType = (handler as any).getErrorType.bind(handler)
			expect(getErrorType(makeValidationError("does not support strict", 400))).toBe(
				"STRUCTURED_OUTPUT_UNSUPPORTED",
			)
		})

		it("classifies compiling messages as STRUCTURED_OUTPUT_COMPILING", () => {
			const handler = buildHandler()
			const getErrorType = (handler as any).getErrorType.bind(handler)
			expect(getErrorType(makeValidationError("schema is being compiled", 400))).toBe(
				"STRUCTURED_OUTPUT_COMPILING",
			)
			expect(getErrorType(makeValidationError("grammar compilation in progress", 503))).toBe(
				"STRUCTURED_OUTPUT_COMPILING",
			)
		})

		it("does not misclassify an unrelated 400 error as STRUCTURED_OUTPUT_UNSUPPORTED", () => {
			const handler = buildHandler()
			const getErrorType = (handler as any).getErrorType.bind(handler)
			// An unrelated 400 without any structured-output keywords must NOT be labeled as
			// STRUCTURED_OUTPUT_UNSUPPORTED — we'd otherwise wrongly disable strict on working models.
			const result = getErrorType(makeValidationError("field required: modelId", 400))
			expect(result).not.toBe("STRUCTURED_OUTPUT_UNSUPPORTED")
			expect(result).not.toBe("STRUCTURED_OUTPUT_COMPILING")
		})

		it("does not mark a 429 throttle as structured output", () => {
			const handler = buildHandler()
			const getErrorType = (handler as any).getErrorType.bind(handler)
			const throttle: any = new Error("rate limit exceeded")
			throttle.name = "ThrottlingException"
			throttle.status = 429
			expect(getErrorType(throttle)).toBe("THROTTLING")
		})
	})
})
