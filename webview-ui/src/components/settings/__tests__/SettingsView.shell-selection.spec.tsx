// pnpm --filter @roo-code/vscode-webview test src/components/settings/__tests__/SettingsView.shell-selection.spec.tsx

/**
 * Tests for the SettingsView ↔ TerminalSettings shell-selection wiring.
 *
 * Verifies that:
 * - Changing the shell selection marks the settings as dirty so the Save
 *   button enables on shell-only changes (previously the dirty flag was
 *   only set incidentally via onTerminalProfilePickerOpened).
 * - Save posts the pending selection through the existing
 *   `setTerminalShellSelection` message (the only path that persists it).
 */

import { render, screen, fireEvent, act } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { vscode } from "@/utils/vscode"
import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"

import SettingsView from "../SettingsView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("../ApiConfigManager", () => ({
	__esModule: true,
	default: ({ currentApiConfigName }: any) => (
		<div data-testid="api-config-management">
			<span>Current config: {currentApiConfigName}</span>
		</div>
	),
}))

// Capture the props SettingsView passes to TerminalSettings so tests can
// drive onShellSelectionChange directly.
const capturedTerminalProps = vi.hoisted(() => ({ current: null as any }))

vi.mock("../TerminalSettings", () => ({
	DEFAULT_PROFILE_VALUE: "__zoo_code_follow_vscode_sentinel__",
	TerminalSettings: (props: any) => {
		capturedTerminalProps.current = props
		return <div data-testid="terminal-settings-stub" />
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick, appearance, "data-testid": dataTestId }: any) =>
		appearance === "icon" ? (
			<button onClick={onClick} aria-label="Remove command" data-testid={dataTestId}>
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
}))

vi.mock("../../../components/common/Tab", () => ({
	...vi.importActual("../../../components/common/Tab"),
	Tab: ({ children }: any) => <div data-testid="tab-container">{children}</div>,
	TabHeader: ({ children }: any) => <div data-testid="tab-header">{children}</div>,
	TabContent: ({ children, "data-testid": dataTestId }: any) => (
		<div data-testid={dataTestId || "tab-content"}>{children}</div>
	),
	TabList: ({ children, value, "data-testid": dataTestId }: any) => (
		<div data-testid={dataTestId} data-value={value}>
			{children}
		</div>
	),
	TabTrigger: ({ children, value, "data-testid": dataTestId, onClick, isSelected }: any) => (
		<button data-testid={dataTestId} data-value={value} data-selected={isSelected} onClick={onClick}>
			{children}
		</button>
	),
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
	// Unlike the SettingsView.spec.tsx mock, this one forwards `disabled` so
	// the Save button's dirty-tracking gating can be asserted.
	Button: ({ children, onClick, disabled, variant, className, "data-testid": dataTestId }: any) => (
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

const renderTerminalTab = (initialState: any = {}) => {
	const onDone = vi.fn()
	const queryClient = new QueryClient()

	render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} targetSection="terminal" />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)

	// Hydrate initial state.
	act(() => {
		mockPostMessage(initialState)
	})

	return { onDone }
}

describe("SettingsView — terminal shell selection", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		capturedTerminalProps.current = null
	})

	it("enables the Save button on a shell-only selection change", () => {
		renderTerminalTab()

		expect(capturedTerminalProps.current).not.toBeNull()
		expect(screen.getByTestId("save-button")).toBeDisabled()

		// Simulate the shell dropdown selection change. This must mark the
		// settings as dirty on its own — not via onTerminalProfilePickerOpened.
		act(() => {
			capturedTerminalProps.current.onShellSelectionChange({ kind: "auto" })
		})

		expect(screen.getByTestId("save-button")).toBeEnabled()
	})

	it("posts setTerminalShellSelection with the pending selection on Save", () => {
		renderTerminalTab()

		act(() => {
			capturedTerminalProps.current.onShellSelectionChange({ kind: "path", path: "/usr/bin/zsh" })
		})

		fireEvent.click(screen.getByTestId("save-button"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "setTerminalShellSelection",
			terminalShellSelection: { kind: "path", path: "/usr/bin/zsh" },
		})
	})
})
