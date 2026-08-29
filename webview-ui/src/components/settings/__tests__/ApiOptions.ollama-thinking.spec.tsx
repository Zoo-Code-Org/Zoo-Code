// npx vitest src/components/settings/__tests__/ApiOptions.ollama-thinking.spec.tsx

import { render, screen } from "@/utils/test-utils"
import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"
import type { ChangeEventHandler, InputHTMLAttributes, ReactNode } from "react"

import type { useOpenRouterModelProviders } from "@src/components/ui/hooks/useOpenRouterModelProviders"

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
// Sentinel (not null) so tests can assert whether the generic ThinkingBudget renders.
vi.mock("../ThinkingBudget", () => ({ ThinkingBudget: () => <div data-testid="thinking-budget" /> }))
vi.mock("../Verbosity", () => ({ Verbosity: () => null }))
vi.mock("../TodoListSettingsControl", () => ({ TodoListSettingsControl: () => null }))
vi.mock("../TemperatureControl", () => ({ TemperatureControl: () => null }))
vi.mock("../RateLimitSecondsControl", () => ({ RateLimitSecondsControl: () => null }))
vi.mock("../ConsecutiveMistakeLimitControl", () => ({ ConsecutiveMistakeLimitControl: () => null }))

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

describe("ApiOptions reasoning effort placement", () => {
	beforeEach(() => {
		useSelectedModelMock.mockImplementation((configuration: ProviderSettings) => ({
			provider: configuration.apiProvider,
			id: configuration.apiModelId,
			info: {},
		}))
	})

	it("does not render the generic ThinkingBudget for Ollama", () => {
		// Ollama renders its own reasoning-effort control inside the provider
		// component (gated by its "Enable thinking" checkbox), so the generic one
		// must be skipped to avoid the duplicated "Model Reasoning Effort" selector.
		renderApiOptions({
			apiConfiguration: {
				apiProvider: providerIdentifiers.ollama,
				ollamaModelId: "qwen3",
				enableReasoningEffort: true,
				reasoningEffort: "medium",
			},
		})

		expect(screen.getByTestId("provider-ollama")).toBeInTheDocument()
		expect(screen.queryByTestId("thinking-budget")).not.toBeInTheDocument()
	})

	it("renders the generic ThinkingBudget for non-Ollama providers", () => {
		renderApiOptions({ apiConfiguration: { apiProvider: providerIdentifiers.anthropic } })

		expect(screen.getByTestId("thinking-budget")).toBeInTheDocument()
	})
})
