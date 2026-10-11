import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClientProvider } from "@tanstack/react-query"

import {
	providerIdentifiers,
	VsCodeLmModelsMessageType,
	type OrganizationAllowList,
	type RouterModels,
} from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { createTestQueryClient } from "@src/utils/test-utils"

import { Unbound } from "../Unbound"
import { VercelAiGateway } from "../VercelAiGateway"
import { VSCodeLM } from "../VSCodeLM"
import { PROVIDERS_WITH_CUSTOM_MODEL_UI } from "../../utils/providerModelConfig"

const { modelPickerMock } = vi.hoisted(() => ({
	modelPickerMock: vi.fn((_props: React.ComponentProps<typeof import("../../ModelPicker").ModelPicker>) => null),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { account?: string }) =>
			key === "settings:providers.githubCopilot.signedIn" ? `Signed in as ${options?.account}` : key,
	}),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock("@src/components/ui", async () => {
	const { Button } = await import("@src/components/ui/button")
	return {
		Button,
		StandardTooltip: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) => (
			<span data-testid="action-tooltip" data-tooltip={typeof content === "string" ? content : undefined}>
				{children}
			</span>
		),
	}
})

vi.mock("../../ModelPicker", () => ({ ModelPicker: modelPickerMock }))
vi.mock("@src/components/common/VSCodeButtonLink", () => ({ VSCodeButtonLink: () => null }))

// The Copilot model list lives in the shared query cache, so every render needs a client.
const renderWithQuery = (ui: React.ReactElement) =>
	render(<QueryClientProvider client={createTestQueryClient()}>{ui}</QueryClientProvider>)

describe("provider model routing", () => {
	const organizationAllowList: OrganizationAllowList = { allowAll: true, providers: {} }

	beforeEach(() => vi.clearAllMocks())

	it("uses only the custom model picker for GitHub Copilot", () => {
		expect(PROVIDERS_WITH_CUSTOM_MODEL_UI).toContain(providerIdentifiers.githubCopilot)
	})

	it("uses compact icon-only buttons with accessible names, stable dimensions, and shared tooltips", () => {
		renderWithQuery(
			<VSCodeLM
				apiConfiguration={{ apiProvider: providerIdentifiers.githubCopilot }}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: VsCodeLmModelsMessageType.githubCopilotModels, githubCopilotAccount: "Test User" },
				}),
			),
		)
		const controls = [
			screen.getByRole("button", { name: "settings:providers.githubCopilot.reconnect" }),
			screen.getByRole("button", { name: "settings:providers.refreshModels.label" }),
			screen.getByRole("button", { name: "settings:providers.githubCopilot.manageAccount" }),
		]
		for (const control of controls) {
			expect(control).toHaveClass("h-7", "w-7", "focus-visible:ring-1")
			expect(control.textContent).toBe("")
			expect(control).not.toHaveAttribute("title")
			expect(control.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
			expect(control.closest('[data-testid="action-tooltip"]')).toHaveAttribute("data-tooltip")
		}
		expect(
			screen.getByRole("group", { name: "settings:providers.githubCopilot.accountActions" }),
		).toBeInTheDocument()
	})

	it("supports keyboard tab navigation and manage-account activation", async () => {
		const frame = document.createElement("iframe")
		frame.hidden = true
		document.body.appendChild(frame)
		const nativeFocus = frame.contentDocument?.createElement("button").focus
		const originalFocus = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")
		if (!nativeFocus || !originalFocus) throw new Error("Native DOM focus is unavailable")
		Object.defineProperty(HTMLElement.prototype, "focus", {
			configurable: true,
			writable: true,
			value: nativeFocus,
		})
		try {
			const user = userEvent.setup()
			const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
			renderWithQuery(
				<VSCodeLM
					apiConfiguration={{ apiProvider: providerIdentifiers.githubCopilot }}
					setApiConfigurationField={vi.fn()}
				/>,
			)
			act(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: VsCodeLmModelsMessageType.githubCopilotModels,
							githubCopilotAccount: "Test User",
						},
					}),
				),
			)
			await user.tab()
			expect(screen.getByRole("button", { name: "settings:providers.githubCopilot.reconnect" })).toHaveFocus()
			await user.tab()
			expect(screen.getByRole("button", { name: "settings:providers.refreshModels.label" })).toHaveFocus()
			await user.tab()
			expect(screen.getByRole("button", { name: "settings:providers.githubCopilot.manageAccount" })).toHaveFocus()
			await user.keyboard("{Enter}")
			expect(postMessage).toHaveBeenCalledWith({ type: VsCodeLmModelsMessageType.githubCopilotManageAccount })
		} finally {
			Object.defineProperty(HTMLElement.prototype, "focus", originalFocus)
			frame.remove()
		}
	})

	it("blocks overlapping actions during refresh and releases them after a discovery error", async () => {
		const user = userEvent.setup()
		renderWithQuery(
			<VSCodeLM
				apiConfiguration={{ apiProvider: providerIdentifiers.githubCopilot }}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: VsCodeLmModelsMessageType.githubCopilotModels, githubCopilotAccount: "Test User" },
				}),
			),
		)
		await user.click(screen.getByRole("button", { name: "settings:providers.refreshModels.label" }))
		expect(screen.getByRole("button", { name: "settings:providers.refreshModels.label" })).toHaveAttribute(
			"aria-busy",
			"true",
		)
		for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled()
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: VsCodeLmModelsMessageType.githubCopilotModels, error: "Model discovery failed" },
				}),
			),
		)
		expect(screen.getByRole("alert")).toHaveTextContent("Model discovery failed")
		for (const button of screen.getAllByRole("button")) expect(button).toBeEnabled()
		expect(screen.getByRole("button", { name: "settings:providers.refreshModels.label" })).toHaveAttribute(
			"aria-busy",
			"false",
		)
	})

	it("shows completed authentication before model discovery and restores it on refresh", () => {
		renderWithQuery(
			<VSCodeLM
				apiConfiguration={{ apiProvider: providerIdentifiers.githubCopilot }}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { name: "settings:providers.githubCopilot.signIn" }))
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: VsCodeLmModelsMessageType.githubCopilotModels,
						githubCopilotAccount: "Test User",
					},
				}),
			),
		)
		expect(screen.getByRole("status")).toHaveTextContent("Signed in as Test User")
		expect(screen.getByRole("button", { name: "settings:providers.githubCopilot.connecting" })).toBeDisabled()
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: VsCodeLmModelsMessageType.githubCopilotSignInResult,
						githubCopilotAccount: "Test User",
						vsCodeLmModels: [],
					},
				}),
			),
		)
		expect(screen.getByRole("button", { name: "settings:providers.githubCopilot.reconnect" })).toBeEnabled()
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: VsCodeLmModelsMessageType.githubCopilotModels,
						githubCopilotAccount: null,
						vsCodeLmModels: [],
					},
				}),
			),
		)
		expect(screen.queryByRole("status")).not.toBeInTheDocument()
	})

	it("reconnects using a fresh-session message rather than repeating passive sign-in", () => {
		const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
		renderWithQuery(
			<VSCodeLM
				apiConfiguration={{ apiProvider: providerIdentifiers.githubCopilot }}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: VsCodeLmModelsMessageType.githubCopilotModels, githubCopilotAccount: "Test User" },
				}),
			),
		)
		fireEvent.click(screen.getByRole("button", { name: "settings:providers.githubCopilot.reconnect" }))
		expect(postMessage).toHaveBeenCalledWith({ type: VsCodeLmModelsMessageType.githubCopilotReconnect })
	})

	it("opens VS Code's account management without signing out or changing the connected account", () => {
		const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
		renderWithQuery(
			<VSCodeLM
				apiConfiguration={{ apiProvider: providerIdentifiers.githubCopilot }}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: VsCodeLmModelsMessageType.githubCopilotModels, githubCopilotAccount: "Test User" },
				}),
			),
		)

		fireEvent.click(screen.getByRole("button", { name: "settings:providers.githubCopilot.manageAccount" }))

		expect(postMessage).toHaveBeenCalledTimes(1)
		expect(postMessage).toHaveBeenCalledWith({ type: VsCodeLmModelsMessageType.githubCopilotManageAccount })
		// Only the host knows whether the user signed out; the connected account stays until it says otherwise.
		expect(screen.getByRole("status")).toHaveTextContent("Signed in as Test User")
	})

	it("offers account management only once an account is connected", () => {
		renderWithQuery(
			<VSCodeLM
				apiConfiguration={{ apiProvider: providerIdentifiers.githubCopilot }}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		expect(
			screen.queryByRole("button", { name: "settings:providers.githubCopilot.manageAccount" }),
		).not.toBeInTheDocument()
	})

	it("drops the account when the host reports it is gone, for example after signing out in VS Code", () => {
		renderWithQuery(
			<VSCodeLM
				apiConfiguration={{ apiProvider: providerIdentifiers.githubCopilot }}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		const send = (data: object) => act(() => void window.dispatchEvent(new MessageEvent("message", { data })))
		send({ type: VsCodeLmModelsMessageType.githubCopilotModels, githubCopilotAccount: "Test User" })
		expect(screen.getByRole("status")).toBeInTheDocument()

		send({ type: VsCodeLmModelsMessageType.githubCopilotModels, githubCopilotAccount: null, vsCodeLmModels: [] })

		expect(screen.queryByRole("status")).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "settings:providers.githubCopilot.signIn" })).toBeEnabled()
	})

	it("shows live model capabilities without writing them into saved settings", async () => {
		const setField = vi.fn()
		renderWithQuery(
			<VSCodeLM
				apiConfiguration={{
					apiProvider: providerIdentifiers.githubCopilot,
					vsCodeLmModelSelector: { vendor: "copilot", id: "model" },
				}}
				setApiConfigurationField={setField}
			/>,
		)
		const modelInfo = { contextWindow: 260000, supportsImages: true, supportsPromptCache: false }

		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: VsCodeLmModelsMessageType.githubCopilotModels,
						vsCodeLmModels: [
							{ vendor: "copilot", id: "model", family: "dynamic-vision", version: "1", modelInfo },
						],
					},
				}),
			),
		)

		await waitFor(() => expect(modelPickerMock.mock.lastCall![0].models?.model).toMatchObject(modelInfo))
		expect(setField).not.toHaveBeenCalled()
	})

	it("keeps the last known models when a mid-sign-in update carries only the account", async () => {
		renderWithQuery(
			<VSCodeLM
				apiConfiguration={{ apiProvider: providerIdentifiers.githubCopilot }}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		const send = (data: object) => act(() => void window.dispatchEvent(new MessageEvent("message", { data })))
		send({
			type: VsCodeLmModelsMessageType.githubCopilotModels,
			vsCodeLmModels: [{ vendor: "copilot", id: "kept", family: "kept", version: "1" }],
		})
		await waitFor(() => expect(modelPickerMock.mock.lastCall![0].models).toHaveProperty("kept"))

		send({ type: VsCodeLmModelsMessageType.githubCopilotModels, githubCopilotAccount: "Test User" })
		// The account arrives; the account-only update must not have emptied the list.
		await screen.findByRole("status")

		expect(modelPickerMock.mock.lastCall![0].models).toHaveProperty("kept")
	})

	it("releases a refresh still waiting when a sign-in result arrives, since its own reply may have been discarded", () => {
		renderWithQuery(
			<VSCodeLM
				apiConfiguration={{ apiProvider: providerIdentifiers.githubCopilot }}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: VsCodeLmModelsMessageType.githubCopilotModels, githubCopilotAccount: "Test User" },
				}),
			),
		)
		fireEvent.click(screen.getByRole("button", { name: "settings:providers.refreshModels.label" }))
		expect(screen.getByRole("button", { name: "settings:providers.refreshModels.label" })).toHaveAttribute(
			"aria-busy",
			"true",
		)

		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: VsCodeLmModelsMessageType.githubCopilotSignInResult,
						githubCopilotAccount: "Test User",
						vsCodeLmModels: [],
					},
				}),
			),
		)

		expect(screen.getByRole("button", { name: "settings:providers.refreshModels.label" })).toHaveAttribute(
			"aria-busy",
			"false",
		)
		for (const button of screen.getAllByRole("button")) expect(button).toBeEnabled()
	})

	it("keeps sign-in pending during background discovery and displays cancellation", () => {
		const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
		renderWithQuery(
			<VSCodeLM
				apiConfiguration={{ apiProvider: providerIdentifiers.githubCopilot }}
				setApiConfigurationField={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "settings:providers.githubCopilot.signIn" }))
		expect(postMessage).toHaveBeenCalledWith({ type: VsCodeLmModelsMessageType.githubCopilotSignIn })
		expect(screen.getByRole("button", { name: "settings:providers.githubCopilot.connecting" })).toBeDisabled()

		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: VsCodeLmModelsMessageType.githubCopilotModels,
						vsCodeLmModels: [],
					},
				}),
			),
		)
		expect(screen.getByRole("button", { name: "settings:providers.githubCopilot.connecting" })).toBeDisabled()

		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: VsCodeLmModelsMessageType.githubCopilotSignInResult,
						error: "Sign-in cancelled",
					},
				}),
			),
		)
		expect(screen.getByRole("alert")).toHaveTextContent("Sign-in cancelled")
		expect(screen.getByRole("button", { name: "settings:providers.githubCopilot.signIn" })).toBeEnabled()
	})

	it("refreshes only Copilot models and preserves distinct model variants", () => {
		const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
		renderWithQuery(
			<VSCodeLM
				apiConfiguration={{ apiProvider: providerIdentifiers.githubCopilot }}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { name: "settings:providers.refreshModels.label" }))
		expect(postMessage).toHaveBeenCalledWith({
			type: VsCodeLmModelsMessageType.requestVsCodeLmModels,
			apiConfiguration: { apiProvider: providerIdentifiers.githubCopilot },
		})

		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: VsCodeLmModelsMessageType.vsCodeLmModels,
						vsCodeLmModels: [{ id: "other-model", vendor: "other", family: "gpt-4o" }],
					},
				}),
			),
		)
		expect(modelPickerMock).not.toHaveBeenCalled()

		const model = {
			id: "gpt-4o-version-2",
			vendor: "copilot",
			family: "gpt-4o",
			version: "2",
			maxInputTokens: 32000,
		}
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: VsCodeLmModelsMessageType.githubCopilotModels,
						vsCodeLmModels: [{ ...model, id: "gpt-4o-version-1", version: "1" }, model],
					},
				}),
			),
		)
		const props = modelPickerMock.mock.lastCall![0]
		expect(Object.keys(props.models ?? {})).toEqual(["gpt-4o-version-1", "gpt-4o-version-2"])
		expect(props.valueTransform?.(model.id)).toEqual({
			id: model.id,
			vendor: model.vendor,
			family: model.family,
			version: model.version,
		})
		expect(props.displayTransform?.({ vendor: model.vendor, family: model.family, id: model.id })).toBe(model.id)
	})

	describe("model picker wiring", () => {
		const send = (data: object) => act(() => void window.dispatchEvent(new MessageEvent("message", { data })))
		const pickerProps = () => modelPickerMock.mock.lastCall![0]
		const mount = (provider: typeof providerIdentifiers.githubCopilot | typeof providerIdentifiers.vscodeLm) =>
			renderWithQuery(
				<VSCodeLM apiConfiguration={{ apiProvider: provider }} setApiConfigurationField={vi.fn()} />,
			)

		const listed = [
			{ id: "m1", vendor: "copilot", family: "fam", version: "1" },
			{ vendor: "other", family: "no-id" },
		]

		it("lists the legacy provider's models from its own messages and names its service accordingly", () => {
			mount(providerIdentifiers.vscodeLm)

			send({ type: VsCodeLmModelsMessageType.vsCodeLmModels, vsCodeLmModels: listed })

			expect(pickerProps().serviceName).toBe("VS Code LM")
			expect(Object.keys(pickerProps().models ?? {})).toEqual(["m1", "other/no-id"])
		})

		it("keeps each provider's list separate: the legacy picker ignores Copilot messages", () => {
			mount(providerIdentifiers.vscodeLm)

			send({ type: VsCodeLmModelsMessageType.githubCopilotModels, vsCodeLmModels: listed })

			expect(modelPickerMock).not.toHaveBeenCalled()
		})

		it("ignores a legacy list that arrives with an error", () => {
			mount(providerIdentifiers.vscodeLm)

			send({ type: VsCodeLmModelsMessageType.vsCodeLmModels, vsCodeLmModels: listed, error: "partial" })

			expect(modelPickerMock).not.toHaveBeenCalled()
		})

		describe("stored value mapping", () => {
			beforeEach(() => {
				mount(providerIdentifiers.vscodeLm)
				send({ type: VsCodeLmModelsMessageType.vsCodeLmModels, vsCodeLmModels: listed })
			})

			it("stores a listed model by its identity, with no capability snapshot", () => {
				expect(pickerProps().valueTransform?.("m1")).toEqual({
					id: "m1",
					vendor: "copilot",
					family: "fam",
					version: "1",
				})
			})

			it("stores an unlisted value as vendor and family", () => {
				expect(pickerProps().valueTransform?.("acme/model-x")).toEqual({ vendor: "acme", family: "model-x" })
			})

			it.each([
				["nothing stored", undefined, ""],
				["a stored id that is listed", { id: "m1" }, "m1"],
				["a stored vendor and family whose model has an id", { vendor: "copilot", family: "fam" }, "m1"],
				[
					"a stored vendor and family whose model has no id",
					{ vendor: "other", family: "no-id" },
					"other/no-id",
				],
				[
					"a stored vendor and family that is no longer listed",
					{ vendor: "gone", family: "model" },
					"gone/model",
				],
				["a stored selector too incomplete to name a model", { vendor: "copilot" }, ""],
			])("shows %s as the right label", (_label, stored, expected) => {
				expect(pickerProps().displayTransform?.(stored)).toBe(expected)
			})
		})
	})

	it("keeps the legacy VS Code LM provider free of Copilot login controls", () => {
		renderWithQuery(
			<VSCodeLM
				apiConfiguration={{ apiProvider: providerIdentifiers.vscodeLm }}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		expect(
			screen.queryByRole("button", { name: "settings:providers.githubCopilot.signIn" }),
		).not.toBeInTheDocument()
	})

	it("requests fresh Unbound models when the refresh button is clicked", () => {
		const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)

		renderWithQuery(
			<Unbound
				apiConfiguration={{ apiProvider: providerIdentifiers.unbound }}
				setApiConfigurationField={vi.fn()}
				refetchRouterModels={vi.fn()}
				organizationAllowList={organizationAllowList}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "settings:providers.refreshModels.label" }))

		expect(postMessage).toHaveBeenCalledWith({
			type: "requestRouterModels",
			values: { provider: providerIdentifiers.unbound, refresh: true },
		})
	})

	it("passes Vercel AI Gateway models selected by its provider identifier to the model picker", () => {
		const models = { "anthropic/claude": { contextWindow: 1, supportsPromptCache: false } }
		const routerModels = Object.fromEntries(
			Object.values(providerIdentifiers).map((provider) => [provider, {}]),
		) as RouterModels
		routerModels[providerIdentifiers.vercelAiGateway] = models

		renderWithQuery(
			<VercelAiGateway
				apiConfiguration={{ apiProvider: providerIdentifiers.vercelAiGateway }}
				setApiConfigurationField={vi.fn()}
				routerModels={routerModels}
				organizationAllowList={organizationAllowList}
			/>,
		)

		expect(modelPickerMock).toHaveBeenCalledWith(expect.objectContaining({ models }), expect.anything())
	})

	it("passes an empty model set when Vercel AI Gateway models are unavailable", () => {
		renderWithQuery(
			<VercelAiGateway
				apiConfiguration={{ apiProvider: providerIdentifiers.vercelAiGateway }}
				setApiConfigurationField={vi.fn()}
				organizationAllowList={organizationAllowList}
			/>,
		)

		expect(modelPickerMock).toHaveBeenCalledWith(expect.objectContaining({ models: {} }), expect.anything())
	})
})
