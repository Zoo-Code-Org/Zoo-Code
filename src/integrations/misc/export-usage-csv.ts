import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

const USAGE_RANGES: readonly string[] = ["today", "7d", "30d", "all"]

/** The most text the host writes for an export: ten years of daily tasks is far below it, a runaway message is not. */
const MAX_USAGE_CSV_LENGTH = 20_000_000

/**
 * Saves the Usage tab's CSV where the user chooses. A webview cannot reliably download a file, so, like every other
 * export, the webview sends the text and the host writes it. The file name is built here from a known range, never
 * from the message. Resolves to the saved file, or `undefined` if the user cancelled, there was nothing to save, or the dialog or the write failed (the user is told).
 */
export async function exportUsageCsv(csv: unknown, range: unknown): Promise<vscode.Uri | undefined> {
	if (typeof csv !== "string" || csv.length === 0 || csv.length > MAX_USAGE_CSV_LENGTH) return undefined

	const name = `zoo-usage-${typeof range === "string" && USAGE_RANGES.includes(range) ? range : "all"}.csv`
	try {
		const saveUri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(path.join(os.homedir(), "Downloads", name)),
			filters: { CSV: ["csv"] },
		})
		if (!saveUri) return undefined

		await vscode.workspace.fs.writeFile(saveUri, Buffer.from(csv, "utf-8"))
		return saveUri
	} catch (error) {
		vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
		return undefined
	}
}
