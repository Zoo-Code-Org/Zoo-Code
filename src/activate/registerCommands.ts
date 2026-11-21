import * as vscode from "vscode"
import delay from "delay"
import { createDiagnosticsReport } from "../services/diagnostics"

import type { CommandId, ExtensionMessage } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { getCommand } from "../utils/commands"
import { ClineProvider } from "../core/webview/ClineProvider"
import type { WebviewFocusTracker } from "../core/webview/WebviewFocusTracker"
import { ContextProxy } from "../core/config/ContextProxy"
import { focusPanel } from "../utils/focusPanel"
import { handleNewTask } from "./handleTask"
import { importSettingsWithFeedback } from "../core/config/importExport"
import { MdmService } from "../services/mdm/MdmService"
import { registerRipgrepDiagnosticCommand } from "../services/ripgrep/diagnostic"

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

// In-flight "open in editor" creation shared by overlapping calls: a
// double-click starts before the first call tracks its new panel, so
// concurrent callers must share one creation instead of racing to create
// two tab panels.
let pendingTabPanelCreation: Promise<ClineProvider> | undefined

/**
 * Get the currently active panel
 * @returns WebviewPanel或WebviewView
 * @internal Test-only seam. Aside from the tab-view disposal check in ClineProvider.ts,
 * which compares getPanel() with the disposing view before clearing the tab ref, nothing
 * outside the test suite reads this.
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
 * Clears the tracked sidebar view only when it is still the disposed one.
 *
 * A sidebar view can be resolved again while the previous view is being
 * disposed; the late disposal of the replaced view must not clear the
 * replacement, or focus/commands would lose the live sidebar.
 */
export function clearSidebarPanel(view: vscode.WebviewView | vscode.WebviewPanel): void {
	if (sidebarPanel === view) {
		sidebarPanel = undefined
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
// (`(...args: any[]) => any`) except for the args, which are typed `never[]`.
// Nothing in this file calls these callbacks - VS Code dispatches positional
// args dynamically - so `never[]` is the stricter choice: it accepts every
// callback shape in the map (`importSettings` takes an optional
// `filePath?: string`, the rest take none) while a direct call like
// `cb("path")` fails to typecheck instead of compiling silently. Widening the
// rest back to `any[]` would drop that guard. The return stays narrowed to
// `unknown` so callers must inspect before using.
type CommandCallback = (...args: never[]) => unknown

// Posts each action in order to the target instance. Failures are logged
// (not thrown) with the handler-specific prefix so a failed post stays
// attributable in the output channel.
const postActions = (
	outputChannel: vscode.OutputChannel,
	target: ClineProvider,
	actions: readonly NonNullable<ExtensionMessage["action"]>[],
	logPrefix: string,
) => {
	for (const action of actions) {
		void target
			.postMessageToWebview({ type: "action", action })
			.catch((error) => outputChannel.appendLine(`[${logPrefix}] postMessageToWebview failed: ${error}`))
	}
}

/**
 * Resolve the provider a sidebar-scoped command should act on.
 *
 * The `view/title` rows scope these commands to the sidebar view, so a title-bar
 * click always has a visible sidebar and the registered provider is the right
 * target. The `commandPalette` rows added beside them do not: with a text editor
 * focused and the sidebar collapsed, `activeWebviewPanelId` is unset, the
 * `activeWebviewPanelId != zoo-code.TabPanelProvider` clause passes, and the
 * palette runs the same handler. Falling back to the visible instance keeps the
 * palette behaviour these handlers had before the click-origin split - act on
 * whichever surface is on screen, and do nothing when none is - instead of
 * evicting a task behind a webview nobody is looking at.
 */
const sidebarCommandTarget = (
	provider: ClineProvider,
	outputChannel: vscode.OutputChannel,
): ClineProvider | undefined => (provider.isViewVisible ? provider : getVisibleProviderOrLog(outputChannel))

const getCommandsMap = ({
	context,
	outputChannel,
	provider,
}: RegisterCommandOptions): Record<Exclude<CommandId, "showRipgrepDiagnostic">, CommandCallback> => ({
	activationCompleted: () => {},
	createDiagnosticsReport: () =>
		createDiagnosticsReport({
			context,
			outputChannel,
			providers: ClineProvider.getAllInstances(),
		}),
	// The `view/title` menu is scoped to the sidebar view, so the click
	// origin of these handlers is the sidebar provider wired in at
	// activation (`provider`). Target it directly instead of the
	// visible-instance heuristic, which would follow the user's focus to a
	// tab instance when both surfaces are open side-by-side. The `*InTab`
	// variants serve the `editor/title` menu and target the tab instance
	// through `getTabProvider()` instead. `sidebarCommandTarget` keeps that
	// targeting while the sidebar is visible and hands the palette path back to
	// the visible instance.
	plusButtonClicked: async () => {
		const target = sidebarCommandTarget(provider, outputChannel)
		if (!target) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("plus")

		await target.evictCurrentTask()
		await target.refreshWorkspace()
		await target.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		// Send focusInput action immediately after chatButtonClicked
		// This ensures the focus happens after the view has switched
		await target.postMessageToWebview({ type: "action", action: "focusInput" })
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

		return openClineInNewTab({ context, outputChannel, webviewFocusTracker: provider.webviewFocusTracker })
	},
	openInNewTab: () =>
		openClineInNewTab({ context, outputChannel, webviewFocusTracker: provider.webviewFocusTracker }),
	settingsButtonClicked: () => {
		const target = sidebarCommandTarget(provider, outputChannel)
		if (!target) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("settings")

		// Also explicitly post the visibility message to trigger scroll reliably.
		postActions(outputChannel, target, ["settingsButtonClicked", "didBecomeVisible"], "settingsButtonClicked")
	},
	settingsButtonClickedInTab: () => {
		const tabProvider = getTabProvider()
		if (!tabProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("settings")

		postActions(
			outputChannel,
			tabProvider,
			["settingsButtonClicked", "didBecomeVisible"],
			"settingsButtonClickedInTab",
		)
	},
	historyButtonClicked: () => {
		const target = sidebarCommandTarget(provider, outputChannel)
		if (!target) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("history")

		postActions(outputChannel, target, ["historyButtonClicked"], "historyButtonClicked")
	},
	historyButtonClickedInTab: () => {
		const tabProvider = getTabProvider()
		if (!tabProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("history")

		postActions(outputChannel, tabProvider, ["historyButtonClicked"], "historyButtonClickedInTab")
	},
	marketplaceButtonClicked: () => {
		const target = sidebarCommandTarget(provider, outputChannel)
		if (!target) {
			return
		}

		postActions(outputChannel, target, ["marketplaceButtonClicked"], "marketplaceButtonClicked")
	},
	marketplaceButtonClickedInTab: () => {
		const tabProvider = getTabProvider()
		if (!tabProvider) {
			return
		}
		postActions(outputChannel, tabProvider, ["marketplaceButtonClicked"], "marketplaceButtonClickedInTab")
	},
	newTask: (params: { prompt?: string } | null | undefined) => handleNewTask(params, provider.webviewFocusTracker),
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
			// Only a currently tracked, live sidebar is a focus candidate: a tracked ref
			// whose view was disposed or replaced must not receive the input focus.
			const liveSidebarPanel =
				sidebarPanel && ClineProvider.getInstanceForView(sidebarPanel) ? sidebarPanel : undefined
			await focusPanel(tabPanel, liveSidebarPanel)

			// focusPanel selects the TAB whenever a tab panel is tracked, so the input
			// focus has to go to whichever provider focusPanel actually focused: the tab's
			// when one is tracked, otherwise the sidebar's, and nothing when neither is
			// available. The previous guard skipped the post as soon as a tab existed, so
			// in the both-tracked state the tab became visible without focusing its input.
			const focusTarget = tabPanel
				? getTabProvider()
				: liveSidebarPanel
					? ClineProvider.getInstanceForView(liveSidebarPanel)
					: undefined
			await focusTarget?.postMessageToWebview({ type: "action", action: "focusInput" })
		} catch (error) {
			outputChannel.appendLine(`Error focusing input: ${error}`)
		}
	},
	retryWebviewRecovery: async () => {
		await (ClineProvider.getVisibleInstance() ?? provider).retryWebviewRecovery()
	},
	focusPanel: async () => {
		try {
			// A stale sidebar ref would make focusPanel reveal a disposed view.
			const liveSidebarPanel =
				sidebarPanel && ClineProvider.getInstanceForView(sidebarPanel) ? sidebarPanel : undefined
			await focusPanel(tabPanel, liveSidebarPanel)
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

type OpenClineInNewTabOptions = {
	context: vscode.ExtensionContext
	outputChannel: vscode.OutputChannel
	webviewFocusTracker: WebviewFocusTracker
}

export const openClineInNewTab = async ({ context, outputChannel, webviewFocusTracker }: OpenClineInNewTabOptions) => {
	// Serialize overlapping "Open in editor" calls: a double-click starts
	// before the first call tracks its new panel, so without a shared
	// in-flight creation both calls would race to create two tab panels.
	// The shared promise is stored before the creation body awaits
	// ContextProxy.getInstance, so every caller started while the creation
	// is in flight — openInNewTab and popoutButtonClicked both dispatch
	// through here — awaits it instead of creating a second panel: exactly
	// one panel is created and every caller receives the same provider.
	if (pendingTabPanelCreation) {
		return pendingTabPanelCreation
	}

	const creation = createTabPanelUnlocked({ context, outputChannel, webviewFocusTracker })
	pendingTabPanelCreation = creation

	try {
		return await creation
	} finally {
		// Clear once settled (success or failure) so the next call starts
		// fresh: the reuse path in createTabPanelUnlocked then takes over for the
		// tracked panel. The clear is unconditional because no other caller can
		// store a replacement while this creation is in flight: the entry guard
		// above hands every overlapping call this same promise, so this finally
		// block is the only writer between storing the slot and settling it.
		pendingTabPanelCreation = undefined
	}
}

// The unserialized tab-creation body. Only openClineInNewTab may call it,
// after it has stored the shared in-flight promise.
const createTabPanelUnlocked = async ({ context, outputChannel, webviewFocusTracker }: OpenClineInNewTabOptions) => {
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

	// Get the existing MDM service instance to ensure consistent policy enforcement
	let mdmService: MdmService | undefined
	try {
		mdmService = MdmService.getInstance()
	} catch (error) {
		// MDM service unavailable: log the fallback and continue without it.
		outputChannel.appendLine(`[openClineInNewTab] MDM service unavailable, continuing without it: ${error}`)
		mdmService = undefined
	}

	const tabProvider = new ClineProvider(
		context,
		outputChannel,
		"editor",
		contextProxy,
		webviewFocusTracker,
		mdmService,
	)
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
	// Stryker disable next-line StringLiteral: setPanel branches only on type === "sidebar", so any other literal routes to the identical tab-ref assignment
	setPanel(newPanel, "tab")

	// TODO: Use better svg icon with light and dark variants (see
	// https://stackoverflow.com/questions/58365687/vscode-extension-iconpath).
	newPanel.iconPath = {
		light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_light.png"),
		dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_dark.png"),
	}

	try {
		await tabProvider.resolveWebviewView(newPanel)
	} catch (error) {
		// The tab ref is already this panel (setPanel above) and the panel's own disposal handler is
		// only registered below, so a failed resolve has to close the blank panel and clear the ref
		// itself before rethrowing: otherwise the next click reveals a panel whose webview never
		// resolved, and the tracked ref keeps pointing at it.
		if (tabPanel === newPanel) setPanel(undefined, "tab")
		newPanel.dispose()
		throw error
	}

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

	// Handle panel closing events: clear the tracked ref only if this panel
	// is still the tracked one, so a late disposal of an already-replaced
	// panel cannot clobber the replacement's ref.
	newPanel.onDidDispose(
		() => {
			// A recovery may already have installed a replacement panel.
			if (tabPanel === newPanel) setPanel(undefined, "tab")
		},
		null,
		context.subscriptions, // Also register dispose listener
	)

	// Lock the editor group so clicking on files doesn't open them over the panel.
	await delay(100)
	await vscode.commands.executeCommand("workbench.action.lockEditorGroup")

	return tabProvider
}
