vi.mock("@/lib/storage/index.js", () => ({
	loadToken: vi.fn(),
	loadCredentials: vi.fn(),
	getCredentialsPath: vi.fn(() => "/tmp/roo/cli-credentials.json"),
	hasToken: vi.fn(),
	clearToken: vi.fn(),
}))

vi.mock("@/lib/auth/index.js", () => ({
	isTokenExpired: vi.fn(),
	isTokenValid: vi.fn(),
	getTokenExpirationDate: vi.fn(),
}))

import { status } from "../status.js"
import { logout } from "../logout.js"
import { loadToken, loadCredentials, getCredentialsPath, hasToken, clearToken } from "@/lib/storage/index.js"
import { isTokenExpired, isTokenValid, getTokenExpirationDate } from "@/lib/auth/index.js"

describe("auth commands", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("reports missing Roo auth tokens as normal for standard CLI usage", async () => {
		vi.mocked(loadToken).mockResolvedValue(null)
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})

		const result = await status()

		expect(result).toEqual({ authenticated: false })
		expect(consoleLog.mock.calls.flat().join("\n")).toContain("Normal CLI usage does not require login.")
		expect(consoleLog.mock.calls.flat().join("\n")).toContain("Roo Code Router has been removed")
	})

	it("reports optional Roo auth token details when available", async () => {
		const token = "header.payload.signature"
		const expiresAt = new Date("2026-05-01T00:00:00.000Z")

		vi.mocked(loadToken).mockResolvedValue(token)
		vi.mocked(loadCredentials).mockResolvedValue({ token, createdAt: "2026-04-01T00:00:00.000Z" })
		vi.mocked(isTokenValid).mockReturnValue(true)
		vi.mocked(isTokenExpired).mockReturnValue(false)
		vi.mocked(getTokenExpirationDate).mockReturnValue(expiresAt)
		vi.mocked(getCredentialsPath).mockReturnValue("/tmp/roo/cli-credentials.json")
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})

		const result = await status({ verbose: true })

		expect(result.authenticated).toBe(true)
		expect(consoleLog.mock.calls.flat().join("\n")).toContain("Legacy Roo auth token still stored")
		expect(consoleLog.mock.calls.flat().join("\n")).toContain("/tmp/roo/cli-credentials.json")
	})

	it("removes stored Roo auth tokens", async () => {
		vi.mocked(hasToken).mockResolvedValue(true)
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})

		const result = await logout()

		expect(result).toEqual({ success: true, wasLoggedIn: true })
		expect(clearToken).toHaveBeenCalledTimes(1)
		expect(consoleLog.mock.calls.flat().join("\n")).toContain("Removed stored legacy Roo auth token")
	})

	it("treats missing Roo auth tokens as already logged out", async () => {
		vi.mocked(hasToken).mockResolvedValue(false)
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})

		const result = await logout()

		expect(result).toEqual({ success: true, wasLoggedIn: false })
		expect(clearToken).not.toHaveBeenCalled()
		expect(consoleLog.mock.calls.flat().join("\n")).toContain("No legacy Roo auth token stored.")
	})
})
