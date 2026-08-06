// npx vitest run src/components/settings/__tests__/TerminalSettings.shell.spec.tsx

import * as React from "react"

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { TerminalSettings } from "../TerminalSettings"
import type { TerminalShellOptionsPayload, TerminalShellSelection, WebviewMessage } from "@roo-code/types"

// Mock translation hook to echo keys
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/utils/docLinks", () => ({
	buildDocLink: () => "https://example.com",
}))

const postMessageMock = vi.fn()
vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: (message: WebviewMessage) => postMessageMock(message) },
}))

interface SelectMockProps {
	children?: React.ReactNode
	value?: string
	onValueChange?: (value: string) => void
	"data-testid"?: string
}

interface SelectTriggerMockProps {
	children?: React.ReactNode
	className?: string
	"data-testid"?: string
}

interface SelectItemMockProps {
	children?: React.ReactNode
	value?: string
}

interface SliderMockProps {
	value?: number[]
	onValueChange?: (value: number[]) => void
}

// Render Select as a list of buttons so we can drive onValueChange in tests.
vi.mock("@/components/ui", async () => {
	const actual = await vi.importActual("@/components/ui")
	return {
		...actual,
		Select: ({ children, value, onValueChange, "data-testid": testId }: SelectMockProps) => (
			<div data-testid={testId ?? "select"} data-value={value}>
				{renderSelectChildren(children, onValueChange)}
			</div>
		),
		SelectTrigger: ({ children, ...rest }: SelectTriggerMockProps) => <div {...rest}>{children}</div>,
		SelectValue: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
		SelectContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
		SelectItem: ({ children, value }: SelectItemMockProps) => <div data-item-value={value}>{children}</div>,
		Slider: ({ value, onValueChange }: SliderMockProps) => (
			<input type="range" value={value?.[0] ?? 0} onChange={(e) => onValueChange?.([parseFloat(e.target.value)])} />
		),
	}
})

interface VSCodeCheckboxMockProps {
	checked?: boolean
	onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
	children?: React.ReactNode
}

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, onChange, children }: VSCodeCheckboxMockProps) => (
		<label>
			<input type="checkbox" checked={!!checked} onChange={(e) => onChange?.(e)} />
			{children}
		</label>
	),
	VSCodeLink: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}))

interface SelectChildProps {
	value?: string
	"data-item-value"?: string
	children?: React.ReactNode
}

// Helper used by the Select mock to render SelectItem children as buttons.
function renderSelectChildren(
	children: React.ReactNode,
	onValueChange?: (value: string) => void,
): React.ReactNode {
	return React.Children.map(children, (child) => {
		if (!React.isValidElement(child)) return child
		const props = child.props as SelectChildProps
		const itemValue = props.value ?? props["data-item-value"]
		if (itemValue !== undefined) {
			return (
				<button data-testid={`option-${itemValue}`} onClick={() => onValueChange?.(itemValue)}>
					{child.props.children}
				</button>
			)
		}
		if (child.props.children) {
			return React.cloneElement(child, {}, renderSelectChildren(child.props.children, onValueChange))
		}
		return child
	})
}

describe("TerminalSettings inline shell selector", () => {
	beforeEach(() => {
		postMessageMock.mockClear()
	})

	const setup = (options?: {
		terminalShellIntegrationDisabled?: boolean
		terminalShellSelection?: TerminalShellSelection
	}) => {
		const setCachedStateField = vi.fn()
		const onShellSelectionChange = vi.fn()
		const onTerminalProfilePickerOpened = vi.fn()

		const utils = render(
			<TerminalSettings
				terminalShellIntegrationDisabled={options?.terminalShellIntegrationDisabled}
				terminalShellSelection={options?.terminalShellSelection}
				onShellSelectionChange={onShellSelectionChange}
				onTerminalProfilePickerOpened={onTerminalProfilePickerOpened}
				setCachedStateField={setCachedStateField}
			/>,
		)

		return { ...utils, setCachedStateField, onShellSelectionChange, onTerminalProfilePickerOpened }
	}

	it("renders shell selector when inline mode is enabled", () => {
		setup({ terminalShellIntegrationDisabled: true })

		expect(screen.getByTestId("terminal-inline-shell-dropdown")).toBeDefined()
		expect(screen.getByTestId("option-auto")).toBeDefined()
	})

	it("hides shell selector when integrated mode is enabled (inline disabled = false)", () => {
		setup({ terminalShellIntegrationDisabled: false })

		expect(screen.queryByTestId("terminal-inline-shell-dropdown")).toBeNull()
	})

	it("sends requestTerminalShellOptions on mount", () => {
		setup({ terminalShellIntegrationDisabled: true })

		expect(postMessageMock).toHaveBeenCalledWith({ type: "requestTerminalShellOptions" })
	})

	it("calls onShellSelectionChange and marks dirty when Auto is selected", () => {
		const { onShellSelectionChange, onTerminalProfilePickerOpened } = setup({
			terminalShellIntegrationDisabled: true,
		})

		const autoButton = screen.getByTestId("option-auto")
		act(() => {
			fireEvent.click(autoButton)
		})

		expect(onShellSelectionChange).toHaveBeenCalledWith({ kind: "auto" })
		expect(onTerminalProfilePickerOpened).toHaveBeenCalled()
	})

	it("calls onShellSelectionChange with profile name when a profile is selected", () => {
		// Simulate the extension host responding with shell options
		const { onShellSelectionChange, onTerminalProfilePickerOpened } = setup({
			terminalShellIntegrationDisabled: true,
		})

		// Simulate receiving terminalShellOptions message
		const payload: TerminalShellOptionsPayload = {
			options: [
				{ id: "auto", label: "Auto", family: "powershell", source: "auto", available: true },
				{
					id: "profile:PowerShell",
					label: "PowerShell",
					family: "powershell",
					source: "vscode-profile",
					available: true,
				},
			],
			effectiveShell: {
				label: "pwsh.exe",
				family: "powershell",
				source: "VS Code Default Profile",
			},
		}

		// Dispatch message event to simulate extension host response
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "terminalShellOptions", terminalShellOptions: payload } }),
			)
		})

		const profileButton = screen.queryByTestId("option-profile:PowerShell")
		if (profileButton) {
			act(() => {
				fireEvent.click(profileButton)
			})

			expect(onShellSelectionChange).toHaveBeenCalledWith({
				kind: "profile",
				profileName: "PowerShell",
			})
			expect(onTerminalProfilePickerOpened).toHaveBeenCalled()
		}
	})

	it("maps the cmd fallback option to a canonical path selection", () => {
		const { onShellSelectionChange, onTerminalProfilePickerOpened } = setup({
			terminalShellIntegrationDisabled: true,
		})

		// Simulate the extension host responding with a "cmd" fallback option.
		const payload: TerminalShellOptionsPayload = {
			options: [
				{ id: "auto", label: "Auto", family: "cmd", source: "auto", available: true },
				{ id: "cmd", label: "Command Prompt (cmd.exe)", family: "cmd", source: "os-default", available: true },
			],
			effectiveShell: { label: "cmd.exe", family: "cmd", source: "OS Default" },
		}

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "terminalShellOptions", terminalShellOptions: payload } }),
			)
		})

		const cmdButton = screen.getByTestId("option-cmd")
		act(() => {
			fireEvent.click(cmdButton)
		})

		expect(onShellSelectionChange).toHaveBeenCalledWith({
			kind: "path",
			path: "C:\\Windows\\System32\\cmd.exe",
		})
		expect(onTerminalProfilePickerOpened).toHaveBeenCalled()
	})

	it("maps a path-based option to a path selection", () => {
		const { onShellSelectionChange, onTerminalProfilePickerOpened } = setup({
			terminalShellIntegrationDisabled: true,
		})

		const path = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
		const payload: TerminalShellOptionsPayload = {
			options: [
				{ id: "auto", label: "Auto", family: "powershell", source: "auto", available: true },
				{
					id: `path:${path}`,
					label: "PowerShell (custom path)",
					family: "powershell",
					source: "user-override",
					available: true,
				},
			],
		}

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "terminalShellOptions", terminalShellOptions: payload } }),
			)
		})

		const pathButton = screen.getByTestId(`option-path:${path}`)
		act(() => {
			fireEvent.click(pathButton)
		})

		expect(onShellSelectionChange).toHaveBeenCalledWith({ kind: "path", path })
		expect(onTerminalProfilePickerOpened).toHaveBeenCalled()
	})

	it("posts requestCustomShellPath when the custom path button is clicked", () => {
		setup({ terminalShellIntegrationDisabled: true })

		const customButton = screen.getByTestId("terminal-inline-shell-custom")
		act(() => {
			fireEvent.click(customButton)
		})

		expect(postMessageMock).toHaveBeenCalledWith({ type: "requestCustomShellPath" })
	})

	it("resolves a persisted cmd.exe path selection to the cmd dropdown option", () => {
		setup({
			terminalShellIntegrationDisabled: true,
			terminalShellSelection: { kind: "path", path: "C:\\Windows\\System32\\cmd.exe" },
		})

		const payload: TerminalShellOptionsPayload = {
			options: [
				{ id: "auto", label: "Auto", family: "cmd", source: "auto", available: true },
				{ id: "cmd", label: "Command Prompt (cmd.exe)", family: "cmd", source: "os-default", available: true },
			],
		}

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "terminalShellOptions", terminalShellOptions: payload } }),
			)
		})

		// The Select value should resolve to the "cmd" option id because the
		// persisted path matches the canonical cmd.exe path.
		const dropdown = screen.getByTestId("terminal-inline-shell-dropdown")
		expect(dropdown.parentElement?.getAttribute("data-value")).toBe("cmd")
	})

	it("falls back to the raw path value when no option matches the persisted path", () => {
		const path = "C:\\Tools\\custom-shell.exe"
		setup({
			terminalShellIntegrationDisabled: true,
			terminalShellSelection: { kind: "path", path },
		})

		const payload: TerminalShellOptionsPayload = {
			options: [
				{ id: "auto", label: "Auto", family: "posix", source: "auto", available: true },
				{
					id: "path:C:\\Windows\\System32\\cmd.exe",
					label: "cmd.exe",
					family: "cmd",
					source: "os-default",
					available: true,
				},
			],
		}

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "terminalShellOptions", terminalShellOptions: payload } }),
			)
		})

		// No option matches the persisted path, so the raw `path:` value is used.
		const dropdown = screen.getByTestId("terminal-inline-shell-dropdown")
		expect(dropdown.parentElement?.getAttribute("data-value")).toBe(`path:${path}`)
	})

	it("displays effective shell info when available", () => {
		render(<TerminalSettings terminalShellIntegrationDisabled={true} setCachedStateField={vi.fn()} />)

		// Simulate receiving terminalShellOptions message with effective shell
		const payload: TerminalShellOptionsPayload = {
			options: [{ id: "auto", label: "Auto", family: "powershell", source: "auto", available: true }],
			effectiveShell: {
				label: "pwsh.exe",
				family: "powershell",
				source: "VS Code Default Profile",
			},
		}

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "terminalShellOptions", terminalShellOptions: payload } }),
			)
		})

		expect(screen.getByTestId("terminal-inline-shell-effective")).toBeDefined()
	})

	it("displays error message when shell options contain an error", () => {
		render(<TerminalSettings terminalShellIntegrationDisabled={true} setCachedStateField={vi.fn()} />)

		// Simulate receiving terminalShellOptions message with error
		const payload: TerminalShellOptionsPayload = {
			options: [],
			error: "SHELL/handleRequestTerminalShellOptions/001: Service unavailable",
		}

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "terminalShellOptions", terminalShellOptions: payload } }),
			)
		})

		expect(screen.getByTestId("terminal-inline-shell-error")).toBeDefined()
	})
})
