import * as vscode from "vscode"
import pWaitFor from "p-wait-for"

import type { RooTerminalCallbacks, RooTerminalProcessResultPromise } from "./types"
import { BaseTerminal } from "./BaseTerminal"
import { TerminalProcess } from "./TerminalProcess"
import { ShellIntegrationManager } from "./ShellIntegrationManager"
import { mergePromise } from "./mergePromise"

export class Terminal extends BaseTerminal {
	public terminal: vscode.Terminal

	public cmdCounter: number = 0

	constructor(id: number, terminal: vscode.Terminal | undefined, cwd: string) {
		super("vscode", id, cwd)

		const env = Terminal.getEnv()
		const iconPath = new vscode.ThemeIcon("rocket")

		if (terminal) {
			this.terminal = terminal
		} else {
			const options: vscode.TerminalOptions = { cwd, name: "Roo Code", iconPath, env }

			// When the user has chosen a specific terminal profile, resolve it to a
			// shell path/args/env so the inline terminal uses that shell (e.g. Git Bash
			// with a UTF-8 charset on Windows). When unset, we leave shellPath/shellArgs
			// undefined so VS Code's default terminal behavior is preserved (#119).
			const profileShell = Terminal.getProfileShell()

			if (profileShell?.shellPath) {
				options.shellPath = profileShell.shellPath

				if (profileShell.shellArgs) {
					options.shellArgs = profileShell.shellArgs
				}

				// Merge the profile's own env on top of the base env so profile-specific
				// variables (e.g. locale/PATH) are not lost. A `null` value unsets one.
				if (profileShell.env) {
					options.env = { ...env, ...profileShell.env }
				}
			}

			this.terminal = vscode.window.createTerminal(options)
		}

		if (Terminal.getTerminalZdotdir()) {
			ShellIntegrationManager.terminalTmpDirs.set(id, env.ZDOTDIR)
		}
	}

	/**
	 * Gets the current working directory from shell integration or falls back to initial cwd.
	 * @returns The current working directory
	 */
	public override getCurrentWorkingDirectory(): string {
		return this.terminal.shellIntegration?.cwd ? this.terminal.shellIntegration.cwd.fsPath : this.initialCwd
	}

	/**
	 * The exit status of the terminal will be undefined while the terminal is
	 * active. (This value is set when onDidCloseTerminal is fired.)
	 */
	public override isClosed(): boolean {
		return this.terminal.exitStatus !== undefined
	}

	public override runCommand(command: string, callbacks: RooTerminalCallbacks): RooTerminalProcessResultPromise {
		// We set busy before the command is running because the terminal may be
		// waiting on terminal integration, and we must prevent another instance
		// from selecting the terminal for use during that time.
		this.busy = true

		const process = new TerminalProcess(this)
		process.command = command
		this.process = process

		// Set up event handlers from callbacks before starting process.
		// This ensures that we don't miss any events because they are
		// configured before the process starts.
		process.on("line", (line) => callbacks.onLine(line, process))
		process.once("completed", (output) => callbacks.onCompleted(output, process))
		process.once("shell_execution_started", (pid) => callbacks.onShellExecutionStarted(pid, process))
		process.once("shell_execution_complete", (details) => callbacks.onShellExecutionComplete(details, process))
		process.once("no_shell_integration", (msg) => callbacks.onNoShellIntegration?.(msg, process))

		const promise = new Promise<void>((resolve, reject) => {
			// Set up event handlers
			process.once("continue", () => resolve())
			process.once("error", (error) => {
				console.error(`[Terminal ${this.id}] error:`, error)
				reject(error)
			})

			// Wait for shell integration before executing the command
			pWaitFor(() => this.terminal.shellIntegration !== undefined, {
				timeout: Terminal.getShellIntegrationTimeout(),
			})
				.then(() => {
					// Clean up temporary directory if shell integration is available, zsh did its job:
					ShellIntegrationManager.zshCleanupTmpDir(this.id)

					// Run the command in the terminal
					process.run(command)
				})
				.catch(() => {
					console.log(`[Terminal ${this.id}] Shell integration not available. Command execution aborted.`)

					// Clean up temporary directory if shell integration is not available
					ShellIntegrationManager.zshCleanupTmpDir(this.id)

					process.emit(
						"no_shell_integration",
						`Shell integration initialization sequence '\\x1b]633;A' was not received within ${Terminal.getShellIntegrationTimeout() / 1000}s. Shell integration has been disabled for this terminal instance. Increase the timeout in the settings if necessary.`,
					)
				})
		})

		return mergePromise(process, promise)
	}

	/**
	 * Gets the terminal contents based on the number of commands to include
	 * @param commands Number of previous commands to include (-1 for all)
	 * @returns The selected terminal contents
	 */
	public static async getTerminalContents(commands = -1): Promise<string> {
		// Save current clipboard content
		const tempCopyBuffer = await vscode.env.clipboard.readText()

		try {
			// Select terminal content
			if (commands < 0) {
				await vscode.commands.executeCommand("workbench.action.terminal.selectAll")
			} else {
				for (let i = 0; i < commands; i++) {
					await vscode.commands.executeCommand("workbench.action.terminal.selectToPreviousCommand")
				}
			}

			// Copy selection and clear it
			await vscode.commands.executeCommand("workbench.action.terminal.copySelection")
			await vscode.commands.executeCommand("workbench.action.terminal.clearSelection")

			// Get copied content
			let terminalContents = (await vscode.env.clipboard.readText()).trim()

			// Restore original clipboard content
			await vscode.env.clipboard.writeText(tempCopyBuffer)

			if (tempCopyBuffer === terminalContents) {
				// No terminal content was copied
				return ""
			}

			// Process multi-line content
			const lines = terminalContents.split("\n")
			const lastLine = lines.pop()?.trim()

			if (lastLine) {
				let i = lines.length - 1

				while (i >= 0 && !lines[i].trim().startsWith(lastLine)) {
					i--
				}

				terminalContents = lines.slice(Math.max(i, 0)).join("\n")
			}

			return terminalContents
		} catch (error) {
			// Ensure clipboard is restored even if an error occurs
			await vscode.env.clipboard.writeText(tempCopyBuffer)
			throw error
		}
	}

	public static getEnv(): Record<string, string> {
		const env: Record<string, string> = {
			ROO_ACTIVE: "true",
			PAGER: process.platform === "win32" ? "" : "cat",

			// VTE must be disabled because it prevents the prompt command from executing
			// See https://wiki.gnome.org/Apps/Terminal/VTE
			VTE_VERSION: "0",
		}

		// Set Oh My Zsh shell integration if enabled
		if (Terminal.getTerminalZshOhMy()) {
			env.ITERM_SHELL_INTEGRATION_INSTALLED = "Yes"
		}

		// Set Powerlevel10k shell integration if enabled
		if (Terminal.getTerminalZshP10k()) {
			env.POWERLEVEL9K_TERM_SHELL_INTEGRATION = "true"
		}

		// VSCode bug#237208: Command output can be lost due to a race between completion
		// sequences and consumers. Add delay via PROMPT_COMMAND to ensure the
		// \x1b]633;D escape sequence arrives after command output is processed.
		// Only add this if commandDelay is not zero
		if (Terminal.getCommandDelay() > 0) {
			env.PROMPT_COMMAND = `sleep ${Terminal.getCommandDelay() / 1000}`
		}

		// Clear the ZSH EOL mark to prevent issues with command output interpretation
		// when output ends with special characters like '%'
		if (Terminal.getTerminalZshClearEolMark()) {
			env.PROMPT_EOL_MARK = ""
		}

		// Handle ZDOTDIR for zsh if enabled
		if (Terminal.getTerminalZdotdir()) {
			env.ZDOTDIR = ShellIntegrationManager.zshInitTmpDir(env)
		}

		return env
	}

	/**
	 * Returns the VS Code config section key (`windows`/`osx`/`linux`) used for
	 * platform-specific terminal profiles.
	 */
	private static getPlatformProfileKey(platform: NodeJS.Platform = process.platform): "windows" | "osx" | "linux" {
		if (platform === "win32") {
			return "windows"
		}

		if (platform === "darwin") {
			return "osx"
		}

		return "linux"
	}

	/**
	 * Resolves the configured inline terminal profile (see `terminalProfile`
	 * setting / {@link Terminal.getTerminalProfile}) into a shell path and args by
	 * reading VS Code's `terminal.integrated.profiles.<platform>` configuration.
	 *
	 * This reuses VS Code's terminal profile concept so users can pick, for
	 * example, a Git Bash profile (UTF-8) instead of the default cmd/PowerShell
	 * (which may use a non-UTF-8 charset such as GBK) on Windows (#119).
	 *
	 * @returns The resolved shell path/args, or undefined when no profile is
	 *   configured or the profile cannot be resolved (default behavior).
	 */
	public static getProfileShell(
		platform: NodeJS.Platform = process.platform,
	): { shellPath: string; shellArgs?: string[]; env?: Record<string, string | null> } | undefined {
		const profileName = Terminal.getTerminalProfile()

		if (!profileName) {
			return undefined
		}

		const platformKey = Terminal.getPlatformProfileKey(platform)

		const profiles = vscode.workspace
			.getConfiguration("terminal.integrated.profiles")
			.get<Record<string, unknown>>(platformKey)

		const profile = profiles?.[profileName] as
			| {
					path?: string | string[]
					args?: string | string[]
					source?: string
					env?: Record<string, unknown>
			  }
			| null
			| undefined

		if (!profile) {
			console.warn(`[Terminal] Configured terminal profile "${profileName}" not found for ${platformKey}.`)
			return undefined
		}

		// A `path` may be a single string or an array of candidate paths (VS Code
		// picks the first that exists). We pass the first candidate to createTerminal.
		const pathValue = Array.isArray(profile.path) ? profile.path[0] : profile.path

		if (!pathValue) {
			// Profiles defined only by `source` (e.g. "PowerShell") can't be mapped to
			// a shell path here, so we fall back to the default terminal.
			console.warn(
				`[Terminal] Terminal profile "${profileName}" has no resolvable "path"; using default terminal.`,
			)
			return undefined
		}

		const shellArgs = Array.isArray(profile.args)
			? profile.args
			: typeof profile.args === "string"
				? [profile.args]
				: undefined

		// VS Code profiles may declare their own `env` (e.g. to set a UTF-8 locale or
		// a custom PATH). Preserve it so the inline terminal doesn't lose environment
		// the user configured on the profile. A `null` value unsets that variable.
		// Values come from user `settings.json`, so sanitize to string/null only.
		let env: Record<string, string | null> | undefined

		if (profile.env && typeof profile.env === "object") {
			const sanitized: Record<string, string | null> = {}

			for (const [key, val] of Object.entries(profile.env)) {
				if (typeof val === "string" || val === null) {
					sanitized[key] = val
				}
			}

			if (Object.keys(sanitized).length > 0) {
				env = sanitized
			}
		}

		return { shellPath: pathValue, shellArgs, env }
	}
}
