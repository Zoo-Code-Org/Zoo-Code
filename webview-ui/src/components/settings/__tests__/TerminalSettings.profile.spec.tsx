// npx vitest run src/components/settings/__tests__/TerminalSettings.profile.spec.tsx

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
	Select: ({ children, value, onValueChange }: any) => (
		<div data-testid="select" data-value={value}>
			{/* Recursively render items and wire their value to onValueChange */}
			{renderSelectChildren(children, onValueChange)}
		</div>
	),
	SelectTrigger: ({ children }: any) => <div>{children}</div>,
	SelectValue: ({ children }: any) => <div>{children}</div>,
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value }: any) => <div data-item-value={value}>{children}</div>,
	Slider: ({ value, onValueChange }: any) => (
		<input
			type="range"
			value={value?.[0] ?? 0}
			onChange={(e) => onValueChange([parseFloat(e.target.value)])}
		/>
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
}))

// Helper used by the Select mock to render SelectItem children as buttons.
function renderSelectChildren(children: any, onValueChange: (value: string) => void): any {
	const React = require("react")
	return React.Children.map(children, (child: any) => {
		if (!child || typeof child !== "object") return child
		const itemValue = child.props?.value ?? child.props?.["data-item-value"]
		// SelectContent wraps SelectItems; recurse into it.
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

describe("TerminalSettings inline terminal profile (#119)", () => {
	beforeEach(() => {
		postMessageMock.mockClear()
	})

	const setup = (terminalProfile?: string) => {
		const setCachedStateField = vi.fn()
		render(
			<TerminalSettings
				terminalShellIntegrationDisabled={false}
				terminalProfile={terminalProfile}
				setCachedStateField={setCachedStateField}
			/>,
		)
		return { setCachedStateField }
	}

	it("requests the VS Code terminal profile lists on mount", () => {
		setup()

		const requested = postMessageMock.mock.calls.map((c) => c[0]?.setting)
		expect(requested).toContain("terminal.integrated.profiles.windows")
		expect(requested).toContain("terminal.integrated.profiles.osx")
		expect(requested).toContain("terminal.integrated.profiles.linux")
	})

	it("does not call setCachedStateField on init (only the Default option is shown)", () => {
		const { setCachedStateField } = setup()
		// No profiles received yet -> only the Default option exists.
		expect(screen.getByTestId("option-__default__")).toBeInTheDocument()
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("populates the dropdown from received profile lists and selecting one sets the profile name", () => {
		const { setCachedStateField } = setup()

		// Simulate the extension responding with a Windows profile list.
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "vsCodeSetting",
						setting: "terminal.integrated.profiles.windows",
						value: { "Git Bash": { path: "C:/Program Files/Git/bin/bash.exe" }, PowerShell: {} },
					},
				}),
			)
		})

		// User selects the Git Bash profile.
		fireEvent.click(screen.getByTestId("option-Git Bash"))

		expect(setCachedStateField).toHaveBeenCalledWith("terminalProfile", "Git Bash")
	})

	it("maps the Default option back to undefined (restores default behavior)", () => {
		const { setCachedStateField } = setup("Git Bash")

		fireEvent.click(screen.getByTestId("option-__default__"))

		expect(setCachedStateField).toHaveBeenCalledWith("terminalProfile", undefined)
	})
})
