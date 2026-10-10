// pnpm --filter @roo-code/vscode-webview test src/components/settings/__tests__/SettingsView.spec.tsx

import type { ChangeEvent, ComponentProps } from "react"

import { makeExtensionState, renderWithExtensionState, screen, fireEvent, within, waitFor } from "@/utils/test-utils"
import { act, cleanup } from "@testing-library/react"

import { vscode } from "@/utils/vscode"
import { DEFAULT_CHECKPOINT_TIMEOUT_SECONDS, type ProviderSettings } from "@roo-code/types"
import type { ApiOptionsProps } from "../ApiOptions"

import SettingsView from "../SettingsView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

// SettingsView hands the buffered api configuration to the provider section, so the
// save round trip can be observed without rendering the whole provider tree.
vi.mock("../ApiOptions", () => ({
	__esModule: true,
	default: ({
		apiConfiguration,
		setApiConfigurationField,
	}: Pick<ApiOptionsProps, "apiConfiguration" | "setApiConfigurationField">) => (
		<div data-testid="api-options">
			<span data-testid="received-strict">{String(apiConfiguration?.openAiStrictToolSchemas)}</span>
			<button
				data-testid="set-strict-true"
				onClick={() => setApiConfigurationField("openAiStrictToolSchemas", true)}
			/>
			<button
				data-testid="set-strict-false"
				onClick={() => setApiConfigurationField("openAiStrictToolSchemas", false)}
			/>
			<button
				data-testid="set-other-field"
				onClick={() => setApiConfigurationField("openAiBaseUrl", "https://example.test")}
			/>
		</div>
	),
}))
vi.mock("../ApiConfigManager", () => ({
	__esModule: true,
	default: ({ currentApiConfigName }: any) => (
		<div data-testid="api-config-management">
			<span>Current config: {currentApiConfigName}</span>
		</div>
	),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick, appearance, "data-testid": dataTestId }: any) =>
		appearance === "icon" ? (
			<button
				onClick={onClick}
				className="codicon codicon-close"
				aria-label="Remove command"
				data-testid={dataTestId}>
				<span className="codicon codicon-close" />
			</button>
		) : (
			<button onClick={onClick} data-appearance={appearance} data-testid={dataTestId}>
				{children}
			</button>
		),
	VSCodeCheckbox: ({ children, onChange, checked, "data-testid": dataTestId }: any) => (
		<label>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange({ target: { checked: e.target.checked } })}
				aria-label={typeof children === "string" ? children : undefined}
				data-testid={dataTestId}
			/>
			{children}
		</label>
	),
	VSCodeTextField: ({ value, onInput, placeholder, "data-testid": dataTestId }: any) => (
		<input
			type="text"
			value={value}
			onChange={(e) => onInput({ target: { value: e.target.value } })}
			placeholder={placeholder}
			data-testid={dataTestId}
		/>
	),
	VSCodeLink: ({ children, href }: any) => <a href={href || "#"}>{children}</a>,
	VSCodeRadio: ({ value, checked, onChange }: any) => (
		<input type="radio" value={value} checked={checked} onChange={onChange} />
	),
	VSCodeRadioGroup: ({ children, onChange }: any) => <div onChange={onChange}>{children}</div>,
	VSCodeTextArea: ({ value, onChange, rows, className, "data-testid": dataTestId }: any) => (
		<textarea
			value={value}
			onChange={onChange}
			rows={rows}
			className={className}
			data-testid={dataTestId}
			role="textbox"
		/>
	),
	VSCodeDropdown: ({
		children,
		value,
		onChange,
		"data-testid": dataTestId,
		...props
	}: ComponentProps<"select"> & { "data-testid"?: string }) => (
		<select
			data-testid={dataTestId}
			value={value}
			onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange?.(e)}
			{...props}>
			{children}
		</select>
	),
	VSCodeOption: ({ children, value, ...props }: ComponentProps<"option">) => (
		<option value={value} {...props}>
			{children}
		</option>
	),
}))

vi.mock("../../../components/common/Tab", () => ({
	...vi.importActual("../../../components/common/Tab"),
	Tab: ({ children }: any) => <div data-testid="tab-container">{children}</div>,
	TabHeader: ({ children }: any) => <div data-testid="tab-header">{children}</div>,
	TabContent: ({ children, "data-testid": dataTestId }: any) => (
		<div data-testid={dataTestId || "tab-content"}>{children}</div>
	),
	TabList: ({ children, value, onValueChange, "data-testid": dataTestId }: any) => {
		// Store onValueChange in a global variable so TabTrigger can access it
		;(window as any).__onValueChange = onValueChange
		return (
			<div data-testid={dataTestId} data-value={value}>
				{children}
			</div>
		)
	},
	TabTrigger: ({ children, value, "data-testid": dataTestId, onClick, isSelected }: any) => {
		// This function simulates clicking on a tab and making its content visible
		const handleClick = () => {
			if (onClick) onClick()
			// Access onValueChange from the global variable
			const onValueChange = (window as any).__onValueChange
			if (onValueChange) onValueChange(value)
			// Make all tab contents invisible
			document.querySelectorAll("[data-tab-content]").forEach((el) => {
				;(el as HTMLElement).style.display = "none"
			})
			// Make this tab's content visible
			const tabContent = document.querySelector(`[data-tab-content="${value}"]`)
			if (tabContent) {
				;(tabContent as HTMLElement).style.display = "block"
			}
		}

		return (
			<button data-testid={dataTestId} data-value={value} data-selected={isSelected} onClick={handleClick}>
				{children}
			</button>
		)
	},
}))

vi.mock("@/components/ui", () => ({
	...vi.importActual("@/components/ui"),
	ToggleSwitch: ({ checked, onChange, "aria-label": ariaLabel, "data-testid": dataTestId }: any) => (
		<button role="switch" aria-checked={checked} aria-label={ariaLabel} data-testid={dataTestId} onClick={onChange}>
			Toggle
		</button>
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
	Popover: ({ children }: any) => <div data-testid="popover">{children}</div>,
	PopoverTrigger: ({ children }: any) => <div data-testid="popover-trigger">{children}</div>,
	PopoverContent: ({ children }: any) => <div data-testid="popover-content">{children}</div>,
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
	Slider: ({ value, onValueChange, "data-testid": dataTestId }: any) => (
		<input
			type="range"
			value={value?.[0] ?? 0}
			onChange={(e) => onValueChange?.([parseFloat(e.target.value)])}
			data-testid={dataTestId}
		/>
	),
	Button: ({ children, onClick, variant, className, disabled, "data-testid": dataTestId }: any) => (
		<button
			onClick={onClick}
			disabled={disabled}
			data-variant={variant}
			className={className}
			data-testid={dataTestId}>
			{children}
		</button>
	),
	StandardTooltip: ({ children, content }: any) => <div title={content}>{children}</div>,
	Input: ({ value, onChange, placeholder, "data-testid": dataTestId }: any) => (
		<input type="text" value={value} onChange={onChange} placeholder={placeholder} data-testid={dataTestId} />
	),
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
	AlertDialog: ({ children, open }: any) => (
		<div data-testid="alert-dialog" data-open={open}>
			{children}
		</div>
	),
	AlertDialogContent: ({ children }: any) => <div data-testid="alert-dialog-content">{children}</div>,
	AlertDialogHeader: ({ children }: any) => <div data-testid="alert-dialog-header">{children}</div>,
	AlertDialogTitle: ({ children }: any) => <div data-testid="alert-dialog-title">{children}</div>,
	AlertDialogDescription: ({ children }: any) => <div data-testid="alert-dialog-description">{children}</div>,
	AlertDialogFooter: ({ children }: any) => <div data-testid="alert-dialog-footer">{children}</div>,
	AlertDialogAction: ({ children, onClick }: any) => (
		<button data-testid="alert-dialog-action" onClick={onClick}>
			{children}
		</button>
	),
	AlertDialogCancel: ({ children, onClick }: any) => (
		<button data-testid="alert-dialog-cancel" onClick={onClick}>
			{children}
		</button>
	),
	// Add Collapsible components
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

// Mock window.postMessage to trigger state hydration
const mockPostMessage = (state: any) => {
	window.postMessage(
		{
			type: "state",
			state: {
				version: "1.0.0",
				clineMessages: [],
				taskHistory: [],
				shouldShowAnnouncement: false,
				allowedCommands: [],
				alwaysAllowExecute: false,
				alwaysDenyUnapprovedCommands: false,
				ttsEnabled: false,
				ttsSpeed: 1,
				soundEnabled: false,
				soundVolume: 0.5,
				...state,
			},
		},
		"*",
	)
}

const renderSettingsView = (initialState: any = {}) => {
	const onDone = vi.fn()

	const result = renderWithExtensionState(<SettingsView onDone={onDone} />)

	// Hydrate initial state.
	act(() => {
		mockPostMessage(initialState)
	})

	// Helper function to activate a tab and ensure its content is visible
	const activateTab = (tabId: string) => {
		// Skip trying to find and click the tab, just directly render with the target section
		// This bypasses the actual tab clicking mechanism but ensures the content is shown
		result.rerender(<SettingsView onDone={onDone} targetSection={tabId} />)
	}

	// Helper to get elements within the settings content (not the indexing container)
	const getSettingsContent = () => screen.getByTestId("settings-content")

	return { onDone, activateTab, getSettingsContent, unmount: result.unmount }
}

describe("SettingsView - Sound Settings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("initializes with tts disabled by default", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		const ttsCheckbox = within(content).getByTestId("tts-enabled-checkbox")
		expect(ttsCheckbox).not.toBeChecked()

		// Speed slider should not be visible when tts is disabled
		expect(within(content).queryByTestId("tts-speed-slider")).not.toBeInTheDocument()
	})

	it("initializes with sound disabled by default", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")
		expect(soundCheckbox).not.toBeChecked()

		// Volume slider should not be visible when sound is disabled
		expect(within(content).queryByTestId("sound-volume-slider")).not.toBeInTheDocument()
	})

	it("toggles tts setting and sends message to VSCode", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		const ttsCheckbox = within(content).getByTestId("tts-enabled-checkbox")

		// Enable tts
		fireEvent.click(ttsCheckbox)
		expect(ttsCheckbox).toBeChecked()

		// Click Save to save settings
		const saveButton = screen.getByTestId("save-button")
		fireEvent.click(saveButton)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					ttsEnabled: true,
				}),
			}),
		)
	})

	it("toggles sound setting and sends message to VSCode", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")

		// Enable sound
		fireEvent.click(soundCheckbox)
		expect(soundCheckbox).toBeChecked()

		// Click Save to save settings
		const saveButton = screen.getByTestId("save-button")
		fireEvent.click(saveButton)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					soundEnabled: true,
				}),
			}),
		)
	})

	it("saves the selected chat font size and persists null on reset", () => {
		const { activateTab, getSettingsContent } = renderSettingsView()

		activateTab("ui")

		const content = getSettingsContent()
		const slider = within(content).getByTestId("chat-font-size-slider")

		// Pick a size, then Save — the boundary should forward it to the host.
		fireEvent.change(slider, { target: { value: "18" } })
		fireEvent.click(screen.getByTestId("save-button"))

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ chatFontSize: 18 }),
			}),
		)

		for (const [request] of vi.mocked(vscode.postMessage).mock.calls.slice(-4)) {
			act(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "settingsSaveResult", requestId: request.requestId, success: true },
					}),
				),
			)
		}

		// Reset clears the override; it is persisted as null (not undefined).
		fireEvent.click(within(getSettingsContent()).getByTestId("chat-font-size-reset"))
		fireEvent.click(screen.getByTestId("save-button"))

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ chatFontSize: null }),
			}),
		)
	})

	it("saves fallback defaults for checkpoint and terminal settings", async () => {
		const { activateTab, getSettingsContent } = renderSettingsView({
			enableCheckpoints: undefined,
			checkpointTimeout: undefined,
			terminalShellIntegrationTimeout: undefined,
			settingsImportedAt: new Date().toISOString(),
		})

		activateTab("notifications")
		const content = getSettingsContent()
		fireEvent.click(await within(content).findByTestId("sound-enabled-checkbox"))
		fireEvent.click(screen.getByTestId("save-button"))

		await waitFor(() =>
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "updateSettings",
					updatedSettings: expect.objectContaining({
						soundEnabled: true,
						enableCheckpoints: false,
						checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
						terminalShellIntegrationTimeout: 30_000,
					}),
				}),
			),
		)
	})

	it("shows tts slider when sound is enabled", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		// Enable tts
		const ttsCheckbox = within(content).getByTestId("tts-enabled-checkbox")
		fireEvent.click(ttsCheckbox)

		// Speed slider should be visible
		const speedSlider = within(content).getByTestId("tts-speed-slider")
		expect(speedSlider).toBeInTheDocument()
		expect(speedSlider).toHaveValue("1")
	})

	it("shows volume slider when sound is enabled", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		// Enable sound
		const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")
		fireEvent.click(soundCheckbox)

		// Volume slider should be visible
		const volumeSlider = within(content).getByTestId("sound-volume-slider")
		expect(volumeSlider).toBeInTheDocument()
		expect(volumeSlider).toHaveValue("0.5")
	})

	it("updates speed and sends message to VSCode when slider changes", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		// Enable tts
		const ttsCheckbox = within(content).getByTestId("tts-enabled-checkbox")
		fireEvent.click(ttsCheckbox)

		// Change speed
		const speedSlider = within(content).getByTestId("tts-speed-slider")
		fireEvent.change(speedSlider, { target: { value: "0.75" } })

		// Click Save to save settings
		const saveButton = screen.getByTestId("save-button")
		fireEvent.click(saveButton)

		// Verify message sent to VSCode
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					ttsSpeed: 0.75,
				}),
			}),
		)
	})

	it("updates volume and sends message to VSCode when slider changes", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		// Enable sound
		const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")
		fireEvent.click(soundCheckbox)

		// Change volume
		const volumeSlider = within(content).getByTestId("sound-volume-slider")
		fireEvent.change(volumeSlider, { target: { value: "0.75" } })

		// Click Save to save settings
		const saveButton = screen.getByTestId("save-button")
		fireEvent.click(saveButton)

		// Verify message sent to VSCode
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					soundVolume: 0.75,
				}),
			}),
		)
	})
})

describe("SettingsView - API Configuration", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders ApiConfigManagement with correct props", () => {
		renderSettingsView()

		expect(screen.getByTestId("api-config-management")).toBeInTheDocument()
	})
})

describe("SettingsView - Allowed Commands", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("shows allowed commands section when alwaysAllowExecute is enabled", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the autoApprove tab
		activateTab("autoApprove")

		const content = getSettingsContent()
		// Enable always allow execute
		const executeCheckbox = within(content).getByTestId("always-allow-execute-toggle")
		fireEvent.click(executeCheckbox)
		// Verify allowed commands section appears
		expect(within(content).getByTestId("allowed-commands-heading")).toBeInTheDocument()
		expect(within(content).getByTestId("command-input")).toBeInTheDocument()
	})

	it("adds new command to the list", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the autoApprove tab
		activateTab("autoApprove")

		const content = getSettingsContent()
		// Enable always allow execute
		const executeCheckbox = within(content).getByTestId("always-allow-execute-toggle")
		fireEvent.click(executeCheckbox)

		// Add a new command
		const input = within(content).getByTestId("command-input")
		fireEvent.change(input, { target: { value: "npm test" } })

		const addButton = within(content).getByTestId("add-command-button")
		fireEvent.click(addButton)

		// Verify command was added
		expect(within(content).getByText("npm test")).toBeInTheDocument()

		// Adding a command must NOT persist before Save; it only buffers in cachedState.
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ allowedCommands: ["npm test"] }),
			}),
		)
	})

	it("removes command from the list", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the autoApprove tab
		activateTab("autoApprove")

		const content = getSettingsContent()
		// Enable always allow execute
		const executeCheckbox = within(content).getByTestId("always-allow-execute-toggle")
		fireEvent.click(executeCheckbox)

		// Add a command
		const input = within(content).getByTestId("command-input")
		fireEvent.change(input, { target: { value: "npm test" } })
		const addButton = within(content).getByTestId("add-command-button")
		fireEvent.click(addButton)

		// Remove the command
		const removeButton = within(content).getByTestId("remove-command-0")
		fireEvent.click(removeButton)

		// Verify command was removed
		expect(within(content).queryByText("npm test")).not.toBeInTheDocument()

		// Removing a command must NOT persist before Save; it only buffers in cachedState.
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ allowedCommands: expect.anything() }),
			}),
		)
	})

	describe("SettingsView - Tab Navigation", () => {
		beforeEach(() => {
			vi.clearAllMocks()
		})

		it("renders with providers tab active by default", () => {
			renderSettingsView()

			// Check that the tab list is rendered
			const tabList = screen.getByTestId("settings-tab-list")
			expect(tabList).toBeInTheDocument()

			// Check that providers content is visible
			expect(screen.getByTestId("api-config-management")).toBeInTheDocument()
		})

		it("shows unsaved changes dialog when clicking Done with unsaved changes", () => {
			// Render once and get the activateTab helper
			const { activateTab, getSettingsContent } = renderSettingsView()

			// Activate the notifications tab
			activateTab("notifications")

			const content = getSettingsContent()
			// Make a change to create unsaved changes
			const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")
			fireEvent.click(soundCheckbox)

			// Click the Done button
			const doneButton = screen.getByText("settings:common.done")
			fireEvent.click(doneButton)

			// Check that unsaved changes dialog is shown
			expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
		})
	})
})

describe("SettingsView - Duplicate Commands", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("prevents duplicate commands", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the autoApprove tab
		activateTab("autoApprove")

		const content = getSettingsContent()
		// Enable always allow execute
		const executeCheckbox = within(content).getByTestId("always-allow-execute-toggle")
		fireEvent.click(executeCheckbox)

		// Add a command twice
		const input = within(content).getByTestId("command-input")
		const addButton = within(content).getByTestId("add-command-button")

		// First addition
		fireEvent.change(input, { target: { value: "npm test" } })
		fireEvent.click(addButton)

		// Second addition attempt
		fireEvent.change(input, { target: { value: "npm test" } })
		fireEvent.click(addButton)

		// Verify command appears only once in active tab
		const commands = within(content).getAllByText("npm test")
		expect(commands).toHaveLength(1)
	})

	it("saves allowed commands when clicking Save", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the autoApprove tab
		activateTab("autoApprove")

		const content = getSettingsContent()
		// Enable always allow execute
		const executeCheckbox = within(content).getByTestId("always-allow-execute-toggle")
		fireEvent.click(executeCheckbox)

		// Add a command
		const input = within(content).getByTestId("command-input")
		fireEvent.change(input, { target: { value: "npm test" } })
		const addButton = within(content).getByTestId("add-command-button")
		fireEvent.click(addButton)

		// Click Save
		const saveButton = screen.getByTestId("save-button")
		fireEvent.click(saveButton)

		// Verify VSCode messages were sent
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					allowedCommands: ["npm test"],
				}),
			}),
		)
	})

	it("reverts and does not persist allowed commands when discarding unsaved changes", () => {
		// Render once and get the activateTab helper
		const { onDone, activateTab, getSettingsContent } = renderSettingsView()

		// Activate the autoApprove tab
		activateTab("autoApprove")

		const content = getSettingsContent()
		// Enable always allow execute
		const executeCheckbox = within(content).getByTestId("always-allow-execute-toggle")
		fireEvent.click(executeCheckbox)

		// Add a command (buffers into cachedState, must not persist yet)
		const input = within(content).getByTestId("command-input")
		fireEvent.change(input, { target: { value: "npm test" } })
		const addButton = within(content).getByTestId("add-command-button")
		fireEvent.click(addButton)

		// Verify the command was buffered and rendered before discarding it
		expect(within(content).getByText("npm test")).toBeInTheDocument()

		// Click Done, which opens the unsaved-changes dialog since a change is detected
		const doneButton = screen.getByText("settings:common.done")
		fireEvent.click(doneButton)

		// Confirm discard
		const discardButton = screen.getByTestId("alert-dialog-action")
		fireEvent.click(discardButton)

		// Discarding must never persist the buffered command edit
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ allowedCommands: ["npm test"] }),
			}),
		)

		// The buffered edit must be reverted before leaving Settings
		expect(within(getSettingsContent()).queryByText("npm test")).not.toBeInTheDocument()
		expect(onDone).toHaveBeenCalledTimes(1)
	})
})

describe("SettingsView - Blanket Auto-Deny", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// Completes the persisted-setting round trip required by the repo's
	// AGENTS.md "Persisted Setting Checklist" for the blanket auto-deny
	// toggle: UI binding buffers in cachedState, and only Save persists the
	// value to the extension host.
	it("saves the blanket auto-deny toggle when clicking Save", () => {
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the autoApprove tab
		activateTab("autoApprove")

		const content = getSettingsContent()
		// Enable always allow execute to reveal the execute section
		const executeCheckbox = within(content).getByTestId("always-allow-execute-toggle")
		fireEvent.click(executeCheckbox)

		// Enable blanket auto-deny
		const autoDenyCheckbox = within(content).getByTestId("auto-deny-unapproved-checkbox")
		fireEvent.click(autoDenyCheckbox)
		expect(autoDenyCheckbox).toBeChecked()

		// Click Save to save settings
		const saveButton = screen.getByTestId("save-button")
		fireEvent.click(saveButton)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					alwaysDenyUnapprovedCommands: true,
				}),
			}),
		)
	})

	it("posts blanket auto-deny as false when the setting is unset", () => {
		// The submit path coerces an omitted setting to false
		// (`alwaysDenyUnapprovedCommands ?? false`) rather than omitting the
		// key, so the host always receives an explicit boolean.
		const { activateTab, getSettingsContent } = renderSettingsView({
			alwaysDenyUnapprovedCommands: undefined,
		})

		// Activate the autoApprove tab
		activateTab("autoApprove")

		const content = getSettingsContent()
		// Enable always allow execute to reveal the execute section; the
		// auto-deny toggle stays un-checked.
		const executeCheckbox = within(content).getByTestId("always-allow-execute-toggle")
		fireEvent.click(executeCheckbox)
		expect(within(content).getByTestId("auto-deny-unapproved-checkbox")).not.toBeChecked()

		// Click Save to save settings
		const saveButton = screen.getByTestId("save-button")
		fireEvent.click(saveButton)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					alwaysDenyUnapprovedCommands: false,
				}),
			}),
		)
	})

	it("buffers the blanket auto-deny toggle until Save", () => {
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the autoApprove tab
		activateTab("autoApprove")

		const content = getSettingsContent()
		// Enable always allow execute to reveal the execute section
		const executeCheckbox = within(content).getByTestId("always-allow-execute-toggle")
		fireEvent.click(executeCheckbox)

		// Toggle blanket auto-deny on
		const autoDenyCheckbox = within(content).getByTestId("auto-deny-unapproved-checkbox")
		fireEvent.click(autoDenyCheckbox)
		expect(autoDenyCheckbox).toBeChecked()

		// Toggling must NOT persist before Save; it only buffers in cachedState.
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ alwaysDenyUnapprovedCommands: true }),
			}),
		)

		// Save now persists the buffered value.
		fireEvent.click(screen.getByTestId("save-button"))

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ alwaysDenyUnapprovedCommands: true }),
			}),
		)
	})
})

describe("SettingsView - openAiStrictToolSchemas save round trip", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	const renderWithConfig = (apiConfiguration: ProviderSettings) => {
		const onDone = vi.fn()
		renderWithExtensionState(<SettingsView onDone={onDone} targetSection={"providers"} />, {
			state: { currentApiConfigName: "test-config", apiConfiguration },
		})
	}

	const posted = () =>
		vi
			.mocked(vscode.postMessage)
			.mock.calls.map((call) => call[0])
			.find((message) => message?.type === "upsertApiConfiguration")

	it("restores the control from a loaded API configuration", () => {
		// The control must show the stored value rather than the display default, so
		// a saved false survives a reload.
		renderWithConfig({ openAiStrictToolSchemas: false })
		expect(screen.getByTestId("received-strict").textContent).toBe("false")
	})

	it("buffers the change and persists it only on Save", () => {
		renderWithConfig({ openAiStrictToolSchemas: true })
		fireEvent.click(screen.getByTestId("set-strict-false"))
		// Toggling buffers in cachedState; nothing is persisted before Save.
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "upsertApiConfiguration" }))
		fireEvent.click(screen.getByTestId("save-button"))
		expect(posted()).toEqual(
			expect.objectContaining({
				type: "upsertApiConfiguration",
				text: "test-config",
				apiConfiguration: expect.objectContaining({ openAiStrictToolSchemas: false }),
			}),
		)
	})

	it("persists a toggled-on value as true in the upsert payload", () => {
		// The save path must carry the value the user set, not only the loaded one:
		// toggling on from a stored false and saving has to put true in the payload.
		renderWithConfig({ openAiStrictToolSchemas: false })
		fireEvent.click(screen.getByTestId("set-strict-true"))
		fireEvent.click(screen.getByTestId("save-button"))
		expect(posted()?.apiConfiguration?.openAiStrictToolSchemas).toBe(true)
	})

	it("saves a loaded false back as false when toggled on and off again", () => {
		renderWithConfig({ openAiStrictToolSchemas: false })
		fireEvent.click(screen.getByTestId("set-strict-true"))
		fireEvent.click(screen.getByTestId("set-strict-false"))
		fireEvent.click(screen.getByTestId("save-button"))
		expect(posted()?.apiConfiguration?.openAiStrictToolSchemas).toBe(false)
	})

	it("leaves an unset value unset instead of writing the display default", () => {
		// The control shows the display default, but saving must not materialise it:
		// a config that never stored the setting stays unset.
		renderWithConfig({})
		expect(screen.getByTestId("received-strict").textContent).toBe("undefined")
		// Make a change elsewhere so Save is enabled, then save.
		fireEvent.click(screen.getByTestId("set-other-field"))
		fireEvent.click(screen.getByTestId("save-button"))
		expect(posted()?.apiConfiguration?.openAiBaseUrl).toBe("https://example.test")
		expect(posted()?.apiConfiguration?.openAiStrictToolSchemas).toBeUndefined()
	})
})

describe("SettingsView - Chat Appearance Save Payload", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("saves the selected chat input effect and table striping", () => {
		renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="ui" />, {
			state: makeExtensionState({ chatInputEffect: "marquee", tableStriped: false }),
		})
		const content = within(screen.getByTestId("settings-content"))

		fireEvent.change(content.getByTestId("chat-input-effect-dropdown"), { target: { value: "breathing" } })
		fireEvent.click(content.getByTestId("table-striped-checkbox"))

		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
		fireEvent.click(screen.getByTestId("save-button"))

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ chatInputEffect: "breathing", tableStriped: true }),
			}),
		)
	})

	it("saves false when table striping is turned off", () => {
		renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="ui" />, {
			state: makeExtensionState({ tableStriped: true }),
		})
		const content = within(screen.getByTestId("settings-content"))

		fireEvent.click(content.getByTestId("table-striped-checkbox"))
		fireEvent.click(screen.getByTestId("save-button"))

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ tableStriped: false }),
			}),
		)
	})

	it("saves marquee and unstriped tables when the settings are unset", () => {
		renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="ui" />, {
			state: makeExtensionState({ chatInputEffect: undefined, tableStriped: undefined }),
		})
		const content = within(screen.getByTestId("settings-content"))

		// Make an unrelated edit so Save is enabled while both appearance settings remain unset.
		fireEvent.change(content.getByTestId("chat-font-size-slider"), { target: { value: "18" } })
		fireEvent.click(screen.getByTestId("save-button"))

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ chatInputEffect: "marquee", tableStriped: false }),
			}),
		)
	})
})

describe("settings save acknowledgment", () => {
	function beginSave() {
		const view = renderSettingsView()
		view.activateTab("notifications")
		const checkbox = within(view.getSettingsContent()).getByTestId("tts-enabled-checkbox")
		fireEvent.click(checkbox)
		const save = screen.getByTestId("save-button")
		fireEvent.click(save)
		const request = vi
			.mocked(vscode.postMessage)
			.mock.calls.filter(([message]) => message.type === "updateSettings")
			.at(-1)?.[0]
		expect(request?.requestId).toBeDefined()
		return { save, checkbox, requestId: request?.requestId, onDone: view.onDone, unmount: view.unmount }
	}

	function respond(requestId: string | undefined, success: boolean) {
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "settingsSaveResult",
						requestId,
						success,
						unsavedSettings: success ? [] : ["chatInputEffect", "tableStriped"],
					},
				}),
			),
		)
	}

	function respondToOtherWrites() {
		for (const [request] of vi.mocked(vscode.postMessage).mock.calls.slice(-3)) {
			respond(request.requestId, true)
		}
	}

	it.each(["updateSettings", "upsertApiConfiguration", "telemetrySetting", "debugSetting"])(
		"waits for every write and retains dirty state when %s fails",
		(failedType) => {
			const { save } = beginSave()
			const requests = vi
				.mocked(vscode.postMessage)
				.mock.calls.slice(-4)
				.map(([message]) => message)
			expect(new Set(requests.map((request) => request.requestId)).size).toBe(4)
			const failed = requests.find((request) => request.type === failedType)!
			// Complete in reverse order, leaving the failure until last.
			for (const request of [...requests].reverse().filter((request) => request !== failed)) {
				respond(request.requestId, true)
				expect(save).toBeDisabled()
				respond(request.requestId, true) // Duplicate acknowledgements cannot complete a save.
				expect(save).toBeDisabled()
			}
			respond(failed.requestId, false)
			expect(save).toBeEnabled()
			expect(screen.getByRole("alert")).toBeInTheDocument()
		},
	)

	it("clears dirty state only after all four writes succeed", () => {
		const { save, requestId, onDone } = beginSave()
		respond(requestId, true)
		expect(save).toBeDisabled()
		respondToOtherWrites()
		expect(save).toBeDisabled()
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "settings:common.done" }))
		expect(onDone).toHaveBeenCalledTimes(1)
	})

	it("retains dirty edits on partial failure and clears them only after a successful retry", () => {
		const { save, checkbox, requestId } = beginSave()
		expect(save).toBeDisabled()
		respond("unrelated", true)
		expect(save).toBeDisabled()
		respond(requestId, false)
		respondToOtherWrites()
		expect(screen.getByRole("alert")).toHaveTextContent("chatInputEffect, tableStriped")
		expect(checkbox).toBeChecked()
		expect(save).toBeEnabled()
		fireEvent.click(save)
		const retry = vi
			.mocked(vscode.postMessage)
			.mock.calls.filter(([message]) => message.type === "updateSettings")
			.at(-1)?.[0]
		expect(retry?.requestId).not.toBe(requestId)
		respond(requestId, false)
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		respond(retry?.requestId, true)
		respondToOtherWrites()
		expect(save).toBeDisabled()
	})

	it("keeps newer edits dirty when an earlier save succeeds", () => {
		const { save, checkbox, requestId } = beginSave()
		fireEvent.click(checkbox)
		respond(requestId, true)
		respondToOtherWrites()
		expect(checkbox).not.toBeChecked()
		expect(save).toBeEnabled()
	})

	describe("save timeout", () => {
		beforeEach(() => {
			vi.clearAllMocks()
			vi.useFakeTimers()
		})

		afterEach(() => {
			cleanup()
			vi.useRealTimers()
			vi.restoreAllMocks()
		})

		it("reports missing results after 30 seconds and ignores late results during a retry", () => {
			const { save, checkbox } = beginSave()
			const expiredRequests = vi
				.mocked(vscode.postMessage)
				.mock.calls.slice(-4)
				.map(([message]) => message)
			act(() => vi.advanceTimersByTime(29_999))
			expect(save).toBeDisabled()
			expect(screen.queryByRole("alert")).not.toBeInTheDocument()
			act(() => vi.advanceTimersByTime(1))
			expect(screen.getByRole("alert")).toHaveTextContent(
				"updateSettings, apiConfiguration, telemetrySetting, debug",
			)
			expect(checkbox).toBeChecked()
			expect(save).toBeEnabled()

			fireEvent.click(save)
			for (const request of expiredRequests) respond(request.requestId, true)
			expect(save).toBeDisabled()
			expect(screen.queryByRole("alert")).not.toBeInTheDocument()
			for (const [request] of vi.mocked(vscode.postMessage).mock.calls.slice(-4)) respond(request.requestId, true)
			act(() => vi.advanceTimersByTime(30_000))
			expect(save).toBeDisabled()
			expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		})

		it("preserves failures and reports only outstanding requests even after another edit", () => {
			const { save, checkbox, requestId } = beginSave()
			respond(requestId, false)
			const requests = vi
				.mocked(vscode.postMessage)
				.mock.calls.slice(-4)
				.map(([message]) => message)
			for (const request of requests.slice(2)) respond(request.requestId, true)
			fireEvent.click(checkbox)
			act(() => vi.advanceTimersByTime(30_000))
			expect(screen.getByRole("alert")).toHaveTextContent("chatInputEffect, tableStriped, apiConfiguration")
			expect(screen.getByRole("alert")).not.toHaveTextContent("telemetrySetting")
			expect(screen.getByRole("alert")).not.toHaveTextContent("debug")
			expect(save).toBeEnabled()
		})

		it.each([true, false])("clears the timeout when all results arrive (success: %s)", (success) => {
			const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
			const { save, requestId } = beginSave()
			clearTimeoutSpy.mockClear()
			respond(requestId, success)
			respondToOtherWrites()
			expect(clearTimeoutSpy).toHaveBeenCalledTimes(1)
			act(() => vi.advanceTimersByTime(30_000))
			if (success) {
				expect(save).toBeDisabled()
				expect(screen.queryByRole("alert")).not.toBeInTheDocument()
			} else {
				expect(save).toBeEnabled()
				expect(screen.getByRole("alert")).toHaveTextContent("chatInputEffect, tableStriped")
			}
		})

		it("clears the timeout on unmount", () => {
			const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
			const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
			const addEventListenerSpy = vi.spyOn(window, "addEventListener")
			const removeEventListenerSpy = vi.spyOn(window, "removeEventListener")
			const { unmount, requestId } = beginSave()
			const handleSaveResult = addEventListenerSpy.mock.calls
				.filter(
					([type, listener]) =>
						type === "message" && typeof listener === "function" && listener.name === "handleSaveResult",
				)
				.at(-1)?.[1]
			expect(handleSaveResult).toBeDefined()
			const timerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 30_000)
			expect(timerIndex).toBeGreaterThanOrEqual(0)
			const timeoutId = setTimeoutSpy.mock.results[timerIndex].value
			clearTimeoutSpy.mockClear()
			removeEventListenerSpy.mockClear()
			unmount()
			expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId)
			expect(removeEventListenerSpy).toHaveBeenCalledWith("message", handleSaveResult)
			respond(requestId, true)
			act(() => vi.advanceTimersByTime(30_000))
		})

		it("ignores a stale timeout callback once a later save completes", () => {
			const { save, requestId } = beginSave()
			respond(requestId, true)
			respondToOtherWrites()
			// Completing the save clears pendingSave, so the leaked timeout must be a no-op.
			act(() => vi.advanceTimersByTime(30_000))
			expect(screen.queryByRole("alert")).not.toBeInTheDocument()
			expect(save).toBeDisabled()
		})
	})

	it("falls back to the tracked setting name when a failed result omits its unsaved keys", () => {
		const { save, requestId } = beginSave()
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "settingsSaveResult", requestId, success: false, unsavedSettings: [] },
				}),
			),
		)
		respondToOtherWrites()
		expect(save).toBeEnabled()
		expect(screen.getByRole("alert")).toHaveTextContent("updateSettings")
	})

	describe("save button gating", () => {
		it("stays disabled until an edit is made, then re-disables while a save is in flight", () => {
			vi.mocked(vscode.postMessage).mockClear()
			const view = renderSettingsView()
			view.activateTab("notifications")
			const save = screen.getByTestId("save-button")
			// No edits yet: nothing to save.
			expect(save).toBeDisabled()
			fireEvent.click(within(view.getSettingsContent()).getByTestId("tts-enabled-checkbox"))
			expect(save).toBeEnabled()
			fireEvent.click(save)
			// A second click while the save is pending is a no-op and leaves it disabled.
			expect(save).toBeDisabled()
			fireEvent.click(save)
			const updateRequests = vi
				.mocked(vscode.postMessage)
				.mock.calls.filter(([message]) => message.type === "updateSettings")
			expect(updateRequests).toHaveLength(1)
		})
	})
})

describe("SettingsView - save payload fallbacks", () => {
	it("persists unset command and file lists as empty arrays", () => {
		vi.mocked(vscode.postMessage).mockClear()
		const view = renderSettingsView({
			allowedCommands: undefined,
			deniedCommands: undefined,
			allowedReadFiles: undefined,
			allowedWriteFiles: undefined,
		})
		view.activateTab("autoApprove")
		fireEvent.click(within(view.getSettingsContent()).getByTestId("always-allow-execute-toggle"))
		fireEvent.click(screen.getByTestId("save-button"))

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					allowedCommands: [],
					deniedCommands: [],
					allowedReadFiles: [],
					allowedWriteFiles: [],
				}),
			}),
		)
	})

	it("unmounting without a pending save is a no-op", () => {
		const addEventListenerSpy = vi.spyOn(window, "addEventListener")
		const removeEventListenerSpy = vi.spyOn(window, "removeEventListener")
		const view = renderSettingsView()
		const handleSaveResult = addEventListenerSpy.mock.calls
			.filter(
				([type, listener]) =>
					type === "message" && typeof listener === "function" && listener.name === "handleSaveResult",
			)
			.at(-1)?.[1]
		// No save has been started, so pendingSave.current is undefined on unmount.
		view.unmount()
		expect(removeEventListenerSpy).toHaveBeenCalledWith("message", handleSaveResult)
	})
})
