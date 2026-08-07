import { render, screen, act } from "@/utils/test-utils"
import React from "react"

import { ExtensionStateContextProvider, useExtensionState } from "../ExtensionStateContext"

const postMessageMock = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (msg: unknown) => postMessageMock(msg),
	},
}))

/** Harness that exposes every setter we want to cover. */
const SettersHarness = () => {
	const ctx = useExtensionState()

	// Store the context on window for assertion access
	;(window as any).__ctx__ = ctx

	return (
		<div>
			<div data-testid="state-snapshot">
				{JSON.stringify({
					historyPreviewCollapsed: ctx.historyPreviewCollapsed,
					reasoningBlockCollapsed: ctx.reasoningBlockCollapsed,
					chatFontSize: ctx.chatFontSize,
					enterBehavior: ctx.enterBehavior,
					hasOpenedModeSelector: ctx.hasOpenedModeSelector,
					autoCondenseContext: ctx.autoCondenseContext,
					autoCondenseContextPercent: ctx.autoCondenseContextPercent,
					profileThresholds: ctx.profileThresholds,
					includeDiagnosticMessages: ctx.includeDiagnosticMessages,
					maxDiagnosticMessages: ctx.maxDiagnosticMessages,
					includeTaskHistoryInEnhance: ctx.includeTaskHistoryInEnhance,
					includeCurrentTime: ctx.includeCurrentTime,
					includeCurrentCost: ctx.includeCurrentCost,
					showWorktreesInHomeScreen: ctx.showWorktreesInHomeScreen,
					soundEnabled: ctx.soundEnabled,
					soundVolume: ctx.soundVolume,
					ttsEnabled: ctx.ttsEnabled,
					ttsSpeed: ctx.ttsSpeed,
					enableCheckpoints: ctx.enableCheckpoints,
					checkpointTimeout: ctx.checkpointTimeout,
					writeDelayMs: ctx.writeDelayMs,
					terminalOutputPreviewSize: ctx.terminalOutputPreviewSize,
					terminalShellIntegrationTimeout: ctx.terminalShellIntegrationTimeout,
					terminalShellIntegrationDisabled: ctx.terminalShellIntegrationDisabled,
					terminalZdotdir: ctx.terminalZdotdir,
					mcpEnabled: ctx.mcpEnabled,
					taskSyncEnabled: ctx.taskSyncEnabled,
					currentApiConfigName: ctx.currentApiConfigName,
					mode: ctx.mode,
					customModePrompts: ctx.customModePrompts,
					customSupportPrompts: ctx.customSupportPrompts,
					enhancementApiConfigId: ctx.enhancementApiConfigId,
					autoApprovalEnabled: ctx.autoApprovalEnabled,
					customModes: ctx.customModes,
					maxOpenTabsContext: ctx.maxOpenTabsContext,
					maxWorkspaceFiles: ctx.maxWorkspaceFiles,
					telemetrySetting: ctx.telemetrySetting,
					showRooIgnoredFiles: ctx.showRooIgnoredFiles,
					enableSubfolderRules: ctx.enableSubfolderRules,
					awsUsePromptCache: ctx.awsUsePromptCache,
					maxImageFileSize: ctx.maxImageFileSize,
					maxTotalImageSize: ctx.maxTotalImageSize,
					pinnedApiConfigs: ctx.pinnedApiConfigs,
					shouldShowAnnouncement: ctx.shouldShowAnnouncement,
					allowedCommands: ctx.allowedCommands,
					deniedCommands: ctx.deniedCommands,
					allowedMaxRequests: ctx.allowedMaxRequests,
					allowedMaxCost: ctx.allowedMaxCost,
					alwaysAllowReadOnly: ctx.alwaysAllowReadOnly,
					alwaysAllowReadOnlyOutsideWorkspace: ctx.alwaysAllowReadOnlyOutsideWorkspace,
					alwaysAllowWrite: ctx.alwaysAllowWrite,
					alwaysAllowWriteOutsideWorkspace: ctx.alwaysAllowWriteOutsideWorkspace,
					alwaysAllowExecute: ctx.alwaysAllowExecute,
					alwaysAllowMcp: ctx.alwaysAllowMcp,
					alwaysAllowModeSwitch: ctx.alwaysAllowModeSwitch,
					alwaysAllowSubtasks: ctx.alwaysAllowSubtasks,
				})}
			</div>
		</div>
	)
}

const renderProvider = () =>
	render(
		<ExtensionStateContextProvider>
			<SettersHarness />
		</ExtensionStateContextProvider>,
	)

const getState = () => JSON.parse(screen.getByTestId("state-snapshot").textContent!)

describe("ExtensionStateContext setters", () => {
	beforeEach(() => {
		postMessageMock.mockClear()
	})

	it("setHistoryPreviewCollapsed updates state", () => {
		renderProvider()
		expect(getState().historyPreviewCollapsed).toBe(false)

		act(() => {
			;(window as any).__ctx__.setHistoryPreviewCollapsed(true)
		})
		expect(getState().historyPreviewCollapsed).toBe(true)
	})

	it("setReasoningBlockCollapsed updates state", () => {
		renderProvider()
		expect(getState().reasoningBlockCollapsed).toBe(true)

		act(() => {
			;(window as any).__ctx__.setReasoningBlockCollapsed(false)
		})
		expect(getState().reasoningBlockCollapsed).toBe(false)
	})

	it("setChatFontSize updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setChatFontSize(16)
		})
		expect(getState().chatFontSize).toBe(16)
	})

	it("setEnterBehavior updates state", () => {
		renderProvider()
		expect(getState().enterBehavior).toBe("send")

		act(() => {
			;(window as any).__ctx__.setEnterBehavior("newline")
		})
		expect(getState().enterBehavior).toBe("newline")
	})

	it("setHasOpenedModeSelector updates state", () => {
		renderProvider()
		expect(getState().hasOpenedModeSelector).toBe(false)

		act(() => {
			;(window as any).__ctx__.setHasOpenedModeSelector(true)
		})
		expect(getState().hasOpenedModeSelector).toBe(true)
	})

	it("setAutoCondenseContext updates state", () => {
		renderProvider()
		expect(getState().autoCondenseContext).toBe(true)

		act(() => {
			;(window as any).__ctx__.setAutoCondenseContext(false)
		})
		expect(getState().autoCondenseContext).toBe(false)
	})

	it("setAutoCondenseContextPercent updates state", () => {
		renderProvider()
		expect(getState().autoCondenseContextPercent).toBe(100)

		act(() => {
			;(window as any).__ctx__.setAutoCondenseContextPercent(80)
		})
		expect(getState().autoCondenseContextPercent).toBe(80)
	})

	it("setProfileThresholds updates state", () => {
		renderProvider()
		expect(getState().profileThresholds).toEqual({})

		act(() => {
			;(window as any).__ctx__.setProfileThresholds({ low: 10, high: 90 })
		})
		expect(getState().profileThresholds).toEqual({ low: 10, high: 90 })
	})

	it("setIncludeDiagnosticMessages updates state", () => {
		renderProvider()
		expect(getState().includeDiagnosticMessages).toBe(true)

		act(() => {
			;(window as any).__ctx__.setIncludeDiagnosticMessages(false)
		})
		expect(getState().includeDiagnosticMessages).toBe(false)
	})

	it("setMaxDiagnosticMessages updates state", () => {
		renderProvider()
		expect(getState().maxDiagnosticMessages).toBe(50)

		act(() => {
			;(window as any).__ctx__.setMaxDiagnosticMessages(100)
		})
		expect(getState().maxDiagnosticMessages).toBe(100)
	})

	it("setIncludeTaskHistoryInEnhance updates state", () => {
		renderProvider()
		expect(getState().includeTaskHistoryInEnhance).toBe(true)

		act(() => {
			;(window as any).__ctx__.setIncludeTaskHistoryInEnhance(false)
		})
		expect(getState().includeTaskHistoryInEnhance).toBe(false)
	})

	it("setIncludeCurrentTime updates state", () => {
		renderProvider()
		expect(getState().includeCurrentTime).toBe(true)

		act(() => {
			;(window as any).__ctx__.setIncludeCurrentTime(false)
		})
		expect(getState().includeCurrentTime).toBe(false)
	})

	it("setIncludeCurrentCost updates state", () => {
		renderProvider()
		expect(getState().includeCurrentCost).toBe(true)

		act(() => {
			;(window as any).__ctx__.setIncludeCurrentCost(false)
		})
		expect(getState().includeCurrentCost).toBe(false)
	})

	it("setShowWorktreesInHomeScreen updates state", () => {
		renderProvider()
		expect(getState().showWorktreesInHomeScreen).toBe(true)

		act(() => {
			;(window as any).__ctx__.setShowWorktreesInHomeScreen(false)
		})
		expect(getState().showWorktreesInHomeScreen).toBe(false)
	})

	it("setSoundEnabled updates state", () => {
		renderProvider()
		expect(getState().soundEnabled).toBe(false)

		act(() => {
			;(window as any).__ctx__.setSoundEnabled(true)
		})
		expect(getState().soundEnabled).toBe(true)
	})

	it("setSoundVolume updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setSoundVolume(0.8)
		})
		expect(getState().soundVolume).toBe(0.8)
	})

	it("setTtsEnabled updates state", () => {
		renderProvider()
		expect(getState().ttsEnabled).toBe(false)

		act(() => {
			;(window as any).__ctx__.setTtsEnabled(true)
		})
		expect(getState().ttsEnabled).toBe(true)
	})

	it("setTtsSpeed updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setTtsSpeed(1.5)
		})
		expect(getState().ttsSpeed).toBe(1.5)
	})

	it("setEnableCheckpoints updates state", () => {
		renderProvider()
		expect(getState().enableCheckpoints).toBe(true)

		act(() => {
			;(window as any).__ctx__.setEnableCheckpoints(false)
		})
		expect(getState().enableCheckpoints).toBe(false)
	})

	it("setCheckpointTimeout updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setCheckpointTimeout(30)
		})
		expect(getState().checkpointTimeout).toBe(30)
	})

	it("setWriteDelayMs updates state", () => {
		renderProvider()
		expect(getState().writeDelayMs).toBe(1000)

		act(() => {
			;(window as any).__ctx__.setWriteDelayMs(2000)
		})
		expect(getState().writeDelayMs).toBe(2000)
	})

	it("setTerminalOutputPreviewSize updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setTerminalOutputPreviewSize("large")
		})
		expect(getState().terminalOutputPreviewSize).toBe("large")
	})

	it("setTerminalShellIntegrationTimeout updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setTerminalShellIntegrationTimeout(5000)
		})
		expect(getState().terminalShellIntegrationTimeout).toBe(5000)
	})

	it("setTerminalShellIntegrationDisabled updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setTerminalShellIntegrationDisabled(true)
		})
		expect(getState().terminalShellIntegrationDisabled).toBe(true)
	})

	it("setTerminalZdotdir updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setTerminalZdotdir(true)
		})
		expect(getState().terminalZdotdir).toBe(true)
	})

	it("setMcpEnabled updates state", () => {
		renderProvider()
		expect(getState().mcpEnabled).toBe(true)

		act(() => {
			;(window as any).__ctx__.setMcpEnabled(false)
		})
		expect(getState().mcpEnabled).toBe(false)
	})

	it("setTaskSyncEnabled updates state", () => {
		renderProvider()
		expect(getState().taskSyncEnabled).toBe(false)

		act(() => {
			;(window as any).__ctx__.setTaskSyncEnabled(true)
		})
		expect(getState().taskSyncEnabled).toBe(true)
	})

	it("setCurrentApiConfigName updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setCurrentApiConfigName("custom-config")
		})
		expect(getState().currentApiConfigName).toBe("custom-config")
	})

	it("setMode updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setMode("architect")
		})
		expect(getState().mode).toBe("architect")
	})

	it("setCustomModePrompts updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setCustomModePrompts({ code: "Custom code prompt" })
		})
		expect(getState().customModePrompts).toEqual(expect.objectContaining({ code: "Custom code prompt" }))
	})

	it("setCustomSupportPrompts updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setCustomSupportPrompts({ enhance: "Enhance this" })
		})
		expect(getState().customSupportPrompts).toEqual({ enhance: "Enhance this" })
	})

	it("setEnhancementApiConfigId updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setEnhancementApiConfigId("enh-config")
		})
		expect(getState().enhancementApiConfigId).toBe("enh-config")
	})

	it("setAutoApprovalEnabled updates state", () => {
		renderProvider()
		expect(getState().autoApprovalEnabled).toBe(false)

		act(() => {
			;(window as any).__ctx__.setAutoApprovalEnabled(true)
		})
		expect(getState().autoApprovalEnabled).toBe(true)
	})

	it("setCustomModes updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setCustomModes([{ slug: "custom", name: "Custom" }])
		})
		expect(getState().customModes).toEqual([{ slug: "custom", name: "Custom" }])
	})

	it("setMaxOpenTabsContext updates state", () => {
		renderProvider()
		expect(getState().maxOpenTabsContext).toBe(20)

		act(() => {
			;(window as any).__ctx__.setMaxOpenTabsContext(50)
		})
		expect(getState().maxOpenTabsContext).toBe(50)
	})

	it("setMaxWorkspaceFiles updates state", () => {
		renderProvider()
		expect(getState().maxWorkspaceFiles).toBe(200)

		act(() => {
			;(window as any).__ctx__.setMaxWorkspaceFiles(500)
		})
		expect(getState().maxWorkspaceFiles).toBe(500)
	})

	it("setTelemetrySetting updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setTelemetrySetting("enabled")
		})
		expect(getState().telemetrySetting).toBe("enabled")
	})

	it("setShowRooIgnoredFiles updates state", () => {
		renderProvider()
		expect(getState().showRooIgnoredFiles).toBe(true)

		act(() => {
			;(window as any).__ctx__.setShowRooIgnoredFiles(false)
		})
		expect(getState().showRooIgnoredFiles).toBe(false)
	})

	it("setEnableSubfolderRules updates state", () => {
		renderProvider()
		expect(getState().enableSubfolderRules).toBe(false)

		act(() => {
			;(window as any).__ctx__.setEnableSubfolderRules(true)
		})
		expect(getState().enableSubfolderRules).toBe(true)
	})

	it("setAwsUsePromptCache updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setAwsUsePromptCache(true)
		})
		expect(getState().awsUsePromptCache).toBe(true)
	})

	it("setMaxImageFileSize updates state", () => {
		renderProvider()
		expect(getState().maxImageFileSize).toBe(5)

		act(() => {
			;(window as any).__ctx__.setMaxImageFileSize(10)
		})
		expect(getState().maxImageFileSize).toBe(10)
	})

	it("setMaxTotalImageSize updates state", () => {
		renderProvider()
		expect(getState().maxTotalImageSize).toBe(20)

		act(() => {
			;(window as any).__ctx__.setMaxTotalImageSize(50)
		})
		expect(getState().maxTotalImageSize).toBe(50)
	})

	it("setPinnedApiConfigs updates state", () => {
		renderProvider()
		expect(getState().pinnedApiConfigs).toEqual({})

		act(() => {
			;(window as any).__ctx__.setPinnedApiConfigs({ "config-1": true })
		})
		expect(getState().pinnedApiConfigs).toEqual({ "config-1": true })
	})

	it("togglePinnedApiConfig pins and unpins a config", () => {
		renderProvider()

		// Pin
		act(() => {
			;(window as any).__ctx__.togglePinnedApiConfig("config-1")
		})
		expect(getState().pinnedApiConfigs).toEqual({ "config-1": true })

		// Unpin (removes from object)
		act(() => {
			;(window as any).__ctx__.togglePinnedApiConfig("config-1")
		})
		expect(getState().pinnedApiConfigs).toEqual({})
	})

	it("setShowAnnouncement updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setShowAnnouncement(true)
		})
		expect(getState().shouldShowAnnouncement).toBe(true)
	})

	it("setAllowedCommands updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setAllowedCommands(["npm", "git"])
		})
		expect(getState().allowedCommands).toEqual(["npm", "git"])
	})

	it("setDeniedCommands updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setDeniedCommands(["rm -rf"])
		})
		expect(getState().deniedCommands).toEqual(["rm -rf"])
	})

	it("setAllowedMaxRequests updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setAllowedMaxRequests(100)
		})
		expect(getState().allowedMaxRequests).toBe(100)
	})

	it("setAllowedMaxCost updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setAllowedMaxCost(5.0)
		})
		expect(getState().allowedMaxCost).toBe(5.0)
	})

	it("setAlwaysAllowReadOnly updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setAlwaysAllowReadOnly(true)
		})
		expect(getState().alwaysAllowReadOnly).toBe(true)
	})

	it("setAlwaysAllowReadOnlyOutsideWorkspace updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setAlwaysAllowReadOnlyOutsideWorkspace(true)
		})
		expect(getState().alwaysAllowReadOnlyOutsideWorkspace).toBe(true)
	})

	it("setAlwaysAllowWrite updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setAlwaysAllowWrite(true)
		})
		expect(getState().alwaysAllowWrite).toBe(true)
	})

	it("setAlwaysAllowWriteOutsideWorkspace updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setAlwaysAllowWriteOutsideWorkspace(true)
		})
		expect(getState().alwaysAllowWriteOutsideWorkspace).toBe(true)
	})

	it("setAlwaysAllowExecute updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setAlwaysAllowExecute(true)
		})
		expect(getState().alwaysAllowExecute).toBe(true)
	})

	it("setAlwaysAllowMcp updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setAlwaysAllowMcp(true)
		})
		expect(getState().alwaysAllowMcp).toBe(true)
	})

	it("setAlwaysAllowModeSwitch updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setAlwaysAllowModeSwitch(true)
		})
		expect(getState().alwaysAllowModeSwitch).toBe(true)
	})

	it("setAlwaysAllowSubtasks updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setAlwaysAllowSubtasks(true)
		})
		expect(getState().alwaysAllowSubtasks).toBe(true)
	})

	it("setExperimentEnabled updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setExperimentEnabled("experiment-1", true)
		})
		// Experiments are merged into the experiments object
		const ctx = (window as any).__ctx__
		expect(ctx.experiments["experiment-1"]).toBe(true)
	})

	it("setApiConfiguration merges configuration", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setApiConfiguration({ apiKey: "test-key" })
		})
		const ctx = (window as any).__ctx__
		expect(ctx.apiConfiguration.apiKey).toBe("test-key")
	})

	it("setCustomInstructions updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setCustomInstructions("Always be helpful")
		})
		const ctx = (window as any).__ctx__
		expect(ctx.customInstructions).toBe("Always be helpful")
	})

	it("setListApiConfigMeta updates state", () => {
		renderProvider()

		act(() => {
			;(window as any).__ctx__.setListApiConfigMeta([{ name: "default", provider: "openai" }])
		})
		const ctx = (window as any).__ctx__
		expect(ctx.listApiConfigMeta).toEqual([{ name: "default", provider: "openai" }])
	})
})
