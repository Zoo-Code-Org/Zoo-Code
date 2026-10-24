/**
 * Describes the command syntax of Windows-native shells for the system prompt.
 *
 * Rules and habits written for bash silently do the wrong thing under these shells
 * (e.g. `;` is not a command separator in cmd.exe), so the model is told which
 * dialect it is writing for. Returns undefined for POSIX shells, where the shell
 * path already names the dialect.
 */
export function getShellName(shellPath: string): string {
	// path.basename follows the host platform; split on both separators so Windows paths work anywhere.
	return shellPath.split(/[\\/]/).pop() ?? ""
}

export function describeShellDialect(shellPath: string): string | undefined {
	const name = getShellName(shellPath).toLowerCase()

	if (name === "cmd.exe" || name === "cmd") {
		return (
			"Commands run through Windows cmd.exe, not bash. Use cmd syntax: `&` or `&&` to chain commands " +
			"(`;` is not a separator), `%VAR%` for variables, `set X=Y`, `%ERRORLEVEL%` for exit codes, " +
			"and `dir`, `type`, `findstr`. POSIX tools may be missing or shadowed by other binaries on PATH."
		)
	}

	if (name === "powershell.exe" || name === "pwsh.exe" || name === "powershell" || name === "pwsh") {
		return (
			"Commands run through PowerShell, not bash. Use PowerShell syntax: `;` to chain commands, " +
			"`$env:VAR` for environment variables, `$LASTEXITCODE` for exit codes, and cmdlets such as " +
			"`Get-ChildItem` and `Select-String`."
		)
	}

	return undefined
}
