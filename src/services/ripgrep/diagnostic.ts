import * as path from "path"
import * as vscode from "vscode"

import { fileExistsAtPath } from "../../utils/fs"
import { loadRipgrep } from "./internal/loadRipgrep"

const binName = process.platform.startsWith("win") ? "rg.exe" : "rg"
const universalBin = `bin/${process.platform}-${process.arch}/${binName}`

function probeCandidates(vscodeAppRoot: string): readonly string[] {
	return [
		path.join(vscodeAppRoot, "node_modules", "@vscode", "ripgrep", "bin", binName),
		path.join(vscodeAppRoot, "node_modules", "vscode-ripgrep", "bin", binName),
		path.join(vscodeAppRoot, "node_modules.asar.unpacked", "vscode-ripgrep", "bin", binName),
		path.join(vscodeAppRoot, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", binName),
		path.join(vscodeAppRoot, "node_modules", "@vscode", "ripgrep-universal", ...universalBin.split("/")),
		path.join(
			vscodeAppRoot,
			"node_modules.asar.unpacked",
			"@vscode",
			"ripgrep-universal",
			...universalBin.split("/"),
		),
	]
}

/**
 * Produces a textual diagnostic report of how ripgrep would be resolved
 * for the given VS Code installation. Pure data function — no UI side
 * effects — so it's fully unit-testable.
 *
 * Step 1 tries `loadRipgrep()` (CommonJS require, hits VS Code's
 * extHost interceptor on builds that have completed the
 * `@vscode/ripgrep` → `@vscode/ripgrep-universal` migration).
 * Step 2 probes every known `vscode.env.appRoot`-relative path and
 * reports which ones exist on disk.
 */
export async function getRipgrepDiagnostic(vscodeAppRoot: string): Promise<string> {
	const lines: string[] = [
		`Zoo Code Ripgrep Diagnostic (${new Date().toISOString()})`,
		`vscode.version: ${vscode.version}`,
		`vscode.env.appRoot: ${vscodeAppRoot}`,
		`process.platform/arch: ${process.platform}/${process.arch}`,
		``,
		`--- step 1: require("@vscode/ripgrep") via loadRipgrep ---`,
	]
	const m = loadRipgrep()
	if (!m) {
		lines.push(`loadRipgrep() returned undefined (require threw)`)
	} else {
		const keys = Object.keys(m).join(",") || "(none)"
		lines.push(`loadRipgrep() returned object. keys: ${keys}`)
		lines.push(`rgPath: ${m.rgPath ?? "(undefined)"}`)
		if (m.rgPath) {
			const fixed = m.rgPath.replace(/\bnode_modules\.asar\b/, "node_modules.asar.unpacked")
			lines.push(`after .asar→.asar.unpacked: ${fixed}`)
			lines.push(`fileExistsAtPath: ${await fileExistsAtPath(fixed)}`)
		}
	}
	lines.push(``)
	lines.push(`--- step 2: path probe under appRoot ---`)
	for (const candidate of probeCandidates(vscodeAppRoot)) {
		lines.push(`  ${(await fileExistsAtPath(candidate)) ? "✓" : "✗"} ${candidate}`)
	}
	return lines.join("\n")
}

/**
 * Registers the `zoo-code.showRipgrepDiagnostic` command. Thin wrapper —
 * runs `getRipgrepDiagnostic`, shows the result in an output channel,
 * copies it to the clipboard, and shows an info toast.
 */
export function registerRipgrepDiagnosticCommand(): vscode.Disposable {
	return vscode.commands.registerCommand("zoo-code.showRipgrepDiagnostic", async () => {
		const report = await getRipgrepDiagnostic(vscode.env.appRoot)
		const channel = vscode.window.createOutputChannel("Zoo Code Ripgrep Diagnostic")
		channel.appendLine(report)
		channel.show(true)
		await vscode.env.clipboard.writeText(report)
		await vscode.window.showInformationMessage("Zoo Code: ripgrep diagnostic copied to clipboard.")
	})
}
