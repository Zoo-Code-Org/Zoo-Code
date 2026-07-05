// npx vitest run core/webview/__tests__/webviewMessageHandler.validateAgents.spec.ts

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"

vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: [],
	},
}))

vi.mock("../../../i18n", () => ({
	t: (key: string, options?: Record<string, any>) => (options ? `${key} ${JSON.stringify(options)}` : key),
}))

vi.mock("../../../integrations/misc/open-file", () => ({
	openFile: vi.fn(),
}))

describe("webviewMessageHandler - agents validation", () => {
	let mockProvider: {
		customModesManager: {
			getProjectModesFileInfo: ReturnType<typeof vi.fn>
			validateAgentsFile: ReturnType<typeof vi.fn>
		}
		postMessageToWebview: ReturnType<typeof vi.fn>
		log: ReturnType<typeof vi.fn>
	}

	beforeEach(() => {
		vi.clearAllMocks()

		mockProvider = {
			customModesManager: {
				getProjectModesFileInfo: vi.fn(),
				validateAgentsFile: vi.fn(),
			},
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
		}
	})

	describe("case 'openProjectModesFile'", () => {
		it("opens the server-resolved project modes file with its default content", async () => {
			const { openFile } = await import("../../../integrations/misc/open-file")
			mockProvider.customModesManager.getProjectModesFileInfo.mockResolvedValue({
				filePath: "/workspace/.boo/agents.yaml",
				defaultContent: "customModes: []\n",
			})

			await webviewMessageHandler(mockProvider as unknown as ClineProvider, {
				type: "openProjectModesFile",
			})

			expect(openFile).toHaveBeenCalledWith("/workspace/.boo/agents.yaml", {
				create: true,
				content: "customModes: []\n",
			})
		})
	})

	describe("case 'validateAgents'", () => {
		it("posts the structured validation result back to the webview", async () => {
			mockProvider.customModesManager.validateAgentsFile.mockResolvedValue({
				filePath: "/workspace/.boo/agents.yaml",
				errors: [],
				warnings: ["common:customModes.validate.missingWhenToUse"],
			})

			await webviewMessageHandler(mockProvider as unknown as ClineProvider, {
				type: "validateAgents",
			})

			expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "agentsValidationResult",
				agentsValidation: {
					filePath: "/workspace/.boo/agents.yaml",
					errors: [],
					warnings: ["common:customModes.validate.missingWhenToUse"],
				},
			})
		})

		it("reports an unexpected error back to the webview instead of throwing", async () => {
			mockProvider.customModesManager.validateAgentsFile.mockRejectedValue(new Error("boom"))

			await webviewMessageHandler(mockProvider as unknown as ClineProvider, {
				type: "validateAgents",
			})

			expect(mockProvider.postMessageToWebview).toHaveBeenCalledTimes(1)
			const [call] = mockProvider.postMessageToWebview.mock.calls[0]
			expect(call.type).toBe("agentsValidationResult")
			expect(call.agentsValidation.errors).toHaveLength(1)
			expect(call.agentsValidation.warnings).toEqual([])
		})
	})
})
