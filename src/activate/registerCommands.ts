import * as vscode from "vscode"
import delay from "delay"

import type { CommandId } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Package } from "../shared/package"
import { getCommand } from "../utils/commands"
import { ClineProvider } from "../core/webview/ClineProvider"
import { ContextProxy } from "../core/config/ContextProxy"
import { focusPanel } from "../utils/focusPanel"
import { handleNewTask } from "./handleTask"
import { CodeIndexManager } from "../services/code-index/manager"
import { importSettingsWithFeedback } from "../core/config/importExport"
import { MdmService } from "../services/mdm/MdmService"
import { registerRipgrepDiagnosticCommand } from "../services/ripgrep/diagnostic"
import { t } from "../i18n"

/**
 * Helper to get the visible ClineProvider instance or log if not found.
 */
export function getVisibleProviderOrLog(outputChannel: vscode.OutputChannel): ClineProvider | undefined {
	const visibleProvider = ClineProvider.getVisibleInstance()
	if (!visibleProvider) {
		outputChannel.appendLine("Cannot find any visible Roo Code instances.")
		return undefined
	}
	return visibleProvider
}

// Store panel references in both modes
let sidebarPanel: vscode.WebviewView | undefined = undefined
let tabPanel: vscode.WebviewPanel | undefined = undefined

/**
 * Get the currently active panel
 * @returns WebviewPanel或WebviewView
 */
export function getPanel(): vscode.WebviewPanel | vscode.WebviewView | undefined {
	return tabPanel || sidebarPanel
}

/**
 * Set panel references.
 *
 * The two refs are independent: each surface keeps its own ref for its whole
 * lifetime, so resolving the sidebar view never wipes a live tab panel (and
 * vice versa). Callers pass `undefined` only when the surface itself is
 * disposed (see the `onDidDispose` wiring in `openClineInNewTab`).
 */
export function setPanel(
	newPanel: vscode.WebviewPanel | vscode.WebviewView | undefined,
	type: "sidebar" | "tab",
): void {
	if (type === "sidebar") {
		sidebarPanel = newPanel as vscode.WebviewView
	} else {
		tabPanel = newPanel as vscode.WebviewPanel
	}
}

/**
 * The instance that owns the tracked tab panel, if it is still alive.
 *
 * Title-bar commands on the editor-tab surface use this instead of the
 * visible-instance heuristic, so a click on the tab's title bar always
 * targets that tab even when the sidebar is visible side-by-side.
 */
function getTabProvider(): ClineProvider | undefined {
	return tabPanel ? ClineProvider.getInstanceForView(tabPanel) : undefined
}

export type RegisterCommandOptions = {
	context: vscode.ExtensionContext
	outputChannel: vscode.OutputChannel
	provider: ClineProvider
}

export const registerCommands = (options: RegisterCommandOptions) => {
	const { context } = options

	for (const [id, callback] of Object.entries(getCommandsMap(options))) {
		const command = getCommand(id as CommandId)
		context.subscriptions.push(vscode.commands.registerCommand(command, callback))
	}

	context.subscriptions.push(registerRipgrepDiagnosticCommand())
}

// `showRipgrepDiagnostic` is registered separately by
// `registerRipgrepDiagnosticCommand` (above), which owns the OutputChannel
// lifecycle alongside the command registration, so it's intentionally
// excluded from this map.
//
// Callback shape mirrors VS Code's own `commands.registerCommand` signature
// (`(...args: any[]) => any`), with the return narrowed to `unknown` so
// callers must inspect before using. `any[]` for args is unavoidable: the
// callbacks here are heterogeneous (`importSettings` takes an optional
// `filePath?: string`, others take none) and VS Code dispatches positional
// args dynamically.
type CommandCallback = (...args: any[]) => unknown
const getCommandsMap = ({
	context,
	outputChannel,
	provider,
}: RegisterCommandOptions): Record<Exclude<CommandId, "showRipgrepDiagnostic">, CommandCallback> => ({
	activationCompleted: () => {},
	// The `view/title` menu is scoped to the sidebar view, so the click
	// origin of these handlers is the sidebar provider wired in at
	// activation (`provider`). Target it directly instead of the
	// visible-instance heuristic, which would follow the user's focus to a
	// tab instance when both surfaces are open side-by-side. The `*InTab`
	// variants serve the `editor/title` menu and target the tab instance
	// through `getTabProvider()` instead.
	plusButtonClicked: async () => {
		TelemetryService.instance.captureTitleButtonClicked("plus")

		await provider.evictCurrentTask()
		await provider.refreshWorkspace()
		await provider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		// Send focusInput action immediately after chatButtonClicked
		// This ensures the focus happens after the view has switched
		await provider.postMessageToWebview({ type: "action", action: "focusInput" })
	},
	plusButtonClickedInTab: async () => {
		const tabProvider = getTabProvider()
		if (!tabProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("plus")

		await tabProvider.evictCurrentTask()
		await tabProvider.refreshWorkspace()
		await tabProvider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		await tabProvider.postMessageToWebview({ type: "action", action: "focusInput" })
	},
	popoutButtonClicked: () => {
		TelemetryService.instance.captureTitleButtonClicked("popout")

		return openClineInNewTab({ context, outputChannel })
	},
	openInNewTab: () => openClineInNewTab({ context, outputChannel }),
	settingsButtonClicked: () => {
		TelemetryService.instance.captureTitleButtonClicked("settings")

		void provider
			.postMessageToWebview({ type: "action", action: "settingsButtonClicked" })
			.catch((error) => outputChannel.appendLine(`[settingsButtonClicked] postMessageToWebview failed: ${error}`))
		// Also explicitly post the visibility message to trigger scroll reliably
		void provider
			.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
			.catch((error) => outputChannel.appendLine(`[settingsButtonClicked] postMessageToWebview failed: ${error}`))
	},
	settingsButtonClickedInTab: () => {
		const tabProvider = getTabProvider()
		if (!tabProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("settings")

		void tabProvider
			.postMessageToWebview({ type: "action", action: "settingsButtonClicked" })
			.catch((error) =>
				outputChannel.appendLine(`[settingsButtonClickedInTab] postMessageToWebview failed: ${error}`),
			)
		void tabProvider
			.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
			.catch((error) =>
				outputChannel.appendLine(`[settingsButtonClickedInTab] postMessageToWebview failed: ${error}`),
			)
	},
	historyButtonClicked: () => {
		TelemetryService.instance.captureTitleButtonClicked("history")

		void provider
			.postMessageToWebview({ type: "action", action: "historyButtonClicked" })
			.catch((error) => outputChannel.appendLine(`[historyButtonClicked] postMessageToWebview failed: ${error}`))
	},
	historyButtonClickedInTab: () => {
		const tabProvider = getTabProvider()
		if (!tabProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("history")

		void tabProvider
			.postMessageToWebview({ type: "action", action: "historyButtonClicked" })
			.catch((error) =>
				outputChannel.appendLine(`[historyButtonClickedInTab] postMessageToWebview failed: ${error}`),
			)
	},
	marketplaceButtonClicked: () => {
		void provider
			.postMessageToWebview({ type: "action", action: "marketplaceButtonClicked" })
			.catch((error) =>
				outputChannel.appendLine(`[marketplaceButtonClicked] postMessageToWebview failed: ${error}`),
			)
	},
	marketplaceButtonClickedInTab: () => {
		const tabProvider = getTabProvider()
		if (!tabProvider) {
			return
		}
		void tabProvider
			.postMessageToWebview({ type: "action", action: "marketplaceButtonClicked" })
			.catch((error) =>
				outputChannel.appendLine(`[marketplaceButtonClickedInTab] postMessageToWebview failed: ${error}`),
			)
	},
	newTask: handleNewTask,
	setCustomStoragePath: async () => {
		const { promptForCustomStoragePath } = await import("../utils/storage")
		await promptForCustomStoragePath()
	},
	importSettings: async (filePath?: string) => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) {
			return
		}

		await importSettingsWithFeedback(
			{
				providerSettingsManager: visibleProvider.providerSettingsManager,
				contextProxy: visibleProvider.contextProxy,
				customModesManager: visibleProvider.customModesManager,
				provider: visibleProvider,
			},
			filePath,
		)
	},
	focusInput: async () => {
		try {
			await focusPanel(tabPanel, sidebarPanel)

			// Send focus input message only when the sidebar panel was
			// focused: the tab takes selection priority in focusPanel, so
			// the sidebar receives the message only when no tab panel is
			// tracked.
			if (sidebarPanel && !tabPanel) {
				await provider.postMessageToWebview({ type: "action", action: "focusInput" })
			}
		} catch (error) {
			outputChannel.appendLine(`Error focusing input: ${error}`)
		}
	},
	focusPanel: async () => {
		try {
			await focusPanel(tabPanel, sidebarPanel)
		} catch (error) {
			outputChannel.appendLine(`Error focusing panel: ${error}`)
		}
	},
	acceptInput: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		void visibleProvider
			.postMessageToWebview({ type: "acceptInput" })
			.catch((error) => outputChannel.appendLine(`[acceptInput] postMessageToWebview failed: ${error}`))
	},
	toggleAutoApprove: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		try {
			await visibleProvider.postMessageToWebview({
				type: "action",
				action: "toggleAutoApprove",
			})
		} catch (error) {
			outputChannel.appendLine(`[toggleAutoApprove] postMessageToWebview failed: ${error}`)
		}
	},
})

export const openClineInNewTab = async ({ context, outputChannel }: Omit<RegisterCommandOptions, "provider">) => {
	// Reuse the tracked tab instead of opening a second one: a repeated
	// "Open in editor" click reveals the existing tab's panel.
	if (tabPanel) {
		const existingProvider = ClineProvider.getInstanceForView(tabPanel)
		if (existingProvider) {
			await tabPanel.reveal()
			await existingProvider.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
			return existingProvider
		}
	}

	// (This example uses webviewProvider activation event which is necessary to
	// deserialize cached webview, but since we use retainContextWhenHidden, we
	// don't need to use that event).
	// https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	const contextProxy = await ContextProxy.getInstance(context)
	const codeIndexManager = CodeIndexManager.getInstance(context)

	// Get the existing MDM service instance to ensure consistent policy enforcement
	let mdmService: MdmService | undefined
	try {
		mdmService = MdmService.getInstance()
	} catch (error) {
		// MDM service not initialized, which is fine - extension can work without it
		mdmService = undefined
	}

	const tabProvider = new ClineProvider(context, outputChannel, "editor", contextProxy, mdmService)
	const lastCol = Math.max(...vscode.window.visibleTextEditors.map((editor) => editor.viewColumn || 0))

	// Check if there are any visible text editors, otherwise open a new group
	// to the right.
	const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0

	if (!hasVisibleEditors) {
		await vscode.commands.executeCommand("workbench.action.newGroupRight")
	}

	const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

	const newPanel = vscode.window.createWebviewPanel(ClineProvider.tabPanelId, "Zoo Code", targetCol, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [context.extensionUri],
	})

	// Save as tab type panel.
	setPanel(newPanel, "tab")

	// TODO: Use better svg icon with light and dark variants (see
	// https://stackoverflow.com/questions/58365687/vscode-extension-iconpath).
	newPanel.iconPath = {
		light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_light.png"),
		dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_dark.png"),
	}

	await tabProvider.resolveWebviewView(newPanel)

	// Add listener for visibility changes to notify webview
	newPanel.onDidChangeViewState(
		(e) => {
			const panel = e.webviewPanel
			if (panel.visible) {
				panel.webview.postMessage({ type: "action", action: "didBecomeVisible" }) // Use the same message type as in SettingsView.tsx
			}
		},
		null, // First null is for `thisArgs`
		context.subscriptions, // Register listener for disposal
	)

	// Handle panel closing events.
	newPanel.onDidDispose(
		() => {
			setPanel(undefined, "tab")
		},
		null,
		context.subscriptions, // Also register dispose listener
	)

	// Lock the editor group so clicking on files doesn't open them over the panel.
	await delay(100)
	await vscode.commands.executeCommand("workbench.action.lockEditorGroup")

	return tabProvider
}
