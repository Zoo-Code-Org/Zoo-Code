vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
	},
}))

import * as vscode from "vscode"

const { mockGetVisibleInstance, mockHandleZooCodeAuthCallback, mockSetZooCodeUserInfo, mockVisibleProvider } =
	vi.hoisted(() => {
		const mockVisibleProvider = {
			handleOpenRouterCallback: vi.fn(),
			handleRequestyCallback: vi.fn(),
			handleZooCodeCallback: vi.fn(),
		} as any

		return {
			mockGetVisibleInstance: vi.fn(() => mockVisibleProvider),
			mockHandleZooCodeAuthCallback: vi.fn(),
			mockSetZooCodeUserInfo: vi.fn(),
			mockVisibleProvider,
		}
	})

vi.mock("../../core/webview/ClineProvider", () => ({
	ClineProvider: {
		getVisibleInstance: mockGetVisibleInstance,
	},
}))

vi.mock("../../services/zoo-code-auth", () => ({
	handleAuthCallback: mockHandleZooCodeAuthCallback,
	setZooCodeUserInfo: mockSetZooCodeUserInfo,
}))

import { handleUri } from "../handleUri"

describe("handleUri", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetVisibleInstance.mockReturnValue(mockVisibleProvider)
	})

	it("ignores legacy cloud auth callback", async () => {
		await handleUri({
			path: "/auth/clerk/callback",
			query: "code=test-code&state=test-state&organizationId=test-org",
		} as any)

		expect(mockVisibleProvider.handleOpenRouterCallback).not.toHaveBeenCalled()
		expect(mockVisibleProvider.handleRequestyCallback).not.toHaveBeenCalled()
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			"Roo Code Cloud sign-in is currently unavailable. Configure another provider to continue.",
		)
	})

	it("stores callback user info even when no webview is visible", async () => {
		mockGetVisibleInstance.mockReturnValue(null)
		mockHandleZooCodeAuthCallback.mockResolvedValue(true)

		await handleUri({
			path: "/auth-callback",
			query: "token=zoo_ext_test_token&name=Jane%20Doe&email=jane%40example.com&image=https%3A%2F%2Fexample.com%2Favatar.png",
		} as any)

		expect(mockHandleZooCodeAuthCallback).toHaveBeenCalledWith("zoo_ext_test_token")
		expect(mockSetZooCodeUserInfo).toHaveBeenCalledWith({
			name: "Jane Doe",
			email: "jane@example.com",
			image: "https://example.com/avatar.png",
		})
		expect(mockVisibleProvider.handleZooCodeCallback).not.toHaveBeenCalled()
	})

	it("refreshes the visible provider after a successful auth callback", async () => {
		mockHandleZooCodeAuthCallback.mockResolvedValue(true)

		await handleUri({
			path: "/auth-callback",
			query: "token=zoo_ext_test_token",
		} as any)

		expect(mockVisibleProvider.handleZooCodeCallback).toHaveBeenCalledWith("zoo_ext_test_token")
	})

	it("does not persist user info when auth callback validation fails", async () => {
		mockHandleZooCodeAuthCallback.mockResolvedValue(false)

		await handleUri({
			path: "/auth-callback",
			query: "token=zoo_ext_test_token&name=Jane%20Doe",
		} as any)

		expect(mockSetZooCodeUserInfo).not.toHaveBeenCalled()
		expect(mockVisibleProvider.handleZooCodeCallback).not.toHaveBeenCalled()
	})
})
