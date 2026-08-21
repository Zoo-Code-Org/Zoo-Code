import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as vscode from "vscode"
import { existsSync } from "fs"
import { userInfo } from "os"
import { getShell } from "../shell"
import { BaseTerminal } from "../../integrations/terminal/BaseTerminal"
import { Terminal } from "../../integrations/terminal/Terminal"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(),
	},
}))

vi.mock("os", () => ({
	userInfo: vi.fn(() => ({ shell: null })),
}))

vi.mock("fs", () => ({
	existsSync: vi.fn(() => false),
}))

vi.mock("path", async () => {
	const actual = await vi.importActual("path")
	return {
		...actual,
		normalize: vi.fn((p: string) => p),
	}
})

describe("Shell Detection Tests", () => {
	let originalPlatform: string
	let originalEnv: NodeJS.ProcessEnv
	let originalGetConfig: any

	/**
	 * Stubs VS Code config using inspect() on the correct section names, matching
	 * how Terminal.getConfiguredDefaultProfileName and Terminal.getConfiguredProfiles
	 * read config (globalValue only — workspace excluded per APPLICATION scope).
	 */
	function mockVsCodeConfig(platformKey: string, defaultProfileName: string | null, profiles: Record<string, any>) {
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === "terminal.integrated") {
				return {
					inspect: (key: string) => {
						expect(key).toBe(`defaultProfile.${platformKey}`)
						return {
							defaultValue: undefined,
							globalValue: defaultProfileName ?? undefined,
						}
					},
					get: () => undefined,
				} as any
			}
			if (section === "terminal.integrated.profiles") {
				return {
					inspect: (key: string) => {
						expect(key).toBe(platformKey)
						return {
							defaultValue: undefined,
							globalValue: profiles,
						}
					},
					get: () => undefined,
				} as any
			}
			return { get: () => undefined, inspect: () => undefined } as any
		}
	}

	beforeEach(() => {
		originalPlatform = process.platform
		originalEnv = { ...process.env }
		originalGetConfig = vscode.workspace.getConfiguration

		delete process.env.SHELL
		delete process.env.COMSPEC

		vi.mocked(userInfo).mockReturnValue({ shell: null } as any)
		// Default: PowerShell 7 is not installed, so the probe falls back to legacy.
		vi.mocked(existsSync).mockReturnValue(false)
		// Clear Zoo profile override and execa shell path between tests.
		Terminal.setTerminalProfile(undefined)
		BaseTerminal.setExecaShellPath(undefined)
	})

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform })
		process.env = originalEnv
		vscode.workspace.getConfiguration = originalGetConfig
		Terminal.setTerminalProfile(undefined)
		BaseTerminal.setExecaShellPath(undefined)
		vi.clearAllMocks()
	})

	// --------------------------------------------------------------------------
	// Windows Shell Detection
	// --------------------------------------------------------------------------
	describe("Windows Shell Detection", () => {
		beforeEach(() => {
			Object.defineProperty(process, "platform", { value: "win32" })
		})

		it("uses explicit PowerShell 7 path from VS Code config (profile path)", () => {
			vi.mocked(existsSync).mockImplementation((p: any) => p === "C:\\Program Files\\PowerShell\\7\\pwsh.exe")
			mockVsCodeConfig("windows", "PowerShell", {
				PowerShell: { path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
			})
			expect(getShell()).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		})

		it("should handle array path from VSCode terminal profile", () => {
			vi.mocked(existsSync).mockImplementation((p: any) => p === "C:\\Program Files\\PowerShell\\7\\pwsh.exe")
			mockVsCodeConfig("windows", "PowerShell", {
				PowerShell: { path: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "pwsh.exe"] },
			})
			expect(getShell()).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		})

		it("falls through to COMSPEC when profile has an empty array path", () => {
			mockVsCodeConfig("windows", "Custom", {
				Custom: { path: [] },
			})
			process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe"
			expect(getShell()).toBe("C:\\Windows\\System32\\cmd.exe")
		})

		it("uses PowerShell 7 path if source is 'PowerShell' but no explicit path", () => {
			vi.mocked(existsSync).mockImplementation((p: any) => p === "C:\\Program Files\\PowerShell\\7\\pwsh.exe")
			mockVsCodeConfig("windows", "PowerShell", {
				PowerShell: { source: "PowerShell" },
			})
			expect(getShell()).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		})

		it("falls back to legacy PowerShell if source is 'PowerShell' but PS7 is absent", () => {
			vi.mocked(existsSync).mockReturnValue(false)
			mockVsCodeConfig("windows", "PowerShell", {
				PowerShell: { source: "PowerShell" },
			})
			expect(getShell()).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
		})

		it("uses WSL bash when profile indicates WSL source", () => {
			mockVsCodeConfig("windows", "WSL", {
				WSL: { source: "WSL" },
			})
			expect(getShell()).toBe("/bin/bash")
		})

		it("falls through to COMSPEC when profile has no path and no source", () => {
			// A profile entry with no path and no recognised source is unresolvable;
			// getShell falls through to env/fallback rather than guessing cmd.exe.
			mockVsCodeConfig("windows", "CommandPrompt", {
				CommandPrompt: {},
			})
			process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe"
			expect(getShell()).toBe("C:\\Windows\\System32\\cmd.exe")
		})

		it("falls through to COMSPEC when configured profile is missing from profiles map", () => {
			mockVsCodeConfig("windows", "NonexistentProfile", {})
			process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe"
			expect(getShell()).toBe("C:\\Windows\\System32\\cmd.exe")
		})

		it("defaults to PowerShell 7 when no profile is configured and pwsh.exe is installed", () => {
			// Modern VS Code prefers PS7 on Windows when no profile is explicitly set.
			mockVsCodeConfig("windows", null, {})
			vi.mocked(existsSync).mockReturnValue(true)
			expect(getShell()).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		})

		it("falls back to Windows PowerShell 5.1 when no profile is configured and PS7 is absent", () => {
			mockVsCodeConfig("windows", null, {})
			vi.mocked(existsSync).mockReturnValue(false)
			expect(getShell()).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
		})

		it("falls back to safe shell when the configured profile path is non-allowlisted", () => {
			vi.mocked(existsSync).mockImplementation((p: any) => p === "C:\\Custom\\evil.exe")
			mockVsCodeConfig("windows", "Custom", {
				Custom: { path: "C:\\Custom\\evil.exe" },
			})
			expect(getShell()).toBe("C:\\Windows\\System32\\cmd.exe")
		})

		it("uses cmd.exe when a Command Prompt profile is explicitly configured", () => {
			vi.mocked(existsSync).mockImplementation((p: any) => p === "C:\\Windows\\System32\\cmd.exe")
			mockVsCodeConfig("windows", "Command Prompt", {
				"Command Prompt": { path: "C:\\Windows\\System32\\cmd.exe" },
			})
			expect(getShell()).toBe("C:\\Windows\\System32\\cmd.exe")
		})
	})

	// --------------------------------------------------------------------------
	// macOS Shell Detection
	// --------------------------------------------------------------------------
	describe("macOS Shell Detection", () => {
		beforeEach(() => {
			Object.defineProperty(process, "platform", { value: "darwin" })
		})

		it("uses VS Code profile path if available", () => {
			vi.mocked(existsSync).mockImplementation((p: any) => p === "/usr/local/bin/fish")
			mockVsCodeConfig("osx", "MyCustomShell", {
				MyCustomShell: { path: "/usr/local/bin/fish" },
			})
			expect(getShell()).toBe("/usr/local/bin/fish")
		})

		it("should handle array path from VSCode terminal profile", () => {
			vi.mocked(existsSync).mockImplementation((p: any) => p === "/opt/homebrew/bin/zsh")
			mockVsCodeConfig("osx", "zsh", {
				zsh: { path: ["/opt/homebrew/bin/zsh", "/bin/zsh"] },
			})
			expect(getShell()).toBe("/opt/homebrew/bin/zsh")
		})

		it("falls back to userInfo().shell if no VS Code config is available", () => {
			mockVsCodeConfig("osx", null, {})
			vi.mocked(userInfo).mockReturnValue({ shell: "/opt/homebrew/bin/zsh" } as any)
			expect(getShell()).toBe("/opt/homebrew/bin/zsh")
		})

		it("falls back to SHELL env var if no userInfo shell is found", () => {
			mockVsCodeConfig("osx", null, {})
			process.env.SHELL = "/usr/local/bin/zsh"
			expect(getShell()).toBe("/usr/local/bin/zsh")
		})

		it("falls back to /bin/zsh if no config, userInfo, or env variable is set", () => {
			mockVsCodeConfig("osx", null, {})
			expect(getShell()).toBe("/bin/zsh")
		})
	})

	// --------------------------------------------------------------------------
	// Linux Shell Detection
	// --------------------------------------------------------------------------
	describe("Linux Shell Detection", () => {
		beforeEach(() => {
			Object.defineProperty(process, "platform", { value: "linux" })
		})

		it("uses VS Code profile path if available", () => {
			vi.mocked(existsSync).mockImplementation((p: any) => p === "/usr/bin/fish")
			mockVsCodeConfig("linux", "CustomProfile", {
				CustomProfile: { path: "/usr/bin/fish" },
			})
			expect(getShell()).toBe("/usr/bin/fish")
		})

		it("should handle array path from VSCode terminal profile", () => {
			vi.mocked(existsSync).mockImplementation((p: any) => p === "/usr/local/bin/bash")
			mockVsCodeConfig("linux", "bash", {
				bash: { path: ["/usr/local/bin/bash", "/bin/bash"] },
			})
			expect(getShell()).toBe("/usr/local/bin/bash")
		})

		it("falls back to userInfo().shell if no VS Code config is available", () => {
			mockVsCodeConfig("linux", null, {})
			vi.mocked(userInfo).mockReturnValue({ shell: "/usr/bin/zsh" } as any)
			expect(getShell()).toBe("/usr/bin/zsh")
		})

		it("falls back to SHELL env var if no userInfo shell is found", () => {
			mockVsCodeConfig("linux", null, {})
			process.env.SHELL = "/usr/bin/fish"
			expect(getShell()).toBe("/usr/bin/fish")
		})

		it("falls back to /bin/bash if nothing is set", () => {
			mockVsCodeConfig("linux", null, {})
			expect(getShell()).toBe("/bin/bash")
		})
	})

	// --------------------------------------------------------------------------
	// Unknown Platform & Error Handling
	// --------------------------------------------------------------------------
	describe("Unknown Platform / Error Handling", () => {
		it("falls back to /bin/bash for unknown platforms", () => {
			Object.defineProperty(process, "platform", { value: "sunos" })
			mockVsCodeConfig("linux", null, {})
			expect(getShell()).toBe("/bin/bash")
		})

		it("handles VS Code config errors gracefully, falling back to userInfo shell if present", () => {
			Object.defineProperty(process, "platform", { value: "linux" })
			vscode.workspace.getConfiguration = () => {
				throw new Error("Configuration error")
			}
			vi.mocked(userInfo).mockReturnValue({ shell: "/bin/bash" } as any)
			expect(getShell()).toBe("/bin/bash")
		})

		it("handles userInfo errors gracefully, falling back to environment variable if present", () => {
			Object.defineProperty(process, "platform", { value: "darwin" })
			mockVsCodeConfig("osx", null, {})
			vi.mocked(userInfo).mockImplementation(() => {
				throw new Error("userInfo error")
			})
			process.env.SHELL = "/bin/zsh"
			expect(getShell()).toBe("/bin/zsh")
		})

		it("falls back fully to default shell paths if everything fails", () => {
			Object.defineProperty(process, "platform", { value: "linux" })
			vscode.workspace.getConfiguration = () => {
				throw new Error("Configuration error")
			}
			vi.mocked(userInfo).mockImplementation(() => {
				throw new Error("userInfo error")
			})
			delete process.env.SHELL
			expect(getShell()).toBe("/bin/bash")
		})

		it("handles inspect() returning undefined gracefully", () => {
			Object.defineProperty(process, "platform", { value: "linux" })
			vscode.workspace.getConfiguration = () =>
				({
					inspect: () => undefined,
					get: () => undefined,
				}) as any
			expect(getShell()).toBe("/bin/bash")
		})
	})

	// --------------------------------------------------------------------------
	// Scope isolation — workspace values must not influence getShell()
	// --------------------------------------------------------------------------
	describe("Scope isolation (workspace values ignored)", () => {
		it("Windows: ignores a workspace-scoped default profile", () => {
			Object.defineProperty(process, "platform", { value: "win32" })
			vi.mocked(existsSync).mockReturnValue(false)
			// globalValue is undefined; only workspaceValue is set
			vscode.workspace.getConfiguration = (section?: string) => {
				if (section === "terminal.integrated") {
					return {
						inspect: (_key: string) => ({
							defaultValue: undefined,
							globalValue: undefined,
							workspaceValue: "PowerShell",
						}),
						get: () => undefined,
					} as any
				}
				if (section === "terminal.integrated.profiles") {
					return {
						inspect: (_key: string) => ({
							defaultValue: undefined,
							globalValue: undefined,
							workspaceValue: { PowerShell: { path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" } },
						}),
						get: () => undefined,
					} as any
				}
				return { get: () => undefined, inspect: () => undefined } as any
			}
			// No global profile → falls back to PS legacy (existsSync returns false for PS7)
			expect(getShell()).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
		})

		it("Linux: ignores a workspace-scoped default profile", () => {
			Object.defineProperty(process, "platform", { value: "linux" })
			vscode.workspace.getConfiguration = (section?: string) => {
				if (section === "terminal.integrated") {
					return {
						inspect: (_key: string) => ({
							defaultValue: undefined,
							globalValue: undefined,
							workspaceValue: "CustomShell",
						}),
						get: () => undefined,
					} as any
				}
				if (section === "terminal.integrated.profiles") {
					return {
						inspect: (_key: string) => ({
							defaultValue: undefined,
							globalValue: undefined,
							workspaceValue: { CustomShell: { path: "/usr/bin/fish" } },
						}),
						get: () => undefined,
					} as any
				}
				return { get: () => undefined, inspect: () => undefined } as any
			}
			// No global profile → falls through to /bin/bash
			expect(getShell()).toBe("/bin/bash")
		})
	})

	// --------------------------------------------------------------------------
	// Non-string defaultProfileName Handling
	// --------------------------------------------------------------------------
	describe("Non-string defaultProfileName handling", () => {
		// Terminal.getConfiguredDefaultProfileName returns inspect().globalValue as-is.
		// If VS Code somehow stores a non-string, it will be undefined (inspect returns
		// typed as string | undefined), so getShell falls through to userInfo/env/fallback.

		it("Windows: handles undefined defaultProfileName (no profile set)", () => {
			Object.defineProperty(process, "platform", { value: "win32" })
			mockVsCodeConfig("windows", null, {})
			vi.mocked(existsSync).mockReturnValue(false)
			expect(getShell()).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
		})

		it("macOS: returns fallback when no profile is configured", () => {
			Object.defineProperty(process, "platform", { value: "darwin" })
			mockVsCodeConfig("osx", null, {})
			expect(getShell()).toBe("/bin/zsh")
		})

		it("Linux: returns fallback when no profile is configured", () => {
			Object.defineProperty(process, "platform", { value: "linux" })
			mockVsCodeConfig("linux", null, {})
			expect(getShell()).toBe("/bin/bash")
		})
	})

	// --------------------------------------------------------------------------
	// Shell Validation Tests
	// --------------------------------------------------------------------------
	describe("Shell Validation", () => {
		it("should allow common Windows shells", () => {
			Object.defineProperty(process, "platform", { value: "win32" })
			vi.mocked(existsSync).mockImplementation((p: any) => p === "C:\\Program Files\\PowerShell\\7\\pwsh.exe")
			mockVsCodeConfig("windows", "PowerShell", {
				PowerShell: { path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
			})
			expect(getShell()).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		})

		it("should allow common Unix shells", () => {
			Object.defineProperty(process, "platform", { value: "linux" })
			vi.mocked(existsSync).mockImplementation((p: any) => p === "/usr/bin/fish")
			mockVsCodeConfig("linux", "CustomProfile", {
				CustomProfile: { path: "/usr/bin/fish" },
			})
			expect(getShell()).toBe("/usr/bin/fish")
		})

		it("should handle case-insensitive matching on Windows", () => {
			Object.defineProperty(process, "platform", { value: "win32" })
			vi.mocked(existsSync).mockImplementation((p: any) => p === "c:\\windows\\system32\\cmd.exe")
			mockVsCodeConfig("windows", "PowerShell", {
				PowerShell: { path: "c:\\windows\\system32\\cmd.exe" },
			})
			expect(getShell()).toBe("c:\\windows\\system32\\cmd.exe")
		})

		it("should reject unknown shells and use fallback", () => {
			Object.defineProperty(process, "platform", { value: "linux" })
			vi.mocked(existsSync).mockImplementation((p: any) => p === "/usr/bin/malicious-shell")
			mockVsCodeConfig("linux", "CustomProfile", {
				CustomProfile: { path: "/usr/bin/malicious-shell" },
			})
			expect(getShell()).toBe("/bin/bash")
		})

		it("should resolve array shell paths and use first path", () => {
			Object.defineProperty(process, "platform", { value: "win32" })
			vi.mocked(existsSync).mockImplementation((p: any) => p === "C:\\Program Files\\PowerShell\\7\\pwsh.exe")
			mockVsCodeConfig("windows", "PowerShell", {
				PowerShell: { path: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "pwsh"] },
			})
			expect(getShell()).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		})

		it("should reject non-allowed shell paths and fall back to safe defaults", () => {
			Object.defineProperty(process, "platform", { value: "win32" })
			vi.mocked(existsSync).mockImplementation((p: any) => p === "C:\\malicious\\shell.exe")
			mockVsCodeConfig("windows", "Malicious", {
				Malicious: { path: "C:\\malicious\\shell.exe" },
			})
			process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe"
			expect(getShell()).toBe("C:\\Windows\\System32\\cmd.exe")
		})

		it("should validate shells from VS Code config", () => {
			Object.defineProperty(process, "platform", { value: "darwin" })
			vi.mocked(existsSync).mockImplementation((p: any) => p === "/usr/local/bin/custom-shell")
			mockVsCodeConfig("osx", "MyCustomShell", {
				MyCustomShell: { path: "/usr/local/bin/custom-shell" },
			})
			expect(getShell()).toBe("/bin/zsh") // not in allowlist → macOS fallback
		})

		it("should validate shells from userInfo", () => {
			Object.defineProperty(process, "platform", { value: "linux" })
			mockVsCodeConfig("linux", null, {})
			vi.mocked(userInfo).mockReturnValue({ shell: "/usr/bin/evil-shell" } as any)
			expect(getShell()).toBe("/bin/bash")
		})

		it("should validate shells from environment variables", () => {
			Object.defineProperty(process, "platform", { value: "linux" })
			mockVsCodeConfig("linux", null, {})
			vi.mocked(userInfo).mockReturnValue({ shell: null } as any)
			process.env.SHELL = "/opt/custom/shell"
			expect(getShell()).toBe("/bin/bash")
		})

		it("should handle WSL bash correctly", () => {
			Object.defineProperty(process, "platform", { value: "win32" })
			mockVsCodeConfig("windows", "WSL", {
				WSL: { source: "WSL" },
			})
			expect(getShell()).toBe("/bin/bash")
		})

		it("should handle empty or null shell paths", () => {
			Object.defineProperty(process, "platform", { value: "linux" })
			mockVsCodeConfig("linux", null, {})
			vi.mocked(userInfo).mockReturnValue({ shell: "" } as any)
			delete process.env.SHELL
			expect(getShell()).toBe("/bin/bash")
		})
	})

	// --------------------------------------------------------------------------
	// Zoo profile override (Terminal.getProfileShell) takes precedence
	// --------------------------------------------------------------------------
	describe("Zoo profile override", () => {
		it("uses Zoo profile shell over VS Code default profile", () => {
			Object.defineProperty(process, "platform", { value: "win32" })
			// VS Code default profile is PowerShell
			vi.mocked(existsSync).mockReturnValue(true)
			mockVsCodeConfig("windows", "PowerShell", {
				PowerShell: { path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
			})
			// Zoo profile override points to Git Bash
			Terminal.setTerminalProfile("Git Bash")
			vi.spyOn(Terminal, "getProfileShell").mockReturnValue({
				shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
			})
			expect(getShell()).toBe("C:\\Program Files\\Git\\bin\\bash.exe")
		})

		it("falls through to VS Code default when Zoo profile has no resolvable shell", () => {
			Object.defineProperty(process, "platform", { value: "win32" })
			vi.mocked(existsSync).mockImplementation((p) => String(p) === "C:\\Program Files\\PowerShell\\7\\pwsh.exe")
			mockVsCodeConfig("windows", "PowerShell", {
				PowerShell: { path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
			})
			Terminal.setTerminalProfile("Unresolvable")
			vi.spyOn(Terminal, "getProfileShell").mockReturnValue(undefined)
			expect(getShell()).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		})
	})

	// --------------------------------------------------------------------------
	// Explicit execa shell path takes highest precedence
	// --------------------------------------------------------------------------
	describe("Execa shell path override", () => {
		it("uses explicit execa shell path over VS Code config", () => {
			Object.defineProperty(process, "platform", { value: "win32" })
			vi.mocked(existsSync).mockReturnValue(true)
			mockVsCodeConfig("windows", "PowerShell", {
				PowerShell: { path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
			})
			BaseTerminal.setExecaShellPath("C:\\Program Files\\Git\\bin\\bash.exe")
			expect(getShell()).toBe("C:\\Program Files\\Git\\bin\\bash.exe")
		})

		it("uses explicit execa shell path over Zoo profile override", () => {
			Object.defineProperty(process, "platform", { value: "linux" })
			mockVsCodeConfig("linux", null, {})
			Terminal.setTerminalProfile("fish")
			vi.spyOn(Terminal, "getProfileShell").mockReturnValue({
				shellPath: "/usr/bin/fish",
			})
			BaseTerminal.setExecaShellPath("/bin/zsh")
			expect(getShell()).toBe("/bin/zsh")
		})

		it("falls through to VS Code config when execa shell path is not set", () => {
			Object.defineProperty(process, "platform", { value: "linux" })
			vi.mocked(existsSync).mockImplementation((p) => String(p) === "/usr/bin/fish")
			mockVsCodeConfig("linux", "fish", {
				fish: { path: "/usr/bin/fish" },
			})
			expect(getShell()).toBe("/usr/bin/fish")
		})

		it("rejects non-allowlisted execa shell path and uses fallback", () => {
			Object.defineProperty(process, "platform", { value: "linux" })
			mockVsCodeConfig("linux", null, {})
			BaseTerminal.setExecaShellPath("/opt/evil/shell")
			expect(getShell()).toBe("/bin/bash")
		})
	})
})
