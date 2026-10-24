import {
	azureOpenAiDefaultApiVersion,
	getAzureOpenAiBaseUrl,
	getAzureOpenAiChatCompletionsUrl,
} from "../providers/openai.js"

describe("Azure OpenAI URLs", () => {
	it.each([
		["https://resource.openai.azure.com", "https://resource.openai.azure.com/openai"],
		["https://resource.openai.azure.com/", "https://resource.openai.azure.com/openai"],
		["https://resource.openai.azure.com/openai", "https://resource.openai.azure.com/openai"],
		["https://resource.openai.azure.com/OpenAI/", "https://resource.openai.azure.com/openai"],
		["https://models.example.com/azure/", "https://models.example.com/azure/openai"],
	])("normalizes %s to the /openai root", (baseUrl, expected) => {
		expect(getAzureOpenAiBaseUrl(baseUrl)).toBe(expected)
	})

	it.each([
		{
			apiVersion: "2025-01-01-preview",
			expected:
				"https://resource.openai.azure.com/openai/deployments/brotherhood/chat/completions?api-version=2025-01-01-preview",
		},
		{
			apiVersion: undefined,
			expected: `https://resource.openai.azure.com/openai/deployments/brotherhood/chat/completions?api-version=${azureOpenAiDefaultApiVersion}`,
		},
		{
			apiVersion: "",
			expected: `https://resource.openai.azure.com/openai/deployments/brotherhood/chat/completions?api-version=${azureOpenAiDefaultApiVersion}`,
		},
	])("builds the deployment chat completions URL for API version $apiVersion", ({ apiVersion, expected }) => {
		expect(getAzureOpenAiChatCompletionsUrl("https://resource.openai.azure.com/", "brotherhood", apiVersion)).toBe(
			expected,
		)
	})
})
