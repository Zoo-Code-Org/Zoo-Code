// npx vitest run integrations/terminal/__tests__/ShellInvocationAdapter.spec.ts

import { ShellInvocationAdapter } from "../shell/ShellInvocationAdapter"
import type { ResolvedShell, ShellFamily, ShellInvocationPlan } from "../shell/types"

describe("ShellInvocationAdapter", () => {
	const command = "echo 'hello world'"

	function makeShell(overrides: Partial<ResolvedShell> = {}): ResolvedShell {
		return {
			executable: "/bin/bash",
			family: "posix",
			displayName: "Bash",
			source: "osDefault",
			trustEvidence: "allowlist",
			...overrides,
		}
	}

	describe("createPlan — PowerShell family", () => {
		it("produces correct args for PowerShell 7 (pwsh.exe)", () => {
			const shell = makeShell({
				executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
				family: "powershell",
				displayName: "PowerShell 7",
			})
			const plan = ShellInvocationAdapter.createPlan(shell, command)
			expect(plan.executable).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
			expect(plan.args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command])
			expect(plan.family).toBe("powershell")
			expect(plan.provider).toBe("execa")
		})

		it("produces correct args for Windows PowerShell 5.1 (powershell.exe)", () => {
			const shell = makeShell({
				executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
				family: "powershell",
				displayName: "Windows PowerShell 5.1",
			})
			const plan = ShellInvocationAdapter.createPlan(shell, command)
			expect(plan.args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command])
		})

		it("passes command as the last single argument, not concatenated", () => {
			const shell = makeShell({ family: "powershell" })
			const cmd = "Get-Process | Select-Object -First 5"
			const plan = ShellInvocationAdapter.createPlan(shell, cmd)
			expect(plan.args[plan.args.length - 1]).toBe(cmd)
			expect(plan.args.length).toBe(5)
		})
	})

	describe("createPlan — cmd family", () => {
		it("produces correct args for cmd.exe", () => {
			const shell = makeShell({
				executable: "C:\\Windows\\System32\\cmd.exe",
				family: "cmd",
				displayName: "Command Prompt",
			})
			const plan = ShellInvocationAdapter.createPlan(shell, command)
			expect(plan.executable).toBe("C:\\Windows\\System32\\cmd.exe")
			expect(plan.args).toEqual(["/d", "/s", "/c", command])
			expect(plan.family).toBe("cmd")
		})
	})

	describe("createPlan — posix family", () => {
		it("produces correct args for bash", () => {
			const shell = makeShell({
				executable: "/bin/bash",
				family: "posix",
				displayName: "Bash",
			})
			const plan = ShellInvocationAdapter.createPlan(shell, command)
			expect(plan.executable).toBe("/bin/bash")
			expect(plan.args).toEqual(["-c", command])
			expect(plan.family).toBe("posix")
		})

		it("produces correct args for zsh", () => {
			const shell = makeShell({
				executable: "/bin/zsh",
				family: "posix",
				displayName: "Zsh",
			})
			const plan = ShellInvocationAdapter.createPlan(shell, command)
			expect(plan.args).toEqual(["-c", command])
		})

		it("produces correct args for sh", () => {
			const shell = makeShell({
				executable: "/bin/sh",
				family: "posix",
				displayName: "sh",
			})
			const plan = ShellInvocationAdapter.createPlan(shell, command)
			expect(plan.args).toEqual(["-c", command])
		})
	})

	describe("createPlan — fish family", () => {
		it("produces correct args for fish", () => {
			const shell = makeShell({
				executable: "/usr/bin/fish",
				family: "fish",
				displayName: "Fish",
			})
			const plan = ShellInvocationAdapter.createPlan(shell, command)
			expect(plan.executable).toBe("/usr/bin/fish")
			expect(plan.args).toEqual(["--no-config", "-c", command])
			expect(plan.family).toBe("fish")
		})
	})

	describe("createPlan — wsl family", () => {
		it("produces correct args for WSL without distro or cwd", () => {
			const shell = makeShell({
				executable: "C:\\Windows\\System32\\wsl.exe",
				family: "wsl",
				displayName: "WSL",
			})
			const plan = ShellInvocationAdapter.createPlan(shell, command)
			expect(plan.executable).toBe("C:\\Windows\\System32\\wsl.exe")
			expect(plan.args).toEqual(["--exec", "/bin/bash", "-c", command])
			expect(plan.family).toBe("wsl")
		})

		it("includes --distribution when distroName is set", () => {
			const shell = makeShell({
				executable: "C:\\Windows\\System32\\wsl.exe",
				family: "wsl",
				displayName: "WSL: Ubuntu",
				distroName: "Ubuntu",
			})
			const plan = ShellInvocationAdapter.createPlan(shell, command)
			expect(plan.args).toEqual(["--distribution", "Ubuntu", "--exec", "/bin/bash", "-c", command])
		})

		it("includes --cd when cwd is provided", () => {
			const shell = makeShell({
				executable: "C:\\Windows\\System32\\wsl.exe",
				family: "wsl",
				displayName: "WSL",
			})
			const cwd = "/home/user/project"
			const plan = ShellInvocationAdapter.createPlan(shell, command, cwd)
			expect(plan.args).toEqual(["--cd", cwd, "--exec", "/bin/bash", "-c", command])
			expect(plan.cwd).toBe(cwd)
		})

		it("includes both --distribution and --cd when both are set", () => {
			const shell = makeShell({
				executable: "C:\\Windows\\System32\\wsl.exe",
				family: "wsl",
				displayName: "WSL: Debian",
				distroName: "Debian",
			})
			const cwd = "/home/user/project"
			const plan = ShellInvocationAdapter.createPlan(shell, command, cwd)
			expect(plan.args).toEqual(["--distribution", "Debian", "--cd", cwd, "--exec", "/bin/bash", "-c", command])
		})
	})

	describe("createPlan — common properties", () => {
		it("sets provider to execa by default", () => {
			const shell = makeShell()
			const plan = ShellInvocationAdapter.createPlan(shell, command)
			expect(plan.provider).toBe("execa")
		})

		it("sets provider to vscode when specified", () => {
			const shell = makeShell()
			const plan = ShellInvocationAdapter.createPlan(shell, command, undefined, "vscode")
			expect(plan.provider).toBe("vscode")
		})

		it("passes cwd from parameter", () => {
			const shell = makeShell()
			const cwd = "/some/path"
			const plan = ShellInvocationAdapter.createPlan(shell, command, cwd)
			expect(plan.cwd).toBe(cwd)
		})

		it("passes env from shell", () => {
			const shell = makeShell({
				env: { FOO: "bar", BAZ: null },
			})
			const plan = ShellInvocationAdapter.createPlan(shell, command)
			expect(plan.env).toEqual({ FOO: "bar", BAZ: null })
		})

		it("does not include shell: true anywhere in the plan", () => {
			const shell = makeShell()
			const plan = ShellInvocationAdapter.createPlan(shell, command)
			expect(plan).not.toHaveProperty("shell")
			// Ensure no string "shell" key exists
			expect(Object.keys(plan)).not.toContain("shell")
		})
	})

	describe("createPlan — command is always last arg", () => {
		const families: ShellFamily[] = ["powershell", "cmd", "posix", "fish", "wsl"]

		families.forEach((family) => {
			it(`command is the last element for family: ${family}`, () => {
				const shell = makeShell({
					family,
					executable: family === "wsl" ? "wsl.exe" : `/bin/${family}`,
					distroName: family === "wsl" ? "Ubuntu" : undefined,
				})
				const cmd = "unique-command-string-12345"
				const plan = ShellInvocationAdapter.createPlan(shell, cmd)
				expect(plan.args[plan.args.length - 1]).toBe(cmd)
			})
		})
	})
})
