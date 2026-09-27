import { act, fireEvent, render, screen, within } from "@/utils/test-utils"
import { bedrockDefaultModelId, providerIdentifiers, type ProviderSettings } from "@roo-code/types"
import type { ChangeEventHandler, InputHTMLAttributes, ReactNode } from "react"

import { requestLmStudioModels } from "@src/components/ui/hooks/useLmStudioModels"
import type { useOpenRouterModelProviders } from "@src/components/ui/hooks/useOpenRouterModelProviders"
import { vscode } from "@src/utils/vscode"

import ApiOptions, { type ApiOptionsProps } from "../ApiOptions"

type OpenRouterModelProvidersQueryResult = Pick<ReturnType<typeof useOpenRouterModelProviders>, "data">

type ChildrenProps = { children?: ReactNode }

type VSCodeTextFieldMockProps = ChildrenProps &
	Pick<InputHTMLAttributes<HTMLInputElement>, "value" | "placeholder"> & {
		onInput?: ChangeEventHandler<HTMLInputElement>
	}

type SearchableSelectMockProps = {
	value?: string
	onValueChange: (value: string) => void
	options: Array<{ value: string; label: string }>
	"data-testid"?: string
}

type SelectMockProps = ChildrenProps & {
	value?: string
	onValueChange?: (value: string) => void
}

type UseSelectedModelReturn = { provider?: string; id?: string; info: Record<string, never> }

const { useOpenRouterModelProvidersMock, useSelectedModelMock } = vi.hoisted(() => ({
	useOpenRouterModelProvidersMock: vi.fn<() => OpenRouterModelProvidersQueryResult>(() => ({ data: undefined })),
	useSelectedModelMock: vi.fn(
		(configuration: ProviderSettings): UseSelectedModelReturn => ({
			provider: configuration.apiProvider,
			id: configuration.apiModelId,
			info: {},
		}),
	),
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		organizationAllowList: { allowAll: true, providers: {} },
		openAiCodexIsAuthenticated: false,
		kimiCodeIsAuthenticated: false,
		kimiCodeOAuthState: undefined,
	}),
}))

vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: () => ({ data: {}, refetch: vi.fn() }),
}))

vi.mock("@src/components/ui/hooks/useZooGatewayRouterModelsSync", () => ({
	useZooGatewayRouterModelsSync: vi.fn(),
}))

vi.mock("@src/components/ui/hooks/useOpenRouterModelProviders", () => ({
	useOpenRouterModelProviders: useOpenRouterModelProvidersMock,
	OPENROUTER_DEFAULT_PROVIDER_NAME: "Auto",
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: useSelectedModelMock,
}))

vi.mock("@src/components/ui/hooks/useLmStudioModels", () => ({
	requestLmStudioModels: vi.fn(),
}))

vi.mock("../providers", () => {
	const provider = (testId: string) => () => <div data-testid={testId} />
	return {
		Anthropic: provider("provider-anthropic"),
		Baseten: provider("provider-baseten"),
		Bedrock: provider("provider-bedrock"),
		DeepSeek: provider("provider-deepseek"),
		Gemini: provider("provider-gemini"),
		LMStudio: provider("provider-lmstudio"),
		LiteLLM: provider("provider-litellm"),
		Mistral: provider("provider-mistral"),
		Moonshot: provider("provider-moonshot"),
		KimiCode: provider("provider-kimi-code"),
		Ollama: provider("provider-ollama"),
		OpenAI: provider("provider-openai-native"),
		OpenAICompatible: provider("provider-openai"),
		OpenAICodex: provider("provider-openai-codex"),
		OpenRouter: provider("provider-openrouter"),
		Poe: provider("provider-poe"),
		QwenCode: provider("provider-qwen-code"),
		Requesty: provider("provider-requesty"),
		SambaNova: provider("provider-sambanova"),
		Unbound: provider("provider-unbound"),
		Vertex: provider("provider-vertex"),
		VSCodeLM: provider("provider-vscode-lm"),
		XAI: provider("provider-xai"),
		ZAi: provider("provider-zai"),
		Fireworks: provider("provider-fireworks"),
		Friendli: provider("provider-friendli"),
		VercelAiGateway: provider("provider-vercel-ai-gateway"),
		OpenCodeGo: provider("provider-opencode-go"),
		Kenari: provider("provider-kenari"),
		NanoGPT: provider("provider-nanogpt"),
		ZooGateway: provider("provider-zoo-gateway"),
		MiniMax: provider("provider-minimax"),
		Mimo: provider("provider-mimo"),
	}
})

vi.mock("../providers/BedrockCustomArn", () => ({
	BedrockCustomArn: () => <div data-testid="bedrock-custom-arn" />,
}))
vi.mock("../ModelPicker", () => ({ ModelPicker: () => null }))
vi.mock("../ApiErrorMessage", () => ({
	ApiErrorMessage: ({ errorMessage }: { errorMessage: string }) => <div>{String(errorMessage)}</div>,
}))
vi.mock("../ThinkingBudget", () => ({ ThinkingBudget: () => null }))
vi.mock("../Verbosity", () => ({ Verbosity: () => null }))
vi.mock("../TodoListSettingsControl", () => ({ TodoListSettingsControl: () => null }))
vi.mock("../TemperatureControl", () => ({ TemperatureControl: () => null }))
vi.mock("../RateLimitSecondsControl", () => ({ RateLimitSecondsControl: () => null }))
vi.mock("../ConsecutiveMistakeLimitControl", () => ({
	ConsecutiveMistakeLimitControl: ({ value, onChange }: { value: number; onChange: (value: number) => void }) => (
		<div data-testid="consecutive-mistake-limit-control">
			<input type="range" value={value} onChange={(event) => onChange(Number(event.target.value))} />
		</div>
	),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, placeholder }: VSCodeTextFieldMockProps) => (
		<label>
			{children}
			<input value={value} placeholder={placeholder} onChange={onInput} />
		</label>
	),
	VSCodeLink: ({ children }: ChildrenProps) => <span>{children}</span>,
}))

vi.mock("@/components/ui", () => ({
	SearchableSelect: ({ value, onValueChange, options, "data-testid": testId }: SearchableSelectMockProps) => (
		<div data-testid={testId}>
			<select value={value} onChange={(event) => onValueChange(event.target.value)}>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</div>
	),
	Collapsible: ({ children }: ChildrenProps) => <div>{children}</div>,
	CollapsibleTrigger: ({ children }: ChildrenProps) => <div>{children}</div>,
	CollapsibleContent: ({ children }: ChildrenProps) => <div>{children}</div>,
	Select: ({ value, onValueChange, children }: SelectMockProps) => (
		<select data-testid="routing-select" value={value} onChange={(event) => onValueChange?.(event.target.value)}>
			{children}
		</select>
	),
	SelectTrigger: ({ children }: ChildrenProps) => <>{children}</>,
	SelectValue: () => null,
	SelectContent: ({ children }: ChildrenProps) => <>{children}</>,
	SelectItem: ({ value, children }: { value?: string; children?: ReactNode }) => (
		<option value={value}>{children}</option>
	),
}))

const renderApiOptions = (props: Partial<ApiOptionsProps> = {}) =>
	render(
		<ApiOptions
			errorMessage={undefined}
			setErrorMessage={() => undefined}
			uriScheme={undefined}
			apiConfiguration={{}}
			setApiConfigurationField={() => undefined}
			{...props}
		/>,
	)

describe("ApiOptions interactions", () => {
	beforeEach(() => {
		useSelectedModelMock.mockImplementation((configuration: ProviderSettings) => ({
			provider: configuration.apiProvider,
			id: configuration.apiModelId,
			info: {},
		}))
		useOpenRouterModelProvidersMock.mockImplementation(() => ({ data: undefined }))
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	describe("debounced provider model refresh", () => {
		it.each([
			{
				provider: providerIdentifiers.openai,
				configuration: {
					openAiBaseUrl: "https://openai.example/v1",
					openAiApiKey: "openai-key",
					openAiHeaders: { "X-Custom": "header-value" },
				},
				expectedMessage: {
					type: "requestOpenAiModels",
					values: {
						baseUrl: "https://openai.example/v1",
						apiKey: "openai-key",
						customHeaders: {},
						openAiHeaders: { "X-Custom": "header-value" },
					},
				},
			},
			{
				provider: providerIdentifiers.ollama,
				configuration: { ollamaBaseUrl: "http://ollama:11434", ollamaApiKey: "ollama-key" },
				expectedMessage: {
					type: "requestOllamaModels",
					values: { baseUrl: "http://ollama:11434", apiKey: "ollama-key" },
				},
			},
			{
				provider: providerIdentifiers.vscodeLm,
				configuration: {},
				expectedMessage: { type: "requestVsCodeLmModels" },
			},
			{
				provider: providerIdentifiers.litellm,
				configuration: { litellmBaseUrl: "http://litellm:4000", litellmApiKey: "litellm-key" },
				expectedMessage: {
					type: "requestRouterModels",
					values: {
						provider: providerIdentifiers.litellm,
						litellmApiKey: "litellm-key",
						litellmBaseUrl: "http://litellm:4000",
					},
				},
			},
			{
				provider: providerIdentifiers.poe,
				configuration: { poeApiKey: "poe-key", poeBaseUrl: "https://api.poe.example/v1" },
				expectedMessage: {
					type: "requestRouterModels",
					values: { provider: providerIdentifiers.poe },
				},
			},
		])("requests models for $provider", ({ provider, configuration, expectedMessage }) => {
			vi.useFakeTimers()
			const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)

			renderApiOptions({ apiConfiguration: { apiProvider: provider, ...configuration } })
			act(() => vi.advanceTimersByTime(249))
			expect(postMessage).not.toHaveBeenCalledWith(expectedMessage)

			act(() => vi.advanceTimersByTime(1))
			expect(postMessage).toHaveBeenCalledTimes(1)
			expect(postMessage).toHaveBeenCalledWith(expectedMessage)
		})

		it("applies the header transform when requesting OpenAI models", () => {
			vi.useFakeTimers()
			const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)

			renderApiOptions({
				apiConfiguration: {
					apiProvider: providerIdentifiers.openai,
					openAiBaseUrl: "https://openai.example/v1",
					openAiApiKey: "openai-key",
					openAiHeaders: { "": "ignored", "X-Keep": " kept" },
				},
			})
			act(() => vi.advanceTimersByTime(250))

			expect(postMessage).toHaveBeenCalledWith({
				type: "requestOpenAiModels",
				values: {
					baseUrl: "https://openai.example/v1",
					apiKey: "openai-key",
					customHeaders: {},
					openAiHeaders: { "X-Keep": "kept" },
				},
			})
		})

		it("syncs processed custom headers into the configuration", () => {
			vi.useFakeTimers()
			const setApiConfigurationField = vi.fn()

			// The empty header key is dropped by convertHeadersToObject, so the
			// processed object differs from the stored one and the sync fires.
			renderApiOptions({
				apiConfiguration: { apiProvider: providerIdentifiers.openai, openAiHeaders: { "": "ignored" } },
				setApiConfigurationField,
			})
			act(() => vi.advanceTimersByTime(300))

			expect(setApiConfigurationField).toHaveBeenCalledWith("openAiHeaders", {}, false)
		})

		it("requests LM Studio models using its configured base URL", () => {
			vi.useFakeTimers()
			renderApiOptions({
				apiConfiguration: {
					apiProvider: providerIdentifiers.lmstudio,
					lmStudioBaseUrl: "http://lmstudio:1234",
				},
			})

			act(() => vi.advanceTimersByTime(249))
			expect(requestLmStudioModels).not.toHaveBeenCalledWith("http://lmstudio:1234")

			act(() => vi.advanceTimersByTime(1))
			expect(requestLmStudioModels).toHaveBeenCalledTimes(1)
			expect(requestLmStudioModels).toHaveBeenCalledWith("http://lmstudio:1234")
		})

		it("does not request dynamic models for a static provider", () => {
			vi.useFakeTimers()
			const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)

			renderApiOptions({ apiConfiguration: { apiProvider: providerIdentifiers.anthropic } })
			act(() => vi.advanceTimersByTime(250))

			expect(postMessage).not.toHaveBeenCalled()
		})
	})

	it.each([
		providerIdentifiers.openrouter,
		providerIdentifiers.requesty,
		providerIdentifiers.unbound,
		providerIdentifiers.anthropic,
		providerIdentifiers.openaiCodex,
		providerIdentifiers.openaiNative,
		providerIdentifiers.mistral,
		providerIdentifiers.baseten,
		providerIdentifiers.bedrock,
		providerIdentifiers.vertex,
		providerIdentifiers.gemini,
		providerIdentifiers.openai,
		providerIdentifiers.lmstudio,
		providerIdentifiers.deepseek,
		providerIdentifiers.qwenCode,
		providerIdentifiers.moonshot,
		providerIdentifiers.kimiCode,
		providerIdentifiers.minimax,
		providerIdentifiers.mimo,
		providerIdentifiers.vscodeLm,
		providerIdentifiers.ollama,
		providerIdentifiers.xai,
		providerIdentifiers.litellm,
		providerIdentifiers.sambanova,
		providerIdentifiers.zai,
		providerIdentifiers.vercelAiGateway,
		providerIdentifiers.opencodeGo,
		providerIdentifiers.kenari,
		providerIdentifiers.nanogpt,
		providerIdentifiers.zooGateway,
		providerIdentifiers.fireworks,
		providerIdentifiers.friendli,
		providerIdentifiers.poe,
	])("renders the %s provider branch when selected", (apiProvider) => {
		renderApiOptions({ apiConfiguration: { apiProvider } })

		expect(screen.getByTestId(`provider-${apiProvider}`)).toBeInTheDocument()
	})

	it("clears parent validation errors for Zoo Gateway", () => {
		const setErrorMessage = vi.fn()
		renderApiOptions({ apiConfiguration: { apiProvider: providerIdentifiers.zooGateway }, setErrorMessage })

		expect(setErrorMessage).toHaveBeenCalledWith(undefined)
	})

	it("reports a validation error for a non-gateway provider with missing credentials", () => {
		const setErrorMessage = vi.fn()
		renderApiOptions({ apiConfiguration: { apiProvider: providerIdentifiers.anthropic }, setErrorMessage })

		expect(setErrorMessage).toHaveBeenCalled()
		expect(setErrorMessage.mock.calls[0][0]).toBeTruthy()
	})

	it("renders the current validation error message", () => {
		renderApiOptions({
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic },
			errorMessage: "settings:validation.apiKey",
		})

		expect(screen.getByText("settings:validation.apiKey")).toBeInTheDocument()
	})

	it("renders OpenRouter provider routing when provider metadata is available", () => {
		useOpenRouterModelProvidersMock.mockReturnValue({
			data: { preferred: { label: "Preferred", contextWindow: 1, supportsPromptCache: false } },
		})

		renderApiOptions({
			apiConfiguration: {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "anthropic/claude-sonnet-4.5",
			},
		})

		expect(screen.getByText("settings:providers.openRouter.providerRouting.title")).toBeInTheDocument()
	})

	it("updates the OpenRouter specific provider from the routing control", () => {
		useOpenRouterModelProvidersMock.mockReturnValue({
			data: { preferred: { label: "Preferred", contextWindow: 1, supportsPromptCache: false } },
		})
		const setApiConfigurationField = vi.fn()

		renderApiOptions({
			apiConfiguration: {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "anthropic/claude-sonnet-4.5",
			},
			setApiConfigurationField,
		})

		fireEvent.change(screen.getByTestId("routing-select"), { target: { value: "preferred" } })
		expect(setApiConfigurationField).toHaveBeenCalledWith("openRouterSpecificProvider", "preferred")
	})

	it("hides OpenRouter provider routing when no provider metadata is available", () => {
		useOpenRouterModelProvidersMock.mockReturnValue({ data: {} })

		renderApiOptions({
			apiConfiguration: {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "anthropic/claude-sonnet-4.5",
			},
		})

		expect(screen.queryByTestId("routing-select")).not.toBeInTheDocument()
	})

	it("preserves the Bedrock custom ARN pseudo-model when switching to Bedrock", () => {
		const setApiConfigurationField = vi.fn()
		renderApiOptions({
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiModelId: "custom-arn" },
			setApiConfigurationField,
		})

		const providerSelect = screen.getByTestId("provider-select").querySelector("select") as HTMLSelectElement
		fireEvent.change(providerSelect, { target: { value: providerIdentifiers.bedrock } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("apiProvider", providerIdentifiers.bedrock)
		expect(setApiConfigurationField.mock.calls.filter(([field]) => field === "apiModelId")).toEqual([])
	})

	it("resets an invalid ordinary model to the Bedrock default when switching providers", () => {
		const setApiConfigurationField = vi.fn()
		renderApiOptions({
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiModelId: "not-a-bedrock-model" },
			setApiConfigurationField,
		})

		const providerSelect = screen.getByTestId("provider-select").querySelector("select") as HTMLSelectElement
		fireEvent.change(providerSelect, { target: { value: providerIdentifiers.bedrock } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("apiProvider", providerIdentifiers.bedrock)
		expect(setApiConfigurationField).toHaveBeenCalledWith("apiModelId", bedrockDefaultModelId, false)
	})

	it("renders the custom ARN settings only for Bedrock's custom ARN pseudo-model", () => {
		const { rerender } = render(
			<ApiOptions
				errorMessage={undefined}
				setErrorMessage={() => undefined}
				uriScheme={undefined}
				apiConfiguration={{ apiProvider: providerIdentifiers.bedrock, apiModelId: "custom-arn" }}
				setApiConfigurationField={() => undefined}
			/>,
		)

		expect(screen.getByTestId("bedrock-custom-arn")).toBeInTheDocument()

		rerender(
			<ApiOptions
				errorMessage={undefined}
				setErrorMessage={() => undefined}
				uriScheme={undefined}
				apiConfiguration={{ apiProvider: providerIdentifiers.bedrock, apiModelId: bedrockDefaultModelId }}
				setApiConfigurationField={() => undefined}
			/>,
		)

		expect(screen.queryByTestId("bedrock-custom-arn")).not.toBeInTheDocument()
	})

	it("syncs the selected model into the config when the model id differs", () => {
		useSelectedModelMock.mockReturnValue({ provider: providerIdentifiers.anthropic, id: "claude-sonnet", info: {} })
		const setApiConfigurationField = vi.fn()

		renderApiOptions({
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiModelId: "old-model" },
			setApiConfigurationField,
		})

		expect(setApiConfigurationField).toHaveBeenCalledWith("apiModelId", "claude-sonnet", false)
	})

	it("updates the consecutive mistake limit from advanced settings", () => {
		const setApiConfigurationField = vi.fn()
		renderApiOptions({ apiConfiguration: {}, setApiConfigurationField })

		fireEvent.change(within(screen.getByTestId("consecutive-mistake-limit-control")).getByRole("slider"), {
			target: { value: "7" },
		})

		expect(setApiConfigurationField).toHaveBeenCalledWith("consecutiveMistakeLimit", 7)
	})

	it("renders and updates the Poe base URL in advanced settings", () => {
		const setApiConfigurationField = vi.fn()
		renderApiOptions({
			apiConfiguration: { apiProvider: providerIdentifiers.poe, poeBaseUrl: "https://api.poe.example/v1" },
			setApiConfigurationField,
		})

		const poeBaseUrl = screen.getByPlaceholderText("https://api.poe.com/v1")
		expect(poeBaseUrl).toHaveValue("https://api.poe.example/v1")

		fireEvent.change(poeBaseUrl, { target: { value: "https://new.poe.example/v1" } })
		expect(setApiConfigurationField).toHaveBeenCalledWith("poeBaseUrl", "https://new.poe.example/v1")
	})
})
