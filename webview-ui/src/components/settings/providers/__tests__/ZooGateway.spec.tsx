import React from "react"
import { render, screen, waitFor } from "@/utils/test-utils"
import type { ModelInfo, ProviderSettings, RouterModels } from "@roo-code/types"

import { ZooGateway, pickZooGatewayDefaultModelId } from "../ZooGateway"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

const extensionStateMock = {
	zooCodeIsAuthenticated: true,
	zooCodeUserEmail: "user@example.com",
	zooCodeUserName: "User",
	zooCodeBaseUrl: "https://www.zoocode.dev",
	uriScheme: "vscode",
	deviceName: "Test Device",
}

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionStateMock,
}))

vi.mock("@src/oauth/urls", () => ({
	getZooCodeAuthUrl: () => "https://www.zoocode.dev/dashboard/connect",
}))

vi.mock("../../ModelPicker", () => ({
	ModelPicker: ({ defaultModelId }: { defaultModelId: string }) => (
		<div data-testid="model-picker" data-default-model={defaultModelId} />
	),
}))

const baseInfo: ModelInfo = {
	maxTokens: 8192,
	contextWindow: 200000,
	supportsImages: false,
	supportsPromptCache: false,
	inputPrice: 1,
	outputPrice: 2,
}

function buildRouterModels(modelIds: string[]): RouterModels {
	const models = Object.fromEntries(modelIds.map((id) => [id, baseInfo]))
	return { "zoo-gateway": models } as unknown as RouterModels
}

describe("pickZooGatewayDefaultModelId", () => {
	it("falls back to the static default when the catalog is empty", () => {
		expect(pickZooGatewayDefaultModelId([])).toBe("anthropic/claude-sonnet-4")
	})

	it("prefers an exact anthropic/claude-sonnet-4.5 match", () => {
		const result = pickZooGatewayDefaultModelId([
			"anthropic/claude-sonnet-4",
			"anthropic/claude-sonnet-4.5",
			"openai/gpt-4o",
		])
		expect(result).toBe("anthropic/claude-sonnet-4.5")
	})

	it("matches a Bedrock-style claude-sonnet-4-5 id", () => {
		const result = pickZooGatewayDefaultModelId([
			"anthropic.claude-sonnet-4-20250514-v1:0",
			"anthropic.claude-sonnet-4-5-20250929-v1:0",
		])
		expect(result).toBe("anthropic.claude-sonnet-4-5-20250929-v1:0")
	})

	it("falls back to claude sonnet 4 when 4.5 is not in the catalog", () => {
		const result = pickZooGatewayDefaultModelId(["openai/gpt-4o", "anthropic/claude-sonnet-4"])
		expect(result).toBe("anthropic/claude-sonnet-4")
	})

	it("falls back to the first available id when no claude sonnet is present", () => {
		const result = pickZooGatewayDefaultModelId(["openai/gpt-4o", "google/gemini-2.5-pro"])
		expect(result).toBe("openai/gpt-4o")
	})
})

describe("ZooGateway component", () => {
	const baseProps = {
		organizationAllowList: { allowAll: true, providers: {} } as ProviderSettings extends never ? never : any,
		setApiConfigurationField: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("auto-selects the resolved default model when the profile has no model id", async () => {
		const setApiConfigurationField = vi.fn()
		render(
			<ZooGateway
				apiConfiguration={{ apiProvider: "zoo-gateway" } as ProviderSettings}
				setApiConfigurationField={setApiConfigurationField}
				routerModels={buildRouterModels(["anthropic/claude-sonnet-4", "anthropic/claude-sonnet-4.5"])}
				organizationAllowList={baseProps.organizationAllowList}
			/>,
		)

		await waitFor(() => {
			expect(setApiConfigurationField).toHaveBeenCalledWith("zooGatewayModelId", "anthropic/claude-sonnet-4.5")
		})
	})

	it("reassigns a stale model id that is not in the catalog", async () => {
		const setApiConfigurationField = vi.fn()
		render(
			<ZooGateway
				apiConfiguration={
					{
						apiProvider: "zoo-gateway",
						zooGatewayModelId: "anthropic/claude-sonnet-4",
					} as ProviderSettings
				}
				setApiConfigurationField={setApiConfigurationField}
				routerModels={buildRouterModels([
					"anthropic.claude-sonnet-4-5-20250929-v1:0",
					"anthropic.claude-sonnet-4-20250514-v1:0",
				])}
				organizationAllowList={baseProps.organizationAllowList}
			/>,
		)

		await waitFor(() => {
			expect(setApiConfigurationField).toHaveBeenCalledWith(
				"zooGatewayModelId",
				"anthropic.claude-sonnet-4-5-20250929-v1:0",
			)
		})
	})

	it("does not overwrite a model id that is already valid for the catalog", async () => {
		const setApiConfigurationField = vi.fn()
		render(
			<ZooGateway
				apiConfiguration={
					{
						apiProvider: "zoo-gateway",
						zooGatewayModelId: "anthropic/claude-sonnet-4.5",
					} as ProviderSettings
				}
				setApiConfigurationField={setApiConfigurationField}
				routerModels={buildRouterModels(["anthropic/claude-sonnet-4", "anthropic/claude-sonnet-4.5"])}
				organizationAllowList={baseProps.organizationAllowList}
			/>,
		)

		await waitFor(() => {
			expect(setApiConfigurationField).not.toHaveBeenCalled()
		})
	})

	it("does nothing while the catalog is still empty (router models loading)", () => {
		const setApiConfigurationField = vi.fn()
		render(
			<ZooGateway
				apiConfiguration={{ apiProvider: "zoo-gateway" } as ProviderSettings}
				setApiConfigurationField={setApiConfigurationField}
				routerModels={undefined}
				organizationAllowList={baseProps.organizationAllowList}
			/>,
		)

		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it("renders the sign-in validation error inline when not authenticated", () => {
		const original = extensionStateMock.zooCodeIsAuthenticated
		extensionStateMock.zooCodeIsAuthenticated = false
		try {
			render(
				<ZooGateway
					apiConfiguration={{ apiProvider: "zoo-gateway" } as ProviderSettings}
					setApiConfigurationField={vi.fn()}
					routerModels={buildRouterModels(["anthropic/claude-sonnet-4"])}
					organizationAllowList={baseProps.organizationAllowList}
				/>,
			)

			expect(screen.getByText("settings:validation.zooGatewaySignIn")).toBeInTheDocument()
		} finally {
			extensionStateMock.zooCodeIsAuthenticated = original
		}
	})
})
