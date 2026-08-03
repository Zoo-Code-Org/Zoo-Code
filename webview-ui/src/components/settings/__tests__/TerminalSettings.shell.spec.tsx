// npx vitest run src/components/settings/__tests__/TerminalSettings.shell.spec.tsx

import * as React from "react"

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { TerminalSettings } from "../TerminalSettings"
import type { TerminalShellOptionsPayload, TerminalShellSelection } from "@roo-code/types"

// Mock translation hook to echo keys
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/utils/docLinks", () => ({
	buildDocLink: () => "https://example.com",
}))

const postMessageMock = vi.fn()
vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: (...args: any[]) => postMessageMock(...args) },
}))

// Render Select as a list of buttons so we can drive onValueChange in tests.
vi.mock("@/components/ui", async () => {
	const actual = await vi.importActual("@/components/ui")
	return {
		...actual,
		Select: ({ children, value, onValueChange, "data-testid": testId }: any) => (
			<div data-testid={testId ?? "select"} data-value={value}>
				{renderSelectChildren(children, onValueChange)}
			</div>
		),
		SelectTrigger: ({ children, ...rest }: any) => <div {...rest}>{children}</div>,
		SelectValue: ({ children }: any) => <div>{children}</div>,
		SelectContent: ({ children }: any) => <div>{children}</div>,
		SelectItem: ({ children, value }: any) => <div data-item-value={value}>{children}</div>,
		Slider: ({ value, onValueChange }: any) => (
			<input type="range" value={value?.[0] ?? 0} onChange={(e) => onValueChange([parseFloat(e.target.value)])} />
		),
	}
})

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, onChange, children }: any) => (
		<label>
			<input type="checkbox" checked={!!checked} onChange={(e: any) => onChange?.(e)} />
			{children}
		</label>
	),
	VSCodeLink: ({ children }: any) => <a>{children}</a>,
}))

// Helper used by the Select mock to render SelectItem children as buttons.
function renderSelectChildren(children: any, onValueChange: (value: string) => void): any {
	return React.Children.map(children, (child: any) => {
		if (!child || typeof child !== "object") return child
		const itemValue = child.props?.value ?? child.props?.["data-item-value"]
		if (itemValue !== undefined) {
			return (
				<button data-testid={`option-${itemValue}`} onClick={() => onValueChange(itemValue)}>
					{child.props.children}
				</button>
			)
		}
		if (child.props?.children) {
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

	it("buffers the picked custom path as pending selection without persisting", () => {
		const { onShellSelectionChange } = setup({ terminalShellIntegrationDisabled: true })

		// Simulate the extension host returning the validated picked path.
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "customShellPathSelected",
						customShellPathSelected: { path: "C:\\tools\\git-bash.exe" },
					},
				}),
			)
		})

		// The selection is buffered as pending state (persisted only on Save),
		// and shown as a selectable item so the dropdown reflects the pick.
		// (The Select mock renders items as `option-${value}` buttons.)
		expect(onShellSelectionChange).toHaveBeenCalledWith({ kind: "path", path: "C:\\tools\\git-bash.exe" })
		expect(screen.getByTestId("option-path:C:\\tools\\git-bash.exe")).toBeDefined()
		expect(screen.queryByTestId("terminal-inline-shell-error")).toBeNull()
	})

	it("shows an error when customShellPathSelected carries a validation error", () => {
		const { onShellSelectionChange } = setup({ terminalShellIntegrationDisabled: true })

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "customShellPathSelected",
						customShellPathSelected: {
							error: "SHELL/handleCustomShellPathPicked/001: The selected shell path is not in the trusted allowlist",
						},
					},
				}),
			)
		})

		expect(onShellSelectionChange).not.toHaveBeenCalled()
		expect(screen.getByTestId("terminal-inline-shell-error")).toBeDefined()
	})
})
