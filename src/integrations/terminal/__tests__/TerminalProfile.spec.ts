// npx vitest run src/integrations/terminal/__tests__/TerminalProfile.spec.ts

import { existsSync } from "fs"

import * as vscode from "vscode"

import { Terminal } from "../Terminal"
import { TerminalRegistry } from "../TerminalRegistry"
import { ShellIntegrationManager } from "../ShellIntegrationManager"

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("fs", () => ({
	existsSync: vi.fn(() => false),
}))

const mockedExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>

describe("Terminal VS Code terminal profile (#277)", () => {
	// VS Code's getConfiguration/createTerminal are overloaded, so the precise
	// spy MockInstance type isn't worth fighting in a test — `any` keeps it simple.
	let getConfigurationSpy: any
	let createTerminalSpy: any

	const mockTerminal = () =>
		({
			exitStatus: undefined,
			name: "Roo Code",
			processId: Promise.resolve(123),
			creationOptions: {},
			state: { isInteractedWith: true },
			dispose: vi.fn(),
			hide: vi.fn(),
			show: vi.fn(),
			sendText: vi.fn(),
			shellIntegration: { executeCommand: vi.fn() },
		}) as any

	// Helper to stub `terminal.integrated.profiles.<platform>` config reads.
	const stubProfiles = (
		profilesByPlatform: Record<string, unknown>,
		workspaceProfilesByPlatform: Record<string, unknown> = {},
	) => {
		getConfigurationSpy = vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation((section?: string) => {
			if (section === "terminal.integrated.profiles") {
				return {
					inspect: (platformKey: string) => ({
						defaultValue: profilesByPlatform[platformKey],
						workspaceValue: workspaceProfilesByPlatform[platformKey],
					}),
				} as any
			}

			return { get: (_key: string, defaultValue?: unknown) => defaultValue } as any
		})
	}

	beforeEach(() => {
		createTerminalSpy = vi.spyOn(vscode.window, "createTerminal").mockImplementation(() => mockTerminal())
		// Default: explicit profile paths exist unless a test says otherwise.
		mockedExistsSync.mockReset()
		mockedExistsSync.mockReturnValue(true)
		// Reset to default (unset) before each test.
		Terminal.setTerminalProfile(undefined)
	})

	afterEach(() => {
		Terminal.setTerminalProfile(undefined)
		vi.restoreAllMocks()
	})

	describe("getTerminalProfile / setTerminalProfile", () => {
		it("defaults to undefined", () => {
			expect(Terminal.getTerminalProfile()).toBeUndefined()
		})

		it("stores a profile name", () => {
			Terminal.setTerminalProfile("Git Bash")
			expect(Terminal.getTerminalProfile()).toBe("Git Bash")
		})

		it("treats empty/whitespace strings as unset (default behavior)", () => {
			Terminal.setTerminalProfile("Git Bash")
			Terminal.setTerminalProfile("")
			expect(Terminal.getTerminalProfile()).toBeUndefined()

			Terminal.setTerminalProfile("   ")
			expect(Terminal.getTerminalProfile()).toBeUndefined()
		})
	})

	describe("getConfiguredProfiles / getAvailableProfileNames", () => {
		it("merges default and global profiles while ignoring workspace profiles", () => {
			getConfigurationSpy = vi
				.spyOn(vscode.workspace, "getConfiguration")
				.mockImplementation((section?: string) => {
					if (section === "terminal.integrated.profiles") {
						return {
							inspect: () => ({
								defaultValue: { bash: { path: "/bin/bash" } },
								globalValue: { zsh: { path: "/bin/zsh" } },
								workspaceValue: { malicious: { path: "/workspace/malicious-shell" } },
							}),
						} as any
					}

					return { get: (_key: string, defaultValue?: unknown) => defaultValue } as any
				})

			expect(Terminal.getConfiguredProfiles("linux")).toEqual({
				bash: { path: "/bin/bash" },
				zsh: { path: "/bin/zsh" },
			})
		})

		it("returns sorted names for profiles with resolvable paths only", () => {
			stubProfiles({
				linux: {
					zsh: { path: "/bin/zsh" },
					PowerShell: { source: "PowerShell" },
					bash: { path: "/bin/bash" },
					missing: { path: "/missing/bash" },
				},
			})
			mockedExistsSync.mockImplementation((profilePath: string) => profilePath !== "/missing/bash")

			expect(Terminal.getAvailableProfileNames("linux")).toEqual(["bash", "zsh"])
		})

		it("excludes cmd.exe profiles on Windows (shell integration unsupported)", () => {
			stubProfiles({
				windows: {
					"Command Prompt": { path: "C:\\Windows\\System32\\cmd.exe" },
					PowerShell: { path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
				},
			})

			expect(Terminal.getAvailableProfileNames("win32")).toEqual(["PowerShell"])
		})

		describe("isCmdExe", () => {
			it.each([
				["C:\\Windows\\System32\\cmd.exe", true],
				["C:\\WINDOWS\\SYSTEM32\\CMD.EXE", true],
				["/mnt/c/Windows/System32/cmd.exe", true],
				["/bin/bash", false],
				["pwsh.exe", false],
				["cmd", false],
			])("isCmdExe(%s) === %s", (input, expected) => {
				expect(Terminal.isCmdExe(input)).toBe(expected)
			})
		})

		describe("isActiveShellCmdExe", () => {
			it("returns false on non-Windows platforms", () => {
				expect(Terminal.isActiveShellCmdExe("linux")).toBe(false)
				expect(Terminal.isActiveShellCmdExe("darwin")).toBe(false)
			})

			it("returns true when profile override resolves to cmd.exe", () => {
				stubProfiles({ windows: { "Command Prompt": { path: "C:\\Windows\\System32\\cmd.exe" } } })
				Terminal.setTerminalProfile("Command Prompt")
				expect(Terminal.isActiveShellCmdExe("win32")).toBe(true)
			})

			it("returns false when profile override resolves to a non-cmd shell", () => {
				stubProfiles({ windows: { PowerShell: { path: "C:\\Program Files\\PowerShell\\pwsh.exe" } } })
				Terminal.setTerminalProfile("PowerShell")
				expect(Terminal.isActiveShellCmdExe("win32")).toBe(false)
			})

			it("returns true when no override and default profile is cmd.exe", () => {
				Terminal.setTerminalProfile(undefined)
				stubProfiles({ windows: { "Command Prompt": { path: "C:\\Windows\\System32\\cmd.exe" } } })
				getConfigurationSpy = vi
					.spyOn(vscode.workspace, "getConfiguration")
					.mockImplementation((section?: string) => {
						if (section === "terminal.integrated.profiles") {
							return {
								inspect: (_key: string) => ({
									defaultValue: { "Command Prompt": { path: "C:\\Windows\\System32\\cmd.exe" } },
									globalValue: undefined,
								}),
							} as any
						}
						if (section === "terminal.integrated") {
							return {
								get: (key: string) => (key === "defaultProfile.windows" ? "Command Prompt" : undefined),
							} as any
						}
						return { get: (_key: string, defaultValue?: unknown) => defaultValue } as any
					})
				expect(Terminal.isActiveShellCmdExe("win32")).toBe(true)
			})

			it("returns false when no override and default profile is PowerShell", () => {
				Terminal.setTerminalProfile(undefined)
				getConfigurationSpy = vi
					.spyOn(vscode.workspace, "getConfiguration")
					.mockImplementation((section?: string) => {
						if (section === "terminal.integrated.profiles") {
							return {
								inspect: (_key: string) => ({
									defaultValue: { PowerShell: { path: "C:\\Program Files\\PowerShell\\pwsh.exe" } },
									globalValue: undefined,
								}),
							} as any
						}
						if (section === "terminal.integrated") {
							return {
								get: (key: string) => (key === "defaultProfile.windows" ? "PowerShell" : undefined),
							} as any
						}
						return { get: (_key: string, defaultValue?: unknown) => defaultValue } as any
					})
				expect(Terminal.isActiveShellCmdExe("win32")).toBe(false)
			})

			it("returns false when no override and no default profile configured", () => {
				Terminal.setTerminalProfile(undefined)
				stubProfiles({})
				expect(Terminal.isActiveShellCmdExe("win32")).toBe(false)
			})
		})
	})

	describe("getProfileShell", () => {
		it("returns undefined when no profile is configured (default behavior preserved)", () => {
			stubProfiles({})
			expect(Terminal.getProfileShell("win32")).toBeUndefined()
		})

		it("resolves a Windows Git Bash profile to its shell path and args", () => {
			stubProfiles({
				windows: {
					"Git Bash": {
						path: "C:\\Program Files\\Git\\bin\\bash.exe",
						args: ["--login", "-i"],
					},
				},
			})

			Terminal.setTerminalProfile("Git Bash")

			expect(Terminal.getProfileShell("win32")).toEqual({
				shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
				shellArgs: ["--login", "-i"],
			})
		})

		it("preserves the profile's env and sanitizes non-string/null values", () => {
			stubProfiles({
				linux: {
					"Custom Bash": {
						path: "/bin/bash",
						env: { LANG: "en_US.UTF-8", UNSET_ME: null, BAD: 123 },
					},
				},
			})

			Terminal.setTerminalProfile("Custom Bash")

			expect(Terminal.getProfileShell("linux")).toEqual({
				shellPath: "/bin/bash",
				shellArgs: undefined,
				// `null` is preserved (unsets the var); the numeric `BAD` is dropped.
				env: { LANG: "en_US.UTF-8", UNSET_ME: null },
			})
		})

		it("picks the first existing path candidate when path is an array", () => {
			stubProfiles({
				windows: {
					"Git Bash": {
						path: ["C:\\missing\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe"],
					},
				},
			})
			// Only the second candidate exists on disk; VS Code would pick it.
			mockedExistsSync.mockImplementation((p: string) => p === "C:\\Program Files\\Git\\bin\\bash.exe")

			Terminal.setTerminalProfile("Git Bash")

			expect(Terminal.getProfileShell("win32")).toEqual({
				shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
				shellArgs: undefined,
			})
		})

		it("falls back to default when none of the path candidates exist", () => {
			stubProfiles({
				windows: {
					"Git Bash": {
						path: ["C:\\missing\\bash.exe", "C:\\also-missing\\bash.exe"],
					},
				},
			})
			mockedExistsSync.mockReturnValue(false)

			Terminal.setTerminalProfile("Git Bash")

			expect(Terminal.getProfileShell("win32")).toBeUndefined()
		})

		it("wraps a string args value into an array", () => {
			stubProfiles({
				linux: {
					bash: { path: "/bin/bash", args: "-l" },
				},
			})

			Terminal.setTerminalProfile("bash")

			expect(Terminal.getProfileShell("linux")).toEqual({
				shellPath: "/bin/bash",
				shellArgs: ["-l"],
			})
		})

		it("drops non-string args array entries", () => {
			stubProfiles({
				linux: {
					bash: { path: "/bin/bash", args: ["-l", 42, null] },
				},
			})

			Terminal.setTerminalProfile("bash")

			expect(Terminal.getProfileShell("linux")).toEqual({
				shellPath: "/bin/bash",
				shellArgs: ["-l"],
			})
		})

		it("reads the osx profile section on darwin", () => {
			stubProfiles({
				osx: { zsh: { path: "/bin/zsh" } },
			})

			Terminal.setTerminalProfile("zsh")

			expect(Terminal.getProfileShell("darwin")).toEqual({
				shellPath: "/bin/zsh",
				shellArgs: undefined,
			})
		})

		it("falls back to default when the configured profile is not found", () => {
			stubProfiles({ windows: { PowerShell: { path: "pwsh.exe" } } })

			Terminal.setTerminalProfile("Nonexistent")

			expect(Terminal.getProfileShell("win32")).toBeUndefined()
		})

		it("falls back to default when the profile has no resolvable path (source-only profile)", () => {
			stubProfiles({ windows: { PowerShell: { source: "PowerShell" } } })

			Terminal.setTerminalProfile("PowerShell")

			expect(Terminal.getProfileShell("win32")).toBeUndefined()
		})
	})

	describe("resolveProfilePath", () => {
		it("resolves a bare executable name through PATH", () => {
			mockedExistsSync.mockImplementation((p: string) => p === "/usr/local/bin/fish")

			expect(Terminal.resolveProfilePath("fish", "linux", { PATH: "/usr/bin:/usr/local/bin" })).toBe(
				"/usr/local/bin/fish",
			)
		})

		it("returns undefined when an executable cannot be found", () => {
			mockedExistsSync.mockReturnValue(false)

			expect(Terminal.resolveProfilePath("/missing/bash", "linux", { PATH: "/usr/bin" })).toBeUndefined()
		})
	})

	describe("createTerminal integration", () => {
		afterEach(() => {
			TerminalRegistry["terminals"] = []
		})

		it("does NOT pass shellPath/shellArgs when no profile is configured", () => {
			stubProfiles({})
			TerminalRegistry.createTerminal("/test/path", "vscode")

			const options = createTerminalSpy.mock.calls[0][0] as vscode.TerminalOptions
			expect(options.shellPath).toBeUndefined()
			expect(options.shellArgs).toBeUndefined()
		})

		it("passes the resolved shellPath/shellArgs when a profile is configured", () => {
			stubProfiles({
				[Terminal.getPlatformProfileKey(process.platform)]: {
					"Git Bash": { path: "/usr/bin/bash", args: ["-i"] },
				},
			})

			Terminal.setTerminalProfile("Git Bash")
			TerminalRegistry.createTerminal("/test/path", "vscode")

			const options = createTerminalSpy.mock.calls[0][0] as vscode.TerminalOptions
			expect(options.shellPath).toBe("/usr/bin/bash")
			expect(options.shellArgs).toEqual(["-i"])
		})

		it("falls back to VS Code defaults when a configured profile disappears", () => {
			stubProfiles({
				[Terminal.getPlatformProfileKey(process.platform)]: {
					"Git Bash": { path: "/missing/bash" },
				},
			})
			mockedExistsSync.mockReturnValue(false)

			Terminal.setTerminalProfile("Git Bash")
			TerminalRegistry.createTerminal("/test/path", "vscode")

			const options = createTerminalSpy.mock.calls[0][0] as vscode.TerminalOptions
			expect(options.shellPath).toBeUndefined()
			expect(options.shellArgs).toBeUndefined()
		})
	})

	describe("ZDOTDIR injection guard", () => {
		let zshInitTmpDirSpy: any

		beforeEach(() => {
			zshInitTmpDirSpy = vi
				.spyOn(ShellIntegrationManager, "zshInitTmpDir")
				.mockReturnValue("/tmp/roo-zdotdir-test")
			Terminal.setTerminalZdotdir(true)
		})

		afterEach(() => {
			Terminal.setTerminalZdotdir(false)
			Terminal.setTerminalProfile(undefined)
			TerminalRegistry["terminals"] = []
			vi.restoreAllMocks()
		})

		it("sets ZDOTDIR when zdotdir is enabled and no profile is configured", () => {
			stubProfiles({})
			const env = Terminal.getEnv()
			expect(zshInitTmpDirSpy).toHaveBeenCalledTimes(1)
			expect(env.ZDOTDIR).toBe("/tmp/roo-zdotdir-test")
		})

		it("skips ZDOTDIR when zdotdir is enabled but a profile is configured", () => {
			stubProfiles({
				[Terminal.getPlatformProfileKey(process.platform)]: {
					zsh: { path: "/bin/zsh" },
				},
			})
			Terminal.setTerminalProfile("zsh")
			const env = Terminal.getEnv()
			expect(zshInitTmpDirSpy).not.toHaveBeenCalled()
			expect(env.ZDOTDIR).toBeUndefined()
		})
	})
})
