/**
 * CommandEnvironmentService — request-scoped service that resolves ONE
 * {@link ResolvedCommandEnvironment} per API request.
 *
 * This is the single source of truth that feeds:
 * - System prompt (shell info, rules)
 * - Native tool description (execute_command)
 * - Runtime execution (ExecaTerminalProcess)
 * - Same-family fallback plan
 *
 * Caching:
 * - Caches by settings version; invalidates on settings change.
 * - The version counter increments when {@link invalidate} is called
 *   (typically on settings update or shell selection change).
 *
 * See ARCH-TERMINAL-001 section 1.9 (Request-scoped data flow).
 */

import type { TerminalShellSelection } from "@roo-code/types"

import type { ShellResolver, ShellResolverSettings } from "./ShellResolver"
import { ShellInvocationAdapter } from "./ShellInvocationAdapter"
import type {
	ResolvedCommandEnvironment,
	ResolvedShell,
	ShellFamily,
	ShellInvocationPlan,
	ShellResolutionResult,
} from "./types"

/**
 * Input settings for the command environment service. These are the
 * shell-related settings from global state plus optional CLI override.
 */
export interface CommandEnvironmentSettings {
	/** New unified terminal shell selection (absent = auto). */
	terminalShellSelection?: TerminalShellSelection
	/** @deprecated Legacy execa shell path. */
	execaShellPath?: string
	/** Zoo Code terminal profile name. */
	terminalProfile?: string
	/** CLI override (highest priority, ephemeral). */
	cliOverride?: string
}

/**
 * Request-scoped command environment resolver.
 *
 * Construct with a {@link ShellResolver} instance. The service caches
 * the resolved environment by settings version and invalidates on change.
 */
export class CommandEnvironmentService {
	private cached: ResolvedCommandEnvironment | null = null
	private cachedVersion: number = -1
	private version: number = 0

	constructor(private readonly shellResolver: ShellResolver) {}

	/**
	 * Returns the resolved command environment for the current settings.
	 *
	 * If the settings version hasn't changed since the last call, returns
	 * the cached environment. Otherwise, resolves a fresh environment.
	 *
	 * @param settings Current shell-related settings.
	 * @param cwd Working directory for the command.
	 * @returns The resolved command environment.
	 */
	getEnvironment(settings: CommandEnvironmentSettings, cwd?: string): ResolvedCommandEnvironment {
		if (this.cached && this.cachedVersion === this.version) {
			return this.cached
		}

		const env = this.resolveEnvironment(settings, cwd)
		this.cached = env
		this.cachedVersion = this.version
		return env
	}

	/**
	 * Invalidates the cached environment. Call this when shell-related
	 * settings change (e.g. terminalShellSelection, execaShellPath, or
	 * terminalProfile is updated).
	 */
	invalidate(): void {
		this.version++
		this.cached = null
		this.cachedVersion = -1
	}

	/**
	 * Gets the current settings version counter.
	 */
	getVersion(): number {
		return this.version
	}

	// -------------------------------------------------
	// Internal resolution
	// -------------------------------------------------

	/**
	 * Resolves a fresh {@link ResolvedCommandEnvironment} from settings.
	 */
	private resolveEnvironment(settings: CommandEnvironmentSettings, cwd?: string): ResolvedCommandEnvironment {
		const resolverSettings: ShellResolverSettings = {
			terminalShellSelection: settings.terminalShellSelection,
			execaShellPath: settings.execaShellPath,
			terminalProfile: settings.terminalProfile,
		}

		const result = this.shellResolver.resolve(resolverSettings, settings.cliOverride)
		const warnings: string[] = []

		// Determine the primary shell.
		let primaryShell: ResolvedShell

		if (result.ok) {
			primaryShell = result.shell
		} else {
			// On failure, use fallback if available, otherwise we need
			// to construct a safe fallback shell.
			if (result.fallback) {
				primaryShell = result.fallback
				warnings.push(
					`Shell resolution failed (${result.error.code}): ${result.error.message}. Using fallback.`,
				)
			} else {
				// No fallback available — this should not happen in normal
				// operation because ShellResolver always provides a safe
				// fallback for non-rejectable errors. For rejectable errors,
				// the caller should have handled the rejection before reaching
				// this point. We construct a minimal safe fallback here.
				primaryShell = this.getEmergencyFallbackShell()
				warnings.push(
					`Shell resolution failed (${result.error.code}): ${result.error.message}. Using emergency fallback.`,
				)
			}
		}

		// Create the primary invocation plan.
		// Provider selection mirrors the legacy getTerminalProviderForExecution
		// logic: use "vscode" for the integrated terminal when the shell family
		// is not cmd.exe (which requires execa for reliable fallback).
		const primaryProvider = primaryShell.family === "cmd" ? "execa" : "vscode"
		const primaryPlan = ShellInvocationAdapter.createPlan(
			primaryShell,
			"", // Command is filled at execution time by ExecaTerminalProcess.
			cwd,
			primaryProvider,
		)

		// Create same-family fallback plan (provider="execa").
		const fallbackPlan = ShellInvocationAdapter.createPlan(primaryShell, "", cwd, "execa")

		// Compute chain operator from family.
		const chainOperator = CommandEnvironmentService.getChainOperator(primaryShell.family)

		// Compute prompt descriptor.
		const promptDescriptor = CommandEnvironmentService.buildPromptDescriptor(primaryShell, primaryPlan.provider)

		return {
			version: this.version,
			primaryPlan,
			fallbackPlan,
			chainOperator,
			promptDescriptor,
			warnings,
		}
	}

	/**
	 * Returns the command chaining operator for the given shell family.
	 * PowerShell uses `;` for compatibility with both PS 5.1 and PS 7.
	 * All other families use `&&`.
	 */
	private static getChainOperator(family: ShellFamily): ";" | "&&" {
		return family === "powershell" ? ";" : "&&"
	}

	/**
	 * Builds the user-facing prompt descriptor from the resolved shell.
	 */
	private static buildPromptDescriptor(
		shell: ResolvedShell,
		provider: "execa" | "vscode",
	): ResolvedCommandEnvironment["promptDescriptor"] {
		const providerLabel = provider === "execa" ? "Inline Terminal" : "VS Code Integrated Terminal"
		const shellFamilyLabel = CommandEnvironmentService.getFamilyLabel(shell.family)
		const shellExecutableName = CommandEnvironmentService.getExecutableName(shell.executable)
		const sourceLabel = CommandEnvironmentService.getSourceLabel(shell.source)

		return {
			providerLabel,
			shellFamilyLabel,
			shellExecutableName,
			sourceLabel,
			isNonInteractive: true,
			supportsFishSyntax: shell.family === "fish",
			supportsPosixSyntax: shell.family === "posix" || shell.family === "wsl",
		}
	}

	/**
	 * Returns a human-readable label for the shell family.
	 */
	private static getFamilyLabel(family: ShellFamily): string {
		switch (family) {
			case "powershell":
				return "PowerShell"
			case "cmd":
				return "Command Prompt"
			case "posix":
				return "POSIX Shell"
			case "fish":
				return "Fish"
			case "wsl":
				return "WSL"
			default:
				return "Unknown"
		}
	}

	/**
	 * Extracts the executable basename from a path.
	 * e.g. "C:\\Program Files\\PowerShell\\7\\pwsh.exe" → "pwsh.exe"
	 */
	private static getExecutableName(executable: string): string {
		// Handle both Windows and POSIX path separators.
		const parts = executable.split(/[\\/]/)
		return parts[parts.length - 1] || executable
	}

	/**
	 * Returns a human-readable label for the resolution source.
	 */
	private static getSourceLabel(source: ResolvedShell["source"]): string {
		switch (source) {
			case "userOverride":
				return "User Override"
			case "cliOverride":
				return "CLI Override"
			case "legacyOverride":
				return "Legacy Setting"
			case "zooProfile":
				return "Zoo Code Profile"
			case "vscodeDefaultProfile":
				return "VS Code Default Profile"
			case "osDefault":
				return "OS Default"
			case "safeFallback":
				return "Safe Fallback"
			default:
				return "Unknown"
		}
	}

	/**
	 * Constructs an emergency fallback shell when resolution fails without
	 * a fallback. This uses the platform's safe default.
	 */
	private getEmergencyFallbackShell(): ResolvedShell {
		const platform = process.platform
		const isWindows = platform === "win32"

		return {
			executable: isWindows ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh",
			family: isWindows ? "cmd" : "posix",
			displayName: isWindows ? "Command Prompt" : "sh",
			source: "safeFallback",
			trustEvidence: "allowlist",
		}
	}
}
