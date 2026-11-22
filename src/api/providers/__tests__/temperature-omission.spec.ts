// npx vitest run src/api/providers/__tests__/temperature-omission.spec.ts
//
// Property tests for the TemperatureOmission.tla invariants (issue #242).
// I1: modelTemperature is nullish => the request body has no temperature field.
// I2: modelTemperature is 0 => the body temperature is 0.
// I3: modelTemperature is c => the body temperature is c.
// The DeepSeek reasoner / ollama R1-format exception is deliberate (PR #247)
// and is kept out of these assertions.

vitest.mock("vscode", () => ({
	window: {
		showErrorMessage: vitest.fn(async () => undefined),
		env: { openExternal: vitest.fn(async () => true), uriScheme: "vscode", appName: "VS Code" },
	},
	Uri: { parse: (value: string) => ({ toString: () => value }) },
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}))

vitest.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: vitest.fn(),
		},
	},
}))

vitest.mock("delay", () => ({
	default: vitest.fn(() => Promise.resolve()),
}))

import { ConverseCommand, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime"
import OpenAI from "openai"

import {
	BEDROCK_DEFAULT_TEMPERATURE,
	geminiDefaultModelId,
	kenariDefaultModelId,
	nanoGptDefaultModelId,
	vercelAiGatewayDefaultModelId,
	zooGatewayDefaultModelId,
} from "@roo-code/types"

import { AwsBedrockHandler } from "../bedrock"
import { FireworksHandler } from "../fireworks"
import { FriendliHandler } from "../friendli"
import { GeminiHandler } from "../gemini"
import { KenariHandler } from "../kenari"
import { LiteLLMHandler } from "../lite-llm"
import { LmStudioHandler } from "../lm-studio"
import { MistralHandler } from "../mistral"
import { NanoGptHandler } from "../nanogpt"
import { NativeOllamaHandler } from "../native-ollama"
import { OpenAiNativeHandler } from "../openai-native"
import { VercelAiGatewayHandler } from "../vercel-ai-gateway"
import { ZAiHandler } from "../zai"
import { ZooGatewayHandler } from "../zoo-gateway"
import { getOllamaModels } from "../fetchers/ollama"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { GoogleGenAI } from "@google/genai"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"

// One shared catalog serves every handler that resolves models via modelCache.
const MODEL_CATALOG = vitest.hoisted(() => ({
	"claude-3-7-sonnet-20250219": {
		maxTokens: 8192,
		contextWindow: 200000,
		supportsImages: false,
		supportsPromptCache: false,
		description: "LiteLLM default",
	},
	"anthropic/claude-sonnet-4": {
		maxTokens: 64000,
		contextWindow: 200000,
		supportsImages: true,
		supportsPromptCache: true,
		description: "Gateway default",
	},
	"glm-5-2": {
		maxTokens: 32768,
		contextWindow: 1048576,
		supportsImages: false,
		supportsPromptCache: false,
		description: "GLM 5.2",
	},
	"openai/gpt-5.6-sol": {
		maxTokens: 32768,
		contextWindow: 400000,
		supportsImages: false,
		supportsPromptCache: false,
		description: "NanoGpt default",
	},
}))

const MODEL_CATALOG_FETCH_TIMEOUT_MS = vitest.hoisted(() => 10_000)

vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockImplementation(() => Promise.resolve(MODEL_CATALOG)),
	refreshModels: vitest.fn().mockImplementation(() => Promise.resolve(MODEL_CATALOG)),
	getModelsFromCache: vitest.fn().mockReturnValue(undefined),
	MODEL_CATALOG_FETCH_TIMEOUT_MS,
}))

// OpenAI SDK mock shared by every chat-completions handler plus openai-native.
const mockCreate = vitest.fn()
const mockResponsesCreate = vitest.fn()

vitest.mock("openai")
;(OpenAI as unknown as { mockImplementation: (impl: () => unknown) => void }).mockImplementation(function () {
	return {
		chat: {
			completions: {
				create: mockCreate,
			},
		},
		responses: {
			create: mockResponsesCreate,
		},
	}
})

// Mistral SDK mock.
const mockMistralStream = vitest.fn()
const mockMistralComplete = vitest.fn()

vitest.mock("@mistralai/mistralai", () => ({
	Mistral: vitest.fn().mockImplementation(function () {
		return {
			chat: {
				stream: mockMistralStream,
				complete: mockMistralComplete,
			},
		}
	}),
}))

// AWS Bedrock SDK mock (mirrors bedrock.spec.ts). send resolves an empty
// stream so createMessage/completePrompt finish without parsing real chunks.
vitest.mock("@aws-sdk/client-bedrock-runtime", () => {
	const mockSend = vitest.fn().mockResolvedValue({ stream: [] })
	const mockConverseStreamCommand = vitest.fn()
	return {
		BedrockRuntimeClient: vitest.fn().mockImplementation(function () {
			return { send: mockSend }
		}),
		ConverseStreamCommand: mockConverseStreamCommand,
		ConverseCommand: vitest.fn(),
	}
})

// Ollama SDK mock (mirrors native-ollama.spec.ts).
const mockChat = vitest.fn()
const mockIsProxyEnabled = vi.hoisted(() => vitest.fn(() => false))
vitest.mock("../../../utils/networkProxy", async (importOriginal) => {
	const actual = (await importOriginal()) as typeof import("../../../utils/networkProxy")
	return {
		...actual,
		isProxyEnabled: mockIsProxyEnabled,
	}
})

const mockedOllama = vi.hoisted(() => ({
	OllamaMock: vitest.fn(),
}))

vitest.mock("ollama", () => {
	const { OllamaMock } = mockedOllama
	return {
		Ollama: OllamaMock.mockImplementation(function (options?: { host?: string }) {
			const instanceAbort = vitest.fn()
			return {
				chat: mockChat,
				abort: instanceAbort,
				_host: options?.host ?? "http://localhost:11434",
				_instanceAbort: instanceAbort,
			}
		}),
		Message: vitest.fn(),
	}
})

vitest.mock("../fetchers/ollama", async (importOriginal) => {
	const actual = (await importOriginal()) as typeof import("../fetchers/ollama")
	return {
		...actual,
		getOllamaModels: vitest.fn(),
	}
})

const mockGetOllamaModels = vitest.mocked(getOllamaModels)

// Bedrock command constructors (mocked module above).
const mockConverseStream = vitest.mocked(ConverseStreamCommand)
const mockConverse = vitest.mocked(ConverseCommand)

const userMessage = [{ role: "user" as const, content: "Hello" }]

// Standard streaming completion chunks for the OpenAI chat-completions shape.
// LiteLLM calls create(...).withResponse(); other handlers iterate the stream.
const makeCompletionStream = () => {
	const stream = asyncStreamFrom([
		{ choices: [{ delta: { content: "Test response" }, index: 0 }], usage: null },
		{
			choices: [{ delta: {}, index: 0 }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		},
	])
	type CompletionStream = ReturnType<typeof asyncStreamFrom> & {
		withResponse: () => Promise<{
			data: ReturnType<typeof asyncStreamFrom>
			response: { headers: Map<string, string> }
		}>
	}
	const streamWithResponse = stream as CompletionStream
	streamWithResponse.withResponse = async () => ({ data: stream, response: { headers: new Map() } })
	return streamWithResponse
}

const nonStreamingCompletion = { choices: [{ message: { content: "ok" } }] }

beforeEach(() => {
	mockCreate.mockClear()
	mockConverseStream.mockClear()
	mockConverse.mockClear()
	// Return the stream synchronously: LiteLLM calls create(...).withResponse()
	// directly on the returned value (the real SDK returns an APIPromise).
	mockCreate.mockImplementation(() => makeCompletionStream())
	mockResponsesCreate.mockClear()
	mockResponsesCreate.mockImplementation(async () =>
		asyncStreamFrom([
			{ type: "response.output_text.delta", delta: "Test response" },
			{ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
		]),
	)
	mockMistralStream.mockClear()
	mockMistralStream.mockImplementation(async () =>
		asyncStreamFrom([
			{ data: { choices: [{ delta: { content: "Test response" }, index: 0 }] } },
			{ data: { choices: [{ delta: {}, index: 0 }], usage: { prompt_tokens: 10, completion_tokens: 5 } } },
		]),
	)
	mockMistralComplete.mockClear()
	mockMistralComplete.mockResolvedValue({ choices: [{ message: { content: "ok" } }] })
	mockChat.mockClear()
	mockChat.mockImplementation(async function* () {
		yield { message: { content: "Test response" }, eval_count: 2, prompt_eval_count: 10 }
	})
	mockGetOllamaModels.mockResolvedValue({
		llama2: {
			contextWindow: 4096,
			maxTokens: 4096,
			supportsImages: false,
			supportsPromptCache: false,
		},
	})
})

describe("temperature omission (issue #242, TemperatureOmission.tla)", () => {
	describe("FireworksHandler (base-openai-compatible createStream)", () => {
		const make = (options: Partial<ApiHandlerOptions> = {}) =>
			new FireworksHandler({ fireworksApiKey: "test-key", ...options })

		it.each([undefined, null])("I1: omits temperature when custom temperature is %s", async (modelTemperature) => {
			await collectStream(make({ modelTemperature }).createMessage("system", userMessage))
			expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
		})

		it("I2: sends an explicit custom temperature of 0", async () => {
			await collectStream(make({ modelTemperature: 0 }).createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0)
		})

		it("I3: sends a custom temperature unchanged", async () => {
			await collectStream(make({ modelTemperature: 0.7 }).createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0.7)
		})
	})

	describe("LiteLLMHandler", () => {
		const make = (options: Partial<ApiHandlerOptions> = {}) =>
			new LiteLLMHandler({ litellmApiKey: "test-key", ...options })

		it.each([undefined, null])("I1: omits temperature when custom temperature is %s", async (modelTemperature) => {
			await collectStream(make({ modelTemperature }).createMessage("system", userMessage))
			expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
		})

		it("I2: sends an explicit custom temperature of 0", async () => {
			await collectStream(make({ modelTemperature: 0 }).createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0)
		})

		it("I3: sends a custom temperature unchanged", async () => {
			await collectStream(make({ modelTemperature: 0.7 }).createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0.7)
		})

		it.each([undefined, null])(
			"I1 (completePrompt): omits temperature when custom temperature is %s",
			async (modelTemperature) => {
				mockCreate.mockResolvedValueOnce(nonStreamingCompletion)
				await make({ modelTemperature }).completePrompt("hello")
				expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
			},
		)
	})

	describe("NativeOllamaHandler", () => {
		const make = (options: Partial<ApiHandlerOptions> = {}) =>
			new NativeOllamaHandler({
				apiModelId: "llama2",
				ollamaModelId: "llama2",
				ollamaBaseUrl: "http://localhost:11434",
				...options,
			})

		it.each([undefined, null])("I1: omits temperature when custom temperature is %s", async (modelTemperature) => {
			await collectStream(make({ modelTemperature }).createMessage("system", userMessage))
			expect("temperature" in mockChat.mock.calls[0][0].options).toBe(false)
		})

		it("I2: sends an explicit custom temperature of 0", async () => {
			await collectStream(make({ modelTemperature: 0 }).createMessage("system", userMessage))
			expect(mockChat.mock.calls[0][0].options.temperature).toBe(0)
		})

		it("I3: sends a custom temperature unchanged", async () => {
			await collectStream(make({ modelTemperature: 0.7 }).createMessage("system", userMessage))
			expect(mockChat.mock.calls[0][0].options.temperature).toBe(0.7)
		})

		it.each([undefined, null])(
			"I1 (completePrompt): omits temperature when custom temperature is %s",
			async (modelTemperature) => {
				mockChat.mockResolvedValueOnce({ message: { content: "ok" } })
				await make({ modelTemperature }).completePrompt("hello")
				expect("temperature" in mockChat.mock.calls[0][0].options).toBe(false)
			},
		)

		it("I2 (completePrompt): sends an explicit custom temperature of 0", async () => {
			mockChat.mockResolvedValueOnce({ message: { content: "ok" } })
			await make({ modelTemperature: 0 }).completePrompt("hello")
			expect(mockChat.mock.calls[0][0].options.temperature).toBe(0)
		})
	})

	describe("OpenAiNativeHandler", () => {
		const systemPrompt = "You are a helpful assistant."
		const make = (options: Partial<ApiHandlerOptions> = {}) =>
			new OpenAiNativeHandler({
				apiModelId: "gpt-5.3-chat-latest",
				openAiNativeApiKey: "test-key",
				...options,
			})

		it.each([undefined, null])("I1: omits temperature when custom temperature is %s", async (modelTemperature) => {
			const handler = make({ modelTemperature })
			const model = handler.getModel()
			const body = handler["buildRequestBody"](model, [], systemPrompt, undefined, undefined, {
				taskId: "test-task",
			})
			expect("temperature" in body).toBe(false)
		})

		it("I2: sends an explicit custom temperature of 0", async () => {
			const handler = make({ modelTemperature: 0 })
			const model = handler.getModel()
			const body = handler["buildRequestBody"](model, [], systemPrompt, undefined, undefined, {
				taskId: "test-task",
			})
			expect(body.temperature).toBe(0)
		})

		it("I3: sends a custom temperature unchanged", async () => {
			const handler = make({ modelTemperature: 0.7 })
			const model = handler.getModel()
			const body = handler["buildRequestBody"](model, [], systemPrompt, undefined, undefined, {
				taskId: "test-task",
			})
			expect(body.temperature).toBe(0.7)
		})

		it.each([undefined, null])(
			"I1 (completePrompt): omits temperature when custom temperature is %s",
			async (modelTemperature) => {
				mockResponsesCreate.mockResolvedValueOnce({
					output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
				})
				await make({ modelTemperature }).completePrompt("hello")
				expect("temperature" in mockResponsesCreate.mock.calls[0][0]).toBe(false)
			},
		)

		it("I3 (completePrompt): sends a custom temperature unchanged", async () => {
			mockResponsesCreate.mockResolvedValueOnce({
				output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
			})
			await make({ modelTemperature: 0.7 }).completePrompt("hello")
			expect(mockResponsesCreate.mock.calls[0][0].temperature).toBe(0.7)
		})
	})

	describe("MistralHandler", () => {
		const make = (options: Partial<ApiHandlerOptions> = {}) =>
			new MistralHandler({ mistralApiKey: "test-key", ...options })

		it.each([undefined, null])("I1: omits temperature when custom temperature is %s", async (modelTemperature) => {
			await collectStream(make({ modelTemperature }).createMessage("system", userMessage))
			expect("temperature" in mockMistralStream.mock.calls[0][0]).toBe(false)
		})

		it("I2: sends an explicit custom temperature of 0", async () => {
			await collectStream(make({ modelTemperature: 0 }).createMessage("system", userMessage))
			expect(mockMistralStream.mock.calls[0][0].temperature).toBe(0)
		})

		it("I3: sends a custom temperature unchanged", async () => {
			await collectStream(make({ modelTemperature: 0.7 }).createMessage("system", userMessage))
			expect(mockMistralStream.mock.calls[0][0].temperature).toBe(0.7)
		})

		it.each([undefined, null])(
			"I1 (completePrompt): omits temperature when custom temperature is %s",
			async (modelTemperature) => {
				await make({ modelTemperature }).completePrompt("hello")
				expect("temperature" in mockMistralComplete.mock.calls[0][0]).toBe(false)
			},
		)

		it("I3 (completePrompt): sends a custom temperature unchanged", async () => {
			await make({ modelTemperature: 0.7 }).completePrompt("hello")
			expect(mockMistralComplete.mock.calls[0][0].temperature).toBe(0.7)
		})
	})

	describe("LmStudioHandler", () => {
		const make = (options: Partial<ApiHandlerOptions> = {}) =>
			new LmStudioHandler({
				lmStudioModelId: "llama2",
				lmStudioBaseUrl: "http://localhost:1234",
				...options,
			})

		it.each([undefined, null])("I1: omits temperature when custom temperature is %s", async (modelTemperature) => {
			const handler = make({ modelTemperature })
			vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			await collectStream(handler.createMessage("system", userMessage))
			expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
		})

		it("I2: sends an explicit custom temperature of 0", async () => {
			const handler = make({ modelTemperature: 0 })
			vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			await collectStream(handler.createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0)
		})

		it("I3: sends a custom temperature unchanged", async () => {
			const handler = make({ modelTemperature: 0.7 })
			vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			await collectStream(handler.createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0.7)
		})

		it.each([undefined, null])(
			"I1 (completePrompt): omits temperature when custom temperature is %s",
			async (modelTemperature) => {
				mockCreate.mockResolvedValueOnce(nonStreamingCompletion)
				await make({ modelTemperature }).completePrompt("hello")
				expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
			},
		)
	})

	describe("AwsBedrockHandler", () => {
		const make = (options: Partial<ApiHandlerOptions> = {}) =>
			new AwsBedrockHandler({
				apiModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
				awsAccessKey: "test-access-key",
				awsSecretKey: "test-secret-key",
				awsRegion: "us-east-1",
				...options,
			})

		it.each([undefined, null])(
			"I1 (createMessage): omits temperature when custom temperature is %s",
			async (modelTemperature) => {
				const handler = make({ modelTemperature })
				await collectStream(handler.createMessage("system", userMessage))
				expect(mockConverseStream).toHaveBeenCalled()
				const { inferenceConfig } = mockConverseStream.mock.calls[0][0]
				expect("temperature" in (inferenceConfig ?? {})).toBe(false)
			},
		)

		it("I2 (createMessage): sends an explicit custom temperature of 0", async () => {
			const handler = make({ modelTemperature: 0 })
			await collectStream(handler.createMessage("system", userMessage))
			const { inferenceConfig } = mockConverseStream.mock.calls[0][0]
			expect(inferenceConfig?.temperature).toBe(0)
		})

		it("I3 (createMessage): sends a custom temperature unchanged", async () => {
			const handler = make({ modelTemperature: 0.7 })
			await collectStream(handler.createMessage("system", userMessage))
			const { inferenceConfig } = mockConverseStream.mock.calls[0][0]
			expect(inferenceConfig?.temperature).toBe(0.7)
		})

		it.each([undefined, null])(
			"I1 (completePrompt): omits temperature when custom temperature is %s",
			async (modelTemperature) => {
				const handler = make({ modelTemperature })
				await handler.completePrompt("hello")
				expect(mockConverse).toHaveBeenCalled()
				const { inferenceConfig } = mockConverse.mock.calls[0][0]
				expect("temperature" in (inferenceConfig ?? {})).toBe(false)
			},
		)

		it("I2 (completePrompt): sends an explicit custom temperature of 0", async () => {
			const handler = make({ modelTemperature: 0 })
			await handler.completePrompt("hello")
			const { inferenceConfig } = mockConverse.mock.calls[0][0]
			expect(inferenceConfig?.temperature).toBe(0)
		})

		it("I3 (completePrompt): sends a custom temperature unchanged", async () => {
			const handler = make({ modelTemperature: 0.7 })
			await handler.completePrompt("hello")
			const { inferenceConfig } = mockConverse.mock.calls[0][0]
			expect(inferenceConfig?.temperature).toBe(0.7)
		})

		it("adaptive path (createMessage): omits temperature even when a custom value is set", async () => {
			const handler = make({ apiModelId: "anthropic.claude-opus-4-8", modelTemperature: 0.7 })
			await collectStream(handler.createMessage("system", userMessage))
			const { inferenceConfig } = mockConverseStream.mock.calls[0][0]
			expect("temperature" in (inferenceConfig ?? {})).toBe(false)
		})

		it("adaptive path (completePrompt): omits temperature even when a custom value is set", async () => {
			const handler = make({ apiModelId: "anthropic.claude-opus-4-8", modelTemperature: 0.7 })
			await handler.completePrompt("hello")
			const { inferenceConfig } = mockConverse.mock.calls[0][0]
			expect("temperature" in (inferenceConfig ?? {})).toBe(false)
		})

		it("I2 (getModel): keeps an explicit custom temperature of 0 (no constructor clobber)", () => {
			expect(make({ modelTemperature: 0 }).getModel().temperature).toBe(0)
		})

		it("getModel keeps the service-default hint when unset; requests omit it (#242)", () => {
			// getModel reports the Bedrock service default as a UI/cost hint;
			// the request paths above omit the key when no custom value is set.
			expect(make().getModel().temperature).toBe(BEDROCK_DEFAULT_TEMPERATURE)
		})
	})

	describe("VercelAiGatewayHandler", () => {
		const make = (options: Partial<ApiHandlerOptions> = {}) =>
			new VercelAiGatewayHandler({ vercelAiGatewayApiKey: "test-key", ...options })

		it.each([undefined, null])("I1: omits temperature when custom temperature is %s", async (modelTemperature) => {
			const handler = make({ modelTemperature })
			expect(handler.getModel().id).toBe(vercelAiGatewayDefaultModelId)
			await collectStream(handler.createMessage("system", userMessage))
			expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
		})

		it("I2: sends an explicit custom temperature of 0", async () => {
			await collectStream(make({ modelTemperature: 0 }).createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0)
		})

		it("I3: sends a custom temperature unchanged", async () => {
			await collectStream(make({ modelTemperature: 0.7 }).createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0.7)
		})

		it.each([undefined, null])(
			"I1 (completePrompt): omits temperature when custom temperature is %s",
			async (modelTemperature) => {
				mockCreate.mockResolvedValueOnce(nonStreamingCompletion)
				await make({ modelTemperature }).completePrompt("hello")
				expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
			},
		)
	})

	describe("ZooGatewayHandler", () => {
		const make = (options: Partial<ApiHandlerOptions> = {}) =>
			new ZooGatewayHandler({ zooSessionToken: "zoo_ext_test_token", ...options })

		it.each([undefined, null])("I1: omits temperature when custom temperature is %s", async (modelTemperature) => {
			const handler = make({ modelTemperature })
			expect(handler.getModel().id).toBe(zooGatewayDefaultModelId)
			await collectStream(handler.createMessage("system", userMessage))
			expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
		})

		it("I2: sends an explicit custom temperature of 0", async () => {
			await collectStream(make({ modelTemperature: 0 }).createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0)
		})

		it("I3: sends a custom temperature unchanged", async () => {
			await collectStream(make({ modelTemperature: 0.7 }).createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0.7)
		})

		it.each([undefined, null])(
			"I1 (completePrompt): omits temperature when custom temperature is %s",
			async (modelTemperature) => {
				mockCreate.mockResolvedValueOnce(nonStreamingCompletion)
				await make({ modelTemperature }).completePrompt("hello")
				expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
			},
		)
	})

	describe("KenariHandler", () => {
		const make = (options: Partial<ApiHandlerOptions> = {}) =>
			new KenariHandler({ kenariApiKey: "test-key", ...options })

		it.each([undefined, null])("I1: omits temperature when custom temperature is %s", async (modelTemperature) => {
			const handler = make({ modelTemperature })
			expect(handler.getModel().id).toBe(kenariDefaultModelId)
			await collectStream(handler.createMessage("system", userMessage))
			expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
		})

		it("I2: sends an explicit custom temperature of 0", async () => {
			await collectStream(make({ modelTemperature: 0 }).createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0)
		})

		it("I3: sends a custom temperature unchanged", async () => {
			await collectStream(make({ modelTemperature: 0.7 }).createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0.7)
		})

		it.each([undefined, null])(
			"I1 (completePrompt): omits temperature when custom temperature is %s",
			async (modelTemperature) => {
				mockCreate.mockResolvedValueOnce(nonStreamingCompletion)
				await make({ modelTemperature }).completePrompt("hello")
				expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
			},
		)
	})

	describe("NanoGptHandler", () => {
		const make = (options: Partial<ApiHandlerOptions> = {}) =>
			new NanoGptHandler({ nanoGptModelId: nanoGptDefaultModelId, ...options })

		it.each([undefined, null])("I1: omits temperature when custom temperature is %s", async (modelTemperature) => {
			await collectStream(make({ modelTemperature }).createMessage("system", userMessage))
			expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
		})

		it("I2: sends an explicit custom temperature of 0", async () => {
			await collectStream(make({ modelTemperature: 0 }).createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0)
		})

		it("I3: sends a custom temperature unchanged", async () => {
			await collectStream(make({ modelTemperature: 0.7 }).createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0.7)
		})

		it.each([undefined, null])(
			"I1 (completePrompt): omits temperature when custom temperature is %s",
			async (modelTemperature) => {
				mockCreate.mockResolvedValueOnce(nonStreamingCompletion)
				await make({ modelTemperature }).completePrompt("hello")
				expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
			},
		)
	})

	describe("FriendliHandler", () => {
		const make = (options: Partial<ApiHandlerOptions> = {}) =>
			new FriendliHandler({ friendliApiKey: "test-key", ...options })

		it.each([undefined, null])("I1: omits temperature when custom temperature is %s", async (modelTemperature) => {
			await collectStream(make({ modelTemperature }).createMessage("system", userMessage))
			expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
		})

		it("I2: sends an explicit custom temperature of 0", async () => {
			await collectStream(make({ modelTemperature: 0 }).createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0)
		})

		it("I3: sends a custom temperature unchanged", async () => {
			await collectStream(make({ modelTemperature: 0.7 }).createMessage("system", userMessage))
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0.7)
		})
	})

	describe("ZAiHandler", () => {
		const make = (options: Partial<ApiHandlerOptions> = {}) =>
			new ZAiHandler({ zaiApiKey: "test-key", zaiApiLine: "international_coding", ...options })

		it.each([undefined, null])(
			"I1: omits temperature when custom temperature is %s (non-thinking path)",
			async (modelTemperature) => {
				// glm-4.5 declares no supportsReasoningEffort, so the handler takes the
				// plain delegation path; the glm-4.7 default would route to thinking.
				const handler = make({ apiModelId: "glm-4.5", modelTemperature })
				expect(handler.getModel().id).toBe("glm-4.5")
				await collectStream(handler.createMessage("system", userMessage))
				expect("thinking" in mockCreate.mock.calls[0][0]).toBe(false)
				expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
			},
		)

		it("I2: sends an explicit custom temperature of 0 (non-thinking path)", async () => {
			const handler = make({ apiModelId: "glm-4.5", modelTemperature: 0 })
			expect(handler.getModel().id).toBe("glm-4.5")
			await collectStream(handler.createMessage("system", userMessage))
			expect("thinking" in mockCreate.mock.calls[0][0]).toBe(false)
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0)
		})

		it.each([undefined, null])(
			"I1: omits temperature when custom temperature is %s (thinking path)",
			async (modelTemperature) => {
				await collectStream(
					make({ apiModelId: "glm-5.3", modelTemperature }).createMessage("system", userMessage),
				)
				expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
			},
		)

		it("I3: sends a custom temperature unchanged (thinking path)", async () => {
			await collectStream(
				make({ apiModelId: "glm-5.3", modelTemperature: 0.7 }).createMessage("system", userMessage),
			)
			expect(mockCreate.mock.calls[0][0].temperature).toBe(0.7)
		})

		it.each([undefined, null])(
			"I1 (completePrompt, thinking path): omits temperature when custom temperature is %s",
			async (modelTemperature) => {
				mockCreate.mockResolvedValueOnce(nonStreamingCompletion)
				await make({ apiModelId: "glm-5.3", modelTemperature }).completePrompt("hello")
				expect("temperature" in mockCreate.mock.calls[0][0]).toBe(false)
			},
		)
	})

	describe("GeminiHandler", () => {
		const make = (options: Partial<ApiHandlerOptions> = {}) =>
			new GeminiHandler({
				apiKey: "test-key",
				geminiApiKey: "test-key",
				apiModelId: geminiDefaultModelId,
				...options,
			})

		const installClientMock = (handler: GeminiHandler) => {
			const mockGenerateContentStream = vitest.fn()
			const mockGenerateContent = vitest.fn()
			handler["client"] = {
				models: {
					generateContentStream: mockGenerateContentStream,
					generateContent: mockGenerateContent,
				},
			} as unknown as GoogleGenAI
			mockGenerateContentStream.mockResolvedValue(
				asyncStreamFrom([
					{ text: "Test response" },
					{ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
				]),
			)
			mockGenerateContent.mockResolvedValue({ text: "ok" })
			return { mockGenerateContentStream, mockGenerateContent }
		}

		it.each([undefined, null])("I1: omits temperature when custom temperature is %s", async (modelTemperature) => {
			const handler = make({ modelTemperature })
			const { mockGenerateContentStream } = installClientMock(handler)
			await collectStream(handler.createMessage("system", userMessage))
			const call = mockGenerateContentStream.mock.calls[0][0]
			expect("temperature" in call.config).toBe(false)
		})

		it("I2: sends an explicit custom temperature of 0", async () => {
			const handler = make({ modelTemperature: 0 })
			const { mockGenerateContentStream } = installClientMock(handler)
			await collectStream(handler.createMessage("system", userMessage))
			const call = mockGenerateContentStream.mock.calls[0][0]
			expect(call.config.temperature).toBe(0)
		})

		it("I3: sends a custom temperature unchanged", async () => {
			const handler = make({ modelTemperature: 0.7 })
			const { mockGenerateContentStream } = installClientMock(handler)
			await collectStream(handler.createMessage("system", userMessage))
			const call = mockGenerateContentStream.mock.calls[0][0]
			expect(call.config.temperature).toBe(0.7)
		})

		it.each([undefined, null])(
			"I1 (completePrompt): omits temperature when custom temperature is %s",
			async (modelTemperature) => {
				const handler = make({ modelTemperature })
				const { mockGenerateContent } = installClientMock(handler)
				await handler.completePrompt("hello")
				const call = mockGenerateContent.mock.calls[0][0]
				expect("temperature" in call.config).toBe(false)
			},
		)

		it("I3 (completePrompt): sends a custom temperature unchanged", async () => {
			const handler = make({ modelTemperature: 0.7 })
			const { mockGenerateContent } = installClientMock(handler)
			await handler.completePrompt("hello")
			const call = mockGenerateContent.mock.calls[0][0]
			expect(call.config.temperature).toBe(0.7)
		})
	})
})
