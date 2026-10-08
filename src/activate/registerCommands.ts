import * as vscode from "vscode"
import delay from "delay"

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
import { Package } from "../shared/package"
import { createDiagnosticsReport } from "../services/diagnostics"

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
 * Get the currently active panel.
 *
 * @internal Exported for focused implementation tests.
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
// `never[]` deliberately lets callbacks with different parameters share one map
// type while rejecting direct calls with arguments. VS Code dispatches positional
// arguments dynamically; `unknown` requires callers to inspect returned values.
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

		// The worktree auto-open flow (`extension.ts`) invokes this command without a sidebar click,
		// so the view may not be resolved yet: focus it explicitly instead of posting into a webview
		// that does not exist. On the menu path the view is already resolved and this is a no-op.
		if (!provider.isViewLaunched) {
			await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
			// The focus command settles when VS Code opens the pane, not when resolveWebviewView
			// hands this provider its view, and postMessageToWebview returns without sending while the
			// view is unset - both actions below would be dropped. Wait for the resolution that this
			// command just asked VS Code to start. The wait releases on one of three things: this
			// provider receives its view, the sidebar view is disposed (the pane was closed before
			// resolving), or the provider is disposed. It has no clock of its own, so a view that is
			// neither resolved nor torn down leaves this command pending until one of those happens.
			await provider.whenViewResolved()
		}
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

		return openClineInNewTab({ context, outputChannel, webviewFocusTracker: provider.webviewFocusTracker })
	},
	openInNewTab: () =>
		openClineInNewTab({ context, outputChannel, webviewFocusTracker: provider.webviewFocusTracker }),
	settingsButtonClicked: () => {
		TelemetryService.instance.captureTitleButtonClicked("settings")

		// Also explicitly post the visibility message to trigger scroll reliably.
		postActions(outputChannel, provider, ["settingsButtonClicked", "didBecomeVisible"], "settingsButtonClicked")
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
		TelemetryService.instance.captureTitleButtonClicked("history")

		postActions(outputChannel, provider, ["historyButtonClicked"], "historyButtonClicked")
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
		postActions(outputChannel, provider, ["marketplaceButtonClicked"], "marketplaceButtonClicked")
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
	createDiagnosticsReport: () =>
		createDiagnosticsReport({
			context,
			outputChannel,
			providers: ClineProvider.getAllInstances(),
		}),
	focusInput: async () => {
		try {
			await focusPanel(tabPanel, sidebarPanel)

			// Post to the surface focusPanel selected: the tab takes
			// selection priority, so the sidebar is targeted only when no
			// tab panel is tracked.
			if (tabPanel) {
				const tabProvider = getTabProvider()
				if (tabProvider) {
					await tabProvider.postMessageToWebview({ type: "action", action: "focusInput" })
				}
			} else if (sidebarPanel) {
				await provider.postMessageToWebview({ type: "action", action: "focusInput" })
			}
		} catch (error) {
			outputChannel.appendLine(`Error focusing input: ${error}`)
		}
	},
	retryWebviewRecovery: async () => {
		await (ClineProvider.getVisibleInstance() ?? provider).retryWebviewRecovery()
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

type OpenClineInNewTabOptions = {
	context: vscode.ExtensionContext
	outputChannel: vscode.OutputChannel
	webviewFocusTracker: WebviewFocusTracker
	// `startNewTask({ newTab: true })` asks for a tab because it has just closed the editors; the
	// title-bar buttons ask for one only to reveal what is already there. Only the first must
	// bypass the tracked-panel reuse, so the caller states it instead of the factory guessing.
	forceNew?: boolean
}

export const openClineInNewTab = async (options: OpenClineInNewTabOptions) => {
	// Serialize overlapping "Open in editor" calls: a double-click starts
	// before the first call tracks its new panel, so without a shared
	// in-flight creation both calls would race to create two tab panels.
	// The shared promise is stored before the creation body awaits
	// ContextProxy.getInstance, so every caller started while the creation
	// is in flight — openInNewTab and popoutButtonClicked both dispatch
	// through here — awaits it instead of creating a second panel: exactly
	// one panel is created and every caller receives the same provider.
	// A forced call must not join somebody else's in-flight creation. forceNew means
	// "this caller has just closed the editors and needs its own provider", so two
	// overlapping startNewTask({ newTab: true }) calls must each get a distinct provider:
	// sharing one would make both evict and re-create the task on the same webview. The
	// non-forced callers - the title-bar reveal buttons - keep reusing the pending panel.
	if (pendingTabPanelCreation && !options.forceNew) {
		return pendingTabPanelCreation
	}

	const creation = createTabPanelUnlocked(options)
	// The forced call creates its own provider but only occupies the shared slot when the
	// slot is free. A forced call that arrives while an ordinary creation is in flight must
	// not evict it: an ordinary caller that starts afterwards is asking for the panel that
	// creation is building, and giving it the forced promise would reject it for a failure of
	// somebody else's creation while its own creation still opens a panel nobody awaits.
	if (!pendingTabPanelCreation) {
		pendingTabPanelCreation = creation
	}

	try {
		return await creation
	} finally {
		// Clear once settled (success or failure) so the next call starts
		// fresh: the reuse path in createTabPanelUnlocked then takes over
		// for the tracked panel. The equality check keeps this settlement from
		// clearing a slot it does not own, which is the normal outcome for a
		// forced call that started while an ordinary creation held the slot: that
		// forced call never stored anything, so the ordinary creation stays.
		if (pendingTabPanelCreation === creation) {
			pendingTabPanelCreation = undefined
		}
	}
}

/**
 * Undo a tab creation that failed part way through. A ClineProvider that was constructed
 * but never resolved stays registered in ClineProvider.activeInstances with its listeners
 * attached, and setPanel may already have pointed the tracked tab ref at a panel nobody
 * owns - so every later "Open in editor" either reuses a dead panel or builds a
 * second provider for the same view. Each step is awaited in its own try/catch so one
 * failing cleanup cannot strand the other, and the tracked ref is cleared only while it
 * still names this panel, so a replacement created in the meantime survives.
 */
async function disposeFailedTabCreation(
	provider: ClineProvider,
	panel: vscode.WebviewPanel | undefined,
	outputChannel: vscode.OutputChannel,
	): Promise<void> {
	const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
	const cleanupFailures: string[] = []
	try {
		await provider.dispose()
	} catch (cleanupError: unknown) {
		cleanupFailures.push(`provider: ${describe(cleanupError)}`)
	}

	if (panel) {
		if (tabPanel === panel) {
			setPanel(undefined, "tab")
		}
		try {
			panel.dispose()
		} catch (cleanupError: unknown) {
			cleanupFailures.push(`panel: ${describe(cleanupError)}`)
		}
	}

	if (cleanupFailures.length > 0) {
		outputChannel.appendLine(
			`[openClineInNewTab] Tab creation failed and cleanup was incomplete (${cleanupFailures.join("; ")}); a leaked provider or panel may remain.`,
		)
	}
}

// The unserialized tab-creation body. Only openClineInNewTab may call it,
// after it has stored the shared in-flight promise.
const createTabPanelUnlocked = async ({
	context,
	outputChannel,
	webviewFocusTracker,
	forceNew,
}: OpenClineInNewTabOptions) => {
	// Reuse the tracked tab instead of opening a second one: a repeated
	// "Open in editor" click reveals the existing tab's panel. A caller that
	// needs a genuinely new tab (startNewTask closes the editors first) passes
	// `forceNew` and skips the reveal.
	if (tabPanel && !forceNew) {
		const existingProvider = ClineProvider.getInstanceForView(tabPanel)
		if (existingProvider) {
			await tabPanel.reveal()
			await existingProvider.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
			return existingProvider
		}

		// The tracked panel has no live provider (closed or disposed out from under us).
		// Drop the stale reference before creating a replacement: an await below that
		// rejects would otherwise leave tabPanel pointing at the dead panel, and focusInput
		// would take the tab branch and post nothing even though a sidebar exists.
		tabPanel = undefined
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
	// Track the panel outside the try so the cleanup can reach it even when the creation
	// failed before or while the panel was being built.
	let newPanel: vscode.WebviewPanel | undefined
	try {
		const lastCol = Math.max(...vscode.window.visibleTextEditors.map((editor) => editor.viewColumn || 0))

		// Check if there are any visible text editors, otherwise open a new group
		// to the right.
		const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0

		if (!hasVisibleEditors) {
			await vscode.commands.executeCommand("workbench.action.newGroupRight")
		}

		const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

		newPanel = vscode.window.createWebviewPanel(ClineProvider.tabPanelId, "Zoo Code", targetCol, {
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

		await tabProvider.resolveWebviewView(newPanel)

		// Add listener for visibility changes to notify webview
		newPanel.onDidChangeViewState(
			(e) => {
				const panel = e.webviewPanel
				// Re-point the tracked tab ref at the panel the user is actually
				// looking at: several tab panels can stay visible at once, but
				// only the active one is the current tab, and the title-bar
				// commands must resolve that instance, not the last created one.
				if (panel.active) {
					// Stryker disable next-line StringLiteral: setPanel only distinguishes "sidebar"; any other value routes to the tab-ref assignment
					setPanel(panel, "tab")
				}
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
				if (tabPanel === newPanel) {
					// Stryker disable next-line StringLiteral: setPanel branches only on type === "sidebar", so any other literal routes to the identical tab-ref assignment
					setPanel(undefined, "tab")
				}
			},
			null,
			context.subscriptions, // Also register dispose listener
		)

		// Lock the editor group so clicking on files doesn't open them over the panel.
		await delay(100)
		await vscode.commands.executeCommand("workbench.action.lockEditorGroup")

		return tabProvider
	} catch (error: unknown) {
		// Nothing that half-built this tab is safe to leave behind: see
		// disposeFailedTabCreation. The original failure is what the caller must see.
		await disposeFailedTabCreation(tabProvider, newPanel, outputChannel)
		throw error
	}
}
