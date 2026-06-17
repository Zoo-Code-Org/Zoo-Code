// npx vitest run src/components/settings/__tests__/TerminalSettings.profile.spec.tsx

import * as React from "react"

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { TerminalSettings, DEFAULT_PROFILE_VALUE } from "../TerminalSettings"

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
// Use async factory to resolve vi.importActual so real Button, TooltipProvider etc. are preserved.
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

describe("TerminalSettings unified profile dropdown", () => {
	beforeEach(() => {
		postMessageMock.mockClear()
	})

	const setup = (terminalProfile?: string) => {
		const setCachedStateField = vi.fn()
		const onTerminalProfilePickerOpened = vi.fn()
		const { rerender } = render(
			<TerminalSettings
				terminalShellIntegrationDisabled={false}
				terminalProfile={terminalProfile}
				onTerminalProfilePickerOpened={onTerminalProfilePickerOpened}
				setCachedStateField={setCachedStateField}
			/>,
		)
		return { onTerminalProfilePickerOpened, setCachedStateField, rerender }
	}

	it("requests the terminal profile names on mount via the allowlisted message", () => {
		setup()
		const types = postMessageMock.mock.calls.map((c) => c[0]?.type)
		expect(types).toContain("requestTerminalProfiles")
	})

	it("shows the dropdown with 'Following VS Code profile' as default when no profile is set", () => {
		setup()
		const dropdown = screen.getByTestId("terminal-profile-dropdown")
		expect(dropdown).toBeInTheDocument()
		expect(dropdown.closest('[data-testid="select"]')?.getAttribute("data-value")).toBe(DEFAULT_PROFILE_VALUE)
		// Configure button visible because "Following VS Code profile" is selected
		expect(screen.getByTestId("terminal-profile-configure-button")).toBeInTheDocument()
	})

	it("selects a specific profile and hides the Configure button", () => {
		const { setCachedStateField, onTerminalProfilePickerOpened, rerender } = setup()

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "terminalProfiles", profiles: ["Git Bash", "zsh"] },
				}),
			)
		})

		// Select "Git Bash" from dropdown
		fireEvent.click(screen.getByTestId("option-Git Bash"))
		expect(setCachedStateField).toHaveBeenCalledWith("terminalProfile", "Git Bash")

		rerender(
			<TerminalSettings
				terminalShellIntegrationDisabled={false}
				terminalProfile="Git Bash"
				onTerminalProfilePickerOpened={onTerminalProfilePickerOpened}
				setCachedStateField={setCachedStateField}
			/>,
		)

		// Configure button should be hidden
		expect(screen.queryByTestId("terminal-profile-configure-button")).not.toBeInTheDocument()
	})

	it("selecting 'Following VS Code profile' sets terminalProfile to undefined", () => {
		const { setCachedStateField } = setup("Git Bash")

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "terminalProfiles", profiles: ["Git Bash", "zsh"] },
				}),
			)
		})

		fireEvent.click(screen.getByTestId(`option-${DEFAULT_PROFILE_VALUE}`))
		expect(setCachedStateField).toHaveBeenCalledWith("terminalProfile", undefined)
	})

	it("clears an unavailable saved profile after profiles load", () => {
		const { setCachedStateField } = setup("Old Shell")

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "terminalProfiles", profiles: ["Command Prompt"] },
				}),
			)
		})

		// The unavailable profile should be cleared
		expect(setCachedStateField).toHaveBeenCalledWith("terminalProfile", undefined)
	})

	it("renders the Configure button and posts openTerminalProfilePicker when clicked", () => {
		const { onTerminalProfilePickerOpened } = setup()

		const btn = screen.getByTestId("terminal-profile-configure-button")
		expect(btn).toBeInTheDocument()
		fireEvent.click(btn)
		expect(onTerminalProfilePickerOpened).toHaveBeenCalledTimes(1)
		expect(postMessageMock).toHaveBeenCalledWith({ type: "openTerminalProfilePicker" })
	})

	it("shows profile section when VS Code integrated terminal is active (shell integration enabled)", () => {
		render(<TerminalSettings terminalShellIntegrationDisabled={false} setCachedStateField={vi.fn()} />)
		expect(screen.getByTestId("terminal-profile-dropdown")).toBeInTheDocument()
	})

	it("hides profile section when inline/Execa execution is active (shell integration disabled)", () => {
		render(<TerminalSettings terminalShellIntegrationDisabled={true} setCachedStateField={vi.fn()} />)
		expect(screen.queryByTestId("terminal-profile-dropdown")).not.toBeInTheDocument()
	})

	it("hides profile section when terminalShellIntegrationDisabled is undefined (defaults to inline mode)", () => {
		render(<TerminalSettings setCachedStateField={vi.fn()} />)
		expect(screen.queryByTestId("terminal-profile-dropdown")).not.toBeInTheDocument()
	})

	it("shows no-profiles hint when profile list is empty after load", () => {
		setup()
		// Hint should NOT appear before profiles are loaded
		expect(screen.queryByTestId("terminal-profile-no-profiles-hint")).not.toBeInTheDocument()
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "terminalProfiles", profiles: [] },
				}),
			)
		})
		// Hint should appear after profiles loaded with empty list
		expect(screen.getByTestId("terminal-profile-no-profiles-hint")).toBeInTheDocument()
	})

	it("shows 'Use Inline Terminal' checkbox before profile section", () => {
		render(<TerminalSettings terminalShellIntegrationDisabled={false} setCachedStateField={vi.fn()} />)

		// Both elements exist and checkbox should appear first in DOM order
		const checkbox = screen.getByText("settings:terminal.shellIntegrationDisabled.label")
		const profileDropdown = screen.getByTestId("terminal-profile-dropdown")

		expect(checkbox).toBeInTheDocument()
		expect(profileDropdown).toBeInTheDocument()
		// Compare DOM positions — checkbox should be before profile dropdown
		expect(checkbox.compareDocumentPosition(profileDropdown) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})

	it("renders the Terminal icon inside the Configure button", () => {
		setup()
		const btn = screen.getByTestId("terminal-profile-configure-button")
		const svg = btn.querySelector("svg")
		expect(svg).toBeInTheDocument()
	})

	it("shows the correct i18n key for the profile label", () => {
		setup()
		expect(screen.getByText("settings:terminal.profile.label")).toBeInTheDocument()
	})

	it("shows the correct i18n key for the followVscode dropdown option", () => {
		setup()
		expect(screen.getByText("settings:terminal.profile.followVscode")).toBeInTheDocument()
	})

	it("shows the correct i18n key for the configure button text", () => {
		setup()
		const btn = screen.getByTestId("terminal-profile-configure-button")
		expect(btn.textContent).toContain("settings:terminal.profile.configureButton")
	})
})
