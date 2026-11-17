import { providerIdentifiers, type ModelInfo, type ProviderSettings } from "@roo-code/types"

import { renderWithExtensionState, screen } from "@/utils/test-utils"
import { defaultModeSlug } from "@roo/modes"
import { ChatTextArea } from "../ChatTextArea"

const mocks = vi.hoisted(() => ({ info: undefined as ModelInfo | undefined }))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ id: "chosen-model", info: mocks.info }),
}))

describe("unified chat model trigger", () => {
	const renderTrigger = (apiConfiguration: ProviderSettings) =>
		renderWithExtensionState(
			<ChatTextArea
				inputValue=""
				setInputValue={vi.fn()}
				sendingDisabled={false}
				selectApiConfigDisabled={false}
				placeholderText="Message"
				selectedImages={[]}
				setSelectedImages={vi.fn()}
				onSend={vi.fn()}
				onSelectImages={vi.fn()}
				shouldDisableImages={false}
				mode={defaultModeSlug}
				setMode={vi.fn()}
				modeShortcutText=""
			/>,
			{
				state: {
					apiConfiguration,
					currentApiConfigName: "Work",
					listApiConfigMeta: [{ id: "work", name: "Work" }],
				},
			},
		)

	it.each([
		{
			name: "required default",
			config: { apiProvider: providerIdentifiers.openaiNative },
			info: { requiredReasoningEffort: true, supportsReasoningEffort: ["low", "high"], reasoningEffort: "high" },
			effort: "high",
		},
		{
			name: "explicit disable",
			config: {
				apiProvider: providerIdentifiers.openaiNative,
				enableReasoningEffort: false,
				reasoningEffort: "high",
			},
			info: { supportsReasoningEffort: true },
			effort: undefined,
		},
		{
			name: "unsupported stale effort",
			config: { apiProvider: providerIdentifiers.openaiNative, reasoningEffort: "high" },
			info: {},
			effort: undefined,
		},
		{
			name: "OpenAI nested effort",
			config: {
				apiProvider: providerIdentifiers.openai,
				enableReasoningEffort: true,
				reasoningEffort: "low",
				openAiCustomModelInfo: { contextWindow: 128000, supportsPromptCache: false, reasoningEffort: "xhigh" },
			},
			info: {},
			effort: "xhigh",
		},
		{
			name: "OpenAI unset enable",
			config: {
				apiProvider: providerIdentifiers.openai,
				openAiCustomModelInfo: { contextWindow: 128000, supportsPromptCache: false, reasoningEffort: "high" },
			},
			info: {},
			effort: undefined,
		},
		{
			name: "enabled none",
			config: { apiProvider: providerIdentifiers.openaiNative, reasoningEffort: "none" },
			info: { supportsReasoningEffort: ["none", "high"] },
			effort: "none",
		},
	] satisfies Array<{
		name: string
		config: ProviderSettings
		info: Partial<ModelInfo>
		effort: string | undefined
	}>)("shows effective badge semantics for $name without a second model picker", ({ config, info, effort }) => {
		mocks.info = { contextWindow: 128000, supportsPromptCache: false, ...info }
		renderTrigger(config)
		const trigger = screen.getByTestId("dropdown-trigger")
		expect(trigger).toHaveTextContent("Work / chosen-model")
		expect(screen.queryByTestId("model-selector-trigger")).not.toBeInTheDocument()
		const badge = trigger.querySelector('[aria-label="chat:modelPicker.reasoningEffortValue"]')
		if (effort) expect(badge).toHaveTextContent(`chat:modelPicker.effort.${effort}`)
		else expect(badge).toBeNull()
	})
})
