import { describeShellDialect } from "../shellDialect"

describe("describeShellDialect", () => {
	it.each([
		{ shell: "C:\\Windows\\System32\\cmd.exe", expected: "cmd.exe" },
		{ shell: "C:\\Windows\\System32\\CMD.EXE", expected: "cmd.exe" },
		{ shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", expected: "PowerShell" },
		{ shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", expected: "PowerShell" },
	])("names the dialect for $shell", ({ shell, expected }) => {
		expect(describeShellDialect(shell)).toContain(expected)
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
