import { describeShellDialect } from "../shellDialect"

describe("describeShellDialect", () => {
	const cmdSyntax = ["`&`", "`&&`", "`%VAR%`", "`set X=Y`", "`%ERRORLEVEL%`", "`!ERRORLEVEL!`"]
	const powershellSyntax = ["`;`", "`$env:VAR`", "`$?`", "`$LASTEXITCODE`"]

	it.each([
		{ shell: "C:\\Windows\\System32\\cmd.exe", expected: "cmd.exe", syntax: cmdSyntax },
		{ shell: "C:\\Windows\\System32\\CMD.EXE", expected: "cmd.exe", syntax: cmdSyntax },
		{ shell: "cmd", expected: "cmd.exe", syntax: cmdSyntax },
		{ shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", expected: "PowerShell", syntax: powershellSyntax },
		{
			shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			expected: "PowerShell",
			syntax: powershellSyntax,
		},
		{ shell: "powershell", expected: "PowerShell", syntax: powershellSyntax },
		{ shell: "pwsh", expected: "PowerShell", syntax: powershellSyntax },
	])("names the dialect and its syntax for $shell", ({ shell, expected, syntax }) => {
		const description = describeShellDialect(shell)

		expect(description).toContain(expected)
		for (const token of syntax) {
			expect(description).toContain(token)
		}
	})

	it("tells PowerShell users that a failed cmdlet does not change $LASTEXITCODE", () => {
		expect(describeShellDialect("pwsh.exe")).toContain("does not change when a cmdlet fails")
	})

	it("warns that ';' does not chain commands in cmd.exe", () => {
		expect(describeShellDialect("C:\\Windows\\System32\\cmd.exe")).toContain("`;` is not a separator")
	})

	it.each(["/bin/bash", "/bin/zsh", "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Windows\\System32\\wsl.exe"])(
		"adds nothing for POSIX shell %s",
		(shell) => {
			expect(describeShellDialect(shell)).toBeUndefined()
		},
	)
})
