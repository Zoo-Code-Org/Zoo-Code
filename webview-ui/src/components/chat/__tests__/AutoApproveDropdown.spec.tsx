import { fireEvent, render, screen } from "@/utils/test-utils"
import { describe, expect, test, vi } from "vitest"

import { AutoApproveDropdown } from "../AutoApproveDropdown"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		autoApprovalEnabled: false,
		setAutoApprovalEnabled: vi.fn(),
		setAlwaysAllowReadOnly: vi.fn(),
		setAlwaysAllowWrite: vi.fn(),
		setAlwaysAllowExecute: vi.fn(),
		setAlwaysAllowMcp: vi.fn(),
		setAlwaysAllowModeSwitch: vi.fn(),
		setAlwaysAllowSubtasks: vi.fn(),
		setAlwaysAllowFollowupQuestions: vi.fn(),
	}),
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/hooks/useAutoApprovalToggles", () => ({
	useAutoApprovalToggles: () => ({
		alwaysAllowReadOnly: false,
		alwaysAllowWrite: false,
		alwaysAllowExecute: false,
		alwaysAllowMcp: false,
		alwaysAllowModeSwitch: false,
		alwaysAllowSubtasks: false,
		alwaysAllowFollowupQuestions: false,
	}),
}))

vi.mock("@/hooks/useAutoApprovalState", () => ({
	useAutoApprovalState: () => ({ effectiveAutoApprovalEnabled: false }),
}))

vi.mock("@/components/ui/hooks/useRooPortal", () => ({
	useRooPortal: () => document.body,
}))

describe("AutoApproveDropdown", () => {
	test("enables the trigger by default", () => {
		render(<AutoApproveDropdown />)

		expect(screen.getByTestId("auto-approve-dropdown-trigger")).toBeEnabled()
	})

	test("disables the trigger when auto-approval controls are unavailable", () => {
		render(<AutoApproveDropdown disabled />)

		expect(screen.getByTestId("auto-approve-dropdown-trigger")).toBeDisabled()
	})

	test("translates the master toggle label and its aria-label", () => {
		render(<AutoApproveDropdown />)

		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))

		expect(screen.getByText("chat:autoApprove.enabled")).toBeInTheDocument()
		expect(screen.getByRole("switch", { name: "chat:autoApprove.toggleAriaLabel" })).toBeInTheDocument()
	})
})
