/**
 * Unified inline-terminal shell resolution contracts.
 *
 * These types are the single source of truth for shell family classification,
 * trust validation, profile resolution, and priority-based shell resolution.
 * See ARCH-TERMINAL-001 in
 * docs/260720_23_session_inline-terminal-shell-fix/211516_architect-report.md.
 *
 * Sub-task 2 scope: types, profile resolver, shell resolver, and shell.ts
 * helpers. No Execa wiring or prompt changes here.
 */

/**
 * Shell family controls command chaining, invocation arguments, and display
 * text. Every resolved shell must map to exactly one family.
 *
 * - `powershell`: PowerShell 7 (pwsh) or Windows PowerShell 5.1
 * - `cmd`: Windows Command Prompt (cmd.exe)
 * - `posix`: Bourne-compatible shells (bash, zsh, sh, dash, ksh, etc.)
 * - `fish`: Fish shell
 * - `wsl`: Windows Subsystem for Linux host adapter
 */
export type ShellFamily = "powershell" | "cmd" | "posix" | "fish" | "wsl"

/**
 * The resolution source that produced a {@link ResolvedShell}. Used for
 * diagnostics, prompt text, and settings UI display.
 */
export type ShellResolutionSource =
	| "userOverride"
	| "cliOverride"
	| "legacyOverride"
	| "zooProfile"
	| "vscodeDefaultProfile"
	| "osDefault"
	| "safeFallback"

/**
 * Canonical resolved shell descriptor. Contains everything downstream code
 * needs to execute, display, and classify the shell without re-reading
 * settings or filesystem state.
 */
export interface ResolvedShell {
	/** Canonical executable path (or bare command for WSL host adapter). */
	executable: string
	/** Shell family for invocation and syntax decisions. */
	family: ShellFamily
	/** User-facing display name (e.g. "PowerShell 7", "Git Bash"). */
	displayName: string
	/** Where this shell came from in the resolution priority chain. */
	source: ShellResolutionSource
	/** Sanitized environment overrides from the profile, if any. */
	env?: Record<string, string | null>
	/** Profile name when resolved from a VS Code or Zoo Code terminal profile. */
	profileName?: string
	/** WSL distribution name when family is `wsl`. */
	distroName?: string
	/**
	 * Trust evidence class:
	 * - `allowlist`: canonical path is in the static SHELL_ALLOWLIST
	 * - `trustedProfile`: path from VS Code default/global profile scope
	 * - `userGrant`: explicit absolute path selected through extension host
	 */
	trustEvidence: "allowlist" | "trustedProfile" | "userGrant"
}

/**
 * Concrete process invocation plan for a resolved shell. The command is
 * always the last element of `args`; it is never concatenated into a host
 * shell command string.
 */
export interface ShellInvocationPlan {
	/** Executable to launch. */
	executable: string
	/** Controlled arguments, with the command as the last element. */
	args: string[]
	/** Shell family for syntax decisions. */
	family: ShellFamily
	/** Working directory for the process. */
	cwd?: string
	/** Environment overrides (null values unset variables). */
	env?: Record<string, string | null>
	/** Execution provider: `execa` for inline, `vscode` for integrated terminal. */
	provider: "execa" | "vscode"
}

/**
 * Request-scoped command environment snapshot. One of these feeds the system
 * prompt, native tool description, command rules, and runtime execution for
 * a single API request.
 */
export interface ResolvedCommandEnvironment {
	/** Version counter; increments on settings change to detect stale snapshots. */
	version: number
	/** Primary execution plan (integrated terminal or inline adapter). */
	primaryPlan: ShellInvocationPlan
	/** Same-family execa fallback plan, if available. */
	fallbackPlan?: ShellInvocationPlan
	/** Command chaining operator for this shell family. */
	chainOperator: ";" | "&&"
	/** User-facing descriptor for prompt and UI rendering. */
	promptDescriptor: {
		/** "Inline Terminal" or "VS Code Integrated Terminal". */
		providerLabel: string
		/** "PowerShell", "Command Prompt", "Git Bash", etc. */
		shellFamilyLabel: string
		/** "pwsh.exe", "powershell.exe", "bash", etc. */
		shellExecutableName: string
		/** "User Override", "VS Code Default Profile", etc. */
		sourceLabel: string
		/** Whether inline execution is non-interactive. */
		isNonInteractive: boolean
		/** Whether the shell supports fish-specific syntax. */
		supportsFishSyntax: boolean
		/** Whether the shell supports POSIX-specific syntax. */
		supportsPosixSyntax: boolean
	}
	/** Nonfatal resolution warnings (e.g. invalid auto candidate skipped). */
	warnings: string[]
}

/**
 * Machine-readable error codes for shell resolution failures.
 * Never include command contents in error messages.
 */
export type ShellResolutionErrorCode =
	| "SHELL_OVERRIDE_INVALID"
	| "SHELL_PROFILE_NOT_FOUND"
	| "SHELL_PATH_NOT_ALLOWED"
	| "SHELL_EXECUTABLE_NOT_FOUND"
	| "SHELL_FAMILY_UNSUPPORTED"
	| "SHELL_WSL_UNAVAILABLE"
	| "SHELL_FALLBACK_MISMATCH"

/**
 * Structured shell resolution error. The message is user-facing and must
 * never contain command contents, stack traces, or internal filesystem paths
 * beyond what is necessary for the user to understand the failure.
 */
export interface ShellResolutionError {
	/** Machine-readable error code. */
	code: ShellResolutionErrorCode
	/** User-facing error message (no command contents). */
	message: string
}

/**
 * Tagged result type for shell resolution. On failure, `fallback` may contain
 * a safe fallback shell, and `rejectable` indicates whether a settings update
 * should be rejected (explicit invalid override) vs. silently skipped (auto
 * candidate fallthrough).
 */
export type ShellResolutionResult =
	| { ok: true; shell: ResolvedShell }
	| { ok: false; error: ShellResolutionError; fallback?: ResolvedShell; rejectable: boolean }
