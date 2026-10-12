// npx vitest src/components/settings/__tests__/AutoApproveSettings.spec.tsx

import React from "react"

import { render, screen, fireEvent } from "@/utils/test-utils"

import { AutoApproveSettings } from "../AutoApproveSettings"
import { vscode } from "@/utils/vscode"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// The toolkit checkbox is a shadow-DOM custom element, so its change events reach the wrapper
// retargeted to the host element, which exposes `checked` itself and is not an HTMLInputElement.
// The global JSX mock renders a plain <input>, hiding that shape from every test in this file;
// this override renders the host tag so the suite exercises the event shape the real webview sends.
type CheckboxHost = HTMLElement & { checked: boolean }

type CheckboxHostProps = {
	children?: React.ReactNode
	checked?: boolean
	"data-testid"?: string
	onChange?: (event: Event) => void
}

vi.mock("@vscode/webview-ui-toolkit/react", async () => {
	const toolkitMock = await import("@/__mocks__/@vscode/webview-ui-toolkit/react")

	const VSCodeCheckboxHost = ({ children, onChange, checked, "data-testid": dataTestId }: CheckboxHostProps) =>
		React.createElement(
			"vscode-checkbox",
			{
				"data-testid": dataTestId,
				role: "checkbox",
				"aria-checked": String(checked ?? false),
				// Mirror the controlled prop onto the host like the real component's internal state,
				// and flip it on click so the dispatched change event carries the post-click value.
				// An unset prop leaves the host without `checked` at all — the degenerate shape the
				// handler must decline instead of writing `undefined`.
				ref: (el: CheckboxHost | null) => {
					if (!el) {
						return
					}
					if (checked !== undefined) {
						el.checked = checked
					}
					el.onclick = () => {
						el.checked = !el.checked
						el.setAttribute("aria-checked", String(el.checked))
						el.dispatchEvent(new CustomEvent("change", { bubbles: true, composed: true }))
					}
					el.onchange = (e: Event) => onChange?.(e)
				},
			},
			children,
		)

	return { ...toolkitMock, VSCodeCheckbox: VSCodeCheckboxHost }
})

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

// AutoApproveSettings reads a couple of live-state values that are genuinely
// immediate actions (autoApprovalEnabled). Those are out of scope for the
// Save/Discard buffering contract, so we just provide inert stand-ins.
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		autoApprovalEnabled: false,
		setAutoApprovalEnabled: vi.fn(),
	}),
}))

vi.mock("@/hooks/useAutoApprovalToggles", () => ({
	useAutoApprovalToggles: () => ({}),
}))

vi.mock("@/hooks/useAutoApprovalState", () => ({
	useAutoApprovalState: () => ({ effectiveAutoApprovalEnabled: false, hasEnabledOptions: false }),
}))

const renderSettings = (overrides = {}) => {
	const setCachedStateField = vi.fn()
	const props = {
		alwaysAllowExecute: true, // reveal the command list section
		allowedCommands: [] as string[],
		deniedCommands: [] as string[],
		allowedReadFiles: [] as string[],
		allowedWriteFiles: [] as string[],
		setCachedStateField,
		...overrides,
	}
	render(<AutoApproveSettings {...(props as any)} />)
	return { setCachedStateField }
}

// A change is "Save-managed" if it must NOT reach the extension host before Save.
const expectNoImmediateUpdateSettings = () => {
	expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
}

describe("AutoApproveSettings - Save/Discard contract", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// Case 1: allowedCommands add
	it("buffers an added allowed command without persisting before Save", () => {
		const { setCachedStateField } = renderSettings()

		fireEvent.change(screen.getByTestId("command-input"), { target: { value: "npm test" } })
		fireEvent.click(screen.getByTestId("add-command-button"))

		expect(setCachedStateField).toHaveBeenCalledWith("allowedCommands", ["npm test"])
		expectNoImmediateUpdateSettings()
	})

	it("buffers an allowed command submitted with Enter", () => {
		const { setCachedStateField } = renderSettings()

		const input = screen.getByTestId("command-input")
		fireEvent.change(input, { target: { value: "pnpm test" } })
		fireEvent.keyDown(input, { key: "Enter" })

		expect(setCachedStateField).toHaveBeenCalledWith("allowedCommands", ["pnpm test"])
	})

	// Case 2: allowedCommands remove
	it("buffers a removed allowed command without persisting before Save", () => {
		const { setCachedStateField } = renderSettings({ allowedCommands: ["npm test"] })

		fireEvent.click(screen.getByTestId("remove-command-0"))

		expect(setCachedStateField).toHaveBeenCalledWith("allowedCommands", [])
		expectNoImmediateUpdateSettings()
	})

	// Case 3a: deniedCommands add
	it("buffers an added denied command without persisting before Save", () => {
		const { setCachedStateField } = renderSettings()

		fireEvent.change(screen.getByTestId("denied-command-input"), { target: { value: "rm -rf" } })
		fireEvent.click(screen.getByTestId("add-denied-command-button"))

		expect(setCachedStateField).toHaveBeenCalledWith("deniedCommands", ["rm -rf"])
		expectNoImmediateUpdateSettings()
	})

	it("buffers a denied command submitted with Enter", () => {
		const { setCachedStateField } = renderSettings()

		const input = screen.getByTestId("denied-command-input")
		fireEvent.change(input, { target: { value: "sudo rm" } })
		fireEvent.keyDown(input, { key: "Enter" })

		expect(setCachedStateField).toHaveBeenCalledWith("deniedCommands", ["sudo rm"])
	})

	// Case 3b: deniedCommands remove
	it("buffers a removed denied command without persisting before Save", () => {
		const { setCachedStateField } = renderSettings({ deniedCommands: ["rm -rf"] })

		fireEvent.click(screen.getByTestId("remove-denied-command-0"))

		expect(setCachedStateField).toHaveBeenCalledWith("deniedCommands", [])
		expectNoImmediateUpdateSettings()
	})

	// Case 4: the allowlists, edited as one pattern per line so that their order,
	// which decides which negation wins, stays under the user's control.
	it.each([
		["write", "allowed-write-file-input", "allowedWriteFiles"],
		["read", "allowed-read-file-input", "allowedReadFiles"],
	])("buffers an edited %s allowlist without persisting before Save", (_label, testId, field) => {
		const { setCachedStateField } = renderSettings()

		fireEvent.input(screen.getByTestId(testId), { target: { value: "notes.md\ndocs/scratch/**" } })

		expect(setCachedStateField).toHaveBeenCalledWith(field, ["notes.md", "docs/scratch/**"])
		expectNoImmediateUpdateSettings()
	})

	it("renders the existing patterns one per line", () => {
		renderSettings({ allowedWriteFiles: ["notes.md", "todo.md"] })

		expect(screen.getByTestId("allowed-write-file-input")).toHaveValue("notes.md\ntodo.md")
	})

	it("keeps a pattern's whitespace, which is significant in gitignore syntax", () => {
		const { setCachedStateField } = renderSettings()

		fireEvent.input(screen.getByTestId("allowed-write-file-input"), { target: { value: " notes.md" } })

		expect(setCachedStateField).toHaveBeenCalledWith("allowedWriteFiles", [" notes.md"])
	})

	// Blank lines are unavoidable while editing text, and are dropped when the
	// settings are saved rather than while typing, so the cursor does not jump.
	it("keeps blank lines while editing", () => {
		const { setCachedStateField } = renderSettings()

		fireEvent.input(screen.getByTestId("allowed-write-file-input"), { target: { value: "notes.md\n\n" } })

		expect(setCachedStateField).toHaveBeenCalledWith("allowedWriteFiles", ["notes.md", "", ""])
	})

	// Each list grants access on its own, so it must be reachable without the
	// toggle it is meant to avoid having to enable.
	it("shows both allowlists while the Read and Write toggles are off", () => {
		renderSettings({ alwaysAllowWrite: false, alwaysAllowReadOnly: false })

		expect(screen.getByTestId("allowed-write-file-input")).toBeInTheDocument()
		expect(screen.getByTestId("allowed-read-file-input")).toBeInTheDocument()
	})

	// The two lists share one component, so they must not share state.
	it("keeps the read and write lists independent", () => {
		const { setCachedStateField } = renderSettings({
			allowedReadFiles: ["read.md"],
			allowedWriteFiles: ["write.md"],
		})

		expect(screen.getByTestId("allowed-read-file-input")).toHaveValue("read.md")
		expect(screen.getByTestId("allowed-write-file-input")).toHaveValue("write.md")

		fireEvent.input(screen.getByTestId("allowed-read-file-input"), { target: { value: "read.md\nmore-read.md" } })

		expect(setCachedStateField).toHaveBeenCalledWith("allowedReadFiles", ["read.md", "more-read.md"])
		expect(setCachedStateField).not.toHaveBeenCalledWith("allowedWriteFiles", expect.anything())
	})

	it("buffers the destructive command guard setting", () => {
		const { setCachedStateField } = renderSettings()

		fireEvent.click(screen.getByTestId("destructive-command-guard-checkbox"))

		expect(setCachedStateField).toHaveBeenCalledWith("destructiveCommandGuardEnabled", true)
		expectNoImmediateUpdateSettings()
	})

	it("renders destructive command guard disabled by default", () => {
		renderSettings()

		expect(screen.getByTestId("destructive-command-guard-checkbox")).not.toBeChecked()
	})

	it("renders destructive command guard enabled from cached settings", () => {
		renderSettings({ destructiveCommandGuardEnabled: true })

		expect(screen.getByTestId("destructive-command-guard-checkbox")).toBeChecked()
	})

	it("buffers disabling destructive command guard", () => {
		const { setCachedStateField } = renderSettings({ destructiveCommandGuardEnabled: true })

		fireEvent.click(screen.getByTestId("destructive-command-guard-checkbox"))

		expect(setCachedStateField).toHaveBeenCalledWith("destructiveCommandGuardEnabled", false)
		expectNoImmediateUpdateSettings()
	})

	it("hides Zoo command list editors while destructive command guard is enabled", () => {
		renderSettings({ destructiveCommandGuardEnabled: true, deniedCommands: ["rm -rf"] })

		expect(screen.queryByTestId("allowed-commands-heading")).not.toBeInTheDocument()
		expect(screen.queryByTestId("denied-commands-heading")).not.toBeInTheDocument()
	})

	it("shows Zoo command list editors while destructive command guard is disabled", () => {
		renderSettings({ destructiveCommandGuardEnabled: false })

		expect(screen.getByTestId("allowed-commands-heading")).toBeInTheDocument()
		expect(screen.getByTestId("denied-commands-heading")).toBeInTheDocument()
	})

	// The blanket auto-deny toggle replaces the hidden command lists as the
	// fail-closed policy in hands-free setups, so it must stay reachable in
	// BOTH DCG modes — unlike the list editors above.
	it.each([
		["disabled", false],
		["enabled", true],
	])("shows the blanket auto-deny toggle while destructive command guard is %s", (_label, dcgEnabled) => {
		renderSettings({ destructiveCommandGuardEnabled: dcgEnabled })

		expect(screen.getByTestId("auto-deny-unapproved-checkbox")).toBeInTheDocument()
	})

	it("renders blanket auto-deny disabled by default", () => {
		renderSettings()

		expect(screen.getByTestId("auto-deny-unapproved-checkbox")).not.toBeChecked()
	})

	it("renders blanket auto-deny enabled from cached settings", () => {
		renderSettings({ alwaysDenyUnapprovedCommands: true })

		expect(screen.getByTestId("auto-deny-unapproved-checkbox")).toBeChecked()
	})

	it("buffers the blanket auto-deny setting", () => {
		const { setCachedStateField } = renderSettings()

		fireEvent.click(screen.getByTestId("auto-deny-unapproved-checkbox"))

		expect(setCachedStateField).toHaveBeenCalledWith("alwaysDenyUnapprovedCommands", true)
		expectNoImmediateUpdateSettings()
	})

	it("buffers disabling blanket auto-deny", () => {
		const { setCachedStateField } = renderSettings({ alwaysDenyUnapprovedCommands: true })

		fireEvent.click(screen.getByTestId("auto-deny-unapproved-checkbox"))

		expect(setCachedStateField).toHaveBeenCalledWith("alwaysDenyUnapprovedCommands", false)
		expectNoImmediateUpdateSettings()
	})

	it("hides the blanket auto-deny toggle while command auto-approval is off", () => {
		// With alwaysAllowExecute off, the whole Execute section (and its
		// toggles, including the blanket auto-deny toggle) is hidden.
		renderSettings({ alwaysAllowExecute: false })

		expect(screen.queryByTestId("auto-deny-unapproved-checkbox")).not.toBeInTheDocument()
	})

	// A change event from the real toolkit arrives with the custom-element host as
	// e.target, which is not an HTMLInputElement; an instanceof-style guard would
	// silently swallow it, leaving the toggle dead in the real webview.
	it("writes the blanket auto-deny value from a change event retargeted to the custom-element host", () => {
		const { setCachedStateField } = renderSettings()
		const host = screen.getByTestId("auto-deny-unapproved-checkbox")

		expect(host).not.toBeInstanceOf(HTMLInputElement)
		fireEvent.click(host)

		expect(setCachedStateField).toHaveBeenCalledWith("alwaysDenyUnapprovedCommands", true)
		expectNoImmediateUpdateSettings()
	})

	it("declines a blanket auto-deny change whose target carries no checked value", () => {
		const { setCachedStateField } = renderSettings()
		const host = screen.getByTestId("auto-deny-unapproved-checkbox")

		// The degenerate shape: a change event whose target exposes no boolean
		// `checked`. The handler must decline it entirely rather than buffer
		// `undefined` through the guard.
		fireEvent.change(host)

		expect(setCachedStateField).not.toHaveBeenCalled()
		expectNoImmediateUpdateSettings()
	})
})
