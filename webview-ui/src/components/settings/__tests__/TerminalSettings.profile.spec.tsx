// npx vitest run src/components/settings/__tests__/TerminalSettings.profile.spec.tsx

import * as React from "react"

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { TerminalSettings } from "../TerminalSettings"

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
vi.mock("@/components/ui", () => ({
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
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, onChange, children }: any) => (
		<label>
			<input type="checkbox" checked={!!checked} onChange={(e: any) => onChange?.(e)} />
			{children}
		</label>
	),
	VSCodeLink: ({ children }: any) => <a>{children}</a>,
	VSCodeButton: ({ children, onClick, ...rest }: any) => (
		<button onClick={onClick} {...rest}>
			{children}
		</button>
	),
}))

// Helper used by the Select mock to render SelectItem children as buttons.
function renderSelectChildren(children: any, onValueChange: (value: string) => void): any {
	return React.Children.map(children, (child: any) => {
		if (!child || typeof child !== "object") return child
		const itemValue = child.props?.value ?? child.props?.["data-item-value"]
		if (child.props?.children && itemValue === undefined) {
			return renderSelectChildren(child.props.children, onValueChange)
		}
		if (itemValue !== undefined) {
			return (
				<button data-testid={`option-${itemValue}`} onClick={() => onValueChange(itemValue)}>
					{child.props.children}
				</button>
			)
		}
		return child
	})
}

describe("TerminalSettings VS Code terminal profile (#277)", () => {
	beforeEach(() => {
		postMessageMock.mockClear()
	})

	// The profile section applies to the VS Code integrated terminal (terminalShellIntegrationDisabled === false).
	const setup = (terminalProfile?: string) => {
		const setCachedStateField = vi.fn()
		const onTerminalProfilePickerOpened = vi.fn()
		render(
			<TerminalSettings
				terminalShellIntegrationDisabled={false}
				terminalProfile={terminalProfile}
				onTerminalProfilePickerOpened={onTerminalProfilePickerOpened}
				setCachedStateField={setCachedStateField}
			/>,
		)
		return { onTerminalProfilePickerOpened, setCachedStateField }
	}

	it("requests the terminal profile names on mount via the allowlisted message", () => {
		setup()
		const types = postMessageMock.mock.calls.map((c) => c[0]?.type)
		expect(types).toContain("requestTerminalProfiles")
	})

	it("shows the default radio selected and no dropdown when no profile is set", () => {
		setup()
		const defaultRadio = screen.getByTestId("terminal-profile-default-radio")
		expect(defaultRadio).toBeChecked()
		expect(screen.queryByTestId("terminal-profile-dropdown")).not.toBeInTheDocument()
	})

	it("shows the override radio selected and dropdown when a profile is set and profiles are available", () => {
		setup("Git Bash")
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "terminalProfiles", profiles: ["Git Bash", "zsh"] },
				}),
			)
		})
		const overrideRadio = screen.getByTestId("terminal-profile-override-radio")
		expect(overrideRadio).toBeChecked()
		expect(screen.getByTestId("terminal-profile-dropdown")).toBeInTheDocument()
	})

	it("keeps a saved profile selected while profile names are loading", () => {
		const { setCachedStateField } = setup("Git Bash")

		expect(screen.getByTestId("terminal-profile-override-radio")).toBeChecked()
		expect(screen.queryByTestId("terminal-profile-dropdown")).not.toBeInTheDocument()
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("falls back to the default radio and clears an unavailable saved profile after profiles load", () => {
		const { setCachedStateField } = setup("Git Bash")
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "terminalProfiles", profiles: ["Command Prompt"] },
				}),
			)
		})

		expect(screen.getByTestId("terminal-profile-default-radio")).toBeChecked()
		expect(screen.getByTestId("terminal-profile-override-radio")).not.toBeChecked()
		expect(screen.queryByTestId("terminal-profile-dropdown")).not.toBeInTheDocument()
		expect(setCachedStateField).toHaveBeenCalledWith("terminalProfile", undefined)
	})

	it("uses instance-local radio groups", () => {
		render(
			<>
				<TerminalSettings terminalShellIntegrationDisabled={false} setCachedStateField={vi.fn()} />
				<TerminalSettings terminalShellIntegrationDisabled={false} setCachedStateField={vi.fn()} />
			</>,
		)

		const defaultRadios = screen.getAllByTestId("terminal-profile-default-radio")
		expect(defaultRadios[0]).toBeChecked()
		expect(defaultRadios[1]).toBeChecked()
		expect(defaultRadios[0]).not.toHaveAttribute("name", defaultRadios[1].getAttribute("name"))
	})

	it("populates the dropdown from received profile names and selecting one sets the profile", () => {
		const { setCachedStateField } = setup("Git Bash")

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "terminalProfiles", profiles: ["Git Bash", "zsh"] },
				}),
			)
		})

		fireEvent.click(screen.getByTestId("option-zsh"))
		expect(setCachedStateField).toHaveBeenCalledWith("terminalProfile", "zsh")
	})

	it("clicking default radio sets terminalProfile to undefined", () => {
		const { setCachedStateField } = setup("Git Bash")
		fireEvent.click(screen.getByTestId("terminal-profile-default-radio"))
		expect(setCachedStateField).toHaveBeenCalledWith("terminalProfile", undefined)
	})

	it("renders the native profile configure button and posts openTerminalProfilePicker when clicked", () => {
		const { onTerminalProfilePickerOpened, setCachedStateField } = setup("Git Bash")
		const btn = screen.getByTestId("terminal-profile-configure-button")
		expect(btn).toBeInTheDocument()
		fireEvent.click(btn)
		expect(onTerminalProfilePickerOpened).toHaveBeenCalledTimes(1)
		expect(postMessageMock).toHaveBeenCalledWith({ type: "openTerminalProfilePicker" })
		expect(setCachedStateField).not.toHaveBeenCalledWith("terminalProfile", undefined)
	})

	it("shows picker section when VS Code integrated terminal is active (shell integration enabled)", () => {
		render(<TerminalSettings terminalShellIntegrationDisabled={false} setCachedStateField={vi.fn()} />)
		expect(screen.getByTestId("terminal-profile-default-radio")).toBeInTheDocument()
	})

	it("hides picker section when inline/Execa execution is active (shell integration disabled)", () => {
		render(<TerminalSettings terminalShellIntegrationDisabled={true} setCachedStateField={vi.fn()} />)
		expect(screen.queryByTestId("terminal-profile-default-radio")).not.toBeInTheDocument()
	})

	it("hides picker section when terminalShellIntegrationDisabled is undefined (defaults to inline mode)", () => {
		render(<TerminalSettings setCachedStateField={vi.fn()} />)
		expect(screen.queryByTestId("terminal-profile-default-radio")).not.toBeInTheDocument()
		expect(screen.queryByText("settings:terminal.inheritEnv.label")).not.toBeInTheDocument()
	})

	it("shows the command delay default as 0ms", () => {
		render(<TerminalSettings terminalShellIntegrationDisabled={false} setCachedStateField={vi.fn()} />)
		expect(screen.getByText("0ms")).toBeInTheDocument()
	})

	it("disables override radio and shows hint when no profiles are available", () => {
		setup()
		// No terminalProfiles message dispatched → profileNames stays []
		const overrideRadio = screen.getByTestId("terminal-profile-override-radio")
		expect(overrideRadio).toBeDisabled()
		expect(screen.getByTestId("terminal-profile-no-profiles-hint")).toBeInTheDocument()
	})

	it("enables override radio after profiles are received", () => {
		setup()
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "terminalProfiles", profiles: ["zsh"] },
				}),
			)
		})
		const overrideRadio = screen.getByTestId("terminal-profile-override-radio")
		expect(overrideRadio).not.toBeDisabled()
		expect(screen.queryByTestId("terminal-profile-no-profiles-hint")).not.toBeInTheDocument()
	})
})
