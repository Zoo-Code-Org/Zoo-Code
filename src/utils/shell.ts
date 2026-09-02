import * as vscode from "vscode"
import { existsSync } from "fs"
import { userInfo } from "os"
import * as path from "path"

import { BaseTerminal } from "../integrations/terminal/BaseTerminal"
import { Terminal } from "../integrations/terminal/Terminal"

// Security: Allowlist of approved shell executables to prevent arbitrary command execution
const SHELL_ALLOWLIST = new Set<string>([
	// Windows PowerShell variants
	"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	"C:\\Program Files\\PowerShell\\7\\pwsh.exe",
	"C:\\Program Files\\PowerShell\\6\\pwsh.exe",
	"C:\\Program Files\\PowerShell\\5\\pwsh.exe",

	// Windows Command Prompt
	"C:\\Windows\\System32\\cmd.exe",

	// Windows WSL
	"C:\\Windows\\System32\\wsl.exe",

	// Git Bash on Windows
	"C:\\Program Files\\Git\\bin\\bash.exe",
	"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
	"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
	"C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",

	// MSYS2/MinGW/Cygwin on Windows
	"C:\\msys64\\usr\\bin\\bash.exe",
	"C:\\msys32\\usr\\bin\\bash.exe",
	"C:\\MinGW\\msys\\1.0\\bin\\bash.exe",
	"C:\\cygwin64\\bin\\bash.exe",
	"C:\\cygwin\\bin\\bash.exe",

	// Unix/Linux/macOS - Bourne-compatible shells
	"/bin/sh",
	"/usr/bin/sh",
	"/bin/bash",
	"/usr/bin/bash",
	"/usr/local/bin/bash",
	"/opt/homebrew/bin/bash",
	"/opt/local/bin/bash",

	// Z Shell
	"/bin/zsh",
	"/usr/bin/zsh",
	"/usr/local/bin/zsh",
	"/opt/homebrew/bin/zsh",
	"/opt/local/bin/zsh",

	// Dash
	"/bin/dash",
	"/usr/bin/dash",

	// Ash
	"/bin/ash",
	"/usr/bin/ash",

	// C Shells
	"/bin/csh",
	"/usr/bin/csh",
	"/bin/tcsh",
	"/usr/bin/tcsh",
	"/usr/local/bin/tcsh",

	// Korn Shells
	"/bin/ksh",
	"/usr/bin/ksh",
	"/bin/ksh93",
	"/usr/bin/ksh93",
	"/bin/mksh",
	"/usr/bin/mksh",
	"/bin/pdksh",
	"/usr/bin/pdksh",

	// Fish Shell
	"/usr/bin/fish",
	"/usr/local/bin/fish",
	"/opt/homebrew/bin/fish",
	"/opt/local/bin/fish",

	// Modern shells
	"/usr/bin/elvish",
	"/usr/local/bin/elvish",
	"/usr/bin/xonsh",
	"/usr/local/bin/xonsh",
	"/usr/bin/nu",
	"/usr/local/bin/nu",
	"/usr/bin/nushell",
	"/usr/local/bin/nushell",
	"/usr/bin/ion",
	"/usr/local/bin/ion",

	// BusyBox
	"/bin/busybox",
	"/usr/bin/busybox",
])

const SHELL_PATHS = {
	// Windows paths
	POWERSHELL_7: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
	POWERSHELL_LEGACY: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	CMD: "C:\\Windows\\System32\\cmd.exe",
	WSL_BASH: "/bin/bash",
	// Unix paths
	MAC_DEFAULT: "/bin/zsh",
	LINUX_DEFAULT: "/bin/bash",
	CSH: "/bin/csh",
	BASH: "/bin/bash",
	KSH: "/bin/ksh",
	SH: "/bin/sh",
	ZSH: "/bin/zsh",
	DASH: "/bin/dash",
	TCSH: "/bin/tcsh",
	FALLBACK: "/bin/sh",
} as const

// -----------------------------------------------------
// 1) VS Code Terminal Configuration Helper
// -----------------------------------------------------

function preferredWindowsPowerShell(): string {
	return existsSync(SHELL_PATHS.POWERSHELL_7) ? SHELL_PATHS.POWERSHELL_7 : SHELL_PATHS.POWERSHELL_LEGACY
}

/**
 * Resolves the shell that VS Code's integrated terminal will use, matching the
 * priority order from Terminal constructor: Zoo profile override first, then
 * VS Code's configured default profile (trusted scopes only — workspace scope
 * excluded per APPLICATION scope restriction).
 *
 * Returns null when no profile is configured or the profile has no resolvable path.
 */
function getShellFromVSCode(): string | null {
	try {
		// Zoo profile override takes precedence — this is the same path
		// Terminal constructor uses to set shellPath on createTerminal().
		const profileShell = Terminal.getProfileShell()
		if (profileShell?.shellPath) {
			return profileShell.shellPath
		}

		const profileName = Terminal.getConfiguredDefaultProfileName()

		if (!profileName) {
			// No profile configured at user/default scope. On Windows, VS Code
			// auto-detects and prefers PowerShell 7 when installed. Mirror that so
			// the system prompt matches what VS Code will actually open. (issue #82)
			if (process.platform === "win32") {
				return preferredWindowsPowerShell()
			}
			return null
		}

		const profiles = Terminal.getConfiguredProfiles()
		const profile = profiles[profileName] as { path?: unknown; source?: unknown } | null | undefined

		if (!profile) {
			return null
		}

		const resolved = Terminal.resolveProfilePath(profile.path)
		if (resolved) {
			return resolved
		}

		// source-only PowerShell profiles (e.g. { source: "PowerShell" }) have no
		// path but we can still identify the shell type from the source field.
		if (typeof profile.source === "string" && profile.source.toLowerCase().includes("powershell")) {
			return preferredWindowsPowerShell()
		}

		// source-only WSL profiles
		if (typeof profile.source === "string" && profile.source.toLowerCase().includes("wsl")) {
			return SHELL_PATHS.WSL_BASH
		}

		return null
	} catch {
		return null
	}
}

// -----------------------------------------------------
// 3) General Fallback Helpers
// -----------------------------------------------------

/**
 * Tries to get a user’s shell from os.userInfo() (works on Unix if the
 * underlying system call is supported). Returns null on error or if not found.
 */
function getShellFromUserInfo(): string | null {
	try {
		const { shell } = userInfo()
		return shell || null
	} catch {
		return null
	}
}

/** Returns the environment-based shell variable, or null if not set. */
function getShellFromEnv(): string | null {
	const { env } = process

	if (process.platform === "win32") {
		// On Windows, COMSPEC typically holds cmd.exe
		return env.COMSPEC || "C:\\Windows\\System32\\cmd.exe"
	}

	if (process.platform === "darwin") {
		// On macOS/Linux, SHELL is commonly the environment variable
		return env.SHELL || "/bin/zsh"
	}

	if (process.platform === "linux") {
		// On Linux, SHELL is commonly the environment variable
		return env.SHELL || "/bin/bash"
	}
	return null
}

// -----------------------------------------------------
// 4) Shell Validation Functions
// -----------------------------------------------------

/**
 * Validates if a shell path is in the allowlist to prevent arbitrary command execution
 */
function isShellAllowed(shellPath: string): boolean {
	if (!shellPath) return false

	const normalizedPath = path.normalize(shellPath)

	// Direct lookup first
	if (SHELL_ALLOWLIST.has(normalizedPath)) {
		return true
	}

	// On Windows, try case-insensitive comparison
	if (process.platform === "win32") {
		const lowerPath = normalizedPath.toLowerCase()
		for (const allowedPath of SHELL_ALLOWLIST) {
			if (allowedPath.toLowerCase() === lowerPath) {
				return true
			}
		}
	}

	return false
}

/**
 * Returns a safe fallback shell based on the platform
 */
function getSafeFallbackShell(): string {
	if (process.platform === "win32") {
		return SHELL_PATHS.CMD
	} else if (process.platform === "darwin") {
		return SHELL_PATHS.MAC_DEFAULT
	} else {
		return SHELL_PATHS.LINUX_DEFAULT
	}
}

// -----------------------------------------------------
// 5) Publicly Exposed Shell Getter
// -----------------------------------------------------

export function getShell(): string {
	let shell: string | null = null

	// 1. Explicit execa shell path — when set, execa uses this exact executable
	//    regardless of VS Code profile settings.
	shell = BaseTerminal.getExecaShellPath() ?? null

	// 2. VS Code profile config (Zoo override first, then default profile).
	if (!shell) {
		shell = getShellFromVSCode()
	}

	// 3. If no shell from VS Code, try userInfo()
	if (!shell) {
		shell = getShellFromUserInfo()
	}

	// 4. If still nothing, try environment variable
	if (!shell) {
		shell = getShellFromEnv()
	}

	// 5. Finally, fall back to a default
	if (!shell) {
		shell = getSafeFallbackShell()
	}

	// 6. Validate the shell against allowlist
	if (!isShellAllowed(shell)) {
		shell = getSafeFallbackShell()
	}

	return shell
}
