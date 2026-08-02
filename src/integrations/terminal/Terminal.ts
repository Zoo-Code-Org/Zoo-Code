import * as vscode from "vscode"

import type { RooTerminalCallbacks, RooTerminalProcessResultPromise } from "./types"
import { BaseTerminal, buildReuseExternalChecks } from "./BaseTerminal"
import { TerminalProcess } from "./TerminalProcess"
import { ShellIntegrationManager } from "./ShellIntegrationManager"
import { mergePromise } from "./mergePromise"
import { TerminalProfileResolver } from "./shell/TerminalProfileResolver"
import type { ResolvedCommandEnvironment, ShellFamily } from "./shell/types"

export class Terminal extends BaseTerminal {
	public terminal: vscode.Terminal

	public cmdCounter: number = 0

	public activeShellExecution?: vscode.TerminalShellExecution

	/**
	 * Request-scoped shell family cached at construction time.  Downstream
	 * code (TerminalProcess) uses this instead of re-reading VS Code
	 * settings to avoid detection mismatches between terminal creation
	 * and command execution.
	 *
	 * @see Terminal.resolveShellFamily
	 */
	public resolvedShellFamily: ShellFamily = "posix"

	private shellIntegrationAbortController?: AbortController

	/**
	 * @param id Terminal ID.
	 * @param terminal Existing VS Code terminal to wrap, or undefined to create new.
	 * @param cwd Working directory.
	 * @param resolvedEnv Optional resolved command environment. When provided,
	 *   the integrated terminal is created with the shell executable from
	 *   `primaryPlan` so it matches the shell reported in the system prompt.
	 */
	constructor(
		id: number,
		terminal: vscode.Terminal | undefined,
		cwd: string,
		resolvedEnv?: ResolvedCommandEnvironment,
	) {
		super("vscode", id, cwd, Terminal.getReuseKey())

		const env = Terminal.getEnv()
		const iconPath = new vscode.ThemeIcon("rocket")

		if (terminal) {
			this.terminal = terminal
		} else {
			const options: vscode.TerminalOptions = { cwd, name: "Zoo Code", iconPath, env }

			// When a resolved command environment is available, use its primary
			// plan executable so the integrated terminal matches the shell family
			// reported to the model. This is the single source of truth.
			if (resolvedEnv?.primaryPlan?.executable) {
				options.shellPath = resolvedEnv.primaryPlan.executable

				// When the resolved shell came from a VS Code terminal profile,
				// also pass the profile's shellArgs so the integrated terminal
				// uses the same arguments (e.g. --noprofile --norc for bash).
				const profileShell = Terminal.getProfileShell()

				if (profileShell?.shellArgs) {
					options.shellArgs = profileShell.shellArgs
				}

				// Preserve environment overrides from the resolved shell.
				if (resolvedEnv.primaryPlan.env) {
					options.env = { ...resolvedEnv.primaryPlan.env, ...env }
				}

				console.info(
					`[Terminal] Creating terminal with resolved shell: ${resolvedEnv.primaryPlan.executable} (family: ${resolvedEnv.primaryPlan.family})`,
				)
			} else {
				// When the user has chosen a VS Code terminal profile, resolve it to a
				// shell path/args so the integrated terminal uses that shell. When
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
			}

			this.terminal = vscode.window.createTerminal(options)
		}

		// Cache the resolved shell family at construction time so downstream
		// code (TerminalProcess) can use it without re-reading VS Code settings.
		this.resolvedShellFamily = Terminal.resolveShellFamily(
			resolvedEnv?.primaryPlan?.executable,
			resolvedEnv?.primaryPlan?.family,
			!terminal ? Terminal.getProfileShell()?.shellPath : undefined,
		)

		// Only register ZDOTDIR cleanup when we actually set it (i.e. no profile
		// override is active — see getEnv() for the same guard).
		if (Terminal.getTerminalZdotdir() && !Terminal.getTerminalProfile()) {
			ShellIntegrationManager.terminalTmpDirs.set(id, env.ZDOTDIR)
		}
	}

	/**
	 * VS Code reuse predicate. A VS Code terminal is reusable only when it is
	 * idle, unowned, not closed, has matching CWD/reuse key, is healthy, and
	 * currently has a shell integration object.
	 */
	public override canReuse(options: {
		cwd: string
		reuseKey: string
		hasProcess: boolean
		shellIntegrationDefined?: boolean
		hasStaleActiveShellExecution?: boolean
	}): boolean {
		return this.lifecycle.canReuse(
			buildReuseExternalChecks(this, {
				cwd: options.cwd,
				reuseKey: options.reuseKey,
				hasProcess: options.hasProcess,
				isClosed: this.isClosed(),
				shellIntegrationDefined:
					options.shellIntegrationDefined ?? this.terminal.shellIntegration !== undefined,
				hasStaleActiveShellExecution:
					options.hasStaleActiveShellExecution ?? this.activeShellExecution !== undefined,
			}),
		)
	}

	/**
	 * Cancels a pending shell-integration wait. Called by the registry during
	 * provider-switch cleanup so the source terminal does not race the fallback
	 * acquisition.
	 */
	public cancelShellIntegrationWait(): void {
		if (this.shellIntegrationAbortController) {
			this.shellIntegrationAbortController.abort()
			this.shellIntegrationAbortController = undefined
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

	public override runCommand(
		command: string,
		callbacks: RooTerminalCallbacks,
		executionId?: string,
	): RooTerminalProcessResultPromise {
		const effectiveExecutionId = executionId ?? `legacy-${this.id}-${Date.now()}`

		if (this.lifecycle.ownerExecutionId === undefined) {
			this.lifecycle.acquireOwner(effectiveExecutionId)
		}

		// Ensure the lifecycle is in a non-idle state for legacy callers that
		// invoke runCommand directly without going through the registry. For
		// VS Code terminals the correct path is idle → integration-ready, matching
		// the architect's reused-terminal sequence.
		if (this.lifecycle.state === "idle" && this.provider === "vscode") {
			this.lifecycle.transition("integration-ready", effectiveExecutionId)
		}

		const process = new TerminalProcess(this)
		process.command = command
		process.executionId = effectiveExecutionId
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
				// cmd.exe cannot emit OSC 633;A — route to fallback immediately.
				this.lifecycle.markUnsupported()
				ShellIntegrationManager.zshCleanupTmpDir(this.id)
				process.emit("no_shell_integration", {
					message:
						"cmd.exe does not support shell integration (VS Code issue #164646). Command will run via fallback.",
					commandSubmitted: false,
					code: "SI_NEVER_AVAILABLE",
					phase: "prepare",
					provider: "vscode",
					outcome: "not-started",
					retryDisposition: "fallback-safe",
				})
				return
			}

			// Wait for shell integration to activate before executing the command.
			// Use the onDidChangeTerminalShellIntegration event rather than polling
			// so we react immediately when the shell is ready. The timeout is kept as
			// a safety net for shells that never activate integration (e.g. heavily
			// customised startup that suppresses the OSC 633;A marker).
			this.waitForShellIntegration(Terminal.getShellIntegrationTimeout(), effectiveExecutionId)
				.then(() => {
					// Clean up temporary directory if shell integration is available, zsh did its job:
					ShellIntegrationManager.zshCleanupTmpDir(this.id)

					// Run the command in the terminal
					process.run(command)
				})
				.catch((error) => {
					// If the wait was cancelled by provider-switch cleanup, do not emit
					// a no_shell_integration event; the caller owns cleanup.
					if (error instanceof Error && error.name === "AbortError") {
						console.info(`[Terminal ${this.id}] shell integration wait cancelled`)
						return
					}

					console.log(`[Terminal ${this.id}] Shell integration not available. Command execution aborted.`)

					// Clean up temporary directory if shell integration is not available
					ShellIntegrationManager.zshCleanupTmpDir(this.id)

					this.lifecycle.markSuspect()
					process.emit("no_shell_integration", {
						message: `Shell integration initialization sequence '\\x1b]633;A' was not received within ${Terminal.getShellIntegrationTimeout() / 1000}s. Shell integration has been disabled for this terminal instance. Increase the timeout in the settings if necessary.`,
						commandSubmitted: false,
						code: "SI_ACTIVATION_TIMEOUT",
						phase: "prepare",
						provider: "vscode",
						outcome: "not-started",
						retryDisposition: "same-terminal-once",
					})
				})
		})

		return mergePromise(process, promise)
	}

	/**
	 * Resolves when this terminal's shell integration becomes active, or rejects
	 * after timeoutMs if the shell never signals readiness. Uses the
	 * onDidChangeTerminalShellIntegration event so we react immediately rather
	 * than polling — important for slow-starting shells (heavy .zshrc, nvm, etc.).
	 *
	 * This method is public so the registry can reuse it during recovery and
	 * provider-switch cleanup. The optional abortSignal allows cancellation.
	 */
	public waitForShellIntegration(timeoutMs: number, executionId?: string, abortSignal?: AbortSignal): Promise<void> {
		if (this.terminal.shellIntegration) {
			// A reused terminal may already be in `integration-ready` (promoted by the
			// registry during reservation) while shellIntegration is still defined.
			// `integration-ready → integration-ready` is not a legal self-transition,
			// so only promote when not already ready.
			if (this.lifecycle.state !== "integration-ready") {
				this.lifecycle.transition("integration-ready", executionId)
			}
			this.lifecycle.markHealthy()
			return Promise.resolve()
		}

		// Only move to `integration-pending` from a state where that transition is
		// legal. From `integration-ready`/`fallback-ready` the forward table does
		// not allow `→ integration-pending`; in that case leave the state as-is and
		// rely on the readiness event (or timeout) to drive the next transition.
		if (this.lifecycle.state !== "integration-ready" && this.lifecycle.state !== "fallback-ready") {
			this.lifecycle.transition("integration-pending", executionId)
		}
		this.shellIntegrationAbortController = new AbortController()
		const abortController = this.shellIntegrationAbortController

		if (abortSignal) {
			abortSignal.addEventListener("abort", () => abortController.abort(), { once: true })
		}

		return new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(timer)
				ref.disposable?.dispose()
				const err = new Error("Shell integration wait cancelled")
				err.name = "AbortError"
				reject(err)
			}

			if (abortController.signal.aborted) {
				onAbort()
				return
			}

			abortController.signal.addEventListener("abort", onAbort, { once: true })

			const ref = { disposable: null as vscode.Disposable | null }
			const timer = setTimeout(() => {
				ref.disposable?.dispose()
				abortController.signal.removeEventListener("abort", onAbort)
				reject(new Error(`Shell integration did not activate within ${timeoutMs / 1000}s`))
			}, timeoutMs)

			ref.disposable = vscode.window.onDidChangeTerminalShellIntegration((e) => {
				if (e.terminal === this.terminal) {
					clearTimeout(timer)
					ref.disposable?.dispose()
					abortController.signal.removeEventListener("abort", onAbort)
					// Guard against illegal self-transition on reused terminals that are
					// already in `integration-ready` when the readiness event fires again.
					if (this.lifecycle.state !== "integration-ready") {
						this.lifecycle.transition("integration-ready", executionId)
					}
					this.lifecycle.markHealthy()
					resolve()
				}
			})
		})
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
	 * Lazily-initialized TerminalProfileResolver instance for delegation.
	 * Created per-call with the current platform/env to avoid stale state.
	 * Tests that spy on Terminal methods still work because the delegation
	 * preserves the same logic through the resolver.
	 */
	private static getProfileResolver(
		platform: NodeJS.Platform = process.platform,
		env: NodeJS.ProcessEnv = process.env,
	): TerminalProfileResolver {
		return TerminalProfileResolver.forRuntime(platform, env)
	}

	/**
	 * Resolves a profile path to an executable on disk. VS Code's built-in Unix
	 * profiles commonly use bare command names such as `bash`, so check PATH in
	 * addition to explicit filesystem paths.
	 *
	 * Delegates to {@link TerminalProfileResolver.resolveProfilePath} internally.
	 */
	public static resolveProfilePath(
		profilePath: unknown,
		platform: NodeJS.Platform = process.platform,
		env: NodeJS.ProcessEnv = process.env,
	): string | undefined {
		return Terminal.getProfileResolver(platform, env).resolveProfilePath(profilePath)
	}

	/**
	 * Reads profiles from trusted settings scopes only. Workspace settings are
	 * intentionally excluded because opening a repository must not allow its
	 * `.vscode/settings.json` to select an executable for Zoo Code to launch.
	 *
	 * Delegates to {@link TerminalProfileResolver.readProfiles} internally.
	 */
	public static getConfiguredProfiles(platform: NodeJS.Platform = process.platform): Record<string, unknown> {
		return Terminal.getProfileResolver(platform).readProfiles()
	}

	/**
	 * Reads the configured default profile from trusted settings scopes only.
	 *
	 * Delegates to {@link TerminalProfileResolver.readDefaultProfileName} internally.
	 */
	public static getConfiguredDefaultProfileName(platform: NodeJS.Platform = process.platform): string | undefined {
		return Terminal.getProfileResolver(platform).readDefaultProfileName()
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
	 * Classifies a shell executable path (or resolved environment) into a
	 * {@link ShellFamily}.  Called once per terminal construction so that
	 * downstream code never has to re-classify.
	 *
	 * Priority:
	 * 1. If `resolvedFamily` is provided (from `resolvedEnv.primaryPlan.family`),
	 *    use it directly — the environment resolver already determined the family.
	 * 2. If `profileShellPath` is provided, classify from the path using the
	 *    existing static helpers.
	 * 3. Otherwise detect from the VS Code active-profile settings once.
	 */
	private static resolveShellFamily(
		resolvedExecutable: string | undefined,
		resolvedFamily: ShellFamily | undefined,
		profileShellPath: string | undefined,
	): ShellFamily {
		// 1. Use the family from the resolved command environment if available.
		if (resolvedFamily) {
			return resolvedFamily
		}

		// 2. Classify from the profile shell path.
		if (profileShellPath) {
			if (Terminal.isPowerShell(profileShellPath)) {
				return "powershell"
			}

			if (Terminal.isCmdExe(profileShellPath)) {
				return "cmd"
			}

			if (Terminal.isFish(profileShellPath)) {
				return "fish"
			}

			return "posix"
		}

		// 3. Detect from the VS Code active-profile settings once.
		if (Terminal.isActiveShellPowerShell()) {
			return "powershell"
		}

		if (Terminal.isActiveShellCmdExe()) {
			return "cmd"
		}

		if (Terminal.isActiveShellFish()) {
			return "fish"
		}

		return "posix"
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

	/**
	 * Returns sorted profile names that resolve to trusted, supported shells.
	 * Excludes cmd.exe profiles (shell integration unsupported).
	 *
	 * Delegates to {@link TerminalProfileResolver.getAvailableProfileNames}.
	 */
	public static getAvailableProfileNames(platform: NodeJS.Platform = process.platform): string[] {
		return Terminal.getProfileResolver(platform).getAvailableProfileNames()
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

		// Delegate to TerminalProfileResolver for path resolution and env
		// sanitization. The resolver handles source-only profiles, name-based
		// detection, and blocked env keys. We extract shellArgs from the raw
		// profile entry here since args are profile-specific.
		const resolver = Terminal.getProfileResolver(platform)
		const resolved = resolver.resolveProfile(profileName, "zooProfile")

		if (!resolved) {
			return undefined
		}

		// Extract shellArgs from the raw profile entry.
		const entry = resolved.entry
		const shellArgs = Array.isArray(entry.args)
			? entry.args.filter((arg): arg is string => typeof arg === "string")
			: typeof entry.args === "string"
				? [entry.args]
				: undefined

		return {
			shellPath: resolved.shell.executable,
			shellArgs,
			env: resolved.shell.env,
		}
	}
}
