import * as vscode from "vscode"

import { t } from "../../i18n"
import type { McpHub } from "./McpHub"

export const EXA_MCP_PROMPT_SHOWN_KEY = "exaMcpInstallPromptShown"

type ExaMcpPromptContext = {
	globalState: Pick<vscode.Memento, "get" | "update">
}

export async function promptToInstallExaMcp(context: ExaMcpPromptContext, mcpHub: McpHub): Promise<void> {
	if (mcpHub.hasExaServer() || context.globalState.get<boolean>(EXA_MCP_PROMPT_SHOWN_KEY, false)) {
		return
	}

	await context.globalState.update(EXA_MCP_PROMPT_SHOWN_KEY, true)

	const installAction: vscode.MessageItem = { title: t("mcp:info.exa_install_action") }
	const selection = await vscode.window.showInformationMessage(t("mcp:info.exa_install_prompt"), installAction)

	if (selection?.title !== installAction.title) {
		return
	}

	try {
		await mcpHub.installExaServer()
		void vscode.window.showInformationMessage(t("mcp:info.exa_install_success"))
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		void vscode.window.showErrorMessage(t("mcp:errors.exa_install_failed", { errorMessage }))
	}
}
