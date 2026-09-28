// npx vitest src/components/settings/providers/__tests__/Fireworks.spec.tsx

import React from "react"
import { render, screen, fireEvent, waitFor, act } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
	allRouterModelsProvider,
	fireworksDefaultModelId,
	fireworksModels,
	providerIdentifiers,
	type ModelInfo,
	type ProviderSettings,
} from "@roo-code/types"

import { Fireworks } from "../Fireworks"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()
	return {
		...actual,
		VSCodeTextField: ({ children, value, onInput, type, placeholder }: any) => (
			<div data-testid="vscode-text-field">
				{children}
				<input
					type={type}
					value={value}
					onInput={(e) => onInput?.(e)}
					placeholder={placeholder}
					data-testid="fireworks-api-key-input"
				/>
			</div>
		),
	}
})

vi.mock("../../ModelPicker", () => ({
	ModelPicker: function MockModelPicker({
		models,
		defaultModelId,
		onModelChange,
		organizationAllowList,
		errorMessage,
	}: {
		models: Record<string, ModelInfo>
		defaultModelId: string
		onModelChange?: (modelId: string) => void
		organizationAllowList?: unknown
		errorMessage?: string
	}) {
		return React.createElement(
			"div",
			{ "data-testid": "model-picker" },
			React.createElement("span", { "data-testid": "model-picker-default" }, defaultModelId),
			React.createElement("span", { "data-testid": "model-picker-ids" }, Object.keys(models).join(",")),
			React.createElement(
				"span",
				{ "data-testid": "model-picker-allow-list" },
				organizationAllowList ? "allow-list" : "no-allow-list",
			),
			React.createElement("span", { "data-testid": "model-picker-error" }, errorMessage ?? ""),
			React.createElement(
				"button",
				{
					"data-testid": "change-model",
					onClick: () => onModelChange?.("accounts/fireworks/models/glm-5p3"),
				},
				"Change model",
			),
		)
	},
}))

vi.mock("@src/utils/vscode", () => {
	const mockPostMessage = vi.fn()
	return {
		vscode: { postMessage: mockPostMessage },
	}
})

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

vi.mock("@src/components/ui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@src/components/ui")>()
	return {
		...actual,
		Button: ({ children, onClick, disabled, variant }: any) => (
			<button data-testid="button" disabled={disabled} onClick={onClick} data-variant={variant}>
				{children}
			</button>
		),
	}
})

vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ href, children }: any) => (
		<a data-testid="vscode-button-link" href={href}>
			{children}
		</a>
	),
}))

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

const mockUseExtensionState = useExtensionState as ReturnType<typeof vi.fn>

const getRefreshButton = () =>
	screen.getAllByTestId("button").find((button) => button.getAttribute("data-variant") === "outline")!

describe("Fireworks Component", () => {
	const mockSetApiConfigurationField = vi.fn()

	const createApiConfiguration = (overrides?: Partial<ProviderSettings>): ProviderSettings => ({
		apiProvider: providerIdentifiers.fireworks,
		...overrides,
	})

	beforeEach(() => {
		vi.clearAllMocks()
		mockUseExtensionState.mockReturnValue({ routerModels: {} })
	})

	it("shows API-fetched models in the picker when available", () => {
		mockUseExtensionState.mockReturnValue({
			routerModels: {
				[providerIdentifiers.fireworks]: {
					"accounts/fireworks/models/glm-5p3": { contextWindow: 1_048_576, supportsPromptCache: false },
				},
			},
		})

		render(
			<Fireworks
				apiConfiguration={createApiConfiguration({ fireworksApiKey: "k" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.getByTestId("model-picker-ids")).toHaveTextContent("accounts/fireworks/models/glm-5p3")
		expect(screen.getByTestId("model-picker-default")).toHaveTextContent(fireworksDefaultModelId)
	})

	it("falls back to the static model list when nothing has been fetched", () => {
		render(
			<Fireworks
				apiConfiguration={createApiConfiguration()}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.getByTestId("model-picker-ids")).toHaveTextContent(Object.keys(fireworksModels).join(","))
	})

	it("disables refresh without an API key and shows the get-key link", () => {
		render(
			<Fireworks
				apiConfiguration={createApiConfiguration()}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(getRefreshButton()).toBeDisabled()
		expect(screen.getByTestId("vscode-button-link")).toBeInTheDocument()
	})

	it("sends a Fireworks-scoped refresh request with the current key", () => {
		render(
			<Fireworks
				apiConfiguration={createApiConfiguration({ fireworksApiKey: "fw-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.queryByTestId("vscode-button-link")).not.toBeInTheDocument()
		fireEvent.click(getRefreshButton())

		expect(getRefreshButton()).toBeDisabled()
		expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "requestRouterModels",
			values: { provider: providerIdentifiers.fireworks, fireworksApiKey: "fw-key" },
		})
	})

	it("shows success and seeds the Fireworks + shared router-model caches from the response", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")
		const setQueryData = vi.spyOn(queryClient, "setQueryData")
		const refreshedModels = {
			"accounts/fireworks/models/glm-5p3": { contextWindow: 1_048_576, supportsPromptCache: false },
		}

		render(
			<QueryClientProvider client={queryClient}>
				<Fireworks
					apiConfiguration={createApiConfiguration({ fireworksApiKey: "fw-key" })}
					setApiConfigurationField={mockSetApiConfigurationField}
				/>
			</QueryClientProvider>,
		)

		fireEvent.click(getRefreshButton())
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "routerModels",
						routerModels: { [providerIdentifiers.fireworks]: refreshedModels },
						values: { provider: providerIdentifiers.fireworks },
					},
				}),
			)
		})

		await waitFor(() => {
			expect(screen.getByText("settings:providers.refreshModels.success")).toBeInTheDocument()
			// Seeding avoids a refetch that would use the saved key instead of the edited one.
			expect(setQueryData).toHaveBeenCalledWith(
				["routerModels", providerIdentifiers.fireworks],
				expect.any(Function),
			)
			expect(setQueryData).toHaveBeenCalledWith(["routerModels", allRouterModelsProvider], expect.any(Function))
			expect(invalidateQueries).not.toHaveBeenCalled()
		})
	})

	it("does not create the aggregate cache entry from a Fireworks-only payload", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const setQueryData = vi.spyOn(queryClient, "setQueryData")

		render(
			<QueryClientProvider client={queryClient}>
				<Fireworks
					apiConfiguration={createApiConfiguration({ fireworksApiKey: "fw-key" })}
					setApiConfigurationField={mockSetApiConfigurationField}
				/>
			</QueryClientProvider>,
		)

		fireEvent.click(getRefreshButton())
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "routerModels",
						routerModels: { [providerIdentifiers.fireworks]: {} },
						values: { provider: providerIdentifiers.fireworks },
					},
				}),
			)
		})

		await waitFor(() => expect(setQueryData).toHaveBeenCalled())
		// The updater must leave an absent aggregate entry absent rather than seeding it
		// with a payload that only contains Fireworks.
		const aggregateCall = setQueryData.mock.calls.find(
			([key]) => Array.isArray(key) && key[1] === allRouterModelsProvider,
		)
		expect(aggregateCall).toBeDefined()
		const updater = aggregateCall![1] as (current: unknown) => unknown
		expect(updater(undefined)).toBeUndefined()
	})

	it("ignores an aggregate routerModels response while loading", async () => {
		render(
			<Fireworks
				apiConfiguration={createApiConfiguration({ fireworksApiKey: "fw-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.click(getRefreshButton())
		await waitFor(() => expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument())

		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "routerModels" } }))
		})

		expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
		expect(screen.queryByText("settings:providers.refreshModels.success")).not.toBeInTheDocument()
	})

	it("shows the error and does not flip to success when a Fireworks routerModels response arrives afterwards", async () => {
		render(
			<Fireworks
				apiConfiguration={createApiConfiguration({ fireworksApiKey: "fw-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.click(getRefreshButton())
		await waitFor(() => expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument())

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "singleRouterModelFetchResponse",
						success: false,
						error: "HTTP 401: Unauthorized",
						values: { provider: providerIdentifiers.fireworks },
					},
				}),
			)
		})
		await waitFor(() => expect(screen.getByText("HTTP 401: Unauthorized")).toBeInTheDocument())

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "routerModels",
						routerModels: { [providerIdentifiers.fireworks]: {} },
						values: { provider: providerIdentifiers.fireworks },
					},
				}),
			)
		})

		expect(screen.getByText("HTTP 401: Unauthorized")).toBeInTheDocument()
		expect(screen.queryByText("settings:providers.refreshModels.success")).not.toBeInTheDocument()
	})

	it("ignores another provider's failure while loading", async () => {
		render(
			<Fireworks
				apiConfiguration={createApiConfiguration({ fireworksApiKey: "fw-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.click(getRefreshButton())
		await waitFor(() => expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument())

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "singleRouterModelFetchResponse",
						success: false,
						error: "OpenRouter unavailable",
						values: { provider: providerIdentifiers.openrouter },
					},
				}),
			)
		})

		expect(screen.queryByText("OpenRouter unavailable")).not.toBeInTheDocument()
		expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
	})

	it("requests the catalog with the new key when the key changes", async () => {
		const { rerender } = render(
			<Fireworks
				apiConfiguration={createApiConfiguration({ fireworksApiKey: "old-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		rerender(
			<Fireworks
				apiConfiguration={createApiConfiguration({ fireworksApiKey: "new-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		await waitFor(() =>
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "requestRouterModels",
				values: { provider: providerIdentifiers.fireworks, fireworksApiKey: "new-key" },
			}),
		)
	})

	it("does not request the catalog on mount or when the key is cleared", async () => {
		const { rerender } = render(
			<Fireworks
				apiConfiguration={createApiConfiguration({ fireworksApiKey: "fw-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		rerender(
			<Fireworks
				apiConfiguration={createApiConfiguration()}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		await new Promise((resolve) => setTimeout(resolve, 300))

		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("threads the organization allow list and validation error into the picker", () => {
		render(
			<Fireworks
				apiConfiguration={createApiConfiguration({ fireworksApiKey: "fw-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
				organizationAllowList={{ allowAll: false, providers: {} }}
				modelValidationError="model not allowed"
			/>,
		)

		expect(screen.getByTestId("model-picker-allow-list")).toHaveTextContent("allow-list")
		expect(screen.getByTestId("model-picker-error")).toHaveTextContent("model not allowed")
	})

	it("resets model-specific settings when the selected model changes", () => {
		render(
			<Fireworks
				apiConfiguration={createApiConfiguration({ fireworksApiKey: "fw-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.click(screen.getByTestId("change-model"))

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", undefined)
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("modelMaxTokens", undefined)
	})
})
