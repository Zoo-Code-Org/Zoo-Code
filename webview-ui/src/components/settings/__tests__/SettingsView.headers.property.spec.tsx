import React from "react"
import { QueryClient } from "@tanstack/react-query"
import { act, configure, fireEvent, screen, waitFor } from "@testing-library/react"
import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest"

import { renderWithExtensionState } from "@/utils/test-utils"

// Regression replays for issue #2770. Each test uses the real OpenAICompatible editor
// inside SettingsView with the real cachedState and Save handler. A test adapter replaces
// the surrounding provider picker.
//
// Safety contracts (mirrored by docs/architecture/tla/ProviderHeaderSettings.tla):
// - LoadedHeadersSurvive: a profile load or switch must not be replaced by stale editor
//   rows, and Save must send the loaded headers.
// - SaveKeepsLatestHeaders: Save must include the latest header addition, edit, or
//   removal without a timing requirement.

configure({ asyncUtilTimeout: 10000 })

const mockPostMessage = vi.hoisted(() => vi.fn())
;(global as any).acquireVsCodeApi = () => ({ postMessage: mockPostMessage })

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: mockPostMessage },
}))

const { useExtensionState } = vi.hoisted(() => ({ useExtensionState: vi.fn() }))

vi.mock("@src/context/ExtensionStateContext", () => ({
	ExtensionStateContextProvider: ({ children }: any) => children,
	useExtensionState,
}))

const mockTranslate = vi.hoisted(() => (key: string) => key)

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: mockTranslate }),
}))

vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange }: any) => (
		<label data-testid={`checkbox-${children?.toString().replace(/\s+/g, "-").toLowerCase()}`}>
			<input
				type="checkbox"
				checked={checked}
				onChange={onChange}
				data-testid={`checkbox-input-${children?.toString().replace(/\s+/g, "-").toLowerCase()}`}
			/>
			{children}
		</label>
	),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, placeholder, className, ...rest }: any) => (
		<div className={className}>
			<input
				type="text"
				value={value ?? ""}
				onChange={(event) => onInput?.(event)}
				placeholder={placeholder}
				{...rest}
			/>
			{children}
		</div>
	),
	VSCodeButton: ({ children, onClick }: any) => (
		<button
			onClick={onClick}
			data-testid={`icon-button-${String((children as any)?.props?.className ?? "").includes("codicon-add") ? "add" : "remove"}`}>
			{children}
		</button>
	),
	VSCodeTextArea: ({ value, onInput, placeholder, ...rest }: any) => (
		<textarea value={value ?? ""} onChange={(event) => onInput?.(event)} placeholder={placeholder} {...rest} />
	),
}))

vi.mock("react-use", () => ({
	useEvent: vi.fn(),
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick, variant, disabled, ...rest }: any) => (
		<button onClick={onClick} disabled={disabled} data-testid={`button-${variant ?? "default"}`} {...rest}>
			{children}
		</button>
	),
	StandardTooltip: ({ children, content }: any) => <div title={content}>{children}</div>,
	AlertDialog: ({ open, children }: any) => (open ? <div data-testid="alert-dialog">{children}</div> : null),
	AlertDialogContent: ({ children }: any) => <div>{children}</div>,
	AlertDialogTitle: ({ children }: any) => <div data-testid="alert-title">{children}</div>,
	AlertDialogDescription: ({ children }: any) => <div>{children}</div>,
	AlertDialogCancel: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	AlertDialogAction: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
	AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
	Tooltip: ({ children }: any) => <>{children}</>,
	TooltipContent: ({ children }: any) => <div>{children}</div>,
	TooltipProvider: ({ children }: any) => <>{children}</>,
	TooltipTrigger: ({ children }: any) => <>{children}</>,
}))

vi.mock("../ModelPicker", () => ({
	ModelPicker: () => <div data-testid="model-picker" />,
}))

vi.mock("@src/components/settings/ModelPicker", () => ({
	ModelPicker: () => <div data-testid="model-picker" />,
}))

vi.mock("../R1FormatSetting", () => ({
	R1FormatSetting: () => <div data-testid="r1-format-setting" />,
}))

vi.mock("@src/components/settings/R1FormatSetting", () => ({
	R1FormatSetting: () => <div data-testid="r1-format-setting" />,
}))

vi.mock("../ThinkingBudget", () => ({
	ThinkingBudget: () => <div data-testid="thinking-budget" />,
}))

vi.mock("@src/components/settings/ThinkingBudget", () => ({
	ThinkingBudget: () => <div data-testid="thinking-budget" />,
}))

// The other settings sections stay out of these replays.
vi.mock("../ApiConfigManager", () => ({ default: () => null }))
vi.mock("../AutoApproveSettings", () => ({ AutoApproveSettings: () => null }))
vi.mock("../CheckpointSettings", () => ({ CheckpointSettings: () => null }))
vi.mock("../NotificationSettings", () => ({ NotificationSettings: () => null }))
vi.mock("../ContextManagementSettings", () => ({ ContextManagementSettings: () => null }))
vi.mock("../TerminalSettings", () => ({ TerminalSettings: () => null }))
vi.mock("../ExperimentalSettings", () => ({ ExperimentalSettings: () => null }))
vi.mock("../LanguageSettings", () => ({ LanguageSettings: () => null }))
vi.mock("../About", () => ({ About: () => null }))
vi.mock("../PromptsSettings", () => ({ default: () => null }))
vi.mock("../SlashCommandsSettings", () => ({ SlashCommandsSettings: () => null }))
vi.mock("../SkillsSettings", () => ({ SkillsSettings: () => null }))
vi.mock("../RulesSettings", () => ({ RulesSettings: () => null }))
vi.mock("../UISettings", () => ({ UISettings: () => null }))
vi.mock("../SettingsSearch", () => ({ SettingsSearch: () => null }))
vi.mock("../SectionHeader", () => ({ SectionHeader: ({ children }: any) => <div>{children}</div> }))
vi.mock("../Section", () => ({ Section: ({ children }: any) => <div>{children}</div> }))
vi.mock("../SearchableSetting", () => ({ SearchableSetting: ({ children }: any) => <div>{children}</div> }))
vi.mock("../useSettingsSearch", () => ({
	SearchIndexProvider: ({ children }: any) => <>{children}</>,
	useSearchIndexRegistry: () => ({ contextValue: { registerSetting: vi.fn() }, index: [] }),
	useSettingsSearch: () => ({
		searchQuery: "",
		setSearchQuery: vi.fn(),
		results: [],
		isOpen: false,
		setIsOpen: vi.fn(),
		clearSearch: vi.fn(),
	}),
}))
vi.mock("@src/components/settings/SearchableSetting", () => ({
	SearchableSetting: ({ children }: any) => <div>{children}</div>,
}))
vi.mock("@src/components/settings/useSettingsSearch", () => ({
	SearchIndexProvider: ({ children }: any) => <>{children}</>,
	useSearchIndexRegistry: () => ({ contextValue: { registerSetting: vi.fn() }, index: [] }),
	useSettingsSearch: () => ({
		searchQuery: "",
		setSearchQuery: vi.fn(),
		results: [],
		isOpen: false,
		setIsOpen: vi.fn(),
		clearSearch: vi.fn(),
	}),
}))
vi.mock("@src/components/modes/ModesView", () => ({ default: () => null }))
vi.mock("@src/components/mcp/McpView", () => ({ default: () => null }))
vi.mock("@src/components/worktrees/WorktreesView", () => ({ WorktreesView: () => null }))
vi.mock("../../common/Tab", () => ({
	Tab: ({ children }: any) => <div>{children}</div>,
	TabContent: React.forwardRef<HTMLDivElement, any>(({ children, ...props }, ref) => (
		<div ref={ref} {...props}>
			{children}
		</div>
	)),
	TabHeader: ({ children }: any) => <div>{children}</div>,
	TabList: ({ children, value, onValueChange }: any) => (
		<div>
			{React.Children.map(children, (child) => {
				if (!React.isValidElement(child)) {
					return child
				}

				const element = child as React.ReactElement<any>
				return React.cloneElement(element, {
					isSelected: element.props.value === value,
					onSelect: () => onValueChange(element.props.value),
				})
			})}
		</div>
	),
	TabTrigger: React.forwardRef<HTMLButtonElement, any>(({ children, onSelect, ...props }, ref) => (
		<button ref={ref} onClick={onSelect} {...props}>
			{children}
		</button>
	)),
}))

// The adapter mounts the real OpenAICompatible editor against the cached state and
// exposes the cached headers plus a non-header control for the replays.
vi.mock("../ApiOptions", async () => {
	const { OpenAICompatible } = await import("../providers/OpenAICompatible")

	return {
		default: ({ apiConfiguration, setApiConfigurationField }: any) => (
			<div>
				<span data-testid="cached-headers">{JSON.stringify(apiConfiguration.openAiHeaders ?? {})}</span>
				<button
					data-testid="probe-other-setting"
					onClick={() => setApiConfigurationField("openAiBaseUrl", "https://probe.example/v1")}>
					probe-other-setting
				</button>
				<OpenAICompatible
					apiConfiguration={apiConfiguration}
					setApiConfigurationField={setApiConfigurationField}
					organizationAllowList={{ allowAll: true, providers: {} }}
				/>
			</div>
		),
	}
})

const HEADERS_TIMEOUT_MS = 350

const createExtensionState = (overrides = {}) => ({
	currentApiConfigName: "default",
	listApiConfigMeta: [],
	uriScheme: "vscode",
	settingsImportedAt: undefined,
	apiConfiguration: {
		apiProvider: providerIdentifiers.openai,
		openAiBaseUrl: "https://initial.example/v1",
		openAiHeaders: {},
	} as ProviderSettings,
	allowedCommands: [],
	deniedCommands: [],
	allowedMaxRequests: undefined,
	allowedMaxCost: undefined,
	language: "en",
	alwaysAllowReadOnly: false,
	alwaysAllowWrite: false,
	alwaysAllowExecute: false,
	alwaysAllowMcp: false,
	alwaysAllowModeSwitch: false,
	alwaysAllowSubtasks: false,
	alwaysDenyUnapprovedCommands: false,
	destructiveCommandGuardEnabled: false,
	telemetrySetting: "unset" as const,
	mcpEnabled: false,
	soundEnabled: false,
	ttsEnabled: false,
	ttsSpeed: 1.0,
	soundVolume: 0.5,
	enableCheckpoints: false,
	experiments: {},
	maxOpenTabsContext: 10,
	maxWorkspaceFiles: 200,
	profileThresholds: {},
	customSupportPrompts: {},
	mode: "code",
	...overrides,
})

const typeHeaderRow = async (index: number, placeholder: string, value: string) => {
	await act(async () => {
		fireEvent.change(screen.getAllByPlaceholderText(placeholder)[index], { target: { value } })
	})
}

const clickSave = async () => {
	await act(async () => {
		fireEvent.click(screen.getByTestId("save-button"))
	})
}

let SettingsView: typeof import("../SettingsView").default

describe("SettingsView headers safety contracts", () => {
	let queryClient: QueryClient

	beforeAll(async () => {
		SettingsView = (await import("../SettingsView")).default
	})

	beforeEach(() => {
		vi.clearAllMocks()
		queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	})

	describe("LoadedHeadersSurvive", () => {
		it.each([
			["empty mount", {}],
			["alpha mount", { "X-Test": "alpha" }],
		])(
			"a profile loaded before any timer replaces %s headers and Save sends it",
			async (_name, mountHeaders) => {
				let extensionState = createExtensionState({
					apiConfiguration: {
						apiProvider: providerIdentifiers.openai,
						openAiBaseUrl: "https://initial.example/v1",
						openAiHeaders: mountHeaders,
					},
				})
				;(useExtensionState as any).mockImplementation(() => extensionState)

				const { rerender } = renderWithExtensionState(<SettingsView onDone={vi.fn()} />, { queryClient })
				await waitFor(() => expect(screen.getByTestId("save-button")).toBeInTheDocument())

				// Deliver a different profile before any delayed write could fire.
				await act(async () => {
					extensionState = createExtensionState({
						currentApiConfigName: "work",
						apiConfiguration: {
							apiProvider: providerIdentifiers.openai,
							openAiBaseUrl: "https://work.example/v1",
							openAiHeaders: { "X-Test": "beta" },
						},
					})
					;(useExtensionState as any).mockImplementation(() => extensionState)
					rerender(<SettingsView onDone={vi.fn()} />)
				})

				// The loaded headers are in the cache right away.
				expect(screen.getByTestId("cached-headers").textContent).toBe(JSON.stringify({ "X-Test": "beta" }))

				// And they are in the editor rows.
				expect(screen.getAllByPlaceholderText("settings:providers.headerName")[0]).toHaveValue("X-Test")
				expect(screen.getAllByPlaceholderText("settings:providers.headerValue")[0]).toHaveValue("beta")

				// Wait past the window where the removed delayed write used to overwrite the cache.
				await act(async () => {
					await new Promise((resolve) => setTimeout(resolve, HEADERS_TIMEOUT_MS))
				})

				expect(screen.getByTestId("cached-headers").textContent).toBe(JSON.stringify({ "X-Test": "beta" }))

				// Change another setting so Save is available, then Save.
				await act(async () => {
					fireEvent.click(screen.getByTestId("probe-other-setting"))
				})
				await clickSave()

				expect(mockPostMessage).toHaveBeenCalledWith({
					type: "upsertApiConfiguration",
					text: "work",
					apiConfiguration: expect.objectContaining({ openAiHeaders: { "X-Test": "beta" } }),
				})
			},
			10000,
		)
	})

	describe("SaveKeepsLatestHeaders", () => {
		it("a header edit saved right away reaches the cache and the Save payload", async () => {
			const extensionState = createExtensionState({
				apiConfiguration: {
					apiProvider: providerIdentifiers.openai,
					openAiBaseUrl: "https://initial.example/v1",
					openAiHeaders: { "X-Test": "alpha" },
				},
			})
			;(useExtensionState as any).mockImplementation(() => extensionState)

			renderWithExtensionState(<SettingsView onDone={vi.fn()} />, { queryClient })
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeInTheDocument())

			// Let the old mount-write window pass first, as the reported replay does.
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, HEADERS_TIMEOUT_MS))
			})

			await typeHeaderRow(0, "settings:providers.headerValue", "beta")

			// The edit is in the cache immediately, without waiting for any timer.
			expect(screen.getByTestId("cached-headers").textContent).toBe(JSON.stringify({ "X-Test": "beta" }))
			expect(screen.getAllByPlaceholderText("settings:providers.headerValue")[0]).toHaveValue("beta")

			// Save right away: the payload carries the new value.
			await clickSave()

			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "upsertApiConfiguration",
				text: "default",
				apiConfiguration: expect.objectContaining({ openAiHeaders: { "X-Test": "beta" } }),
			})
		}, 10000)

		it("a header added and saved right away is included in the Save payload", async () => {
			const extensionState = createExtensionState()
			;(useExtensionState as any).mockImplementation(() => extensionState)

			renderWithExtensionState(<SettingsView onDone={vi.fn()} />, { queryClient })
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeInTheDocument())

			await act(async () => {
				fireEvent.click(screen.getByTestId("icon-button-add"))
			})
			await typeHeaderRow(0, "settings:providers.headerName", "X-Test")
			await typeHeaderRow(0, "settings:providers.headerValue", "alpha")

			expect(screen.getByTestId("cached-headers").textContent).toBe(JSON.stringify({ "X-Test": "alpha" }))

			await clickSave()

			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "upsertApiConfiguration",
				text: "default",
				apiConfiguration: expect.objectContaining({ openAiHeaders: { "X-Test": "alpha" } }),
			})
		}, 10000)

		it("a header removed and saved right away is absent from the Save payload", async () => {
			const extensionState = createExtensionState({
				apiConfiguration: {
					apiProvider: providerIdentifiers.openai,
					openAiBaseUrl: "https://initial.example/v1",
					openAiHeaders: { "X-Test": "alpha" },
				},
			})
			;(useExtensionState as any).mockImplementation(() => extensionState)

			renderWithExtensionState(<SettingsView onDone={vi.fn()} />, { queryClient })
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeInTheDocument())

			await act(async () => {
				fireEvent.click(screen.getByTestId("icon-button-remove"))
			})

			expect(screen.getByTestId("cached-headers").textContent).toBe(JSON.stringify({}))

			await clickSave()

			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "upsertApiConfiguration",
				text: "default",
				apiConfiguration: expect.objectContaining({ openAiHeaders: {} }),
			})
		}, 10000)

		it("a write echo does not reset rows the user is still typing in", async () => {
			const extensionState = createExtensionState({
				apiConfiguration: {
					apiProvider: providerIdentifiers.openai,
					openAiBaseUrl: "https://initial.example/v1",
					openAiHeaders: { "X-Test": "alpha" },
				},
			})
			;(useExtensionState as any).mockImplementation(() => extensionState)

			renderWithExtensionState(<SettingsView onDone={vi.fn()} />, { queryClient })
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeInTheDocument())

			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, HEADERS_TIMEOUT_MS))
			})

			await typeHeaderRow(0, "settings:providers.headerValue", "beta")

			// The immediate write echoes back through the cached state; the input keeps the typed value.
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, HEADERS_TIMEOUT_MS))
			})

			expect(screen.getAllByPlaceholderText("settings:providers.headerValue")[0]).toHaveValue("beta")
			expect(screen.getByTestId("cached-headers").textContent).toBe(JSON.stringify({ "X-Test": "beta" }))
		}, 10000)

		it("an in-progress row with an empty key survives the write round trip", async () => {
			const extensionState = createExtensionState()
			;(useExtensionState as any).mockImplementation(() => extensionState)

			renderWithExtensionState(<SettingsView onDone={vi.fn()} />, { queryClient })
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeInTheDocument())

			await act(async () => {
				fireEvent.click(screen.getByTestId("icon-button-add"))
			})

			// Key still empty: nothing is written to the cache yet, but the row must stay.
			await typeHeaderRow(0, "settings:providers.headerValue", "pending")
			expect(screen.getByTestId("cached-headers").textContent).toBe(JSON.stringify({}))
			expect(screen.getAllByPlaceholderText("settings:providers.headerValue")[0]).toHaveValue("pending")

			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, HEADERS_TIMEOUT_MS))
			})

			expect(screen.getAllByPlaceholderText("settings:providers.headerValue")[0]).toHaveValue("pending")

			// Finishing the key persists the row.
			await typeHeaderRow(0, "settings:providers.headerName", "X-Done")
			expect(screen.getByTestId("cached-headers").textContent).toBe(JSON.stringify({ "X-Done": "pending" }))
		}, 10000)
	})
})
