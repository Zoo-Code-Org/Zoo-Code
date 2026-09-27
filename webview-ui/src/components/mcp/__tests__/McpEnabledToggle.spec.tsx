// npx vitest src/components/mcp/__tests__/McpEnabledToggle.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import McpEnabledToggle from "../McpEnabledToggle"
import { vscode } from "@src/utils/vscode"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const contextSetMcpEnabled = vi.fn()
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mcpEnabled: true,
		setMcpEnabled: contextSetMcpEnabled,
	}),
}))

const getCheckbox = () => screen.getByRole("checkbox")

describe("McpEnabledToggle - Save/Discard contract", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// Case 6: controlled (inside SettingsView) must buffer, not persist before Save.
	it("buffers via the setter prop without persisting before Save when controlled", () => {
		const setMcpEnabled = vi.fn()
		render(<McpEnabledToggle mcpEnabled={true} setMcpEnabled={setMcpEnabled} />)

		fireEvent.click(getCheckbox())

		expect(setMcpEnabled).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
		// Must not touch live extension state either.
		expect(contextSetMcpEnabled).not.toHaveBeenCalled()
	})

	// Regression guard: uncontrolled usage keeps the original immediate behavior.
	it("persists immediately via live state when used uncontrolled", () => {
		render(<McpEnabledToggle />)

		fireEvent.click(getCheckbox())

		expect(contextSetMcpEnabled).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { mcpEnabled: false },
		})
	})
})
