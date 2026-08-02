/**
 * ShellInvocationAdapter — converts a {@link ResolvedShell} into a concrete
 * {@link ShellInvocationPlan} with shell-family-specific controlled arguments.
 *
 * The command is always passed as a single argument (the last element of
 * `args`). It is never concatenated into a host-shell command string. This
 * eliminates the `shell: true` fallback that caused PowerShell syntax to be
 * sent to `cmd.exe` (issue #705).
 *
 * See ARCH-TERMINAL-001 section 1.8 (Shell-family invocation plans).
 */

import type { ResolvedShell, ShellFamily, ShellInvocationPlan } from "./types"

/**
 * Default guest shell for WSL when no specific guest shell is configured.
 * WSL's default user shell is typically `/bin/bash`.
 */
const WSL_DEFAULT_GUEST_SHELL = "/bin/bash"

/**
 * Builds a {@link ShellInvocationPlan} from a {@link ResolvedShell} and a
 * command string. The adapter is stateless and side-effect free.
 */
export class ShellInvocationAdapter {
	/**
	 * Creates an invocation plan for the given resolved shell and command.
	 *
	 * @param shell The resolved shell to invoke.
	 * @param command The command string to execute (passed as a single arg).
	 * @param cwd Optional working directory override.
	 * @param provider Execution provider: `execa` for inline, `vscode` for
	 *   integrated terminal. Defaults to `execa`.
	 * @returns A {@link ShellInvocationPlan} with family-specific arguments.
	 */
	static createPlan(
		shell: ResolvedShell,
		command: string,
		cwd?: string,
		provider: "execa" | "vscode" = "execa",
	): ShellInvocationPlan {
		const args = ShellInvocationAdapter.buildArgs(shell.family, shell, command, cwd)

		return {
			executable: shell.executable,
			args,
			family: shell.family,
			cwd,
			env: shell.env,
			provider,
		}
	}

	/**
	 * Builds the controlled argument array for the given shell family.
	 * The command is always the last element.
	 *
	 * @param family The shell family.
	 * @param shell The resolved shell (for WSL distro metadata).
	 * @param command The command string.
	 * @param cwd Optional working directory (used by WSL --cd).
	 * @returns Argument array with the command as the last element.
	 */
	private static buildArgs(family: ShellFamily, shell: ResolvedShell, command: string, cwd?: string): string[] {
		switch (family) {
			case "powershell":
				return ShellInvocationAdapter.buildPowerShellArgs(command)
			case "cmd":
				return ShellInvocationAdapter.buildCmdArgs(command)
			case "posix":
				return ShellInvocationAdapter.buildPosixArgs(command)
			case "fish":
				return ShellInvocationAdapter.buildFishArgs(command)
			case "wsl":
				return ShellInvocationAdapter.buildWslArgs(shell, command, cwd)
			default:
				// Exhaustiveness check — if a new family is added without a
				// case, this throws at build time via the never type.
				return ShellInvocationAdapter.assertNever(family)
		}
	}

	/**
	 * PowerShell 5.1 / PowerShell 7 invocation:
	 * `pwsh.exe -NoLogo -NoProfile -NonInteractive -Command <command>`
	 *
	 * `-NoProfile` ensures no interactive profile scripts are loaded.
	 * `-NonInteractive` ensures the shell does not prompt for input.
	 * `-NoLogo` suppresses the copyright banner.
	 */
	private static buildPowerShellArgs(command: string): string[] {
		return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
	}

	/**
	 * Command Prompt invocation:
	 * `cmd.exe /d /s /c <command>`
	 *
	 * `/d` disables auto-run from registry.
	 * `/s` enables quoted command string handling.
	 * `/c` executes the command and terminates.
	 */
	private static buildCmdArgs(command: string): string[] {
		return ["/d", "/s", "/c", command]
	}

	/**
	 * POSIX shell (bash, zsh, sh, dash, ksh) invocation:
	 * `<shell> -c <command>`
	 *
	 * The `-c` flag reads the command from the next argument. No login
	 * or interactive profile is loaded.
	 */
	private static buildPosixArgs(command: string): string[] {
		return ["-c", command]
	}

	/**
	 * Fish shell invocation:
	 * `fish --no-config -c <command>`
	 *
	 * `--no-config` skips loading the user configuration file, ensuring
	 * deterministic, non-interactive execution.
	 */
	private static buildFishArgs(command: string): string[] {
		return ["--no-config", "-c", command]
	}

	/**
	 * WSL invocation:
	 * `wsl.exe [--distribution <distro>] [--cd <cwd>] --exec <guestShell> -c <command>`
	 *
	 * WSL is treated as a host-to-guest adapter. The guest shell (default
	 * `/bin/bash`) executes the command with `-c`. The `--cd` flag sets the
	 * working directory inside the WSL filesystem. The `--exec` flag bypasses
	 * the default shell's login/profile scripts.
	 *
	 * If no CWD is provided, `--cd` is omitted (WSL will use the default
	 * starting directory).
	 */
	private static buildWslArgs(shell: ResolvedShell, command: string, cwd?: string): string[] {
		const args: string[] = []

		// Optional distro selection.
		if (shell.distroName) {
			args.push("--distribution", shell.distroName)
		}

		// Working directory inside WSL.
		if (cwd) {
			args.push("--cd", cwd)
		}

		// Guest shell execution.
		args.push("--exec", WSL_DEFAULT_GUEST_SHELL, "-c", command)

		return args
	}

	/**
	 * Exhaustiveness guard for the shell family switch. If a new family is
	 * added to {@link ShellFamily} without a corresponding case in
	 * {@link buildArgs}, this method produces a compile-time error.
	 */
	private static assertNever(family: never): string[] {
		throw new Error(`SHELL/ShellInvocationAdapter/buildArgs/001: Unsupported shell family: ${String(family)}`)
	}
}
