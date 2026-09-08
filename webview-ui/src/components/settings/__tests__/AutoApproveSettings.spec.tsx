// npx vitest src/components/settings/__tests__/AutoApproveSettings.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import { AutoApproveSettings } from "../AutoApproveSettings"
import { vscode } from "@/utils/vscode"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

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
})
