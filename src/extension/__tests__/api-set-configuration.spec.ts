import { describe, expect, it, vi } from "vitest"

import { API } from "../api"

vi.mock("@roo-code/ipc", () => ({
	IpcServer: class {},
}))

vi.mock("../../integrations/terminal/Terminal", () => ({
	Terminal: {
		getTerminalProfile: vi.fn(),
		setTerminalProfile: vi.fn(),
	},
}))

vi.mock("../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		closeIdleTerminals: vi.fn(),
	},
}))

describe("API.setConfiguration", () => {
	it("routes configuration through ClineProvider.setValues so view-local state stays in sync", async () => {
		const provider = {
			context: {},
			on: vi.fn(),
			setValues: vi.fn().mockResolvedValue(undefined),
			contextProxy: {
				setValues: vi.fn().mockResolvedValue(undefined),
			},
			providerSettingsManager: {
				saveConfig: vi.fn().mockResolvedValue("default-id"),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		} as any
		const api = new API({ appendLine: vi.fn() } as any, provider)
		const configuration = {
			apiProvider: "bedrock" as const,
			currentApiConfigName: "default",
			awsRegion: "us-east-1",
			apiModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		}

		await api.setConfiguration(configuration)

		expect(provider.setValues).toHaveBeenCalledWith(configuration)
		expect(provider.contextProxy.setValues).not.toHaveBeenCalled()
		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("default", configuration)
		expect(provider.postStateToWebview).toHaveBeenCalled()
	})
})
