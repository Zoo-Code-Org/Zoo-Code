import { EventEmitter } from "events"

import { describe, expect, it, vi, type Mock } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"

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

type ProviderDouble = EventEmitter & {
	context: vscode.ExtensionContext
	on: Mock<(...args: unknown[]) => unknown>
	setValues: Mock<(...args: unknown[]) => Promise<void>>
	contextProxy: {
		setValues: Mock<(...args: unknown[]) => Promise<void>>
	}
	providerSettingsManager: {
		saveConfig: Mock<(...args: unknown[]) => Promise<string>>
	}
	postStateToWebview: Mock<(...args: unknown[]) => Promise<void>>
}

function asClineProvider(provider: ProviderDouble): ClineProvider {
	return provider as unknown as ClineProvider
}

describe("API.setConfiguration", () => {
	it("routes configuration through ClineProvider.setValues so view-local state stays in sync", async () => {
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const provider = {
			context: {} as vscode.ExtensionContext,
			on: vi.fn(),
			setValues: vi.fn().mockResolvedValue(undefined),
			contextProxy: {
				setValues: vi.fn().mockResolvedValue(undefined),
			},
			providerSettingsManager: {
				saveConfig: vi.fn().mockResolvedValue("default-id"),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		} as ProviderDouble
		const api = new API(outputChannel, asClineProvider(provider))
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
