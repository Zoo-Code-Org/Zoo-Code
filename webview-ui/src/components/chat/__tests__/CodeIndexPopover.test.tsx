import React from "react"

import type { EmbedderProvider, ExtensionState } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types"

import { fireEvent, renderWithExtensionState, screen } from "@/utils/test-utils"
import { useOpenRouterModelProviders } from "@src/components/ui/hooks/useOpenRouterModelProviders"

import { CodeIndexPopover, createValidationSchema } from "../CodeIndexPopover"

vi.mock("@src/components/ui/hooks/useOpenRouterModelProviders", () => ({
	OPENROUTER_DEFAULT_PROVIDER_NAME: "Auto",
	useOpenRouterModelProviders: vi.fn(() => ({ data: undefined })),
}))

vi.mock("@src/components/ui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@src/components/ui")>()
	return {
		...actual,
		Popover: ({ children, onOpenChange }: React.PropsWithChildren<{ onOpenChange?: (open: boolean) => void }>) => {
			React.useEffect(() => onOpenChange?.(true), [onOpenChange])
			return <>{children}</>
		},
		PopoverContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
		Select: ({
			children,
			value,
			onValueChange,
		}: React.PropsWithChildren<{
			value?: string
			onValueChange?: (value: string) => void
		}>) => (
			<select value={value} onChange={(event) => onValueChange?.(event.target.value)}>
				{children}
			</select>
		),
		SelectTrigger: () => null,
		SelectValue: () => null,
		SelectContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
		SelectItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => (
			<option value={value}>{children}</option>
		),
	}
})

const indexingStatus = {
	systemStatus: "Standby" as const,
	message: "",
	processedItems: 0,
	totalItems: 0,
	currentItemUnit: "items",
}

const baseSettings = {
	codebaseIndexEnabled: true,
	codebaseIndexQdrantUrl: "http://localhost:6333",
	codebaseIndexEmbedderModelId: "embedding-model",
}

const translate = (key: string) => key

describe("CodeIndexPopover validation", () => {
	it.each([
		{
			provider: providerIdentifiers.openai,
			requiredField: "codeIndexOpenAiKey",
			settings: { codeIndexOpenAiKey: "openai-key" },
		},
		{
			provider: providerIdentifiers.ollama,
			requiredField: "codebaseIndexEmbedderBaseUrl",
			settings: { codebaseIndexEmbedderBaseUrl: "http://localhost:11434" },
		},
		{
			provider: providerIdentifiers.gemini,
			requiredField: "codebaseIndexGeminiApiKey",
			settings: { codebaseIndexGeminiApiKey: "gemini-key" },
		},
		{
			provider: providerIdentifiers.mistral,
			requiredField: "codebaseIndexMistralApiKey",
			settings: { codebaseIndexMistralApiKey: "mistral-key" },
		},
		{
			provider: providerIdentifiers.vercelAiGateway,
			requiredField: "codebaseIndexVercelAiGatewayApiKey",
			settings: { codebaseIndexVercelAiGatewayApiKey: "gateway-key" },
		},
		{
			provider: providerIdentifiers.bedrock,
			requiredField: "codebaseIndexBedrockRegion",
			settings: { codebaseIndexBedrockRegion: "us-east-1" },
		},
		{
			provider: providerIdentifiers.openrouter,
			requiredField: "codebaseIndexOpenRouterApiKey",
			settings: { codebaseIndexOpenRouterApiKey: "openrouter-key" },
		},
	])("requires provider-specific configuration for $provider", ({ provider, requiredField, settings }) => {
		const schema = createValidationSchema(provider, translate)
		const validSettings = { ...baseSettings, ...settings }

		expect(schema.safeParse(validSettings).success).toBe(true)

		const invalidSettings = { ...validSettings, [requiredField]: "" }
		const result = schema.safeParse(invalidSettings)
		expect(result.success).toBe(false)
		if (!result.success) {
			expect(result.error.issues).toEqual(
				expect.arrayContaining([expect.objectContaining({ path: [requiredField] })]),
			)
		}
	})
})

describe("CodeIndexPopover OpenRouter provider lookup", () => {
	const mockedUseOpenRouterModelProviders = vi.mocked(useOpenRouterModelProviders)

	const renderPopover = (
		provider: EmbedderProvider,
		modelId: string,
		apiProvider?: ExtensionState["apiConfiguration"],
	) =>
		renderWithExtensionState(
			<CodeIndexPopover indexingStatus={indexingStatus}>
				<button>Open code index settings</button>
			</CodeIndexPopover>,
			{
				state: {
					codebaseIndexConfig: {
						...baseSettings,
						codebaseIndexEmbedderProvider: provider,
						codebaseIndexEmbedderModelId: modelId,
					},
					codebaseIndexModels: {},
					apiConfiguration: apiProvider,
					platform: "darwin",
					arch: "arm64",
				} as Partial<ExtensionState>,
			},
		)

	beforeEach(() => {
		mockedUseOpenRouterModelProviders.mockClear()
	})

	it("disables provider lookup for a non-OpenRouter embedder", () => {
		renderPopover(providerIdentifiers.openai, "text-embedding-3-small")

		expect(mockedUseOpenRouterModelProviders).toHaveBeenLastCalledWith(undefined, undefined, { enabled: false })
	})

	it("waits for an OpenRouter model selection before enabling lookup", () => {
		renderPopover(providerIdentifiers.openrouter, "")

		expect(mockedUseOpenRouterModelProviders).toHaveBeenLastCalledWith("", undefined, { enabled: false })
	})

	it("loads providers for the selected OpenRouter embedding model", () => {
		renderPopover(providerIdentifiers.openrouter, "openai/text-embedding-3-small")

		expect(mockedUseOpenRouterModelProviders).toHaveBeenLastCalledWith("openai/text-embedding-3-small", undefined, {
			enabled: true,
		})
	})

	it.each([
		{ provider: providerIdentifiers.openai, label: "settings:codeIndex.openAiKeyLabel" },
		{ provider: providerIdentifiers.ollama, label: "settings:codeIndex.ollamaBaseUrlLabel" },
		{ provider: providerIdentifiers.gemini, label: "settings:codeIndex.geminiApiKeyLabel" },
		{ provider: providerIdentifiers.mistral, label: "settings:codeIndex.mistralApiKeyLabel" },
		{
			provider: providerIdentifiers.vercelAiGateway,
			label: "settings:codeIndex.vercelAiGatewayApiKeyLabel",
		},
		{ provider: providerIdentifiers.bedrock, label: "settings:codeIndex.bedrockRegionLabel" },
		{ provider: providerIdentifiers.openrouter, label: "settings:codeIndex.openRouterApiKeyLabel" },
	] as const)("renders the $provider provider settings when the setup section opens", ({ provider, label }) => {
		renderPopover(provider, "embedding-model")
		fireEvent.click(screen.getByText("settings:codeIndex.setupConfigLabel"))

		expect(screen.getByText(label)).toBeInTheDocument()
	})

	it.each([
		{
			name: "matching Bedrock API provider",
			apiConfiguration: {
				apiProvider: providerIdentifiers.bedrock,
				awsRegion: "us-west-2",
				awsProfile: "development",
			},
			expectedRegion: "us-west-2",
			expectedProfile: "development",
		},
		{
			name: "mismatched API provider",
			apiConfiguration: {
				apiProvider: providerIdentifiers.anthropic,
				awsRegion: "us-west-2",
				awsProfile: "development",
			},
			expectedRegion: "",
			expectedProfile: "",
		},
		{
			name: "unset API provider",
			apiConfiguration: undefined,
			expectedRegion: "",
			expectedProfile: "",
		},
	] as const)("populates Bedrock fields for $name", ({ apiConfiguration, expectedRegion, expectedProfile }) => {
		renderPopover(providerIdentifiers.openai, "embedding-model", apiConfiguration)
		fireEvent.click(screen.getByText("settings:codeIndex.setupConfigLabel"))

		fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: providerIdentifiers.bedrock } })

		expect(screen.getByPlaceholderText("settings:codeIndex.bedrockRegionPlaceholder")).toHaveValue(expectedRegion)
		expect(screen.getByPlaceholderText("settings:codeIndex.bedrockProfilePlaceholder")).toHaveValue(expectedProfile)
	})
})
