import { existsSync } from "fs"
import * as path from "path"

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

	public activeShellExecution?: vscode.TerminalShellExecution

	constructor(id: number, terminal: vscode.Terminal | undefined, cwd: string) {
		super("vscode", id, cwd, Terminal.getReuseKey())

		const env = Terminal.getEnv()
		const iconPath = new vscode.ThemeIcon("rocket")

		if (terminal) {
			this.terminal = terminal
		} else {
			const options: vscode.TerminalOptions = { cwd, name: "Zoo Code", iconPath, env }

			// When the user has chosen a VS Code terminal profile, resolve it to a
			// shell path/args/env so the integrated terminal uses that shell. When
			// unset, shellPath/shellArgs are left undefined so VS Code's default
			// terminal behavior is preserved.
			const profileShell = Terminal.getProfileShell()

			if (profileShell?.shellPath) {
				options.shellPath = profileShell.shellPath

				if (profileShell.shellArgs) {
					options.shellArgs = profileShell.shellArgs
				}

				console.info(
					`[Terminal] Creating terminal with profile "${Terminal.getTerminalProfile()}" -> ${profileShell.shellPath}`,
				)

				// Preserve profile-specific variables (e.g. locale/PATH), but keep
				// Zoo Code's shell-integration controls authoritative.
				if (profileShell.env) {
					options.env = { ...profileShell.env, ...env }
				}
			}

			this.terminal = vscode.window.createTerminal(options)
		}

		// Only register ZDOTDIR cleanup when we actually set it (i.e. no profile
		// override is active — see getEnv() for the same guard).
		if (Terminal.getTerminalZdotdir() && !Terminal.getTerminalProfile()) {
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
		process.once("no_shell_integration", (details) => callbacks.onNoShellIntegration?.(details, process))

		const promise = new Promise<void>((resolve, reject) => {
			// Set up event handlers
			process.once("continue", () => resolve())
			process.once("error", (error) => {
				console.error(`[Terminal ${this.id}] error:`, error)
				reject(error)
			})

			if (Terminal.isActiveShellCmdExe()) {
				// Keep this defensive fallback for callers that invoke Terminal.runCommand()
				// directly instead of routing through executeCommandInTerminal().
				// cmd.exe cannot emit OSC 633;A — skip the timeout entirely and go
				// straight to the execa fallback (VS Code issue #164646).
				ShellIntegrationManager.zshCleanupTmpDir(this.id)
				process.emit("no_shell_integration", {
					message:
						"cmd.exe does not support shell integration (VS Code issue #164646). Command will run via fallback.",
					commandSubmitted: false,
				})
			} else {
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

						process.emit("no_shell_integration", {
							message: `Shell integration initialization sequence '\\x1b]633;A' was not received within ${Terminal.getShellIntegrationTimeout() / 1000}s. Shell integration has been disabled for this terminal instance. Increase the timeout in the settings if necessary.`,
							commandSubmitted: false,
						})
					})
			}
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

		// Handle ZDOTDIR for zsh if enabled. Skip when a profile override is
		// active: VS Code's own shell integration injector also sets ZDOTDIR for
		// zsh, and the two would fight each other (VS Code's ambient env wins per
		// issue #96295). Let VS Code handle injection for the selected profile.
		if (Terminal.getTerminalZdotdir() && !Terminal.getTerminalProfile()) {
			env.ZDOTDIR = ShellIntegrationManager.zshInitTmpDir(env)
		}

		return env
	}

	/**
	 * Returns the VS Code config section key (`windows`/`osx`/`linux`) used for
	 * platform-specific terminal profiles.
	 */
	public static getPlatformProfileKey(platform: NodeJS.Platform = process.platform): "windows" | "osx" | "linux" {
		if (platform === "win32") {
			return "windows"
		}

		if (platform === "darwin") {
			return "osx"
		}

		return "linux"
	}

	/**
	 * Resolves a profile path to an executable on disk. VS Code's built-in Unix
	 * profiles commonly use bare command names such as `bash`, so check PATH in
	 * addition to explicit filesystem paths.
	 */
	public static resolveProfilePath(
		profilePath: unknown,
		platform: NodeJS.Platform = process.platform,
		env: NodeJS.ProcessEnv = process.env,
	): string | undefined {
		const candidates = Array.isArray(profilePath) ? profilePath : [profilePath]
		const pathValue = env.PATH ?? env.Path ?? env.path
		const pathEntries = pathValue?.split(platform === "win32" ? ";" : ":") ?? []
		const platformJoin = platform === "win32" ? path.win32.join : path.posix.join

		for (const value of candidates) {
			if (typeof value !== "string") {
				continue
			}

			const candidate = value.trim()

			if (!candidate) {
				continue
			}

			if (/[\\/]/.test(candidate)) {
				if (existsSync(candidate)) {
					return candidate
				}

				continue
			}

			const extensions =
				platform === "win32" && path.extname(candidate) === ""
					? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
					: [""]

			for (const entry of pathEntries) {
				const directory = entry.replace(/^"(.*)"$/, "$1")

				for (const extension of extensions) {
					const resolved = platformJoin(directory, `${candidate}${extension}`)

					if (existsSync(resolved)) {
						return resolved
					}
				}
			}
		}

		return undefined
	}

	/**
	 * Reads profiles from trusted settings scopes only. Workspace settings are
	 * intentionally excluded because opening a repository must not allow its
	 * `.vscode/settings.json` to select an executable for Zoo Code to launch.
	 */
	public static getConfiguredProfiles(platform: NodeJS.Platform = process.platform): Record<string, unknown> {
		const platformKey = Terminal.getPlatformProfileKey(platform)
		const configuration = vscode.workspace.getConfiguration("terminal.integrated.profiles")

		// Some test doubles and older embedders expose get() without inspect().
		// Falling back to no profiles preserves the trusted-scope guarantee.
		if (typeof configuration.inspect !== "function") {
			return {}
		}

		const inspected = configuration.inspect<Record<string, unknown>>(platformKey)

		return {
			...(inspected?.defaultValue ?? {}),
			...(inspected?.globalValue ?? {}),
		}
	}

	/**
	 * Reads the configured default profile from trusted settings scopes only.
	 */
	public static getConfiguredDefaultProfileName(platform: NodeJS.Platform = process.platform): string | undefined {
		const platformKey = Terminal.getPlatformProfileKey(platform)
		const configuration = vscode.workspace.getConfiguration("terminal.integrated")

		// Some test doubles and older embedders expose get() without inspect().
		// Falling back to undefined preserves the trusted-scope guarantee.
		if (typeof configuration.inspect !== "function") {
			return undefined
		}

		const inspected = configuration.inspect<string>(`defaultProfile.${platformKey}`)

		return inspected?.globalValue ?? inspected?.defaultValue
	}

	/**
	 * Returns true when the resolved shell path is cmd.exe. cmd.exe cannot emit
	 * the OSC 633;C sequence (VS Code issue #164646, closed as not planned), so
	 * shell integration will never work for it — exclude it from the picker.
	 */
	public static isCmdExe(shellPath: string): boolean {
		return /[/\\]cmd\.exe$/i.test(shellPath)
	}

	public static isPowerShell(shellPath: string): boolean {
		return /[/\\](?:pwsh|powershell)(?:\.exe)?$/i.test(shellPath)
	}

	public static isFish(shellPath: string): boolean {
		return /[/\\]fish(?:\.exe)?$/i.test(shellPath)
	}

	/**
	 * Returns true when the active shell (profile override or VS Code default) is
	 * cmd.exe. Used to skip the shell integration timeout entirely for cmd.exe.
	 */
	public static isActiveShellCmdExe(platform: NodeJS.Platform = process.platform): boolean {
		if (platform !== "win32") {
			return false
		}

		// Check explicit profile override first.
		const profileShell = Terminal.getProfileShell(platform)

		if (profileShell?.shellPath) {
			return Terminal.isCmdExe(profileShell.shellPath)
		}

		// Fall back to VS Code's configured default profile for Windows.
		const defaultProfileName = Terminal.getConfiguredDefaultProfileName(platform)

		if (!defaultProfileName) {
			return false
		}

		const profiles = Terminal.getConfiguredProfiles(platform)
		const profile = profiles[defaultProfileName] as { path?: unknown } | null | undefined

		if (!profile) {
			return false
		}

		const resolved = Terminal.resolveProfilePath(profile.path, platform)
		return resolved ? Terminal.isCmdExe(resolved) : false
	}

	public static isActiveShellPowerShell(platform: NodeJS.Platform = process.platform): boolean {
		if (platform !== "win32") {
			return false
		}

		const profileOverride = Terminal.getTerminalProfile()

		if (profileOverride) {
			const profileShell = Terminal.getProfileShell(platform)
			return profileShell?.shellPath ? Terminal.isPowerShell(profileShell.shellPath) : false
		}

		const defaultProfileName = Terminal.getConfiguredDefaultProfileName(platform)

		if (!defaultProfileName) {
			return false
		}

		const profiles = Terminal.getConfiguredProfiles(platform)
		const profile = profiles[defaultProfileName] as { path?: unknown; source?: unknown } | null | undefined

		if (!profile) {
			return false
		}

		const resolved = Terminal.resolveProfilePath(profile.path, platform)

		if (resolved) {
			return Terminal.isPowerShell(resolved)
		}

		return typeof profile.source === "string" && profile.source.toLowerCase().includes("powershell")
	}

	public static isActiveShellFish(platform: NodeJS.Platform = process.platform): boolean {
		const profileOverride = Terminal.getTerminalProfile()

		if (profileOverride) {
			const profileShell = Terminal.getProfileShell(platform)
			return profileShell?.shellPath ? Terminal.isFish(profileShell.shellPath) : false
		}

		const defaultProfileName = Terminal.getConfiguredDefaultProfileName(platform)

		if (!defaultProfileName) {
			return false
		}

		const profiles = Terminal.getConfiguredProfiles(platform)
		const profile = profiles[defaultProfileName] as { path?: unknown } | null | undefined

		if (!profile) {
			return false
		}

		const resolved = Terminal.resolveProfilePath(profile.path, platform)
		return resolved ? Terminal.isFish(resolved) : false
	}

	public static getAvailableProfileNames(platform: NodeJS.Platform = process.platform): string[] {
		const names: string[] = []

		for (const [name, entry] of Object.entries(Terminal.getConfiguredProfiles(platform))) {
			if (!entry || typeof entry !== "object") {
				continue
			}

			const { path: profilePath } = entry as { path?: unknown }
			const resolved = Terminal.resolveProfilePath(profilePath, platform)

			if (resolved && !Terminal.isCmdExe(resolved)) {
				names.push(name)
			}
		}

		return names.sort()
	}

	/**
	 * Returns a stable key that prevents terminals created with different VS Code
	 * profile overrides from being reused interchangeably.
	 */
	public static getReuseKey(): string {
		return `vscode:${Terminal.getTerminalProfile() ?? "default"}`
	}

	/**
	 * Resolves the configured VS Code terminal profile (see `terminalProfile`
	 * setting / {@link Terminal.getTerminalProfile}) into a shell path and args by
	 * reading VS Code's `terminal.integrated.profiles.<platform>` configuration.
	 *
	 * This reuses VS Code's terminal profile concept so users can pick, for
	 * example, a Git Bash profile instead of the default shell. Only profiles
	 * with a resolvable `path` are supported; source-only profiles (e.g.
	 * `{ source: "PowerShell" }`) cannot be mapped to a shell binary by an
	 * extension and return undefined.
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

		const profiles = Terminal.getConfiguredProfiles(platform)

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

		const pathValue = Terminal.resolveProfilePath(profile.path, platform)

		if (!pathValue) {
			// Profiles defined only by `source` (e.g. "PowerShell") can't be mapped to
			// a shell path here, so we fall back to the default terminal.
			console.warn(
				`[Terminal] Terminal profile "${profileName}" has no resolvable "path"; using default terminal.`,
			)
			return undefined
		}

		const shellArgs = Array.isArray(profile.args)
			? profile.args.filter((arg): arg is string => typeof arg === "string")
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
			const blockedKeys = new Set([
				"ZDOTDIR",
				"PROMPT_COMMAND",
				"LD_PRELOAD",
				"LD_LIBRARY_PATH",
				"DYLD_INSERT_LIBRARIES",
				"DYLD_LIBRARY_PATH",
				"BASH_ENV",
				"ENV",
			])

			for (const [key, val] of Object.entries(profile.env)) {
				if (!blockedKeys.has(key.toUpperCase()) && (typeof val === "string" || val === null)) {
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
