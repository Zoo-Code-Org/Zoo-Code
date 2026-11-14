const { mockShowWarningMessage } = vi.hoisted(() => ({
	mockShowWarningMessage:
		vi.fn<
			(
				message: string,
				options: import("vscode").MessageOptions,
				...items: string[]
			) => Promise<string | undefined>
		>(),
}))

vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: mockShowWarningMessage,
	},
}))

// i18next loads no locale resources in the test environment, so t() would return
// the key. Resolve keys from the en bundle so dialog text and interpolation match
// production behavior.
vi.mock("../../i18n", async () => {
	const { default: enCommon } = await import("../../i18n/locales/en/common.json")
	return {
		t: (key: string, options?: Record<string, unknown>) => {
			const template = key
				.replace(/^common:/, "")
				.split(".")
				.reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enCommon)
			return typeof template === "string"
				? template.replace(/\{\{(\w+)\}\}/g, (match: string, name: string) => String(options?.[name] ?? match))
				: key
		},
	}
})

import * as vscode from "vscode"

const {
	mockGetVisibleInstance,
	mockGetAllInstances,
	mockHandleZooCodeAuthCallback,
	mockSetZooCodeUserInfo,
	mockVisibleProvider,
} = vi.hoisted(() => {
	// Visible provider double provides the OpenRouter, Requesty, and Zoo Code callbacks.
	const mockVisibleProvider = {
		handleOpenRouterCallback: vi.fn(),
		handleRequestyCallback: vi.fn(),
		handleZooCodeCallback: vi.fn(),
	} as unknown as ClineProvider

	return {
		mockGetVisibleInstance: vi.fn((): ClineProvider | null => mockVisibleProvider),
		mockGetAllInstances: vi.fn(() => [mockVisibleProvider]),
		mockHandleZooCodeAuthCallback: vi.fn(),
		mockSetZooCodeUserInfo: vi.fn(),
		mockVisibleProvider,
	}
})

vi.mock("../../core/webview/ClineProvider", () => ({
	ClineProvider: {
		getVisibleInstance: mockGetVisibleInstance,
		getAllInstances: mockGetAllInstances,
	},
}))

vi.mock("../../services/zoo-code-auth", () => ({
	handleAuthCallback: mockHandleZooCodeAuthCallback,
	setZooCodeUserInfo: mockSetZooCodeUserInfo,
}))

import { handleUri } from "../handleUri"
import { toRequestyServiceUrl } from "../../shared/utils/requesty"
import type { ClineProvider } from "../../core/webview/ClineProvider"

const makeUri = (uri: Pick<vscode.Uri, "path" | "query">): vscode.Uri => uri as vscode.Uri

const makeCallbackProvider = (callback = vi.fn()): ClineProvider =>
	// Provider double provides handleZooCodeCallback only.
	({ handleZooCodeCallback: callback }) as unknown as ClineProvider

describe("handleUri", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockShowWarningMessage.mockResolvedValue(undefined)
		mockGetVisibleInstance.mockReturnValue(mockVisibleProvider)
		mockGetAllInstances.mockReturnValue([mockVisibleProvider])
	})

	it.each(["/openrouter", "/requesty"])("dispatches %s codes without losing literal plus signs", async (path) => {
		mockShowWarningMessage.mockImplementation(async () => "Activate Requesty")
		await handleUri(makeUri({ path, query: "code=a+b%2Bc&baseUrl=https%3A%2F%2Fexample.com" }))

		if (path === "/openrouter") {
			expect(mockVisibleProvider.handleOpenRouterCallback).toHaveBeenCalledWith("a+b+c")
			expect(mockVisibleProvider.handleRequestyCallback).not.toHaveBeenCalled()
		} else {
			expect(mockVisibleProvider.handleRequestyCallback).toHaveBeenCalledWith("a+b+c", "https://example.com")
			expect(mockVisibleProvider.handleOpenRouterCallback).not.toHaveBeenCalled()
		}
	})

	it("passes null when Requesty has no base URL", async () => {
		mockShowWarningMessage.mockImplementation(async () => "Activate Requesty")
		await handleUri(makeUri({ path: "/requesty", query: "code=test-code" }))
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			"Activate Requesty credentials from an external link?",
			expect.objectContaining({ modal: true, detail: expect.stringContaining("https://router.requesty.ai/v1") }),
			"Activate Requesty",
		)
		expect(mockVisibleProvider.handleRequestyCallback).toHaveBeenCalledWith("test-code", null)
	})

	it.each(["not-a-url", "ftp://x.example", ""])(
		"shows the resolved destination for invalid baseUrl %s and passes the raw value",
		async (baseUrl) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			mockShowWarningMessage.mockImplementation(async () => "Activate Requesty")
			try {
				await handleUri(
					makeUri({ path: "/requesty", query: `code=test-code&baseUrl=${encodeURIComponent(baseUrl)}` }),
				)
			} finally {
				warn.mockRestore()
			}
			// The dialog shows what toRequestyServiceUrl resolves (the default on fallback),
			// while the callback receives the raw value for consumers to resolve again.
			expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
				"Activate Requesty credentials from an external link?",
				expect.objectContaining({
					modal: true,
					detail: expect.stringContaining(JSON.stringify(toRequestyServiceUrl(baseUrl))),
				}),
				"Activate Requesty",
			)
			expect(mockVisibleProvider.handleRequestyCallback).toHaveBeenCalledWith("test-code", baseUrl)
		},
	)

	it.each([undefined, "Cancel"])(
		"does not apply an unsolicited Requesty callback when dismissed with %s",
		async (choice) => {
			mockShowWarningMessage.mockImplementation(async () => choice)
			await handleUri(
				makeUri({ path: "/requesty", query: "code=attacker-key&baseUrl=https://attacker.example/v1" }),
			)
			expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
				"Activate Requesty credentials from an external link?",
				expect.objectContaining({
					modal: true,
					detail: expect.stringContaining("https://attacker.example/v1"),
				}),
				"Activate Requesty",
			)
			expect(mockVisibleProvider.handleRequestyCallback).not.toHaveBeenCalled()
		},
	)

	it("waits for explicit approval before applying callback credentials", async () => {
		let approve: (choice: string | undefined) => void = () => {}
		mockShowWarningMessage.mockImplementation(
			() =>
				new Promise<string | undefined>((resolve) => {
					approve = resolve
				}),
		)
		const callback = handleUri(makeUri({ path: "/requesty", query: "code=test-code" }))
		expect(mockVisibleProvider.handleRequestyCallback).not.toHaveBeenCalled()
		approve("Activate Requesty")
		await callback
		expect(mockVisibleProvider.handleRequestyCallback).toHaveBeenCalledWith("test-code", null)
	})

	it.each(["/openrouter", "/requesty"])("ignores %s when no provider is visible", async (path) => {
		mockGetVisibleInstance.mockReturnValue(null)
		await handleUri(makeUri({ path, query: "code=test-code" }))
		expect(mockVisibleProvider.handleOpenRouterCallback).not.toHaveBeenCalled()
		expect(mockVisibleProvider.handleRequestyCallback).not.toHaveBeenCalled()
	})

	it.each(["/openrouter", "/requesty", "/auth-callback", "/unknown"])(
		"ignores %s without callback credentials",
		async (path) => {
			await handleUri(makeUri({ path, query: "" }))
			expect(mockVisibleProvider.handleOpenRouterCallback).not.toHaveBeenCalled()
			expect(mockVisibleProvider.handleRequestyCallback).not.toHaveBeenCalled()
			expect(mockHandleZooCodeAuthCallback).not.toHaveBeenCalled()
			expect(mockSetZooCodeUserInfo).not.toHaveBeenCalled()
			expect(mockVisibleProvider.handleZooCodeCallback).not.toHaveBeenCalled()
		},
	)

	it("logs non-Error callback failures and continues to the next provider", async () => {
		mockHandleZooCodeAuthCallback.mockResolvedValue(true)
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		const failingProvider = makeCallbackProvider(vi.fn().mockRejectedValue("storage unavailable"))
		mockGetAllInstances.mockReturnValue([failingProvider, mockVisibleProvider])
		try {
			await handleUri(makeUri({ path: "/auth-callback", query: "token=test-token" }))
			expect(log).toHaveBeenCalledWith(
				"Failed to persist Zoo Gateway token for a provider instance:",
				"storage unavailable",
			)
			expect(mockVisibleProvider.handleZooCodeCallback).toHaveBeenCalledWith("test-token")
		} finally {
			log.mockRestore()
		}
	})

	it("ignores legacy cloud auth callback", async () => {
		await handleUri(
			makeUri({
				path: "/auth/clerk/callback",
				query: "code=test-code&state=test-state&organizationId=test-org",
			}),
		)

		expect(mockVisibleProvider.handleOpenRouterCallback).not.toHaveBeenCalled()
		expect(mockVisibleProvider.handleRequestyCallback).not.toHaveBeenCalled()
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			"Roo Code Cloud sign-in is currently unavailable. Configure another provider to continue.",
		)
	})

	it("stores callback user info even when no provider instances exist", async () => {
		mockGetVisibleInstance.mockReturnValue(null)
		mockGetAllInstances.mockReturnValue([])
		mockHandleZooCodeAuthCallback.mockResolvedValue(true)

		await handleUri(
			makeUri({
				path: "/auth-callback",
				query: "token=zoo_ext_test_token&name=Jane%20Doe&email=jane%40example.com&image=https%3A%2F%2Fexample.com%2Favatar.png",
			}),
		)

		expect(mockHandleZooCodeAuthCallback).toHaveBeenCalledWith("zoo_ext_test_token")
		expect(mockSetZooCodeUserInfo).toHaveBeenCalledWith({
			name: "Jane Doe",
			email: "jane@example.com",
			image: "https://example.com/avatar.png",
		})
		// No provider instances exist, so handleZooCodeCallback should not be called
		expect(mockVisibleProvider.handleZooCodeCallback).not.toHaveBeenCalled()
	})

	it("refreshes the visible provider after a successful auth callback", async () => {
		mockHandleZooCodeAuthCallback.mockResolvedValue(true)

		await handleUri(
			makeUri({
				path: "/auth-callback",
				query: "token=zoo_ext_test_token",
			}),
		)

		// When no user info is provided, null values are passed to clear stale data
		expect(mockSetZooCodeUserInfo).toHaveBeenCalledWith({
			name: null,
			email: null,
			image: null,
		})
		expect(mockVisibleProvider.handleZooCodeCallback).toHaveBeenCalledWith("zoo_ext_test_token")
	})

	it("clears stale user info fields when re-authing with missing fields", async () => {
		mockHandleZooCodeAuthCallback.mockResolvedValue(true)

		// Re-auth with only name - email and image should be cleared
		await handleUri(
			makeUri({
				path: "/auth-callback",
				query: "token=zoo_ext_test_token&name=John%20Doe",
			}),
		)

		expect(mockSetZooCodeUserInfo).toHaveBeenCalledWith({
			name: "John Doe",
			email: null,
			image: null,
		})
	})

	it("does not persist user info when auth callback validation fails", async () => {
		mockHandleZooCodeAuthCallback.mockResolvedValue(false)

		await handleUri(
			makeUri({
				path: "/auth-callback",
				query: "token=zoo_ext_test_token&name=Jane%20Doe",
			}),
		)

		expect(mockSetZooCodeUserInfo).not.toHaveBeenCalled()
		expect(mockVisibleProvider.handleZooCodeCallback).not.toHaveBeenCalled()
	})

	it("propagates the callback token to every ClineProvider instance, not just the visible one", async () => {
		// Regression: prior to multi-instance fan-out, hidden providers (sidebar collapsed,
		// secondary panels) never received the zooSessionToken, so their profile settings
		// stayed unauthenticated until reload.
		mockHandleZooCodeAuthCallback.mockResolvedValue(true)

		const hiddenProvider = makeCallbackProvider()
		const secondHidden = makeCallbackProvider()
		mockGetAllInstances.mockReturnValue([mockVisibleProvider, hiddenProvider, secondHidden])

		await handleUri(
			makeUri({
				path: "/auth-callback",
				query: "token=zoo_ext_test_token",
			}),
		)

		expect(mockHandleZooCodeAuthCallback).toHaveBeenCalledWith("zoo_ext_test_token")
		expect(mockSetZooCodeUserInfo).toHaveBeenCalled()
		expect(mockVisibleProvider.handleZooCodeCallback).toHaveBeenCalledWith("zoo_ext_test_token")
		expect(hiddenProvider.handleZooCodeCallback).toHaveBeenCalledWith("zoo_ext_test_token")
		expect(secondHidden.handleZooCodeCallback).toHaveBeenCalledWith("zoo_ext_test_token")
	})

	it("serializes callbacks across instances to avoid concurrent profile-store writes", async () => {
		// Regression: a previous implementation used Promise.all which fanned out concurrent
		// read-modify-write operations on the same provider settings store. Verify the
		// callbacks are invoked sequentially.
		mockHandleZooCodeAuthCallback.mockResolvedValue(true)

		const order: string[] = []
		const makeProvider = (name: string) =>
			makeCallbackProvider(
				vi.fn(async () => {
					order.push(`${name}:start`)
					// Yield to the event loop so a concurrent call would interleave.
					await new Promise((resolve) => setTimeout(resolve, 0))
					order.push(`${name}:end`)
				}),
			)

		const a = makeProvider("a")
		const b = makeProvider("b")
		mockGetAllInstances.mockReturnValue([a, b])

		await handleUri(
			makeUri({
				path: "/auth-callback",
				query: "token=zoo_ext_test_token",
			}),
		)

		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"])
	})

	it("continues fan-out when one instance fails to persist the callback token", async () => {
		mockHandleZooCodeAuthCallback.mockResolvedValue(true)

		const failingProvider = makeCallbackProvider(
			vi.fn(async () => {
				throw new Error("profile store unavailable")
			}),
		)
		const healthyProvider = makeCallbackProvider()
		mockGetAllInstances.mockReturnValue([failingProvider, healthyProvider])

		await handleUri(
			makeUri({
				path: "/auth-callback",
				query: "token=zoo_ext_test_token",
			}),
		)

		expect(failingProvider.handleZooCodeCallback).toHaveBeenCalledWith("zoo_ext_test_token")
		expect(healthyProvider.handleZooCodeCallback).toHaveBeenCalledWith("zoo_ext_test_token")
	})
})
