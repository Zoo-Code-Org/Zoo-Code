import * as vscode from "vscode"

import { Package } from "../shared/package"
import type { WebviewFocusTracker } from "../core/webview/WebviewFocusTracker"
import { t } from "../i18n"
import { resolveChatProvider } from "./resolveChatProvider"

export const handleNewTask = async (
	params: { prompt?: string } | null | undefined,
	webviewFocusTracker: WebviewFocusTracker,
) => {
	let prompt = params?.prompt

	if (!prompt) {
		prompt = await vscode.window.showInputBox({
			prompt: t("common:input.task_prompt"),
			placeHolder: t("common:input.task_placeholder"),
		})
	}

	if (!prompt) {
		await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
		return
	}

	const provider = await resolveChatProvider(webviewFocusTracker)
	await provider?.handleCodeAction("newTask", "NEW_TASK", { userInput: prompt })
}
