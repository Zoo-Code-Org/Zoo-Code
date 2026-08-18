import {
	OllamaModelsMessageType,
	ollamaModelsMessageTypeSchema,
	ollamaModelsMessageTypes,
} from "../providers/ollama.js"
import { OpenAiModelsMessageType, openAiModelsMessageTypeSchema } from "../providers/openai.js"
import { LmStudioModelsMessageType, lmStudioModelsMessageTypeSchema } from "../providers/lm-studio.js"
import { VsCodeLmModelsMessageType, vsCodeLmModelsMessageTypeSchema } from "../providers/vscode-llm.js"

describe("OllamaModelsMessageType", () => {
	it("exposes the request and response message types", () => {
		expect(ollamaModelsMessageTypes).toEqual(["requestOllamaModels", "ollamaModels"])
		expect(OllamaModelsMessageType.requestOllamaModels).toBe("requestOllamaModels")
		expect(OllamaModelsMessageType.ollamaModels).toBe("ollamaModels")
	})

	it("validates supported message types", () => {
		expect(ollamaModelsMessageTypeSchema.safeParse("requestOllamaModels").success).toBe(true)
		expect(ollamaModelsMessageTypeSchema.safeParse("ollamaModels").success).toBe(true)
		expect(ollamaModelsMessageTypeSchema.safeParse("requestUnknownModels").success).toBe(false)
	})
})

describe.each([
	["OpenAI", OpenAiModelsMessageType, openAiModelsMessageTypeSchema, "requestOpenAiModels", "openAiModels"],
	[
		"LM Studio",
		LmStudioModelsMessageType,
		lmStudioModelsMessageTypeSchema,
		"requestLmStudioModels",
		"lmStudioModels",
	],
	[
		"VS Code LM",
		VsCodeLmModelsMessageType,
		vsCodeLmModelsMessageTypeSchema,
		"requestVsCodeLmModels",
		"vsCodeLmModels",
	],
])("%s model message types", (_provider, messageType, schema, requestType, responseType) => {
	it("exposes and validates its request and response types", () => {
		expect(messageType).toMatchObject({ [requestType]: requestType, [responseType]: responseType })
		expect(schema.safeParse(requestType).success).toBe(true)
		expect(schema.safeParse(responseType).success).toBe(true)
		expect(schema.safeParse("unknownModelsMessage").success).toBe(false)
	})
})
