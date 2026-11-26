import { providerIdentifiers, openAiModelInfoSaneDefaults, type ProviderSettings } from "@roo-code/types"
import { act, screen, fireEvent, waitFor } from "@testing-library/react"

import { renderWithExtensionState } from "@/utils/test-utils"
import { vi, describe, it, expect, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import React from "react"

import SettingsView, { SAVE_ANSWER_TIMEOUT_MS } from "../SettingsView"
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
import { About } from "../About"
import { ExperimentalSettings } from "../ExperimentalSettings"

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

	afterEach(() => {
		vi.useRealTimers()
	})

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

	it("keeps an in-flight deny-list edit when an external list update arrives while the dialog is open", async () => {
		// Drive the real setter through a double section, so the buffered edit looks
		// like a user edit.
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

	it("folds an external list update into the buffer after a no-op list set or a non-list edit", async () => {
		// Only an edit that changes a list claims ownership. A no-op set or a
		// non-list edit must leave the lists open to external updates.
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField, deniedCommands }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<span data-testid="current-deny-list">{JSON.stringify(deniedCommands)}</span>
					<button
						data-testid="edit-non-list-setting"
						onClick={() => setCachedStateField("alwaysAllowReadOnly", true)}>
						Edit a non-list setting
					</button>
					<button
						data-testid="noop-deny-set"
						onClick={() => setCachedStateField("deniedCommands", deniedCommands)}>
						Re-set the displayed deny list
					</button>
				</div>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		// An edit outside the lists leaves them open, so the external deny entry enters the buffer.
		fireEvent.click(await screen.findByTestId("edit-non-list-setting"))
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		await waitFor(() =>
			expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify(["rm -rf"])),
		)

		// A re-set to the same array changes nothing, so the next update folds in.
		fireEvent.click(screen.getByTestId("noop-deny-set"))
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["docker"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		await waitFor(() =>
			expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify(["docker"])),
		)
	})

	it("baselines the save on the pre-edit displayed lists when a state post lands during an in-flight list edit", async () => {
		// The baseline must hold the lists displayed before the edit. Folding the post
		// in would let the save erase a never-displayed entry as a deletion, and
		// folding the buffer in would resurrect an in-flight deletion.
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

		// The submit keeps the in-flight edit, and the baseline stays at the pre-edit lists.
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				commandListBaseline: { allowedCommands: [], deniedCommands: [] },
				updatedSettings: expect.objectContaining({ deniedCommands: ["git status"] }),
			}),
		)
	})

	it("keeps a deleted displayed entry in the save baseline when a state post lands during the deletion", async () => {
		// The reverse case: a displayed entry that the user then deleted must stay in
		// the baseline so the save applies the deletion. A buffer-folded baseline
		// would re-admit it as an external addition.
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

		// A coincidental post adds a never-displayed entry, and the held merge keeps the deletion.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf", "docker"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)

		fireEvent.click(screen.getByTestId("save-button"))

		// The baseline keeps the deleted entry so the save applies the deletion. It
		// excludes the never-displayed "docker", so the save keeps it and warns.
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				commandListBaseline: { allowedCommands: [], deniedCommands: ["rm -rf"] },
				updatedSettings: expect.objectContaining({ deniedCommands: [] }),
			}),
		)
	})

	it("keeps a buffered list edit and its hold on external updates when the save is reported failed", async () => {
		// A failed save must leave the dialog as the user left it. Releasing the hold
		// at submit would let the post-failure refresh overwrite the edit on screen.
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

		// A display-setting difference routes this save through the answered path,
		// without touching the buffered command lists.
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

		// The host refreshes after the rejected write, and the edit the user is looking at wins.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify(["git status"]))

		// The retry submits the buffered edit, not the replacing refresh. The call
		// count plus the last baseline prove the retry did it.
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

	it("requests an answer for a list-only save and keeps the buffered edit when the host reports failure", async () => {
		// A rejected list write arrives through the same answer as a failed display
		// write, so a list-only save carries a request id and the answer decides.
		// Releasing the hold at submit would show a rejected write as saved.
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

		expect(updateSettingsPosts()).toHaveLength(1)
		const saveId = lastSaveRequestId(postMessage)
		expect(saveId).toBeDefined()
		expect(screen.getByTestId("save-button")).toBeDisabled() // waiting for the host's answer

		// The host refreshes with the write unlanded, so the submitted entry is absent, then reports failure.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: [],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(saveId, { success: false, error: "storage unavailable" })

		// The failure keeps the edit on screen, still holds the refresh back, and leaves the form dirty.
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify(["git status"]))
	})

	it("clears the unsaved flag for a list-only save the host confirms, releasing the lists to updates", async () => {
		// The success case: the refresh shows the submitted list, so the settle releases the
		// hold and the flag. A later change enters without setting the flag again.
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
		const saveId = lastSaveRequestId(postMessage)
		expect(saveId).toBeDefined()

		// The host writes the list before it answers, so the refresh carries the submitted entry.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["git status"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(saveId, { success: true })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())

		// The lists committed, so a later host update cannot overwrite an in-flight edit.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		await waitFor(() =>
			expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify(["rm -rf"])),
		)
		expect(screen.getByTestId("save-button")).toBeDisabled()
	})

	it("reconciles each list's retry baseline with that list's own write outcome after a failed save", async () => {
		// A failed save reports one outcome, yet each list's write result comes from the refresh
		// before the answer. A landed list keeps its advanced baseline, and an unwritten one
		// rolls back, so a deletion stays a user deletion on retry.
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

		// A display-setting difference routes this save through the answered path,
		// without touching the buffered command lists.
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

		// The host wrote the allow list but not the deny list, then reported failure,
		// so the refresh carries only the allow list's new entry.
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
		// The host writes the list before answering. Observing the submitted entry in
		// the refresh, not the answer alone, releases the hold.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["git status"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(lastSaveRequestId(postMessage), { success: true })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())

		// The lists committed, so a later host update cannot overwrite an in-flight edit.
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
		// One answer covers the whole payload, so a rejected list write can arrive
		// with success set to true. Each list's own result comes from the refresh. The
		// allow list carries the submitted entry and keeps its advanced baseline. The
		// deny list comes back unchanged, so its deletion rolls back. The flag stays
		// on.
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

		// A display-setting difference routes this save through the answered path,
		// without touching the buffered command lists.
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

		// The host wrote the allow list but silently rejected the deny write, and
		// still answered success.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo", "ls"],
			deniedCommands: ["rm -rf"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(saveId, { success: true })

		// The unlanded write keeps the flag on and the deletion holds updates back.
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo", "ls"],
			deniedCommands: ["docker"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify([]))

		// Retry classifies each list by its own result: the landed allow list keeps
		// its advanced baseline, and the rolled-back deny baseline keeps the deletion.
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

	it("releases the unsaved flag after a save when a refused external update changed nothing", async () => {
		// A refused external post changes nothing, so the merge must leave the buffer
		// object untouched. The save settles by comparing the live buffer against the
		// exact object it submitted. An equal-valued copy would count as a mid-save
		// edit and keep the flag on.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
		})
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField, deniedCommands }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<span data-testid="current-deny-list">{JSON.stringify(deniedCommands)}</span>
					<button data-testid="clear-deny-list" onClick={() => setCachedStateField("deniedCommands", [])}>
						Clear deny list
					</button>
				</div>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("clear-deny-list"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		// The display difference puts the save on the answered path. Its lists repeat
		// what the dialog displayed, so the held merge rejects them.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)

		fireEvent.click(screen.getByTestId("save-button"))
		const saveId = lastSaveRequestId(postMessage)
		expect(saveId).toBeDefined()

		// The host posts the file's changed lists before this save's write. The
		// in-flight deletion still refuses them, so the post must not touch the buffer.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf", "docker"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify([]))

		// The write lands and the answer reports success: the buffer is what was
		// submitted, so the flag goes off.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: [],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(saveId, { success: true })

		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
	})

	it("settles the save against the refreshed state posted just before the answer", async () => {
		// The host posts the refresh before its answer, and the settle must see that
		// refresh: the submitted list there records the write as landed. Using the
		// pre-refresh state would report a landed write as missing.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
		})
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<button data-testid="clear-deny-list" onClick={() => setCachedStateField("deniedCommands", [])}>
						Clear deny list
					</button>
					<button
						data-testid="edit-allow-list"
						onClick={() => setCachedStateField("allowedCommands", ["echo"])}>
						Edit allow list
					</button>
				</div>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("clear-deny-list"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		// A display-setting difference routes this save through the answered path,
		// without touching the buffered command lists.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)

		fireEvent.click(screen.getByTestId("save-button"))
		const saveId = lastSaveRequestId(postMessage)
		expect(saveId).toBeDefined()

		// The refresh posts with the landed deletion, and the success answer follows it immediately.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: [],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(saveId, { success: true })

		// The settle saw the refreshed list: the write counts as landed and the flag goes off.
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())

		// No rollback either: the advanced baseline survives, so a re-edit posts
		// the landed list as the displayed baseline.
		fireEvent.click(screen.getByTestId("edit-allow-list"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		fireEvent.click(screen.getByTestId("save-button"))
		const saves = updateSettingsPosts()
		expect(saves).toHaveLength(2)
		expect(saves.at(-1)).toEqual(
			expect.objectContaining({
				type: "updateSettings",
				commandListBaseline: expect.objectContaining({ deniedCommands: [] }),
			}),
		)
	})

	it("keeps the submitted buffer when an equal-valued list restatement arrives during a later pending save", async () => {
		// A post with value-equal lists must leave the buffer object untouched, even
		// when it differs from the baseline in the gate slot. The save settles by
		// comparing the buffer against the exact object it submitted, and fresh
		// equal-valued arrays would count as a mid-save edit.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
		})
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<button data-testid="clear-deny-list" onClick={() => setCachedStateField("deniedCommands", [])}>
						Clear deny list
					</button>
					<button
						data-testid="edit-other-setting"
						onClick={() => setCachedStateField("alwaysAllowReadOnly", true)}>
						Edit a non-list setting
					</button>
				</div>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		// An in-flight deletion, then an external gate flip. The flip enters the
		// buffer while the held-back lists keep the baseline at the pre-flip gate.
		fireEvent.click(await screen.findByTestId("clear-deny-list"))
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
			workspaceCommandListsEnabled: true,
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		// The display difference puts this save on the answered path. The refresh
		// shows the deletion landed, so the answer releases the flag and the hold.
		fireEvent.click(screen.getByTestId("save-button"))
		const deleteSaveId = lastSaveRequestId(postMessage)
		expect(deleteSaveId).toBeDefined()
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: [],
			workspaceCommandListsEnabled: true,
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(deleteSaveId, { success: true })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())

		// A second save follows: a non-list edit sets the flag again. The host restates
		// the file with fresh equal-valued arrays, and the lists match the buffer. The
		// merge therefore folds nothing, and the buffer stays the submitted object.
		fireEvent.click(screen.getByTestId("edit-other-setting"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		fireEvent.click(screen.getByTestId("save-button"))
		const formatSaveId = lastSaveRequestId(postMessage)
		expect(formatSaveId).toBeDefined()
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: [],
			workspaceCommandListsEnabled: true,
			showRelativeTimes: false,
			timeFormat: "24h",
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(formatSaveId, { success: true })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
	})

	it("clears the unsaved flag and releases every list when the refresh shows all writes landed", async () => {
		// Every edited list landed in the refresh, so the flag clears and the lists
		// accept external updates again.
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

		// The lists committed, so a later host update cannot overwrite an in-flight edit.
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

	it("settles a save as clean when the host merges its refresh, and stays dirty for a user edit during the save", async () => {
		// A host refresh that lands during a pending save replaces the edit buffer on
		// its own, so the settle must not read the replacement as unsaved work. A real
		// edit in the same window must still keep the form dirty.
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField, deniedCommands }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<span data-testid="current-deny-list">{JSON.stringify(deniedCommands)}</span>
					<button
						data-testid="edit-allow-list"
						onClick={() => setCachedStateField("allowedCommands", ["echo", "ls"])}>
						Edit allow list
					</button>
					<button
						data-testid="edit-non-list-setting"
						onClick={() => setCachedStateField("alwaysAllowReadOnly", true)}>
						Edit a non-list setting
					</button>
				</div>
			),
		)

		const submitListEdit = async () => {
			;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
				...defaultExtensionState,
				allowedCommands: ["echo"],
			})
			const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
				queryClient,
			})
			fireEvent.click(await screen.findByTestId("edit-allow-list"))
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
			fireEvent.click(screen.getByTestId("save-button"))
			return view
		}

		// First case: the host flips the gate and restates the submitted lists. The
		// lists match the submission, so this refresh is an automatic merge.
		const mergedView = await submitListEdit()
		const mergeSaveId = lastSaveRequestId(postMessage)
		expect(mergeSaveId).toBeDefined()
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo", "ls"],
			workspaceCommandListsEnabled: true,
		})
		mergedView.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(mergeSaveId, { success: true })

		// The merge left nothing unsaved, so the form is clean and the lists are open again.
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo", "ls"],
			deniedCommands: ["rm -rf"],
			workspaceCommandListsEnabled: true,
		})
		mergedView.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		await waitFor(() =>
			expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify(["rm -rf"])),
		)
		expect(screen.getByTestId("save-button")).toBeDisabled()
		mergedView.unmount()

		// Second case: the user edits a cached field while the save is pending. The
		// refresh still matches the submission, yet the form must stay dirty.
		const editedView = await submitListEdit()
		const editedSaveId = lastSaveRequestId(postMessage)
		expect(editedSaveId).toBeDefined()
		fireEvent.click(screen.getByTestId("edit-non-list-setting"))
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo", "ls"],
			workspaceCommandListsEnabled: true,
		})
		editedView.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(editedSaveId, { success: true })

		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		editedView.unmount()
	})

	it("keeps the form dirty when a sibling setter edits a field during a pending save", async () => {
		// The settle must recognise a user edit from every setter that can change the
		// buffer, not only the generic field setter. Each sibling section below is
		// driven in its own render; both run inside this one test so the suite's
		// declared test count moves by exactly one.
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<button
						data-testid="edit-allow-list"
						onClick={() => setCachedStateField("allowedCommands", ["echo", "ls"])}>
						Edit allow list
					</button>
				</div>
			),
		)
		vi.mocked(ExperimentalSettings).mockImplementation(
			({ setExperimentEnabled }: React.ComponentProps<typeof ExperimentalSettings>) => (
				<button data-testid="edit-sibling" onClick={() => setExperimentEnabled("imageGeneration", true)}>
					Edit an experiment
				</button>
			),
		)
		vi.mocked(About).mockImplementation(({ setTelemetrySetting }: React.ComponentProps<typeof About>) => (
			<button data-testid="edit-sibling" onClick={() => setTelemetrySetting("enabled")}>
				Edit telemetry
			</button>
		))

		const siblingSections = ["experimental", "about"] as const

		for (const siblingSection of siblingSections) {
			;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
				...defaultExtensionState,
				allowedCommands: ["echo"],
			})
			const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
				queryClient,
			})

			// A list edit starts the save, so the settle has a submission to reconcile.
			fireEvent.click(await screen.findByTestId("edit-allow-list"))
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
			fireEvent.click(screen.getByTestId("save-button"))
			const saveId = lastSaveRequestId(postMessage)
			expect(saveId).toBeDefined()
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())

			// While the save is pending, the user edits a field through a sibling setter.
			view.rerender(<SettingsView onDone={vi.fn()} targetSection={siblingSection} />)
			fireEvent.click(await screen.findByTestId("edit-sibling"))

			// The host's refresh carries the submitted list, so that write landed and only
			// the edit made during the save can keep the form dirty.
			;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
				...defaultExtensionState,
				allowedCommands: ["echo", "ls"],
			})
			view.rerender(<SettingsView onDone={vi.fn()} targetSection={siblingSection} />)
			answerSave(saveId, { success: true })

			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
			view.unmount()
		}
	})

	it("re-enables Save for a new edit after the answer settles the previous save", async () => {
		// Save is disabled while the answer is outstanding, so only an edit made after
		// the answer proves the settlement was applied rather than merely pending.
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<button data-testid="edit-allow-list" onClick={() => setCachedStateField("allowedCommands", ["echo"])}>
					Edit allow list
				</button>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("edit-allow-list"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		fireEvent.click(screen.getByTestId("save-button"))
		const saveId = lastSaveRequestId(postMessage)
		expect(saveId).toBeDefined()

		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["echo"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(saveId, { success: true })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())

		// The settle ran: the form went clean, and a fresh edit raises it again.
		fireEvent.click(screen.getByTestId("edit-allow-list"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
	})

	it("settles an answer handled before the state post commits, and applies a held answer on the timeout", async () => {
		// The host posts the refreshed lists and then the answer, as two separate
		// messages. When the answer is handled first, the dialog's copy still holds the
		// pre-save lists. Judging the write against them reports a landed write as
		// failed, so the answer waits for the post to commit. With no commit at all, the
		// existing timeout applies the held answer instead of leaving it unapplied.
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField, deniedCommands }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<span data-testid="current-deny-list">{JSON.stringify(deniedCommands)}</span>
					<button data-testid="clear-deny-list" onClick={() => setCachedStateField("deniedCommands", [])}>
						Clear deny list
					</button>
				</div>
			),
		)

		// Both cases start from a dialog holding an unsaved deletion.
		const openWithPendingDeletion = async () => {
			;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
				...defaultExtensionState,
				deniedCommands: ["rm -rf"],
			})
			const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
				queryClient,
			})
			fireEvent.click(await screen.findByTestId("clear-deny-list"))
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
			return view
		}

		// First case: the answer arrives before the post commits, and that post then
		// releases it. The settlement sees the landed deletion, so the form goes clean.
		const committed = await openWithPendingDeletion()
		fireEvent.click(screen.getByTestId("save-button"))
		const committedId = lastSaveRequestId(postMessage)
		expect(committedId).toBeDefined()
		answerSave(committedId, { success: true })
		expect(screen.getByTestId("save-button")).toBeDisabled()

		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: [],
		})
		committed.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
		expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify([]))
		committed.unmount()

		// Second case: the answer is held and no post ever follows. The timeout applies
		// it, so the save stops waiting instead of leaving the result unapplied. Fake
		// timers start before Save, because the timeout is armed by the save's own effect.
		const uncommitted = await openWithPendingDeletion()
		vi.useFakeTimers()
		fireEvent.click(screen.getByTestId("save-button"))
		const uncommittedId = lastSaveRequestId(postMessage)
		expect(uncommittedId).toBeDefined()
		answerSave(uncommittedId, { success: true })
		expect(screen.getByTestId("save-button")).toBeDisabled()

		await act(async () => {
			await vi.advanceTimersByTimeAsync(SAVE_ANSWER_TIMEOUT_MS)
		})
		vi.useRealTimers()

		// The held answer was applied, so the save is no longer pending. The deletion
		// never landed in any post, so the edit stays on screen for retry.
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify([]))
		uncommitted.unmount()
	})

	it("holds a save answer through an unrelated state post until the save's own lists arrive", async () => {
		// The host posts its state for reasons unrelated to a save, and such a post
		// repeats the command lists the dialog dispatched from. Judging the answer
		// against those lists reports a landed write as failed, so the answer must wait
		// for the post carrying the save's own lists.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
		})
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField, deniedCommands }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<span data-testid="current-deny-list">{JSON.stringify(deniedCommands)}</span>
					<button data-testid="clear-deny-list" onClick={() => setCachedStateField("deniedCommands", [])}>
						Clear deny list
					</button>
				</div>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("clear-deny-list"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		fireEvent.click(screen.getByTestId("save-button"))
		const saveId = lastSaveRequestId(postMessage)
		expect(saveId).toBeDefined()

		// A post unrelated to this save commits before the answer: the same lists, a
		// different payload. It is not the post the answer is owed.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(saveId, { success: true })

		// Still held, so the save stays pending: settling here would read the pre-save
		// lists and leave the form dirty with Save enabled.
		expect(screen.getByTestId("save-button")).toBeDisabled()
		expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify([]))

		// A second unrelated post lands while the answer is held. It still repeats the
		// dispatched lists, so it must not apply the answer either.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
			showRelativeTimes: false,
			maxOpenTabsContext: 11,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		expect(screen.getByTestId("save-button")).toBeDisabled()

		// The post carrying the save's own lists arrives, and the held answer applies
		// against it: the deletion landed, so the form goes clean.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: [],
			showRelativeTimes: false,
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
		view.unmount()
	})

	it("keeps the discarded baseline when a pending save settles after the user discards", async () => {
		// A discard during a pending save replaces the buffer the save submitted. The
		// late answer must not write the baseline it captured from that buffer: doing so
		// would make the next save apply a list the user already discarded.
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
		fireEvent.click(screen.getByTestId("save-button"))
		const saveId = lastSaveRequestId(postMessage)
		expect(saveId).toBeDefined()

		// Another writer replaces the list while the save is pending. The user then
		// discards, so the dialog shows the new list and owns it as its baseline.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["docker"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		fireEvent.click(screen.getByText("settings:common.done"))
		fireEvent.click(await screen.findByText("settings:unsavedChangesDialog.discardButton"))

		// The answer arrives after the discard, describing the buffer that is gone.
		answerSave(saveId, { success: false, error: "storage unavailable" })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())

		// The discarded baseline stands: the next save submits the list the discard
		// restored, not the pre-discard baseline the settled save captured.
		fireEvent.click(screen.getByTestId("clear-deny-list"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		fireEvent.click(screen.getByTestId("save-button"))
		const saves = updateSettingsPosts()
		expect(saves.at(-1)).toEqual(
			expect.objectContaining({
				type: "updateSettings",
				commandListBaseline: expect.objectContaining({ deniedCommands: ["docker"] }),
			}),
		)
	})

	it("releases a reordered but landed list and disables Save", async () => {
		// The host returns the list in its own order. A landed write must be recognised
		// from what the list contains, not from where each entry sits, or a successful
		// save leaves Save enabled.
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<button
					data-testid="edit-allow-list"
					onClick={() => setCachedStateField("allowedCommands", ["echo", "ls"])}>
					Edit allow list
				</button>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("edit-allow-list"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		fireEvent.click(screen.getByTestId("save-button"))
		const saveId = lastSaveRequestId(postMessage)
		expect(saveId).toBeDefined()

		// Both submitted entries landed, in the host's order rather than the dialog's.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			allowedCommands: ["ls", "echo"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(saveId, { success: true })

		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
	})

	it("adopts a host list that arrived while the lists were held", async () => {
		// A deny entry the host posted during the hold is not shown, because the held
		// list edit outranks it. Once the save releases the hold, that entry must become
		// visible without waiting for another state post.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["rm -rf"],
		})
		vi.mocked(AutoApproveSettings).mockImplementation(
			({ setCachedStateField, deniedCommands }: React.ComponentProps<typeof AutoApproveSettings>) => (
				<div>
					<span data-testid="current-deny-list">{JSON.stringify(deniedCommands)}</span>
					<button data-testid="clear-deny-list" onClick={() => setCachedStateField("deniedCommands", [])}>
						Clear deny list
					</button>
				</div>
			),
		)
		const view = renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />, {
			queryClient,
		})

		fireEvent.click(await screen.findByTestId("clear-deny-list"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		fireEvent.click(screen.getByTestId("save-button"))
		const saveId = lastSaveRequestId(postMessage)
		expect(saveId).toBeDefined()

		// The host posts the landed deletion together with an entry another writer
		// added. The held edit keeps that entry off screen for now.
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			...defaultExtensionState,
			deniedCommands: ["docker"],
		})
		view.rerender(<SettingsView onDone={vi.fn()} targetSection="autoApprove" />)
		answerSave(saveId, { success: true })

		// Releasing the hold adopts the posted list, so the added entry shows.
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
		await waitFor(() =>
			expect(screen.getByTestId("current-deny-list")).toHaveTextContent(JSON.stringify(["docker"])),
		)
	})
})
