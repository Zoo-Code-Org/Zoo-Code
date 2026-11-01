import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { randomBytes } from "crypto"
import * as vscode from "vscode"

import { Package } from "../../shared/package"
import { getStorageBasePath } from "../../utils/storage"
import { buildDiagnosticsReport } from "./report"
import type { DiagnosticsProviderSource } from "./types"

export async function createDiagnosticsReport(options: {
	context: vscode.ExtensionContext
	outputChannel: vscode.OutputChannel
	providers: DiagnosticsProviderSource[]
}): Promise<void> {
	try {
		const storagePath = await getStorageBasePath(options.context.globalStorageUri.fsPath)
		const report = await buildDiagnosticsReport({
			providers: options.providers,
			storagePath,
			version: Package.version,
			releaseChannel: Package.releaseChannel,
			environment: {
				vscodeVersion: vscode.version,
				appName: vscode.env.appName,
				uiKind:
					vscode.env.uiKind === vscode.UIKind.Desktop
						? "desktop"
						: vscode.env.uiKind === vscode.UIKind.Web
							? "web"
							: "unknown",
				platform: process.platform,
				architecture: process.arch,
				locale: vscode.env.language,
				remote: Boolean(vscode.env.remoteName),
				workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
				customStorageConfigured: Boolean(
					vscode.workspace.getConfiguration(Package.name).get<string>("customStoragePath", ""),
				),
			},
		})
		const json = JSON.stringify(report, null, 2)
		const fileName = `zoo-code-diagnostics-${Date.now()}-${randomBytes(4).toString("hex")}.json`
		const filePath = path.join(os.tmpdir(), fileName)
		await fs.writeFile(filePath, json, "utf8")
		const [openResult, copyResult] = await Promise.allSettled([
			vscode.workspace
				.openTextDocument(filePath)
				.then((document) => vscode.window.showTextDocument(document, { preview: true })),
			vscode.env.clipboard.writeText(json),
		])
		if (openResult.status === "fulfilled" && copyResult.status === "fulfilled") {
			await vscode.window.showInformationMessage(
				"Zoo Code: redacted diagnostics copied and opened for review. No data was uploaded.",
			)
		} else {
			if (openResult.status === "rejected")
				options.outputChannel.appendLine("[createDiagnosticsReport] open failed")
			if (copyResult.status === "rejected")
				options.outputChannel.appendLine("[createDiagnosticsReport] copy failed")
			await vscode.window.showWarningMessage(
				"Zoo Code created the diagnostics report, but could not open or copy every result. No data was uploaded.",
			)
		}
	} catch (error) {
		const category = error instanceof Error ? error.name : "UnknownError"
		options.outputChannel.appendLine(`[createDiagnosticsReport] failed: ${category}`)
		await vscode.window.showErrorMessage("Zoo Code could not create the diagnostics report.")
	}
}
