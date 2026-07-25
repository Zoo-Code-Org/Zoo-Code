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

	// Case 3b: deniedCommands remove
	it("buffers a removed denied command without persisting before Save", () => {
		const { setCachedStateField } = renderSettings({ deniedCommands: ["rm -rf"] })

		fireEvent.click(screen.getByTestId("remove-denied-command-0"))

		expect(setCachedStateField).toHaveBeenCalledWith("deniedCommands", [])
		expectNoImmediateUpdateSettings()
	})
})
