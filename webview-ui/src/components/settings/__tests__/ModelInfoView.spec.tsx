import { OpenAiServiceTier, providerIdentifiers, type ModelInfo } from "@roo-code/types"

import { render, screen, within } from "@/utils/test-utils"

import { ModelInfoView } from "../ModelInfoView"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) =>
			({
				"settings:modelInfo.imageSupportUnknown": "Image support not reported",
				"settings:modelInfo.supportsImages": "Supports images",
				"settings:modelInfo.noImages": "Does not support images",
				"settings:modelInfo.noPromptCache": "Does not support prompt caching",
				"settings:modelInfo.promptCacheManagedByCopilot": "Prompt caching managed by GitHub Copilot",
				"settings:serviceTier.pricingTableTitle": "Service tier pricing",
				"settings:serviceTier.columns.tier": "Tier",
				"settings:serviceTier.columns.input": "Input",
				"settings:serviceTier.columns.output": "Output",
				"settings:serviceTier.columns.cacheReads": "Cache reads",
				"settings:serviceTier.standard": "Standard",
				"settings:serviceTier.flex": "Flex",
				"settings:serviceTier.priority": "Priority",
			})[key] ?? key,
	}),
}))

const baseModelInfo: ModelInfo = {
	contextWindow: 128_000,
	supportsPromptCache: true,
	inputPrice: 10,
	outputPrice: 20,
	cacheReadsPrice: 3,
}

const defaultProps = {
	selectedModelId: "gpt-test",
	isDescriptionExpanded: false,
	setIsDescriptionExpanded: vi.fn(),
}

const getPricingRowValues = (tier: string) => {
	const row = screen.getByRole("cell", { name: tier }).closest("tr")
	expect(row).not.toBeNull()
	return within(row!)
		.getAllByRole("cell")
		.map((cell) => cell.textContent)
}

describe("ModelInfoView service tier pricing", () => {
	it("reports prompt caching as unsupported for other providers when the model says nothing about it", () => {
		render(
			<ModelInfoView
				{...defaultProps}
				apiProvider={providerIdentifiers.openai}
				modelInfo={{ contextWindow: 128000 } as ModelInfo}
				hidePricing
			/>,
		)
		expect(screen.getByText("Does not support prompt caching")).toBeInTheDocument()
	})

	it("shows unknown Copilot image capability without claiming the model is text-only", () => {
		render(
			<ModelInfoView
				{...defaultProps}
				apiProvider={providerIdentifiers.githubCopilot}
				modelInfo={{ contextWindow: 128000, supportsPromptCache: false }}
				hidePricing
			/>,
		)
		expect(screen.getByText("Image support not reported")).toBeInTheDocument()
		expect(screen.queryByText("Does not support images")).not.toBeInTheDocument()
		expect(screen.queryByText("Supports images")).not.toBeInTheDocument()
	})

	it("continues to show explicit Copilot image restrictions as unsupported", () => {
		render(
			<ModelInfoView
				{...defaultProps}
				apiProvider={providerIdentifiers.githubCopilot}
				modelInfo={{ contextWindow: 128000, supportsImages: false, supportsPromptCache: false }}
				hidePricing
			/>,
		)
		expect(screen.getByText("Does not support images")).toBeInTheDocument()
		expect(screen.queryByText("Image support not reported")).not.toBeInTheDocument()
	})

	it("shows vision and provider-managed caching for Copilot without claiming caching is unsupported", () => {
		render(
			<ModelInfoView
				{...defaultProps}
				apiProvider={providerIdentifiers.githubCopilot}
				selectedModelId="claude-opus-5.5"
				modelInfo={{ contextWindow: 871793, supportsImages: true, supportsPromptCache: false }}
				hidePricing
			/>,
		)
		expect(screen.getByText("Supports images")).toBeInTheDocument()
		expect(screen.getByText("Prompt caching managed by GitHub Copilot")).toBeInTheDocument()
		expect(screen.getByText("Prompt caching managed by GitHub Copilot")).toHaveAttribute("tabindex", "0")
		expect(screen.queryByText("Does not support prompt caching")).not.toBeInTheDocument()
	})

	it("keeps unsupported caching labels for providers whose models do not support caching", () => {
		render(
			<ModelInfoView
				{...defaultProps}
				apiProvider={providerIdentifiers.ollama}
				modelInfo={{ contextWindow: 32000, supportsImages: false, supportsPromptCache: false }}
				hidePricing
			/>,
		)
		expect(screen.getByText("Does not support images")).toBeInTheDocument()
		expect(screen.getByText("Does not support prompt caching")).toBeInTheDocument()
	})
	it("uses the canonical gemini provider identifier", () => {
		expect(providerIdentifiers.gemini).toBe("gemini")
	})

	it("shows Gemini billing guidance for the canonical Gemini provider", () => {
		render(
			<ModelInfoView
				{...defaultProps}
				apiProvider={providerIdentifiers.gemini}
				selectedModelId="gemini-3-pro-preview"
				modelInfo={baseModelInfo}
			/>,
		)

		expect(screen.getByText("settings:modelInfo.gemini.billingEstimate")).toBeInTheDocument()
	})

	it("shows Gemini free-request guidance for non-pro-preview Gemini models", () => {
		render(
			<ModelInfoView
				{...defaultProps}
				apiProvider={providerIdentifiers.gemini}
				selectedModelId="gemini-3-flash"
				modelInfo={baseModelInfo}
			/>,
		)

		expect(screen.getByText("settings:modelInfo.gemini.freeRequests")).toBeInTheDocument()
	})

	it("does not show Gemini billing guidance for non-Gemini providers", () => {
		render(
			<ModelInfoView
				{...defaultProps}
				apiProvider={providerIdentifiers.openai}
				selectedModelId="gpt-5"
				modelInfo={baseModelInfo}
			/>,
		)

		expect(screen.queryByText("settings:modelInfo.gemini.billingEstimate")).not.toBeInTheDocument()
		expect(screen.queryByText("settings:modelInfo.gemini.freeRequests")).not.toBeInTheDocument()
	})

	it("shows OpenAI Native tier prices with per-field fallback to Standard pricing", () => {
		const modelInfo: ModelInfo = {
			...baseModelInfo,
			tiers: [
				{ name: OpenAiServiceTier.Default, contextWindow: 128_000 },
				{
					name: OpenAiServiceTier.Flex,
					contextWindow: 128_000,
					inputPrice: 4,
					cacheReadsPrice: 1,
				},
				{
					name: OpenAiServiceTier.Priority,
					contextWindow: 128_000,
					outputPrice: 40,
				},
			],
		}

		render(<ModelInfoView {...defaultProps} apiProvider={providerIdentifiers.openaiNative} modelInfo={modelInfo} />)

		expect(screen.getByText("Service tier pricing")).toBeInTheDocument()
		expect(getPricingRowValues("Standard")).toEqual(["Standard", "$10.00", "$20.00", "$3.00"])
		expect(getPricingRowValues("Flex")).toEqual(["Flex", "$4.00", "$20.00", "$1.00"])
		expect(getPricingRowValues("Priority")).toEqual(["Priority", "$10.00", "$40.00", "$3.00"])
	})

	it("only shows the tier pricing table for OpenAI Native models with a non-standard tier", () => {
		const tieredModelInfo: ModelInfo = {
			...baseModelInfo,
			tiers: [{ name: OpenAiServiceTier.Flex, contextWindow: 128_000 }],
		}
		const { rerender } = render(
			<ModelInfoView {...defaultProps} apiProvider="anthropic" modelInfo={tieredModelInfo} />,
		)

		expect(screen.queryByText("Service tier pricing")).not.toBeInTheDocument()

		rerender(
			<ModelInfoView
				{...defaultProps}
				apiProvider={providerIdentifiers.openaiNative}
				modelInfo={{
					...baseModelInfo,
					tiers: [{ name: OpenAiServiceTier.Default, contextWindow: 128_000 }],
				}}
			/>,
		)

		expect(screen.queryByText("Service tier pricing")).not.toBeInTheDocument()
	})

	it("does not show the tier pricing table when model info has no tiers", () => {
		render(
			<ModelInfoView
				{...defaultProps}
				apiProvider={providerIdentifiers.openaiNative}
				modelInfo={baseModelInfo}
			/>,
		)

		expect(screen.queryByText("Service tier pricing")).not.toBeInTheDocument()
	})

	it("shows unavailable prices when neither the tier nor Standard defines them", () => {
		render(
			<ModelInfoView
				{...defaultProps}
				apiProvider={providerIdentifiers.openaiNative}
				modelInfo={{
					contextWindow: 128_000,
					supportsPromptCache: false,
					tiers: [
						{ name: OpenAiServiceTier.Flex, contextWindow: 128_000 },
						{ name: OpenAiServiceTier.Priority, contextWindow: 128_000 },
					],
				}}
			/>,
		)

		expect(getPricingRowValues("Flex")).toEqual(["Flex", "—", "—", "—"])
		expect(getPricingRowValues("Priority")).toEqual(["Priority", "—", "—", "—"])
	})
})
