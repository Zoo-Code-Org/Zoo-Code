/**
 * ShellResolver — deterministic shell resolution service.
 *
 * Resolves the effective shell using a strict priority chain (see
 * ARCH-TERMINAL-001 section 1.6):
 *
 * 1. CLI override (`cliOverride`)
 * 2. User path override from `terminalShellSelection` (`userOverride`)
 * 3. User profile override from `terminalShellSelection` (`userOverride`)
 * 4. Legacy `execaShellPath` (`legacyOverride`)
 * 5. Zoo Code `terminalProfile` (`zooProfile`)
 * 6. VS Code default profile (`vscodeDefaultProfile`)
 * 7. OS default (`osDefault`)
 * 8. Safe platform fallback (`safeFallback`)
 *
 * Invariants:
 * - Pure service: no static mutation, no webview reads.
 * - Returns {@link ShellResolutionResult} with typed errors.
 * - Explicit invalid override returns a rejectable typed error.
 * - Invalid auto candidate falls through to the next step.
 * - Windows comparison is case-insensitive; Unix is case-sensitive.
 * - WSL resolves to `wsl.exe` + guest metadata, NOT `/bin/bash`.
 */

import { existsSync } from "fs"
import { userInfo } from "os"
import * as path from "path"

import type { TerminalShellSelection } from "@roo-code/types"

import { classifyShellFamily, isShellPathAllowed } from "../../../utils/shell"
import type { TerminalProfileResolver } from "./TerminalProfileResolver"
import type {
	ResolvedShell,
	ShellFamily,
	ShellResolutionError,
	ShellResolutionResult,
	ShellResolutionSource,
} from "./types"

// -----------------------------------------------------
// Dependency interfaces (injectable for testing)
// -----------------------------------------------------

/** Filesystem probe for existence checks. */
export interface FileSystemProbe {
	existsSync(path: string): boolean
}

/** OS user info probe. */
export interface UserInfoProbe {
	/** Returns the user's login shell, or null if unavailable. */
	getShell(): string | null
}

/** Environment variable probe. */
export interface EnvProbe {
	/** Returns the platform-specific default shell from environment. */
	getShellFromEnv(platform: NodeJS.Platform): string | null
}

/** Settings input for the resolver. */
export interface ShellResolverSettings {
	/** New unified terminal shell selection (absent = auto). */
	terminalShellSelection?: TerminalShellSelection
	/** @deprecated Legacy execa shell path. Used as legacyOverride when new setting is absent. */
	execaShellPath?: string
	/** Zoo Code terminal profile name (for integrated terminal). */
	terminalProfile?: string
}

// -----------------------------------------------------
// Default dependency implementations
// -----------------------------------------------------

class NodeFileSystemProbe implements FileSystemProbe {
	existsSync(filePath: string): boolean {
		return existsSync(filePath)
	}
}

class NodeUserInfoProbe implements UserInfoProbe {
	getShell(): string | null {
		try {
			const { shell } = userInfo()
			return shell || null
		} catch (e) {
			console.warn("[ShellResolver] userInfo() probe failed:", e instanceof Error ? e.message : e)
			return null
		}
	}
}

class NodeEnvProbe implements EnvProbe {
	getShellFromEnv(platform: NodeJS.Platform): string | null {
		const { env } = process

		if (platform === "win32") {
			return env.COMSPEC || "C:\\Windows\\System32\\cmd.exe"
		}
		if (platform === "darwin") {
			return env.SHELL || "/bin/zsh"
		}
		if (platform === "linux") {
			return env.SHELL || "/bin/bash"
		}
		return null
	}
}

// -----------------------------------------------------
// Constants
// -----------------------------------------------------

/** Safe fallback shell paths per platform. */
const SAFE_FALLBACK_SHELLS: Record<string, string> = {
	win32: "C:\\Windows\\System32\\cmd.exe",
	darwin: "/bin/zsh",
	linux: "/bin/bash",
}

/** Known Windows PowerShell paths for OS default detection. */
const POWERSHELL_7_PATH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
const POWERSHELL_LEGACY_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

/** WSL host adapter path. */
const WSL_EXE_PATH = "C:\\Windows\\System32\\wsl.exe"

/**
 * Maps bare Windows shell executable names to their canonical full paths.
 * This handles the case where a UI dropdown or CLI sends "cmd.exe" instead
 * of the full "C:\Windows\System32\cmd.exe" path.
 *
 * Only well-known Windows system shells are mapped here — arbitrary bare
 * names are NOT resolved via PATH lookup for security reasons.
 */
const BARE_SHELL_NAME_MAP: Record<string, string> = {
	"cmd.exe": "C:\\Windows\\System32\\cmd.exe",
	cmd: "C:\\Windows\\System32\\cmd.exe",
	"powershell.exe": POWERSHELL_LEGACY_PATH,
	powershell: POWERSHELL_LEGACY_PATH,
	"pwsh.exe": POWERSHELL_7_PATH,
	pwsh: POWERSHELL_7_PATH,
	"wsl.exe": WSL_EXE_PATH,
	wsl: WSL_EXE_PATH,
}

/**
 * Normalizes a bare shell name to its canonical full path on Windows.
 * If the input is already an absolute path or not a known bare name,
 * it is returned unchanged.
 *
 * @param shellPath The shell path or bare name to normalize.
 * @returns The canonical full path if the bare name is recognized, otherwise the original input.
 */
function normalizeBareShellName(shellPath: string): string {
	if (!shellPath) return shellPath

	// If the path is already absolute, no normalization needed.
	if (path.isAbsolute(shellPath)) {
		return shellPath
	}

	// Check if the bare name (case-insensitive on Windows) maps to a known shell.
	const lowerPath = shellPath.toLowerCase()
	if (BARE_SHELL_NAME_MAP[lowerPath]) {
		return BARE_SHELL_NAME_MAP[lowerPath]
	}

	return shellPath
}

// -----------------------------------------------------
// ShellResolver
// -----------------------------------------------------

/**
 * Deterministic shell resolution service.
 *
 * Construct with {@link forRuntime} for production use, or inject test
 * doubles for unit testing. The resolver holds no mutable state.
 */
export class ShellResolver {
	constructor(
		private readonly platform: NodeJS.Platform,
		private readonly env: NodeJS.ProcessEnv,
		private readonly fs: FileSystemProbe,
		private readonly userInfo: UserInfoProbe,
		private readonly envProbe: EnvProbe,
		private readonly profileResolver: TerminalProfileResolver,
	) {}

	/**
	 * Creates a resolver wired with default Node.js dependencies and the
	 * given profile resolver.
	 */
	static forRuntime(profileResolver: TerminalProfileResolver): ShellResolver {
		return new ShellResolver(
			process.platform,
			process.env,
			new NodeFileSystemProbe(),
			new NodeUserInfoProbe(),
			new NodeEnvProbe(),
			profileResolver,
		)
	}

	// -------------------------------------------------
	// Public API
	// -------------------------------------------------

	/**
	 * Resolves the effective shell using the full priority chain.
	 *
	 * @param settings Current shell-related settings.
	 * @param cliOverride Optional CLI `--terminal-shell` override (highest priority).
	 * @returns {@link ShellResolutionResult} — success with shell, or failure
	 *   with typed error, optional fallback, and `rejectable` flag.
	 */
	resolve(settings: ShellResolverSettings, cliOverride?: string): ShellResolutionResult {
		// 1. CLI override (highest priority, ephemeral).
		if (cliOverride) {
			const result = this.tryResolveExplicitPath(cliOverride, "cliOverride")
			if (result.ok) {
				return result
			}
			// CLI override failure is rejectable — the user explicitly asked for it.
			// Rejectable errors do not include a fallback.
			return { ok: false, error: result.error, rejectable: true }
		}

		// 2. User path override from terminalShellSelection.
		if (settings.terminalShellSelection?.kind === "path") {
			const result = this.tryResolveExplicitPath(settings.terminalShellSelection.path, "userOverride")
			if (result.ok) {
				return result
			}
			// Explicit user override failure is rejectable.
			return { ok: false, error: result.error, rejectable: true }
		}

		// 3. User profile override from terminalShellSelection.
		if (settings.terminalShellSelection?.kind === "profile") {
			const result = this.tryResolveProfile(settings.terminalShellSelection.profileName, "userOverride")
			if (result.ok) {
				return result
			}
			// Explicit user profile failure is rejectable.
			return { ok: false, error: result.error, rejectable: true }
		}

		// 4. Legacy execaShellPath (when new setting is absent).
		if (!settings.terminalShellSelection && settings.execaShellPath) {
			const result = this.tryResolveExplicitPath(settings.execaShellPath, "legacyOverride")
			if (result.ok) {
				return result
			}
			// Legacy override failure is rejectable (user explicitly set it).
			return { ok: false, error: result.error, rejectable: true }
		}

		// 5. Zoo Code terminalProfile.
		if (settings.terminalProfile) {
			const result = this.tryResolveProfile(settings.terminalProfile, "zooProfile")
			if (result.ok) {
				return result
			}
			// Auto candidate — invalid profile falls through, not rejectable.
		}

		// 6. VS Code default profile.
		{
			const result = this.tryResolveDefaultProfile("vscodeDefaultProfile")
			if (result.ok) {
				return result
			}
		}

		// 7. OS default.
		{
			const result = this.tryResolveOsDefault("osDefault")
			if (result.ok) {
				return result
			}
		}

		// 8. Safe platform fallback.
		return this.resolveSafeFallback()
	}

	/**
	 * Convenience method for backward compatibility with getShell().
	 * Returns the executable path string, or the safe fallback.
	 */
	resolveExecutable(settings: ShellResolverSettings, cliOverride?: string): string {
		const result = this.resolve(settings, cliOverride)
		if (result.ok) {
			return result.shell.executable
		}
		// On failure, use the fallback if available, otherwise safe fallback.
		if (result.fallback) {
			return result.fallback.executable
		}
		return this.getSafeFallbackShell()
	}

	// -------------------------------------------------
	// Resolution steps
	// -------------------------------------------------

	/**
	 * Tries to resolve an explicit executable path. Validates:
	 * - Path is allowed (allowlist or user grant)
	 * - Path exists on disk
	 * - Path maps to a supported shell family
	 */
	private tryResolveExplicitPath(shellPath: string, source: ShellResolutionSource): ShellResolutionResult {
		if (!shellPath || typeof shellPath !== "string") {
			return this.fail("SHELL_OVERRIDE_INVALID", "Shell path is empty or invalid.", false)
		}

		// Normalize bare shell names (e.g. "cmd.exe") to their canonical full
		// paths before validation. This handles UI dropdowns and CLI inputs
		// that send bare names instead of full paths. Only well-known Windows
		// system shells are mapped — arbitrary names are NOT resolved via
		// PATH lookup for security reasons.
		const resolvedShellPath = normalizeBareShellName(shellPath)

		const normalizedPath = path.normalize(resolvedShellPath)

		// Check if the path is allowed (allowlist or user grant).
		// Pass the resolved shellPath (after bare-name normalization), not
		// the platform-normalized version, because isShellPathAllowed tries
		// both path.normalize and path.posix.normalize internally for
		// cross-platform compatibility.
		if (!isShellPathAllowed(resolvedShellPath)) {
			return this.fail(
				"SHELL_PATH_NOT_ALLOWED",
				`The selected shell path is not in the trusted allowlist: ${path.basename(normalizedPath)}`,
				false,
			)
		}

		// Check if the executable exists. Try both the normalized path and
		// the resolved path for cross-platform compatibility.
		if (!this.fs.existsSync(normalizedPath) && !this.fs.existsSync(resolvedShellPath)) {
			return this.fail(
				"SHELL_EXECUTABLE_NOT_FOUND",
				`Shell executable not found: ${path.basename(normalizedPath)}`,
				false,
			)
		}

		// Classify the shell family. Use the resolved path for classification
		// because path.normalize on Windows mangles Unix-style paths.
		const family = classifyShellFamily(resolvedShellPath)
		if (!family) {
			return this.fail(
				"SHELL_FAMILY_UNSUPPORTED",
				`Unsupported shell family for: ${path.basename(normalizedPath)}`,
				false,
			)
		}

		return {
			ok: true,
			shell: {
				executable: resolvedShellPath,
				family,
				displayName: this.deriveDisplayName(family, resolvedShellPath),
				source,
				trustEvidence: source === "cliOverride" || source === "userOverride" ? "userGrant" : "allowlist",
			},
		}
	}

	/**
	 * Tries to resolve a named VS Code terminal profile.
	 */
	private tryResolveProfile(profileName: string, source: ShellResolutionSource): ShellResolutionResult {
		const resolved = this.profileResolver.resolveProfile(profileName, source)

		if (!resolved) {
			return this.fail(
				"SHELL_PROFILE_NOT_FOUND",
				`Terminal profile "${profileName}" not found or could not be resolved.`,
				false,
			)
		}

		return { ok: true, shell: resolved.shell }
	}

	/**
	 * Tries to resolve the VS Code default terminal profile.
	 */
	private tryResolveDefaultProfile(source: ShellResolutionSource): ShellResolutionResult {
		const shell = this.profileResolver.resolveDefaultProfile(source)

		if (!shell) {
			return this.fail("SHELL_PROFILE_NOT_FOUND", "No VS Code default terminal profile configured.", false)
		}

		return { ok: true, shell }
	}

	/**
	 * Tries to resolve the OS default shell.
	 * On Windows: PowerShell 7 if installed, else Windows PowerShell 5.1.
	 * On Unix: userInfo().shell, then env SHELL.
	 */
	private tryResolveOsDefault(source: ShellResolutionSource): ShellResolutionResult {
		// Windows: prefer PowerShell 7, then legacy PowerShell.
		if (this.platform === "win32") {
			const ps7 = POWERSHELL_7_PATH
			if (this.fs.existsSync(ps7) && isShellPathAllowed(ps7)) {
				return {
					ok: true,
					shell: {
						executable: ps7,
						family: "powershell",
						displayName: "PowerShell 7",
						source,
						trustEvidence: "allowlist",
					},
				}
			}

			const psLegacy = POWERSHELL_LEGACY_PATH
			if (this.fs.existsSync(psLegacy) && isShellPathAllowed(psLegacy)) {
				return {
					ok: true,
					shell: {
						executable: psLegacy,
						family: "powershell",
						displayName: "Windows PowerShell 5.1",
						source,
						trustEvidence: "allowlist",
					},
				}
			}

			return this.fail(
				"SHELL_EXECUTABLE_NOT_FOUND",
				"No PowerShell executable found on this Windows system.",
				false,
			)
		}

		// Unix: try userInfo().shell first.
		const userShell = this.userInfo.getShell()
		if (userShell && this.fs.existsSync(userShell) && isShellPathAllowed(userShell)) {
			const family = classifyShellFamily(userShell)
			if (family) {
				return {
					ok: true,
					shell: {
						executable: userShell,
						family,
						displayName: this.deriveDisplayName(family, userShell),
						source,
						trustEvidence: "allowlist",
					},
				}
			}
		}

		// Unix: try env SHELL / COMSPEC.
		const envShell = this.envProbe.getShellFromEnv(this.platform)
		if (envShell && this.fs.existsSync(envShell) && isShellPathAllowed(envShell)) {
			const family = classifyShellFamily(envShell)
			if (family) {
				return {
					ok: true,
					shell: {
						executable: envShell,
						family,
						displayName: this.deriveDisplayName(family, envShell),
						source,
						trustEvidence: "allowlist",
					},
				}
			}
		}

		return this.fail("SHELL_EXECUTABLE_NOT_FOUND", "No OS default shell found.", false)
	}

	/**
	 * Returns the safe platform fallback shell. This is the last resort
	 * and always succeeds (the fallback path is always allowlisted).
	 */
	private resolveSafeFallback(): ShellResolutionResult {
		const fallbackPath = this.getSafeFallbackShell()
		const family = classifyShellFamily(fallbackPath) ?? "posix"

		return {
			ok: true,
			shell: {
				executable: fallbackPath,
				family,
				displayName: this.deriveDisplayName(family, fallbackPath),
				source: "safeFallback",
				trustEvidence: "allowlist",
			},
		}
	}

	// -------------------------------------------------
	// Helpers
	// -------------------------------------------------

	/** Returns the safe fallback shell path for the current platform. */
	private getSafeFallbackShell(): string {
		return SAFE_FALLBACK_SHELLS[this.platform] ?? SAFE_FALLBACK_SHELLS.linux
	}

	/** Derives a user-facing display name from the shell family and executable. */
	private deriveDisplayName(family: ShellFamily, executable: string): string {
		switch (family) {
			case "powershell":
				return /pwsh/i.test(executable) ? "PowerShell 7" : "Windows PowerShell 5.1"
			case "cmd":
				return "Command Prompt"
			case "wsl":
				return "WSL"
			case "fish":
				return "Fish"
			case "posix":
				return path.basename(executable)
		}
	}

	/** Creates a failure result with an optional fallback shell. */
	private fail(code: ShellResolutionError["code"], message: string, rejectable: boolean): ShellResolutionResult {
		// Provide a safe fallback shell for non-rejectable failures.
		const fallback: ResolvedShell | undefined = rejectable
			? undefined
			: {
					executable: this.getSafeFallbackShell(),
					family: classifyShellFamily(this.getSafeFallbackShell()) ?? "posix",
					displayName: "Safe Fallback",
					source: "safeFallback",
					trustEvidence: "allowlist",
				}

		return {
			ok: false,
			error: { code, message },
			fallback,
			rejectable,
		}
	}
}
