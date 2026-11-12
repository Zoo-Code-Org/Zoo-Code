import { providerIdentifiers, openAiModelInfoSaneDefaults, type ProviderSettings } from "@roo-code/types"
import { screen, fireEvent, waitFor } from "@testing-library/react"

import { renderWithExtensionState } from "@/utils/test-utils"
import { vi, describe, it, expect, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import React from "react"

import SettingsView from "../SettingsView"
import { vscode } from "@src/utils/vscode"

import { answerSave, lastSaveRequestId } from "./saveAcknowledgement"

const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => {})

const updateSettingsPosts = () =>
	postMessage.mock.calls.map(([message]) => message).filter((message) => message.type === "updateSettings")

// Mock the extension state context
vi.mock("@src/context/ExtensionStateContext", () => ({
	ExtensionStateContextProvider: ({ children }: any) => children,
	useExtensionState: vi.fn(),
}))

// Mock the translation context
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
	useTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Mock UI components
vi.mock("@src/components/ui", () => ({
	ToggleSwitch: ({ checked, onChange, "aria-label": ariaLabel, "data-testid": dataTestId }: any) => (
		<button role="switch" aria-checked={checked} aria-label={ariaLabel} data-testid={dataTestId} onClick={onChange}>
			Toggle
		</button>
	),
	Input: ({ value, onChange, placeholder, id, type, className, ...props }: any) => (
		<input
			type={type || "text"}
			value={value}
			onChange={onChange}
			placeholder={placeholder}
			id={id}
			className={className}
			{...props}
		/>
	),
	Textarea: ({ value, onChange, placeholder, id, className, ...props }: any) => (
		<textarea
			value={value}
			onChange={onChange}
			placeholder={placeholder}
			id={id}
			className={className}
			{...props}
		/>
	),
	Checkbox: ({ checked, onCheckedChange, id, className, ...props }: any) => (
		<input
			type="checkbox"
			checked={checked}
			onChange={(e) => onCheckedChange?.(e.target.checked)}
			id={id}
			className={className}
			{...props}
		/>
	),
	AlertDialog: ({ open, children }: any) => (open ? <div data-testid="alert-dialog">{children}</div> : null),
	AlertDialogContent: ({ children }: any) => <div>{children}</div>,
	AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
	AlertDialogDescription: ({ children }: any) => <div>{children}</div>,
	AlertDialogCancel: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	AlertDialogAction: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
	AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
	Button: ({ children, onClick, disabled, ...props }: any) => (
		<button onClick={onClick} disabled={disabled} {...props}>
			{children}
		</button>
	),
	Tooltip: ({ children }: any) => <>{children}</>,
	TooltipContent: ({ children }: any) => <div>{children}</div>,
	TooltipProvider: ({ children }: any) => <>{children}</>,
	TooltipTrigger: ({ children }: any) => <>{children}</>,
	StandardTooltip: ({ children, content }: any) => <div title={content}>{children}</div>,
	Popover: ({ children }: any) => <>{children}</>,
	PopoverTrigger: ({ children }: any) => <>{children}</>,
	PopoverContent: ({ children }: any) => <div>{children}</div>,
	Select: ({ children, value, onValueChange }: any) => (
		<div data-testid="select" data-value={value}>
			<button onClick={() => onValueChange && onValueChange("test-change")}>{value}</button>
			{children}
		</div>
	),
	SelectContent: ({ children }: any) => <div data-testid="select-content">{children}</div>,
	SelectGroup: ({ children }: any) => <div data-testid="select-group">{children}</div>,
	SelectItem: ({ children, value }: any) => (
		<div data-testid={`select-item-${value}`} data-value={value}>
			{children}
		</div>
	),
	SelectTrigger: ({ children }: any) => <div data-testid="select-trigger">{children}</div>,
	SelectValue: ({ placeholder }: any) => <div data-testid="select-value">{placeholder}</div>,
	Slider: ({ value, onValueChange, "data-testid": dataTestId }: any) => (
		<input
			type="range"
			value={value?.[0] ?? 0}
			onChange={(e) => onValueChange?.([parseFloat(e.target.value)])}
			data-testid={dataTestId}
		/>
	),
	SearchableSelect: ({ value, onValueChange, options, placeholder }: any) => (
		<select value={value} onChange={(e) => onValueChange(e.target.value)} data-testid="searchable-select">
			{placeholder && <option value="">{placeholder}</option>}
			{options?.map((opt: any) => (
				<option key={opt.value} value={opt.value}>
					{opt.label}
				</option>
			))}
		</select>
	),
	Collapsible: ({ children, open }: any) => (
		<div className="collapsible-mock" data-open={open}>
			{children}
		</div>
	),
	CollapsibleTrigger: ({ children, className, onClick }: any) => (
		<div className={`collapsible-trigger-mock ${className || ""}`} onClick={onClick}>
			{children}
		</div>
	),
	CollapsibleContent: ({ children, className }: any) => (
		<div className={`collapsible-content-mock ${className || ""}`}>{children}</div>
	),
	Dialog: ({ children, ...props }: any) => (
		<div data-testid="dialog" {...props}>
			{children}
		</div>
	),
	DialogContent: ({ children, ...props }: any) => (
		<div data-testid="dialog-content" {...props}>
			{children}
		</div>
	),
	DialogHeader: ({ children, ...props }: any) => (
		<div data-testid="dialog-header" {...props}>
			{children}
		</div>
	),
	DialogTitle: ({ children, ...props }: any) => (
		<div data-testid="dialog-title" {...props}>
			{children}
		</div>
	),
	DialogDescription: ({ children, ...props }: any) => (
		<div data-testid="dialog-description" {...props}>
			{children}
		</div>
	),
	DialogFooter: ({ children, ...props }: any) => (
		<div data-testid="dialog-footer" {...props}>
			{children}
		</div>
	),
}))

// Mock ModesView and McpView since they're rendered during indexing
vi.mock("@src/components/modes/ModesView", () => ({
	default: () => null,
}))

vi.mock("@src/components/mcp/McpView", () => ({
	default: ({ mcpEnabled, setMcpEnabled }: any) => (
		<button
			data-testid="mcp-enabled-toggle"
			data-mcp-enabled={String(mcpEnabled)}
			onClick={() => setMcpEnabled(!mcpEnabled)}>
			Toggle MCP
		</button>
	),
}))

// Mock Tab components
vi.mock("../common/Tab", () => ({
	Tab: ({ children }: any) => <div>{children}</div>,
	TabContent: React.forwardRef<HTMLDivElement, any>(({ children }, ref) => <div ref={ref}>{children}</div>),
	TabHeader: ({ children }: any) => <div>{children}</div>,
	TabList: ({ children }: any) => <div data-testid="settings-tab-list">{children}</div>,
	TabTrigger: React.forwardRef<HTMLButtonElement, any>(({ children, onClick }, ref) => (
		<button ref={ref} onClick={onClick}>
			{children}
		</button>
	)),
}))

// Mock child components that are complex
// Mock ApiConfigManager to not interact with props
vi.mock("../ApiConfigManager", () => ({
	default: vi.fn(() => <div data-testid="api-config-manager">ApiConfigManager</div>),
}))

vi.mock("../ApiOptions", () => ({
	default: vi.fn(() => <div data-testid="api-options">ApiOptions</div>),
}))

// Mock other settings components - ensure they don't interact with props
vi.mock("../AutoApproveSettings", () => ({
	AutoApproveSettings: vi.fn(() => <div>AutoApproveSettings</div>),
}))
vi.mock("../CheckpointSettings", () => ({
	CheckpointSettings: vi.fn(() => <div>CheckpointSettings</div>),
}))
vi.mock("../NotificationSettings", () => ({
	NotificationSettings: vi.fn(() => <div>NotificationSettings</div>),
}))
vi.mock("../ContextManagementSettings", () => ({
	ContextManagementSettings: vi.fn(() => <div>ContextManagementSettings</div>),
}))
vi.mock("../TerminalSettings", () => ({
	TerminalSettings: vi.fn(() => <div>TerminalSettings</div>),
}))
vi.mock("../ExperimentalSettings", () => ({
	ExperimentalSettings: vi.fn(() => <div>ExperimentalSettings</div>),
}))
vi.mock("../LanguageSettings", () => ({
	LanguageSettings: vi.fn(() => <div>LanguageSettings</div>),
}))
vi.mock("../About", () => ({
	About: vi.fn(() => <div>About</div>),
}))
vi.mock("../PromptsSettings", () => ({
	default: vi.fn(() => <div>PromptsSettings</div>),
}))
vi.mock("../SlashCommandsSettings", () => ({
	SlashCommandsSettings: vi.fn(() => <div>SlashCommandsSettings</div>),
}))
vi.mock("../UISettings", () => ({
	UISettings: vi.fn(() => <div>UISettings</div>),
}))
vi.mock("../SectionHeader", () => ({
	SectionHeader: ({ children }: any) => <div>{children}</div>,
}))
vi.mock("../Section", () => ({
	Section: ({ children }: any) => <div>{children}</div>,
}))
vi.mock("../SettingsSearch", () => ({
	SettingsSearch: () => null,
}))

import { useExtensionState } from "@src/context/ExtensionStateContext"
import ApiOptions from "../ApiOptions"
import { AutoApproveSettings } from "../AutoApproveSettings"

describe("SettingsView - Unsaved Changes Detection", () => {
	let queryClient: QueryClient

	const defaultExtensionState = {
		currentApiConfigName: "default",
		listApiConfigMeta: [],
		uriScheme: "vscode",
		settingsImportedAt: undefined,
		apiConfiguration: {
			apiProvider: providerIdentifiers.openai,
			apiModelId: "", // Empty string initially
		},
		alwaysAllowReadOnly: false,
		alwaysAllowReadOnlyOutsideWorkspace: false,
		allowedCommands: [],
		deniedCommands: [],
		allowedMaxRequests: undefined,
		allowedMaxCost: undefined,
		language: "en" as const,
		alwaysAllowExecute: false,
		alwaysDenyUnapprovedCommands: false,
		destructiveCommandGuardEnabled: false,
		alwaysAllowMcp: false,
		alwaysAllowModeSwitch: false,
		alwaysAllowSubtasks: false,
		alwaysAllowWrite: false,
		alwaysAllowWriteOutsideWorkspace: false,
		alwaysAllowWriteProtected: false,
		autoCondenseContext: false,
		autoCondenseContextPercent: 50,
		enableCheckpoints: false,
		experiments: {},
		maxOpenTabsContext: 10,
		maxWorkspaceFiles: 200,
		mcpEnabled: false,
		soundEnabled: false,
		ttsEnabled: false,
		ttsSpeed: 1.0,
		soundVolume: 0.5,
		telemetrySetting: "unset" as const,
		terminalOutputLineLimit: 500,
		terminalOutputCharacterLimit: 50000,
		terminalShellIntegrationTimeout: 3000,
		terminalShellIntegrationDisabled: false,
		terminalCommandDelay: 0,
		terminalPowershellCounter: false,
		terminalZshClearEolMark: false,
		terminalZshOhMy: false,
		terminalZshP10k: false,
		terminalZdotdir: false,
		writeDelayMs: 0,
		showRooIgnoredFiles: false,
		maxReadFileLine: -1,
		maxImageFileSize: 5,
		maxTotalImageSize: 20,
		customCondensingPrompt: "",
		customSupportPrompts: {},
		profileThresholds: {},
		alwaysAllowFollowupQuestions: false,
		followupAutoApproveTimeoutMs: undefined,
		includeDiagnosticMessages: false,
		maxDiagnosticMessages: 50,
		includeTaskHistoryInEnhance: true,
		openRouterImageApiKey: undefined,
		openRouterImageGenerationSelectedModel: undefined,
		reasoningBlockCollapsed: true,
	}

	beforeEach(() => {
		vi.clearAllMocks()
		// Reset the ApiOptions mock to its default implementation
		vi.mocked(ApiOptions).mockImplementation(() => {
			// Don't do anything with props, just render a div
			return <div data-testid="api-options">ApiOptions</div>
		})
		queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		})
		;(useExtensionState as any).mockReturnValue(defaultExtensionState)
	})

	it("should not show unsaved changes when settings are automatically initialized", async () => {
		const onDone = vi.fn()

		renderWithExtensionState(<SettingsView onDone={onDone} />, { queryClient })

		// Wait for the component to render
		await waitFor(() => {
			expect(screen.getByTestId("api-options")).toBeInTheDocument()
		})

		// Wait for any async state updates to complete
		await waitFor(() => {
			const saveButton = screen.getByTestId("save-button") as HTMLButtonElement
			expect(saveButton.disabled).toBe(true)
		})

		// Click the Done button
		const doneButton = screen.getByText("settings:common.done")
		fireEvent.click(doneButton)

		// Should not show unsaved changes dialog - onDone should be called immediately
		await waitFor(() => {
			expect(onDone).toHaveBeenCalled()
		})

		// Verify no dialog appeared
		expect(screen.queryByText("settings:unsavedChangesDialog.title")).not.toBeInTheDocument()
	})

	it("should not trigger unsaved changes for automatic model initialization", async () => {
		const onDone = vi.fn()

		// Mock ApiOptions to simulate ModelPicker initialization
		vi.mocked(ApiOptions).mockImplementation(({ setApiConfigurationField, apiConfiguration }) => {
			const [hasInitialized, setHasInitialized] = React.useState(false)

			React.useEffect(() => {
				// Only run once and only if not already initialized
				if (!hasInitialized && apiConfiguration?.apiModelId === "") {
					// Simulate automatic initialization from empty string to a value
					setApiConfigurationField("apiModelId", "default-model", false)
					setHasInitialized(true)
				}
			}, [hasInitialized, apiConfiguration?.apiModelId, setApiConfigurationField])

			return <div data-testid="api-options">ApiOptions with Init</div>
		})

		renderWithExtensionState(<SettingsView onDone={onDone} />, { queryClient })

		// Wait for the component to render and effects to run
		await waitFor(() => {
			expect(screen.getByTestId("api-options")).toBeInTheDocument()
		})

		// Give time for effects to complete
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Check that save button is disabled (no changes detected)
		const saveButton = screen.getByTestId("save-button") as HTMLButtonElement
		expect(saveButton.disabled).toBe(true)

		// Click the Done button
		const doneButton = screen.getByText("settings:common.done")
		fireEvent.click(doneButton)

		// Should not show unsaved changes dialog
		expect(screen.queryByText("settings:unsavedChangesDialog.title")).not.toBeInTheDocument()

		// onDone should be called
		expect(onDone).toHaveBeenCalled()
	})

	it("should show unsaved changes when user makes actual changes", async () => {
		const onDone = vi.fn()

		// Create a custom mock for this test that simulates user interaction
		const ApiOptionsWithButton = vi.fn(({ setApiConfigurationField }) => {
			const handleUserChange = () => {
				// Simulate user action (isUserAction = true by default)
				setApiConfigurationField("apiModelId", "user-selected-model")
			}

			return (
				<div data-testid="api-options">
					<button onClick={handleUserChange} data-testid="change-model">
						Change Model
					</button>
				</div>
			)
		})

		// Override the mock for this specific test
		vi.mocked(ApiOptions).mockImplementation(ApiOptionsWithButton)

		renderWithExtensionState(<SettingsView onDone={onDone} />, { queryClient })

		// Wait for the component to render
		await waitFor(() => {
			expect(screen.getByTestId("api-options")).toBeInTheDocument()
		})

		// Simulate user changing a setting
		const changeButton = screen.getByTestId("change-model")
		fireEvent.click(changeButton)

		// Click the Done button
		const doneButton = screen.getByText("settings:common.done")
		fireEvent.click(doneButton)

		// Should show unsaved changes dialog
		await waitFor(() => {
			expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
		})

		// onDone should not be called yet
		expect(onDone).not.toHaveBeenCalled()
	})

	it("should handle initialization from undefined to value without triggering unsaved changes", async () => {
		const onDone = vi.fn()

		// Start with undefined apiModelId
		const stateWithUndefined = {
			...defaultExtensionState,
			apiConfiguration: {
				apiProvider: providerIdentifiers.openai,
				apiModelId: undefined,
			},
		}
		;(useExtensionState as any).mockReturnValue(stateWithUndefined)

		renderWithExtensionState(<SettingsView onDone={onDone} />, { queryClient })

		// Wait for initialization
		await waitFor(() => {
			expect(screen.getByTestId("api-options")).toBeInTheDocument()
		})

		// Wait for save button to be disabled (no changes)
		await waitFor(() => {
			const saveButton = screen.getByTestId("save-button") as HTMLButtonElement
			expect(saveButton.disabled).toBe(true)
		})

		// Click Done button
		const doneButton = screen.getByText("settings:common.done")
		fireEvent.click(doneButton)

		// Should call onDone immediately without showing dialog
		await waitFor(() => {
			expect(onDone).toHaveBeenCalled()
		})

		// Verify no dialog appeared
		expect(screen.queryByText("settings:unsavedChangesDialog.title")).not.toBeInTheDocument()
	})

	it("should handle initialization from null to value without triggering unsaved changes", async () => {
		const onDone = vi.fn()

		// Start with null apiModelId
		const stateWithNull = {
			...defaultExtensionState,
			apiConfiguration: {
				apiProvider: providerIdentifiers.openai,
				apiModelId: null,
			},
		}
		;(useExtensionState as any).mockReturnValue(stateWithNull)

		renderWithExtensionState(<SettingsView onDone={onDone} />, { queryClient })

		// Wait for initialization
		await waitFor(() => {
			expect(screen.getByTestId("api-options")).toBeInTheDocument()
		})

		// Wait for save button to be disabled (no changes)
		await waitFor(() => {
			const saveButton = screen.getByTestId("save-button") as HTMLButtonElement
			expect(saveButton.disabled).toBe(true)
		})

		// Click Done button
		const doneButton = screen.getByText("settings:common.done")
		fireEvent.click(doneButton)

		// Should call onDone immediately without showing dialog
		await waitFor(() => {
			expect(onDone).toHaveBeenCalled()
		})

		// Verify no dialog appeared
		expect(screen.queryByText("settings:unsavedChangesDialog.title")).not.toBeInTheDocument()
	})

	it("should not trigger changes when ApiOptions syncs model IDs during mount", async () => {
		const onDone = vi.fn()

		// This specifically tests the bug we fixed where ApiOptions' useEffect
		// was syncing selectedModelId with apiModelId and incorrectly triggering
		// change detection because it wasn't passing isUserAction=false

		// Mock ApiOptions to simulate the actual sync behavior
		vi.mocked(ApiOptions).mockImplementation(({ setApiConfigurationField, apiConfiguration }) => {
			const [hasSynced, setHasSynced] = React.useState(false)

			React.useEffect(() => {
				// Simulate the automatic sync that happens in the real component
				// This should NOT trigger unsaved changes because isUserAction=false
				// Only sync once to avoid multiple calls
				if (!hasSynced && apiConfiguration?.apiModelId === "") {
					setApiConfigurationField("apiModelId", "synced-model", false)
					setHasSynced(true)
				}
			}, [hasSynced, apiConfiguration?.apiModelId, setApiConfigurationField])

			return <div data-testid="api-options">ApiOptions</div>
		})

		renderWithExtensionState(<SettingsView onDone={onDone} />, { queryClient })

		// Wait for component to fully mount and ApiOptions effect to run
		await waitFor(() => {
			expect(screen.getByTestId("api-options")).toBeInTheDocument()
		})

		// Wait for any async effects to complete
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Save button should still be disabled (no user changes)
		const saveButton = screen.getByTestId("save-button") as HTMLButtonElement
		expect(saveButton.disabled).toBe(true)

		// Clicking done should not show dialog
		const doneButton = screen.getByText("settings:common.done")
		fireEvent.click(doneButton)

		// Should call onDone directly without showing unsaved changes dialog
		await waitFor(() => {
			expect(onDone).toHaveBeenCalled()
		})

		// No dialog should appear
		expect(screen.queryByText("settings:unsavedChangesDialog.title")).not.toBeInTheDocument()
	})

	it("buffers MCP enablement until Save", async () => {
		renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="mcp" />, { queryClient })

		const toggle = await screen.findByTestId("mcp-enabled-toggle")
		fireEvent.click(toggle)

		await waitFor(() => expect(toggle).toHaveAttribute("data-mcp-enabled", "true"))
		expect(postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ mcpEnabled: true }),
			}),
		)

		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		fireEvent.click(screen.getByTestId("save-button"))

		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ mcpEnabled: true }),
			}),
		)
	})

	it("buffers and saves the complete NanoGPT provider configuration from cached state", async () => {
		const liveApiConfiguration = {
			apiProvider: providerIdentifiers.nanogpt,
			nanoGptApiKey: "original-key",
			nanoGptModelId: "openai/original",
			nanoGptRoutingPreference: "auto" as const,
		}
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			apiConfiguration: liveApiConfiguration,
		})
		vi.mocked(ApiOptions).mockImplementation(({ apiConfiguration, setApiConfigurationField }) => (
			<div>
				<input
					data-testid="cached-nanogpt-key"
					value={apiConfiguration.nanoGptApiKey ?? ""}
					onChange={(event) => setApiConfigurationField("nanoGptApiKey", event.target.value)}
				/>
				<input
					data-testid="cached-nanogpt-model"
					value={apiConfiguration.nanoGptModelId ?? ""}
					onChange={(event) => setApiConfigurationField("nanoGptModelId", event.target.value)}
				/>
				<select
					data-testid="cached-nanogpt-routing"
					value={apiConfiguration.nanoGptRoutingPreference ?? "auto"}
					onChange={(event) =>
						setApiConfigurationField(
							"nanoGptRoutingPreference",
							event.target.value as
								"auto" | "fast" | "cheap" | "latency" | "throughput" | "tools" | "caching",
						)
					}>
					<option value="auto">Automatic</option>
					<option value="tools">Tool-capable</option>
				</select>
			</div>
		))

		renderWithExtensionState(<SettingsView onDone={vi.fn()} />, { queryClient })

		expect(await screen.findByTestId("cached-nanogpt-key")).toHaveValue("original-key")
		expect(screen.getByTestId("cached-nanogpt-model")).toHaveValue("openai/original")
		expect(screen.getByTestId("cached-nanogpt-routing")).toHaveValue("auto")

		fireEvent.change(screen.getByTestId("cached-nanogpt-key"), { target: { value: "unsaved-key" } })
		fireEvent.change(screen.getByTestId("cached-nanogpt-model"), { target: { value: "openai/next" } })
		fireEvent.change(screen.getByTestId("cached-nanogpt-routing"), { target: { value: "tools" } })

		expect(liveApiConfiguration).toEqual({
			apiProvider: providerIdentifiers.nanogpt,
			nanoGptApiKey: "original-key",
			nanoGptModelId: "openai/original",
			nanoGptRoutingPreference: "auto",
		})
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "upsertApiConfiguration" }))

		fireEvent.click(screen.getByTestId("save-button"))

		expect(postMessage).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "default",
			apiConfiguration: {
				apiProvider: providerIdentifiers.nanogpt,
				nanoGptApiKey: "unsaved-key",
				nanoGptModelId: "openai/next",
				nanoGptRoutingPreference: "tools",
			},
		})
	})

	it("keeps OpenAI-compatible reasoning edits cached until Save despite a live state refresh", async () => {
		const configuration: ProviderSettings = {
			apiProvider: providerIdentifiers.openai,
			openAiModelId: "custom-model",
			enableReasoningEffort: false,
			reasoningEffort: "low",
			openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, reasoningEffort: "low" },
		}
		vi.mocked(useExtensionState, { partial: true }).mockReturnValue({
			...defaultExtensionState,
			apiConfiguration: configuration,
		})
		vi.mocked(ApiOptions).mockImplementation(({ apiConfiguration, setApiConfigurationField }) => (
			<button
				data-testid="select-compatible-max"
				onClick={() => {
					setApiConfigurationField("enableReasoningEffort", true)
					setApiConfigurationField("openAiCustomModelInfo", {
						...(apiConfiguration.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
						reasoningEffort: "max",
					})
				}}>
				{apiConfiguration.openAiCustomModelInfo?.reasoningEffort}
			</button>
		))
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} />, { queryClient })
		fireEvent.click(await screen.findByTestId("select-compatible-max"))

		vi.mocked(useExtensionState, { partial: true }).mockReturnValue({
			...defaultExtensionState,
			apiConfiguration: { ...configuration },
		})
		view.rerender(<SettingsView onDone={vi.fn()} />)

		expect(screen.getByTestId("select-compatible-max")).toHaveTextContent("max")
		expect(configuration.enableReasoningEffort).toBe(false)
		expect(configuration.openAiCustomModelInfo?.reasoningEffort).toBe("low")
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "upsertApiConfiguration" }))

		fireEvent.click(screen.getByTestId("save-button"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "default",
			apiConfiguration: {
				...configuration,
				enableReasoningEffort: true,
				openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, reasoningEffort: "max" },
			},
		})
	})

	it("discards NanoGPT cached edits and restores the extension values", async () => {
		const onDone = vi.fn()
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			apiConfiguration: {
				apiProvider: providerIdentifiers.nanogpt,
				nanoGptApiKey: "saved-key",
				nanoGptModelId: "openai/saved",
				nanoGptRoutingPreference: "cheap",
			},
		})
		vi.mocked(ApiOptions).mockImplementation(({ apiConfiguration, setApiConfigurationField }) => (
			<input
				data-testid="cached-nanogpt-key"
				value={apiConfiguration.nanoGptApiKey ?? ""}
				onChange={(event) => setApiConfigurationField("nanoGptApiKey", event.target.value)}
			/>
		))

		renderWithExtensionState(<SettingsView onDone={onDone} />, { queryClient })
		fireEvent.change(await screen.findByTestId("cached-nanogpt-key"), { target: { value: "discard-me" } })
		fireEvent.click(screen.getByText("settings:common.done"))
		fireEvent.click(await screen.findByText("settings:unsavedChangesDialog.discardButton"))

		await waitFor(() => expect(screen.getByTestId("cached-nanogpt-key")).toHaveValue("saved-key"))
		expect(onDone).toHaveBeenCalledOnce()
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "upsertApiConfiguration" }))
	})

	it("buffers and saves the complete IO Intelligence provider configuration from cached state", async () => {
		const liveApiConfiguration = {
			apiProvider: providerIdentifiers.ioIntelligence,
			ioIntelligenceApiKey: "original-key",
			ioIntelligenceModelId: "meta-llama/original",
		}
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			apiConfiguration: liveApiConfiguration,
		})
		vi.mocked(ApiOptions).mockImplementation(({ apiConfiguration, setApiConfigurationField }) => (
			<div>
				<input
					data-testid="cached-ionet-key"
					value={apiConfiguration.ioIntelligenceApiKey ?? ""}
					onChange={(event) => setApiConfigurationField("ioIntelligenceApiKey", event.target.value)}
				/>
				<input
					data-testid="cached-ionet-model"
					value={apiConfiguration.ioIntelligenceModelId ?? ""}
					onChange={(event) => setApiConfigurationField("ioIntelligenceModelId", event.target.value)}
				/>
			</div>
		))

		renderWithExtensionState(<SettingsView onDone={vi.fn()} />, { queryClient })

		expect(await screen.findByTestId("cached-ionet-key")).toHaveValue("original-key")
		expect(screen.getByTestId("cached-ionet-model")).toHaveValue("meta-llama/original")

		fireEvent.change(screen.getByTestId("cached-ionet-key"), { target: { value: "unsaved-key" } })
		fireEvent.change(screen.getByTestId("cached-ionet-model"), { target: { value: "zai-org/next" } })

		expect(liveApiConfiguration).toEqual({
			apiProvider: providerIdentifiers.ioIntelligence,
			ioIntelligenceApiKey: "original-key",
			ioIntelligenceModelId: "meta-llama/original",
		})
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "upsertApiConfiguration" }))

		fireEvent.click(screen.getByTestId("save-button"))

		expect(postMessage).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "default",
			apiConfiguration: {
				apiProvider: providerIdentifiers.ioIntelligence,
				ioIntelligenceApiKey: "unsaved-key",
				ioIntelligenceModelId: "zai-org/next",
			},
		})
	})

	it("keeps an in-flight deny-list edit when an external list update arrives while the dialog is open", async () => {
		// Drive the real cached-state setter through a stand-in auto-approve section so the
		// buffered list edit is indistinguishable from a user typing in the deny list.
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<button
					data-testid="buffer-deny-edit"
					onClick={() => setCachedStateField("deniedCommands", ["git status"])}>
					Buffer deny edit
				</button>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("buffer-deny-edit"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		// The deny list changes in the extension host while the dialog is open.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)

		// The user's unsaved list edit wins over the external update, and Save submits it.
		fireEvent.click(screen.getByTestId("save-button"))
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ deniedCommands: ["git status"] }),
			}),
		)
		expect(postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ deniedCommands: ["rm -rf"] }),
			}),
		)
	})

	it("baselines the save on the pre-edit displayed lists when a state post lands during an in-flight list edit", async () => {
		// The baseline feeds the save's classification of every entry the submitted
		// list omits, so it must hold the lists the dialog displayed BEFORE the
		// in-flight edit. Folding the posted state in would claim the never-displayed
		// entry had been shown, letting the save erase it as a user deletion; folding
		// the edited buffer in would drop an in-flight deletion from the baseline,
		// letting the save resurrect it as an external addition.
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<button
					data-testid="buffer-deny-edit"
					onClick={() => setCachedStateField("deniedCommands", ["git status"])}>
					Buffer deny edit
				</button>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("buffer-deny-edit"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		// A deny entry lands externally while the list edit holds the merge back.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)

		fireEvent.click(screen.getByTestId("save-button"))

		// The submit keeps the in-flight edit, and the baseline stays at the lists
		// displayed before the edit - neither the held-back post's list nor the
		// edited buffer's.
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				commandListBaseline: { allowedCommands: [], deniedCommands: [] },
				updatedSettings: expect.objectContaining({ deniedCommands: ["git status"] }),
			}),
		)
	})

	it("keeps a deleted displayed entry in the save baseline when a state post lands during the deletion", async () => {
		// The deletion counterpart: an entry the dialog displayed and the user then
		// deleted must stay in the baseline, so the save classifies it as a user
		// deletion and applies it. A baseline folded from the deletion-carrying
		// buffer would make the entry look externally added and re-admit it.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
		})
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<button data-testid="clear-deny-list" onClick={() => setCachedStateField("deniedCommands", [])}>
					Clear deny list
				</button>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("clear-deny-list"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		// A coincidental post re-bakes the deny list and adds an entry the dialog
		// never displayed; the held merge keeps the buffered deletion.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf", "docker"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)

		fireEvent.click(screen.getByTestId("save-button"))

		// The baseline retains the deleted (displayed) entry so the save applies the
		// deletion, and excludes the never-displayed "docker" so the save keeps that
		// entry and warns about it instead.
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				commandListBaseline: { allowedCommands: [], deniedCommands: ["rm -rf"] },
				updatedSettings: expect.objectContaining({ deniedCommands: [] }),
			}),
		)
	})

	it("keeps a buffered list edit and its hold on external updates when the save is reported failed", async () => {
		// A failed save must leave the dialog exactly as the user left it: still dirty, and with the
		// in-flight list still holding back external refreshes. Clearing the hold at submit - before
		// the host's answer - would let the post-failure state refresh overwrite the edit on screen.
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField, deniedCommands }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<span data-testid="current-deny-list">{JSON.stringify(deniedCommands)}</span>
					<button
						data-testid="buffer-deny-edit"
						onClick={() => setCachedStateField("deniedCommands", ["git status"])}>
						Buffer deny edit
					</button>
				</div>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("buffer-deny-edit"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		// A display-setting difference between the buffer and the live state puts this save on the
		// path that waits for the host's answer, without touching the buffered command lists.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)

		fireEvent.click(screen.getByTestId("save-button"))

		const saveId = lastSaveRequestId(postMessage)
		expect(saveId).toBeDefined()
		expect(screen.getByTestId("save-button")).toBeDisabled() // waiting for the host's answer
		answerSave(saveId, { success: false, error: "storage unavailable" })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled()) // the failure keeps it dirty

		// The host refreshes state after the rejected write; the edit the user is looking at wins.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify(["git status"]))

		// Retrying submits the buffered edit, not the refresh that tried to replace it. The first save posted the
		// same list, so only the call count plus the last message's list and baseline prove the retry did it.
		fireEvent.click(screen.getByTestId("save-button"))
		const saves = updateSettingsPosts()
		expect(saves).toHaveLength(2)
		expect(saves.at(-1)).toEqual(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ deniedCommands: ["git status"] }),
				commandListBaseline: expect.objectContaining({ deniedCommands: expect.any(Array) }),
			}),
		)
	})

	it("sends a list-only save with no answer id and releases it at submit", async () => {
		// A save that changes only the command lists carries no request id - the answer path needs a
		// display-setting change - so the ack-driven failure retention the neighboring tests pin is
		// unreachable for it. What the current code can prove for a no-requestId save: the hold and the
		// unsaved flag release at submit, and the following state post is classified against the submitted
		// lists - showing the submitted entry (write landed) leaves the dialog clean, while a refresh
		// without it (a rejected write is indistinguishable from an external edit at this point) folds
		// into the dialog without re-dirtying it.
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField, deniedCommands }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<span data-testid="current-deny-list">{JSON.stringify(deniedCommands)}</span>
					<button
						data-testid="buffer-deny-edit"
						onClick={() => setCachedStateField("deniedCommands", ["git status"])}>
						Buffer deny edit
					</button>
				</div>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("buffer-deny-edit"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		fireEvent.click(screen.getByTestId("save-button"))

		// The list-only save posted the edit and asked for no answer.
		expect(updateSettingsPosts()).toHaveLength(1)
		expect(lastSaveRequestId(postMessage)).toBeUndefined()
		// With no answer to wait for, the hold releases at submit and the flag goes clean.
		expect(screen.getByTestId("save-button")).toBeDisabled()

		// The write did not land: the refresh carries the original list. The submitted entry is absent
		// from it, so the merge treats the post as an external change over an already-committed dialog
		// and folds it in - the edit is gone and the flag stays off.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: [],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		await waitFor(() => expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify([])))
		expect(screen.getByTestId("save-button")).toBeDisabled()
	})

	it("reconciles each list's retry baseline with that list's own write outcome after a failed save", async () => {
		// A failed save reports one outcome for the whole payload, yet its writes ran setting by setting: the
		// refresh the host posts before the answer carries each list's configuration result. A list whose own
		// write landed keeps its advanced baseline - its pre-submit baseline no longer describes the file; one
		// that was not written rolls back to the pre-submit baseline, so the user's deletion stays a deletion on
		// retry instead of looking like an external addition the save must re-admit.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo"],
			deniedCommands: ["rm -rf"],
		})
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<button
						data-testid="edit-allow-list"
						onClick={() => setCachedStateField("allowedCommands", ["echo", "ls"])}>
						Edit allow list
					</button>
					<button data-testid="clear-deny-list" onClick={() => setCachedStateField("deniedCommands", [])}>
						Clear deny list
					</button>
				</div>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("edit-allow-list"))
		fireEvent.click(screen.getByTestId("clear-deny-list"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		// A display-setting difference between the buffer and the live state puts this save on the path that
		// waits for the host's answer, without touching the buffered command lists.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo"],
			deniedCommands: ["rm -rf"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)

		fireEvent.click(screen.getByTestId("save-button"))
		const saveId = lastSaveRequestId(postMessage)
		expect(saveId).toBeDefined()

		// The host wrote the allow list before the save failed, and never wrote the deny list: the refresh
		// carries the allow list's new entry but the deny list's unchanged deletion target, then the answer
		// reports the failure.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo", "ls"],
			deniedCommands: ["rm -rf"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(saveId, { success: false, error: "storage unavailable" })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		fireEvent.click(screen.getByTestId("save-button"))
		const saves = updateSettingsPosts()
		expect(saves).toHaveLength(2)
		expect(saves.at(-1)).toEqual(
			expect.objectContaining({
				type: "updateSettings",
				commandListBaseline: { allowedCommands: ["echo", "ls"], deniedCommands: ["rm -rf"] },
				updatedSettings: expect.objectContaining({ allowedCommands: ["echo", "ls"], deniedCommands: [] }),
			}),
		)
	})

	it("releases the buffered list to external updates once the host confirms the save", async () => {
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField, deniedCommands }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<span data-testid="current-deny-list">{JSON.stringify(deniedCommands)}</span>
					<button
						data-testid="buffer-deny-edit"
						onClick={() => setCachedStateField("deniedCommands", ["git status"])}>
						Buffer deny edit
					</button>
				</div>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("buffer-deny-edit"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)

		fireEvent.click(screen.getByTestId("save-button"))
		expect(lastSaveRequestId(postMessage)).toBeDefined() // this save waits for the host's answer
		// The host writes the list before it answers, so the refresh carries the submitted entry; that
		// observation, not the answer alone, is what releases the hold.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["git status"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(lastSaveRequestId(postMessage), { success: true })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())

		// The lists committed, so a later host update is no longer an in-flight edit being stomped.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		await waitFor(() =>
			expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify(["rm -rf"])),
		)
	})

	it("keeps a silently rejected list write dirty and rolls back only its baseline when the host reports success", async () => {
		// The answer reports one outcome for the whole payload, so a rejected command-list write can arrive
		// with success: true. Each edited list's own write result comes from the refresh the host posts before
		// its answer: the allow list carries the submitted entry, so its baseline stays advanced; the deny
		// list comes back unchanged, so its deletion rolls back to the pre-submit baseline and the flag keeps
		// reporting the edit as unsaved instead of silently dropping it.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo"],
			deniedCommands: ["rm -rf"],
		})
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField, deniedCommands }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<span data-testid="current-deny-list">{JSON.stringify(deniedCommands)}</span>
					<button
						data-testid="edit-allow-list"
						onClick={() => setCachedStateField("allowedCommands", ["echo", "ls"])}>
						Edit allow list
					</button>
					<button data-testid="clear-deny-list" onClick={() => setCachedStateField("deniedCommands", [])}>
						Clear deny list
					</button>
				</div>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("edit-allow-list"))
		fireEvent.click(screen.getByTestId("clear-deny-list"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		// A display-setting difference between the buffer and the live state puts this save on the path that
		// waits for the host's answer, without touching the buffered command lists.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo"],
			deniedCommands: ["rm -rf"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)

		fireEvent.click(screen.getByTestId("save-button"))
		const saveId = lastSaveRequestId(postMessage)
		expect(saveId).toBeDefined()

		// The host wrote the allow list but silently rejected the deny-list write, and still answers success:
		// the refresh carries the allow list's new entry and the deny list's old entry back.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo", "ls"],
			deniedCommands: ["rm -rf"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(saveId, { success: true })

		// The unlanded write keeps the flag on, and the buffered deletion keeps holding external updates back.
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo", "ls"],
			deniedCommands: ["docker"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify([]))

		// Retrying classifies each list by its own write result: the landed allow list keeps its advanced
		// baseline, and the rolled-back deny baseline keeps the deletion a user deletion to re-apply.
		fireEvent.click(screen.getByTestId("save-button"))
		const saves = updateSettingsPosts()
		expect(saves).toHaveLength(2)
		expect(saves.at(-1)).toEqual(
			expect.objectContaining({
				type: "updateSettings",
				commandListBaseline: { allowedCommands: ["echo", "ls"], deniedCommands: ["rm -rf"] },
				updatedSettings: expect.objectContaining({ allowedCommands: ["echo", "ls"], deniedCommands: [] }),
			}),
		)
	})

	it("clears the unsaved flag and releases every list when the refresh shows all writes landed", async () => {
		// A save whose every edited list appears landed in the host's refresh clears the flag and
		// releases the buffered lists to external updates.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo"],
			deniedCommands: ["rm -rf"],
		})
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField, deniedCommands }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<span data-testid="current-deny-list">{JSON.stringify(deniedCommands)}</span>
					<button
						data-testid="edit-allow-list"
						onClick={() => setCachedStateField("allowedCommands", ["echo", "ls"])}>
						Edit allow list
					</button>
					<button data-testid="clear-deny-list" onClick={() => setCachedStateField("deniedCommands", [])}>
						Clear deny list
					</button>
				</div>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("edit-allow-list"))
		fireEvent.click(screen.getByTestId("clear-deny-list"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo"],
			deniedCommands: ["rm -rf"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)

		fireEvent.click(screen.getByTestId("save-button"))
		const saveId = lastSaveRequestId(postMessage)
		expect(saveId).toBeDefined()

		// The host wrote both lists before answering: the refresh carries both submitted lists.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo", "ls"],
			deniedCommands: [],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(saveId, { success: true })

		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())

		// The lists committed, so a later host update is no longer an in-flight edit being stomped.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo", "ls"],
			deniedCommands: ["curl"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		await waitFor(() => expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify(["curl"])))
		expect(screen.getByTestId("save-button")).toBeDisabled() // a folded external update is not a user edit
	})

	it("discards IO Intelligence cached edits and restores the extension values", async () => {
		const onDone = vi.fn()
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			apiConfiguration: {
				apiProvider: providerIdentifiers.ioIntelligence,
				ioIntelligenceApiKey: "saved-key",
				ioIntelligenceModelId: "meta-llama/saved",
			},
		})
		vi.mocked(ApiOptions).mockImplementation(({ apiConfiguration, setApiConfigurationField }) => (
			<input
				data-testid="cached-ionet-key"
				value={apiConfiguration.ioIntelligenceApiKey ?? ""}
				onChange={(event) => setApiConfigurationField("ioIntelligenceApiKey", event.target.value)}
			/>
		))

		renderWithExtensionState(<SettingsView onDone={onDone} />, { queryClient })
		fireEvent.change(await screen.findByTestId("cached-ionet-key"), { target: { value: "discard-me" } })
		fireEvent.click(screen.getByText("settings:common.done"))
		fireEvent.click(await screen.findByText("settings:unsavedChangesDialog.discardButton"))

		await waitFor(() => expect(screen.getByTestId("cached-ionet-key")).toHaveValue("saved-key"))
		expect(onDone).toHaveBeenCalledOnce()
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "upsertApiConfiguration" }))
	})
})
