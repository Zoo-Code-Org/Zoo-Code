/**
 * TerminalProfileResolver — resolves VS Code terminal profiles into
 * {@link ResolvedShell} objects using trusted settings scopes only.
 *
 * Security invariants:
 * - Reads only default and global VS Code profile scopes (NOT workspace).
 * - Classifies resolved paths into {@link ShellFamily} using helpers from
 *   shell.ts.
 * - Handles source-only profiles (PowerShell source, WSL source).
 * - Sanitizes profile env variables (blocks dangerous keys).
 *
 * See ARCH-TERMINAL-001 section 1.7 (Trust and allowlist policy).
 */

import { existsSync } from "fs"
import * as path from "path"
import * as vscode from "vscode"

import { classifyShellFamily } from "../../../utils/shell"
import type { ResolvedShell, ShellFamily, ShellResolutionSource } from "./types"

// -----------------------------------------------------
// Dependency interfaces (injectable for testing)
// -----------------------------------------------------

/**
 * Reads VS Code terminal profile configuration from trusted scopes only.
 * Implementations MUST exclude workspace-scope values.
 */
export interface ProfileConfigReader {
	/** Read merged default + global profiles for the platform. */
	readProfiles(platform: NodeJS.Platform): Record<string, unknown>
	/** Read the default profile name from trusted scopes. */
	readDefaultProfileName(platform: NodeJS.Platform): string | undefined
}

/** Filesystem probe for existence checks. */
export interface FileSystemProbe {
	existsSync(path: string): boolean
}

/** Shell classification helpers. */
export interface ShellHelpers {
	classifyShellFamily(shellPath: string): ShellFamily | undefined
}

// -----------------------------------------------------
// Profile entry shape (subset of VS Code ITerminalProfile)
// -----------------------------------------------------

interface ProfileEntry {
	path?: string | string[]
	args?: string | string[]
	source?: string
	env?: Record<string, unknown>
}

/**
 * A profile resolved to a {@link ResolvedShell}, plus the raw entry for
 * callers (like Terminal.getProfileShell) that need profile args.
 */
export interface ResolvedProfile {
	shell: ResolvedShell
	/** Raw profile entry (for arg extraction by legacy callers). */
	entry: ProfileEntry
}

/** Profile available for UI option discovery. */
export interface AvailableProfile {
	name: string
	shell: ResolvedShell
}

// -----------------------------------------------------
// Constants
// -----------------------------------------------------

/**
 * Environment variable keys that are never inherited from terminal profiles.
 * These can hijack shell startup or load arbitrary libraries.
 */
const BLOCKED_ENV_KEYS = new Set([
	"ZDOTDIR",
	"PROMPT_COMMAND",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"BASH_ENV",
	"ENV",
])

/** Known Windows shell paths for source-only profile resolution. */
const POWERSHELL_7_PATH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
const POWERSHELL_LEGACY_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const WSL_EXE_PATH = "C:\\Windows\\System32\\wsl.exe"

// -----------------------------------------------------
// Default dependency implementations
// -----------------------------------------------------

/**
 * Reads VS Code terminal profile configuration using `inspect()` to access
 * only default and global scope values. Workspace-scope values are
 * intentionally excluded to prevent untrusted repository settings from
 * selecting an executable.
 */
class VsCodeProfileConfigReader implements ProfileConfigReader {
	readProfiles(platform: NodeJS.Platform): Record<string, unknown> {
		const platformKey = getPlatformProfileKey(platform)
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

	readDefaultProfileName(platform: NodeJS.Platform): string | undefined {
		const platformKey = getPlatformProfileKey(platform)
		const configuration = vscode.workspace.getConfiguration("terminal.integrated")

		if (typeof configuration.inspect !== "function") {
			return undefined
		}

		const inspected = configuration.inspect<string>(`defaultProfile.${platformKey}`)

		return inspected?.globalValue ?? inspected?.defaultValue
	}
}

/** Wraps Node.js fs.existsSync. */
class NodeFileSystemProbe implements FileSystemProbe {
	existsSync(filePath: string): boolean {
		return existsSync(filePath)
	}
}

/** Wraps classifyShellFamily from shell.ts. */
class DefaultShellHelpers implements ShellHelpers {
	classifyShellFamily(shellPath: string): ShellFamily | undefined {
		return classifyShellFamily(shellPath)
	}
}

// -----------------------------------------------------
// Helpers
// -----------------------------------------------------

/**
 * Maps a Node.js platform to the VS Code config section key.
 * Mirrors Terminal.getPlatformProfileKey without importing Terminal.
 */
function getPlatformProfileKey(platform: NodeJS.Platform): "windows" | "osx" | "linux" {
	if (platform === "win32") {
		return "windows"
	}
	if (platform === "darwin") {
		return "osx"
	}
	return "linux"
}

/**
 * Normalizes a path that can be either a string or an array of strings.
 * If it's an array, returns the first element. Otherwise returns the string.
 */
function normalizeShellPath(filePath: string | string[] | undefined): string | null {
	if (!filePath) return null
	if (Array.isArray(filePath)) {
		return filePath.length > 0 ? filePath[0] : null
	}
	return filePath
}

/**
 * Derives a user-facing display name from the shell family and optional
 * profile name.
 */
function deriveDisplayName(family: ShellFamily, executable: string, profileName?: string): string {
	switch (family) {
		case "powershell":
			return /pwsh/i.test(executable) ? "PowerShell 7" : "Windows PowerShell 5.1"
		case "cmd":
			return "Command Prompt"
		case "wsl":
			return profileName ? `WSL: ${profileName}` : "WSL"
		case "fish":
			return "Fish"
		case "posix":
			return path.basename(executable)
	}
}

// -----------------------------------------------------
// TerminalProfileResolver
// -----------------------------------------------------

/**
 * Resolves VS Code terminal profiles into {@link ResolvedShell} objects.
 *
 * This is a pure service: it holds no mutable state and reads configuration
 * through injectable dependencies. The {@link forRuntime} factory wires up
 * the default implementations that read from VS Code's configuration API.
 */
export class TerminalProfileResolver {
	constructor(
		private readonly configReader: ProfileConfigReader,
		private readonly fs: FileSystemProbe,
		private readonly helpers: ShellHelpers,
		private readonly platform: NodeJS.Platform,
		private readonly env: NodeJS.ProcessEnv,
	) {}

	/**
	 * Creates a resolver wired with default dependencies that read from
	 * VS Code's configuration API and Node.js filesystem.
	 */
	static forRuntime(
		platform: NodeJS.Platform = process.platform,
		env: NodeJS.ProcessEnv = process.env,
	): TerminalProfileResolver {
		return new TerminalProfileResolver(
			new VsCodeProfileConfigReader(),
			new NodeFileSystemProbe(),
			new DefaultShellHelpers(),
			platform,
			env,
		)
	}

	// -------------------------------------------------
	// Raw config access (for Terminal.ts delegation)
	// -------------------------------------------------

	/**
	 * Reads merged default + global profiles for the current platform.
	 * Workspace-scope profiles are excluded for security.
	 */
	readProfiles(): Record<string, unknown> {
		return this.configReader.readProfiles(this.platform)
	}

	/**
	 * Reads the default profile name from trusted scopes only.
	 */
	readDefaultProfileName(): string | undefined {
		return this.configReader.readDefaultProfileName(this.platform)
	}

	// -------------------------------------------------
	// Path resolution (for Terminal.ts delegation)
	// -------------------------------------------------

	/**
	 * Resolves a profile path to an executable on disk. VS Code's built-in
	 * Unix profiles commonly use bare command names such as `bash`, so
	 * check PATH in addition to explicit filesystem paths.
	 *
	 * Mirrors Terminal.resolveProfilePath logic.
	 */
	resolveProfilePath(profilePath: unknown): string | undefined {
		const candidates = Array.isArray(profilePath) ? profilePath : [profilePath]
		const pathValue = this.env.PATH ?? this.env.Path ?? this.env.path
		const pathEntries = pathValue?.split(this.platform === "win32" ? ";" : ":") ?? []
		const platformJoin = this.platform === "win32" ? path.win32.join : path.posix.join

		for (const value of candidates) {
			if (typeof value !== "string") {
				continue
			}

			const candidate = value.trim()

			if (!candidate) {
				continue
			}

			if (/[\\/]/.test(candidate)) {
				if (this.fs.existsSync(candidate)) {
					return candidate
				}
				continue
			}

			const extensions =
				this.platform === "win32" && path.extname(candidate) === ""
					? (this.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
					: [""]

			for (const entry of pathEntries) {
				const directory = entry.replace(/^"(.*)"$/, "$1")

				for (const extension of extensions) {
					const resolved = platformJoin(directory, `${candidate}${extension}`)

					if (this.fs.existsSync(resolved)) {
						return resolved
					}
				}
			}
		}

		return undefined
	}

	// -------------------------------------------------
	// Profile resolution
	// -------------------------------------------------

	/**
	 * Resolves the VS Code default profile into a {@link ResolvedShell}.
	 * Returns undefined when no default profile is configured or the
	 * profile cannot be resolved to a trusted executable.
	 */
	resolveDefaultProfile(source: ShellResolutionSource = "vscodeDefaultProfile"): ResolvedShell | undefined {
		const defaultName = this.readDefaultProfileName()
		if (!defaultName) {
			return undefined
		}
		return this.resolveProfile(defaultName, source)?.shell
	}

	/**
	 * Resolves a named profile into a {@link ResolvedProfile} (shell + raw
	 * entry). Returns undefined when the profile is not found or cannot be
	 * resolved to a trusted executable mapping to a supported shell family.
	 *
	 * @param profileName The VS Code terminal profile name.
	 * @param source The resolution source label (set by caller).
	 */
	resolveProfile(profileName: string, source: ShellResolutionSource): ResolvedProfile | undefined {
		const profiles = this.readProfiles()
		const entry = profiles?.[profileName] as ProfileEntry | null | undefined

		if (!entry) {
			// Fallback for well-known VS Code built-in profiles that may not
			// appear in the trusted config scopes but are still valid shells.
			// VS Code provides built-in profiles like "PowerShell" and "WSL"
			// via the `source` mechanism, but these may not be present in
			// terminal.integrated.profiles.<platform> configuration.
			// We synthesize a minimal entry and attempt resolution so the
			// user's selection doesn't silently revert to Auto.
			const fallbackShell = this.resolveWellKnownProfileName(profileName, source)
			if (fallbackShell) {
				return { shell: fallbackShell, entry: {} }
			}

			console.warn(
				`[TerminalProfileResolver] Configured terminal profile "${profileName}" not found for ${this.platform}.`,
			)
			return undefined
		}

		const shell = this.resolveProfileEntry(profileName, entry, source)
		if (!shell) {
			return undefined
		}

		return { shell, entry }
	}

	/**
	 * Resolves well-known profile names (PowerShell, WSL) when the profile
	 * entry is not found in the trusted VS Code config. This handles VS Code
	 * built-in profiles that are available at runtime but may not appear in
	 * terminal.integrated.profiles.<platform> configuration.
	 *
	 * Only well-known shell families are resolved here — arbitrary profile
	 * names are NOT mapped to executables for security reasons.
	 */
	private resolveWellKnownProfileName(profileName: string, source: ShellResolutionSource): ResolvedShell | undefined {
		if (this.platform !== "win32") {
			return undefined
		}

		const nameLower = profileName.toLowerCase()

		// Profile name includes "powershell" -> resolve to PS7 or PS5.1.
		if (nameLower.includes("powershell")) {
			const executable = this.fs.existsSync(POWERSHELL_7_PATH) ? POWERSHELL_7_PATH : POWERSHELL_LEGACY_PATH

			return {
				executable,
				family: "powershell",
				displayName: deriveDisplayName("powershell", executable, profileName),
				source,
				profileName,
				trustEvidence: "trustedProfile",
			}
		}

		// Profile name includes "wsl" -> resolve to wsl.exe host adapter.
		if (nameLower.includes("wsl")) {
			return {
				executable: WSL_EXE_PATH,
				family: "wsl",
				displayName: deriveDisplayName("wsl", WSL_EXE_PATH, profileName),
				source,
				profileName,
				trustEvidence: "trustedProfile",
			}
		}

		return undefined
	}

	/**
	 * Resolves a raw profile entry into a {@link ResolvedShell}. Handles
	 * source-only profiles (PowerShell, WSL) and explicit path profiles.
	 */
	private resolveProfileEntry(
		profileName: string,
		entry: ProfileEntry,
		source: ShellResolutionSource,
	): ResolvedShell | undefined {
		// 1. Try explicit path resolution first.
		const pathValue = this.resolveProfilePath(entry.path)

		if (pathValue) {
			const family = this.helpers.classifyShellFamily(pathValue)
			if (!family) {
				// Unsupported shell family — skip this profile.
				console.warn(
					`[TerminalProfileResolver] Profile "${profileName}" resolves to unsupported shell family: ${pathValue}`,
				)
				return undefined
			}

			return {
				executable: pathValue,
				family,
				displayName: deriveDisplayName(family, pathValue, profileName),
				source,
				env: this.sanitizeEnv(entry.env),
				profileName,
				trustEvidence: "trustedProfile",
			}
		}

		// 2. Handle source-only profiles (no resolvable path).
		if (entry.source) {
			return this.resolveSourceProfile(profileName, entry, source)
		}

		// 3. Windows-specific name-based detection (mirrors existing
		// getWindowsShellFromVSCode behavior). When a profile has no path
		// and no source, but the profile name suggests a shell family,
		// resolve it to the known executable.
		if (this.platform === "win32") {
			const nameLower = profileName.toLowerCase()

			// Profile name includes "powershell" -> resolve to PS7 or PS5.1.
			if (nameLower.includes("powershell")) {
				const executable = this.fs.existsSync(POWERSHELL_7_PATH) ? POWERSHELL_7_PATH : POWERSHELL_LEGACY_PATH

				return {
					executable,
					family: "powershell",
					displayName: deriveDisplayName("powershell", executable, profileName),
					source,
					env: this.sanitizeEnv(entry.env),
					profileName,
					trustEvidence: "trustedProfile",
				}
			}

			// Profile name includes "wsl" -> resolve to wsl.exe host adapter.
			if (nameLower.includes("wsl")) {
				return {
					executable: WSL_EXE_PATH,
					family: "wsl",
					displayName: deriveDisplayName("wsl", WSL_EXE_PATH, profileName),
					source,
					env: this.sanitizeEnv(entry.env),
					profileName,
					trustEvidence: "trustedProfile",
				}
			}
		}

		// 4. Profiles with no path, no source, and no name-based detection
		// cannot be resolved.
		console.warn(
			`[TerminalProfileResolver] Terminal profile "${profileName}" has no resolvable "path" or "source".`,
		)
		return undefined
	}

	/**
	 * Resolves source-only profiles. VS Code supports `source: "PowerShell"`
	 * and `source: "WSL"` which don't have an explicit path but are
	 * well-known shells.
	 */
	private resolveSourceProfile(
		profileName: string,
		entry: ProfileEntry,
		source: ShellResolutionSource,
	): ResolvedShell | undefined {
		const sourceLower = entry.source!.toLowerCase()

		// PowerShell source: only resolve on Windows. On Unix, PowerShell
		// source profiles are VS Code built-ins that an extension cannot
		// map to a shell binary without platform-specific detection.
		if (sourceLower.includes("powershell") && this.platform === "win32") {
			const executable = this.fs.existsSync(POWERSHELL_7_PATH) ? POWERSHELL_7_PATH : POWERSHELL_LEGACY_PATH

			return {
				executable,
				family: "powershell",
				displayName: deriveDisplayName("powershell", executable, profileName),
				source,
				env: this.sanitizeEnv(entry.env),
				profileName,
				trustEvidence: "trustedProfile",
			}
		}

		// WSL source: only resolve on Windows. WSL is a Windows-only feature.
		if (sourceLower.includes("wsl") && this.platform === "win32") {
			// Extract distro name if the profile declares one.
			const distroName =
				entry.env && typeof entry.env === "object"
					? (entry.env as Record<string, unknown>)["WSL_DISTRO_NAME"]
					: undefined

			return {
				executable: WSL_EXE_PATH,
				family: "wsl",
				displayName: deriveDisplayName("wsl", WSL_EXE_PATH, profileName),
				source,
				env: this.sanitizeEnv(entry.env),
				profileName,
				distroName: typeof distroName === "string" ? distroName : undefined,
				trustEvidence: "trustedProfile",
			}
		}

		console.warn(`[TerminalProfileResolver] Unknown profile source "${entry.source}" for profile "${profileName}".`)
		return undefined
	}

	/**
	 * Sanitizes profile env variables. Blocks dangerous keys that can
	 * hijack shell startup or load arbitrary libraries. Only string and
	 * null values are preserved.
	 */
	private sanitizeEnv(profileEnv: Record<string, unknown> | undefined): Record<string, string | null> | undefined {
		if (!profileEnv || typeof profileEnv !== "object") {
			return undefined
		}

		const sanitized: Record<string, string | null> = {}

		for (const [key, val] of Object.entries(profileEnv)) {
			if (!BLOCKED_ENV_KEYS.has(key.toUpperCase()) && (typeof val === "string" || val === null)) {
				sanitized[key] = val
			}
		}

		return Object.keys(sanitized).length > 0 ? sanitized : undefined
	}

	// -------------------------------------------------
	// Available profiles (for UI option discovery)
	// -------------------------------------------------

	/**
	 * Returns all profiles that resolve to a trusted, supported shell.
	 * Excludes cmd.exe profiles (shell integration unsupported) to match
	 * existing Terminal.getAvailableProfileNames behavior.
	 */
	getAvailableProfiles(): AvailableProfile[] {
		const profiles = this.readProfiles()
		const result: AvailableProfile[] = []

		for (const [name, raw] of Object.entries(profiles)) {
			if (!raw || typeof raw !== "object") {
				continue
			}

			const entry = raw as ProfileEntry
			const resolved = this.resolveProfileEntry(name, entry, "vscodeDefaultProfile")

			if (resolved && resolved.family !== "cmd") {
				result.push({ name, shell: resolved })
			}
		}

		return result.sort((a, b) => a.name.localeCompare(b.name))
	}

	/**
	 * Returns sorted profile names that resolve to trusted, supported shells.
	 * Convenience method matching Terminal.getAvailableProfileNames behavior.
	 */
	getAvailableProfileNames(): string[] {
		return this.getAvailableProfiles().map((p) => p.name)
	}
}
