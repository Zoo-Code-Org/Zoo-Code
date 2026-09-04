import { render, screen } from "@/utils/test-utils"
import { providerIdentifiers } from "@roo-code/types"

import ApiOptions from "../ApiOptions"

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
	useOpenRouterModelProviders: () => ({ data: undefined }),
	OPENROUTER_DEFAULT_PROVIDER_NAME: "Auto",
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: (configuration: { apiProvider?: string; apiModelId?: string }) => ({
		provider: configuration.apiProvider,
		id: configuration.apiModelId,
		info: {},
	}),
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
		NeuronPool: provider("provider-neuronpool"),
		VercelAiGateway: provider("provider-vercel-ai-gateway"),
		OpenCodeGo: provider("provider-opencode-go"),
		Kenari: provider("provider-kenari"),
		NanoGPT: provider("provider-nanogpt"),
		ZooGateway: provider("provider-zoo-gateway"),
		MiniMax: provider("provider-minimax"),
		Mimo: provider("provider-mimo"),
	}
})

vi.mock("../ModelPicker", () => ({ ModelPicker: () => null }))
vi.mock("../ApiErrorMessage", () => ({ ApiErrorMessage: () => null }))
vi.mock("../ThinkingBudget", () => ({ ThinkingBudget: () => null }))
vi.mock("../Verbosity", () => ({ Verbosity: () => null }))
vi.mock("../TodoListSettingsControl", () => ({ TodoListSettingsControl: () => null }))
vi.mock("../TemperatureControl", () => ({ TemperatureControl: () => null }))
vi.mock("../RateLimitSecondsControl", () => ({ RateLimitSecondsControl: () => null }))
vi.mock("../ConsecutiveMistakeLimitControl", () => ({ ConsecutiveMistakeLimitControl: () => null }))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children }: { children?: unknown }) => <label>{children}</label>,
	VSCodeLink: ({ children }: { children?: unknown }) => <span>{children}</span>,
}))

vi.mock("@/components/ui", () => ({
	SearchableSelect: () => <div data-testid="searchable-select" />,
	Collapsible: ({ children }: { children?: unknown }) => <div>{children}</div>,
	CollapsibleTrigger: ({ children }: { children?: unknown }) => <div>{children}</div>,
	CollapsibleContent: ({ children }: { children?: unknown }) => <div>{children}</div>,
	Select: ({ children }: { children?: unknown }) => <div>{children}</div>,
	SelectTrigger: ({ children }: { children?: unknown }) => <div>{children}</div>,
	SelectValue: ({ children }: { children?: unknown }) => <div>{children}</div>,
	SelectContent: ({ children }: { children?: unknown }) => <div>{children}</div>,
	SelectItem: ({ children }: { children?: unknown }) => <div>{children}</div>,
	Button: ({ children }: { children?: unknown }) => <button>{children}</button>,
	StandardTooltip: ({ children }: { children?: unknown }) => <div>{children}</div>,
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

describe("ApiOptions NeuronPool branch", () => {
	it("renders NeuronPool only when that provider is selected", () => {
		const setApiConfigurationField = vi.fn()
		const uriHandler = vi.fn()
		render(
			<ApiOptions
				apiConfiguration={{ apiProvider: providerIdentifiers.friendli }}
				setApiConfigurationField={setApiConfigurationField}
				uriHandler={uriHandler}
			/>,
		)
		expect(screen.getByTestId("provider-friendli")).toBeInTheDocument()
		expect(screen.queryByTestId("provider-neuronpool")).not.toBeInTheDocument()
	})
})
