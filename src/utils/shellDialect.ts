/**
 * Describes the command syntax of Windows-native shells for the system prompt.
 *
 * Rules and habits written for bash silently do the wrong thing under these shells
 * (e.g. `;` is not a command separator in cmd.exe), so the model is told which
 * dialect it is writing for. Returns undefined for POSIX shells, where the shell
 * path already names the dialect.
 */
export function describeShellDialect(shellPath: string): string | undefined {
	// path.basename follows the host platform; split on both separators so Windows paths work anywhere.
	const name = (shellPath.split(/[\\/]/).pop() ?? "").toLowerCase()

	if (name === "cmd.exe" || name === "cmd") {
		return (
			"Commands run through Windows cmd.exe, not bash. Use cmd syntax: `&` or `&&` to chain commands " +
			"(`;` is not a separator), `%VAR%` for variables, `set X=Y`, and `%ERRORLEVEL%` for exit codes " +
			"(`%ERRORLEVEL%` expands before a chained line runs, so use `&&` or `||` for same-line success checks; " +
			"enable delayed expansion and use `!ERRORLEVEL!` when the numeric result is needed after a command), " +
			"and `dir`, `type`, `findstr`. POSIX tools may be missing or shadowed by other binaries on PATH."
		)
	}

	if (name === "powershell.exe" || name === "pwsh.exe" || name === "powershell" || name === "pwsh") {
		return (
			"Commands run through PowerShell, not bash. Use PowerShell syntax: `;` to chain commands, " +
			"`$env:VAR` for environment variables, `$?` for whether the last command succeeded " +
			"(`$LASTEXITCODE` only holds the exit code of native programs and does not change when a cmdlet fails), " +
			"and cmdlets such as `Get-ChildItem` and `Select-String`."
		)
	}

	return undefined
}
