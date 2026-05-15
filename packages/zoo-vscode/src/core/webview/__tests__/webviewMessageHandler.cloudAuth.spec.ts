import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn(),
		instance: {
			login: vi.fn(),
			handleAuthCallback: vi.fn(),
		},
	},
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
}))

import * as vscode from "vscode"

import { CloudService } from "@roo-code/cloud"

import { webviewMessageHandler } from "../webviewMessageHandler"

describe("webviewMessageHandler cloud auth fallbacks", () => {
	const mockProvider = {
		postMessageToWebview: vi.fn(),
		postStateToWebview: vi.fn(),
		contextProxy: {
			getValue: vi.fn(),
			setValue: vi.fn(),
		},
		getCurrentTask: vi.fn(),
		cwd: "/test/path",
		log: vi.fn(),
	} as any

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("does not attempt cloud sign-in when CloudService is unavailable", async () => {
		vi.mocked(CloudService.hasInstance).mockReturnValue(false)

		await webviewMessageHandler(mockProvider, {
			type: "rooCloudSignIn",
			useProviderSignup: true,
		} as any)

		expect(CloudService.instance.login).not.toHaveBeenCalled()
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			"Roo Code Cloud sign-in is currently unavailable. Configure another provider to continue.",
		)
	})

	it("ignores manual auth callback when CloudService is unavailable", async () => {
		vi.mocked(CloudService.hasInstance).mockReturnValue(false)

		await webviewMessageHandler(mockProvider, {
			type: "rooCloudManualUrl",
			text: "vscode://ZooCodeOrganization.zoo-code/auth/clerk/callback?code=test-code&state=test-state",
		} as any)

		expect(CloudService.instance.handleAuthCallback).not.toHaveBeenCalled()
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			"Roo Code Cloud sign-in is currently unavailable. Configure another provider to continue.",
		)
	})
})
