import * as childProcess from "child_process"
import * as vscode from "vscode"

import { fileExistsAtPath } from "../../utils/fs"
import { getCommand } from "../../utils/commands"
import { loadRipgrep } from "./internal/loadRipgrep"
import { getBinPath, ripgrepCandidatePaths } from "./index"

const SPAWN_TIMEOUT_MS = 5_000

/**
 * Attempts `rg --version` with a 5 s timeout.
 * Returns { stdout, stderr, exitCode } on normal exit, { timedOut } on timeout,
 * or { spawnError } when spawn itself fails (e.g. ENOENT).
 */
export function trySpawnRipgrep(rgPath: string): Promise<{
	stdout?: string
	stderr?: string
	exitCode?: number
	timedOut?: true
	spawnError?: string
}> {
	return new Promise((resolve) => {
		let proc: childProcess.ChildProcess
		try {
			proc = childProcess.spawn(rgPath, ["--version"], { timeout: SPAWN_TIMEOUT_MS })
		} catch (err) {
			resolve({ spawnError: err instanceof Error ? err.message : String(err) })
			return
		}

		let stdout = ""
		let stderr = ""
		proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()))
		proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()))

		proc.on("error", (err) => resolve({ spawnError: err.message }))
		proc.on("close", (code, signal) => {
			if (signal === "SIGTERM" && code === null) {
				resolve({ timedOut: true })
			} else {
				resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? -1 })
			}
		})
	})
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
 * reports which ones exist on disk. Step 2 is skipped when appRoot is empty.
 * Step 3 runs `rg --version` on the path getBinPath() would select, directly
 * testing whether spawn succeeds (the failure mode Naved reported).
 */
export async function getRipgrepDiagnostic(vscodeAppRoot: string): Promise<string> {
	const appRootEmpty = !vscodeAppRoot || vscodeAppRoot.trim() === ""
	const lines: string[] = [
		`Zoo Code Ripgrep Diagnostic (${new Date().toISOString()})`,
		`vscode.version: ${vscode.version}`,
		`vscode.env.appRoot: ${appRootEmpty ? "(empty)" : vscodeAppRoot}`,
		...(appRootEmpty ? [] : [`process.platform/arch: ${process.platform}/${process.arch}`]),
		``,
		`--- step 1: require("@vscode/ripgrep") via loadRipgrep ---`,
	]

	const m = loadRipgrep()
	if (!m) {
		lines.push(`loadRipgrep() returned undefined (require threw)`)
	} else if (m.loadError) {
		lines.push(`loadRipgrep() returned loadError: ${m.loadError}`)
	} else {
		const keys = Object.keys(m).join(",") || "(none)"
		lines.push(`loadRipgrep() returned object. keys: ${keys}`)
		lines.push(`rgPath: ${m.rgPath ?? "(undefined)"}`)
		lines.push(`rgPath JSON: ${JSON.stringify(m.rgPath)}`)
		if (m.rgPath) {
			// Path-separator lookahead instead of `\b` — `\b` matches at the `r`/`.` boundary
			// inside `node_modules.asar.unpacked` too, producing a double `.unpacked.unpacked`.
			const fixed = m.rgPath.replace(/node_modules\.asar(?=[\\/])/, "node_modules.asar.unpacked")
			lines.push(`after .asar→.asar.unpacked: ${fixed}`)
			lines.push(`fileExistsAtPath: ${await fileExistsAtPath(fixed)}`)
		}
	}

	if (appRootEmpty) {
		lines.push(``)
		lines.push(`Cannot probe paths: vscode.env.appRoot is empty.`)
	} else {
		lines.push(``)
		lines.push(`--- step 2: path probe under appRoot ---`)
		for (const candidate of ripgrepCandidatePaths(vscodeAppRoot)) {
			const exists = await fileExistsAtPath(candidate)
			lines.push(`  ${exists ? "✓" : "✗"} ${candidate}`)
		}

		lines.push(``)
		lines.push(`--- step 3: spawn rg --version on selected path ---`)
		const selectedPath = await getBinPath(vscodeAppRoot)
		if (!selectedPath) {
			lines.push(`getBinPath() returned undefined — no candidate path exists`)
		} else {
			lines.push(`getBinPath() selected: ${selectedPath}`)
			lines.push(`selectedPath JSON: ${JSON.stringify(selectedPath)}`)
			const result = await trySpawnRipgrep(selectedPath)
			if (result.spawnError) {
				lines.push(`spawn error: ${result.spawnError}`)
			} else if (result.timedOut) {
				lines.push(`timed out after ${SPAWN_TIMEOUT_MS}ms`)
			} else {
				lines.push(`exit code: ${result.exitCode}`)
				lines.push(`stdout: ${result.stdout || "(empty)"}`)
				if (result.stderr) lines.push(`stderr: ${result.stderr}`)
			}
		}
	}

	return lines.join("\n")
}

/**
 * Registers the `zoo-code.showRipgrepDiagnostic` command. Thin wrapper —
 * runs `getRipgrepDiagnostic`, shows the result in an output channel,
 * copies it to the clipboard, and shows an info toast. The OutputChannel
 * is created once at registration and disposed alongside the command via
 * the composite Disposable returned here.
 */
export function registerRipgrepDiagnosticCommand(): vscode.Disposable {
	const channel = vscode.window.createOutputChannel("Zoo Code Ripgrep Diagnostic")
	const command = vscode.commands.registerCommand(getCommand("showRipgrepDiagnostic"), async () => {
		const report = await getRipgrepDiagnostic(vscode.env.appRoot)
		channel.clear()
		channel.appendLine(report)
		channel.show(true)
		await vscode.env.clipboard.writeText(report)
		await vscode.window.showInformationMessage("Zoo Code: ripgrep diagnostic copied to clipboard.")
	})
	return vscode.Disposable.from(command, channel)
}
