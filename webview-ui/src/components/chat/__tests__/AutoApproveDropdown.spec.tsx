import { render, screen, fireEvent } from "@/utils/test-utils"
import { describe, expect, test, vi, beforeEach } from "vitest"

import { AutoApproveDropdown } from "../AutoApproveDropdown"

const mocks = vi.hoisted(() => ({
	postMessage: vi.fn(),
	setAutoApprovalEnabled: vi.fn(),
	setAlwaysAllowReadOnly: vi.fn(),
	setAlwaysAllowWrite: vi.fn(),
	setAlwaysAllowExecute: vi.fn(),
	setAlwaysAllowMcp: vi.fn(),
	setAlwaysAllowModeSwitch: vi.fn(),
	setAlwaysAllowSubtasks: vi.fn(),
	setAlwaysAllowWebFetch: vi.fn(),
	setAlwaysAllowFollowupQuestions: vi.fn(),
	state: {
		autoApprovalEnabled: false as boolean | undefined,
	},
	toggles: {
		alwaysAllowReadOnly: false,
		alwaysAllowWrite: false,
		alwaysAllowExecute: false,
		alwaysAllowMcp: false,
		alwaysAllowModeSwitch: false,
		alwaysAllowSubtasks: false,
		alwaysAllowWebFetch: false,
		alwaysAllowFollowupQuestions: false,
	} as Record<string, boolean | undefined>,
	effectiveAutoApprovalEnabled: false,
}))

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: mocks.postMessage } }))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		autoApprovalEnabled: mocks.state.autoApprovalEnabled,
		setAutoApprovalEnabled: mocks.setAutoApprovalEnabled,
		setAlwaysAllowReadOnly: mocks.setAlwaysAllowReadOnly,
		setAlwaysAllowWrite: mocks.setAlwaysAllowWrite,
		setAlwaysAllowExecute: mocks.setAlwaysAllowExecute,
		setAlwaysAllowMcp: mocks.setAlwaysAllowMcp,
		setAlwaysAllowModeSwitch: mocks.setAlwaysAllowModeSwitch,
		setAlwaysAllowSubtasks: mocks.setAlwaysAllowSubtasks,
		setAlwaysAllowWebFetch: mocks.setAlwaysAllowWebFetch,
		setAlwaysAllowFollowupQuestions: mocks.setAlwaysAllowFollowupQuestions,
	}),
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/hooks/useAutoApprovalToggles", () => ({
	useAutoApprovalToggles: () => mocks.toggles,
}))

vi.mock("@/hooks/useAutoApprovalState", () => ({
	useAutoApprovalState: () => ({ effectiveAutoApprovalEnabled: mocks.effectiveAutoApprovalEnabled }),
}))

vi.mock("@/components/ui/hooks/useRooPortal", () => ({
	useRooPortal: () => document.body,
}))

describe("AutoApproveDropdown", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.state.autoApprovalEnabled = false
		mocks.effectiveAutoApprovalEnabled = false
		mocks.toggles.alwaysAllowWebFetch = false
	})

	test("enables the trigger by default", () => {
		render(<AutoApproveDropdown />)

		expect(screen.getByTestId("auto-approve-dropdown-trigger")).toBeEnabled()
	})

	test("disables the trigger when auto-approval controls are unavailable", () => {
		render(<AutoApproveDropdown disabled />)

		expect(screen.getByTestId("auto-approve-dropdown-trigger")).toBeDisabled()
	})

	test("toggles web fetch auto-approval from the dropdown", () => {
		mocks.effectiveAutoApprovalEnabled = true

		render(<AutoApproveDropdown />)

		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))

		const webFetchButton = screen.getByTestId("auto-approve-alwaysAllowWebFetch")
		expect(webFetchButton).toBeEnabled()

		fireEvent.click(webFetchButton)

		expect(mocks.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { alwaysAllowWebFetch: true },
		})
		expect(mocks.setAlwaysAllowWebFetch).toHaveBeenCalledWith(true)
		expect(mocks.setAlwaysAllowWebFetch).toHaveBeenCalledTimes(1)
	})
})
