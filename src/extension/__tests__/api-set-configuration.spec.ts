import { describe, expect, it, vi } from "vitest"

import { providerIdentifiers } from "@roo-code/types"

import { API } from "../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"
import type { OutputChannel } from "vscode"
// The merged API constructor requires a ClineProviderFactory; these specs drive
// tab creation through the mocked createClineTabPanel, so the factory must never
// be called. Cast structurally: the class type carries private members.
const makeUnusedTabFactory = () =>
	({
		createInNewTab: vi.fn().mockRejectedValue(new Error("Unexpected editor-tab creation in this test")),
	}) as unknown as ConstructorParameters<typeof API>[2]

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
		const provider = Object.assign({} as ClineProvider, {
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
		})
		const api = new API(
			Object.assign({} as OutputChannel, { appendLine: vi.fn() }),
			provider,
			makeUnusedTabFactory(),
		)
		const configuration = {
			apiProvider: providerIdentifiers.bedrock,
			currentApiConfigName: "default",
			awsRegion: "us-east-1",
			apiModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		}

		await api.setConfiguration(configuration)

		// Exact side-effect counts: a regression that repeats any of these operations
		// (duplicate settings write, duplicate profile save, duplicate webview post) fails.
		expect(provider.setValues).toHaveBeenCalledTimes(1)
		expect(provider.setValues).toHaveBeenCalledWith(configuration)
		expect(provider.contextProxy.setValues).not.toHaveBeenCalled()
		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledTimes(1)
		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("default", configuration)
		expect(provider.postStateToWebview).toHaveBeenCalledTimes(1)
	})
})
