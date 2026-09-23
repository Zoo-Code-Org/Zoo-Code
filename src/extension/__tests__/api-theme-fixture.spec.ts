import { describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"

import { API } from "../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"

vi.mock("@roo-code/ipc", () => ({
	IpcServer: class {},
}))

describe("API - theme fixture probe", () => {
	it("delegates capture to the sidebar provider", async () => {
		const fixture = {
			themeId: "Default Dark Modern",
			bodyClass: "vscode-dark",
			variables: { "--vscode-foreground": "#cccccc" },
		}
		const requestWebviewThemeFixture = vi.fn().mockResolvedValue(fixture)
		const provider = {
			context: {},
			on: vi.fn(),
			requestWebviewThemeFixture,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider)

		await expect(api.captureWebviewThemeFixture()).resolves.toEqual(fixture)
		expect(requestWebviewThemeFixture).toHaveBeenCalledOnce()
	})

	it("exposes the current announcement id for deterministic test setup", () => {
		const provider = {
			context: {},
			on: vi.fn(),
			latestAnnouncementId: "current-announcement",
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider)

		expect(api.getLatestAnnouncementId()).toBe("current-announcement")
	})
})
