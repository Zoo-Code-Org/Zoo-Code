import { render, screen, fireEvent, waitFor, configure } from "@testing-library/react"
import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"

// Increase timeout for slow CI environments
configure({ asyncUtilTimeout: 10000 })

// Mock vscode API
const mockPostMessage = vi.hoisted(() => vi.fn())
const mockVscode = {
	postMessage: mockPostMessage,
}
;(global as any).acquireVsCodeApi = () => mockVscode

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: mockPostMessage,
	},
}))

import { useExtensionState } from "@src/context/ExtensionStateContext"

// Mock the extension state context
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

const mockTranslate = vi.hoisted(() => (key: string) => key)

// Mock the translation context
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: mockTranslate,
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
	AlertDialogTitle: ({ children }: any) => <div data-testid="alert-title">{children}</div>,
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
	StandardTooltip: ({ children }: any) => <>{children}</>,
	Popover: ({ children }: any) => <>{children}</>,
	PopoverTrigger: ({ children }: any) => <>{children}</>,
	PopoverContent: ({ children }: any) => <div>{children}</div>,
	Tooltip: ({ children }: any) => <>{children}</>,
	TooltipProvider: ({ children }: any) => <>{children}</>,
	TooltipTrigger: ({ children }: any) => <>{children}</>,
	TooltipContent: ({ children }: any) => <div>{children}</div>,
	Command: ({ children }: any) => <div data-testid="command">{children}</div>,
	CommandInput: ({ value, onValueChange }: any) => (
		<input data-testid="command-input" value={value} onChange={(e) => onValueChange(e.target.value)} />
	),
	CommandGroup: ({ children }: any) => <div data-testid="command-group">{children}</div>,
	CommandItem: ({ children, onSelect }: any) => (
		<div data-testid="command-item" onClick={onSelect}>
			{children}
		</div>
	),
	CommandList: ({ children }: any) => <div data-testid="command-list">{children}</div>,
	CommandEmpty: ({ children }: any) => <div data-testid="command-empty">{children}</div>,
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
	default: () => null,
}))

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
vi.mock("@src/components/common/Tab", () => ({
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

// Mock all child components to isolate the test
vi.mock("../ApiConfigManager", () => ({
	default: () => null,
}))

const mockApiOptions = ({ apiConfiguration, setApiConfigurationField }: any) => (
	<div>
		<span data-testid="provider-value">{apiConfiguration.apiProvider}</span>
		<input
			data-testid="baseten-api-key"
			value={apiConfiguration.basetenApiKey ?? ""}
			onChange={(event) => setApiConfigurationField("basetenApiKey", event.target.value)}
		/>
	</div>
)

vi.mock("../ApiOptions", () => ({
	default: mockApiOptions,
}))
vi.mock("@src/components/settings/ApiOptions", () => ({
	default: mockApiOptions,
}))

vi.mock("../AutoApproveSettings", () => ({
	AutoApproveSettings: () => null,
}))

vi.mock("../SectionHeader", () => ({
	SectionHeader: ({ children }: any) => <div>{children}</div>,
}))

vi.mock("../Section", () => ({
	Section: ({ children }: any) => <div>{children}</div>,
}))

vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ children }: any) => <div>{children}</div>,
}))
vi.mock("@src/components/settings/SearchableSetting", () => ({
	SearchableSetting: ({ children }: any) => <div>{children}</div>,
}))
vi.mock("../useSettingsSearch", () => ({
	SearchIndexProvider: ({ children }: any) => <>{children}</>,
	useSearchIndexRegistry: () => ({
		contextValue: { registerSetting: vi.fn() },
		index: [],
	}),
	useSettingsSearch: () => ({
		searchQuery: "",
		setSearchQuery: vi.fn(),
		results: [],
		isOpen: false,
		setIsOpen: vi.fn(),
		clearSearch: vi.fn(),
	}),
}))
vi.mock("@src/components/settings/useSettingsSearch", () => ({
	SearchIndexProvider: ({ children }: any) => <>{children}</>,
	useSearchIndexRegistry: () => ({
		contextValue: { registerSetting: vi.fn() },
		index: [],
	}),
	useSettingsSearch: () => ({
		searchQuery: "",
		setSearchQuery: vi.fn(),
		results: [],
		isOpen: false,
		setIsOpen: vi.fn(),
		clearSearch: vi.fn(),
	}),
}))

// Mock all settings components
vi.mock("../CheckpointSettings", () => ({
	CheckpointSettings: () => null,
}))
vi.mock("../NotificationSettings", () => ({
	NotificationSettings: () => null,
}))
vi.mock("../ContextManagementSettings", () => ({
	ContextManagementSettings: () => null,
}))
vi.mock("../TerminalSettings", () => ({
	TerminalSettings: () => null,
}))
vi.mock("../ExperimentalSettings", () => ({
	ExperimentalSettings: () => null,
}))
vi.mock("../LanguageSettings", () => ({
	LanguageSettings: () => null,
}))
vi.mock("../About", () => ({
	About: () => null,
}))
vi.mock("../PromptsSettings", () => ({
	default: () => null,
}))
vi.mock("../SlashCommandsSettings", () => ({
	SlashCommandsSettings: () => null,
}))
vi.mock("../UISettings", () => ({
	UISettings: () => null,
}))

vi.mock("../SettingsSearch", () => ({
	SettingsSearch: () => null,
}))
vi.mock("@src/components/settings/SettingsSearch", () => ({
	SettingsSearch: () => null,
}))

let SettingsView: typeof import("../SettingsView").default

describe("SettingsView - Autocomplete save round trip", () => {
	let queryClient: QueryClient

	const createExtensionState = (overrides = {}) => ({
		currentApiConfigName: "default",
		listApiConfigMeta: [],
		uriScheme: "vscode",
		settingsImportedAt: undefined,
		apiConfiguration: {
			apiProvider: "openai",
			apiModelId: "",
		},
		alwaysAllowReadOnly: false,
		alwaysAllowReadOnlyOutsideWorkspace: false,
		allowedCommands: [],
		deniedCommands: [],
		allowedMaxRequests: undefined,
		allowedMaxCost: undefined,
		language: "en",
		alwaysAllowExecute: false,
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
		terminalProfile: undefined,
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
		autoCloseZooOpenedFiles: true,
		autoCloseZooOpenedFilesAfterUserEdited: false,
		autoCloseZooOpenedNewFiles: false,
		mode: "code",
		...overrides,
	})

	const getUpdateSettingsPayload = () => {
		const call = mockPostMessage.mock.calls.find(([message]) => message?.type === "updateSettings")
		return call?.[0]?.updatedSettings
	}

	const renderSettings = (overrides = {}, targetSection?: string) => {
		;(useExtensionState as any).mockReturnValue(createExtensionState(overrides))

		return render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection={targetSection} />
			</QueryClientProvider>,
		)
	}

	beforeAll(async () => {
		// Import after mocks are registered so the isolated tests use the
		// lightweight child component mocks above instead of the full settings UI.
		SettingsView = (await import("../SettingsView")).default
	})

	beforeEach(() => {
		vi.clearAllMocks()
		queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		})
	})

	it("includes autocompleteConfig in the updateSettings payload when edited", async () => {
		renderSettings({ autocompleteConfig: { enabled: false } }, "autocomplete")

		const checkbox = await screen.findByTestId("autocomplete-enabled-checkbox")
		await waitFor(() => {
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(true)
		})

		fireEvent.click(checkbox)
		await waitFor(() => {
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(false)
		})

		fireEvent.click(screen.getByTestId("save-button"))

		expect(getUpdateSettingsPayload()).toEqual(
			expect.objectContaining({
				autocompleteConfig: expect.objectContaining({ enabled: true }),
			}),
		)
	})

	it("sends the API key only when the user typed one", async () => {
		renderSettings(
			{
				autocompleteConfig: { enabled: true, provider: "codestral" },
				hasAutocompleteApiKey: true,
			},
			"autocomplete",
		)

		const apiKeyInput = await screen.findByTestId("autocomplete-api-key-input")
		await waitFor(() => {
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(true)
		})

		// An unrelated edit marks the form dirty; saving it must not clobber the stored key.
		fireEvent.input(screen.getByTestId("autocomplete-model-input"), {
			target: { value: "codestral-latest" },
		})
		await waitFor(() => {
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(false)
		})

		fireEvent.click(screen.getByTestId("save-button"))

		expect(getUpdateSettingsPayload()).toEqual(
			expect.objectContaining({
				autocompleteConfig: expect.objectContaining({ provider: "codestral" }),
			}),
		)
		expect(getUpdateSettingsPayload()).not.toHaveProperty("autocompleteApiKey")

		// Now type a key: the save payload must carry it (and only then).
		mockPostMessage.mockClear()
		fireEvent.input(apiKeyInput, { target: { value: "sk-test" } })
		await waitFor(() => {
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(false)
		})

		fireEvent.click(screen.getByTestId("save-button"))

		expect(getUpdateSettingsPayload()).toEqual(
			expect.objectContaining({
				autocompleteApiKey: "sk-test",
			}),
		)
	})

	it("does not re-send the API key on a later save once the draft was consumed", async () => {
		renderSettings(
			{
				autocompleteConfig: { enabled: true, provider: "codestral" },
				hasAutocompleteApiKey: true,
			},
			"autocomplete",
		)

		await screen.findByTestId("autocomplete-api-key-input")
		await waitFor(() => {
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(true)
		})

		fireEvent.input(screen.getByTestId("autocomplete-api-key-input"), { target: { value: "sk-test" } })
		await waitFor(() => {
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(false)
		})

		fireEvent.click(screen.getByTestId("save-button"))
		expect(getUpdateSettingsPayload()).toEqual(
			expect.objectContaining({
				autocompleteApiKey: "sk-test",
			}),
		)

		// Edit another field and save again: the consumed draft must be omitted.
		mockPostMessage.mockClear()
		fireEvent.input(screen.getByTestId("autocomplete-model-input"), {
			target: { value: "codestral-2501" },
		})
		await waitFor(() => {
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(false)
		})

		fireEvent.click(screen.getByTestId("save-button"))

		expect(getUpdateSettingsPayload()).not.toHaveProperty("autocompleteApiKey")
		expect(getUpdateSettingsPayload()).toEqual(
			expect.objectContaining({
				autocompleteConfig: expect.objectContaining({ modelId: "codestral-2501" }),
			}),
		)
	})

	it("mounts headlessly during search indexing without posting any messages", async () => {
		// SettingsView cycles every section at opacity-0 on mount to build the search
		// index. The autocomplete section must not post model-fetch or settings
		// messages for every user who simply opens the settings panel.
		renderSettings({ autocompleteConfig: { enabled: true, provider: "ollama" } })

		await waitFor(() => {
			expect(screen.getByTestId("save-button")).toBeInTheDocument()
		})

		// Indexing is complete once no changes have been detected on mount.
		await waitFor(() => {
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(true)
		})

		expect(mockPostMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
			}),
		)
		expect(mockPostMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "autocompleteModels",
			}),
		)
	})
})
