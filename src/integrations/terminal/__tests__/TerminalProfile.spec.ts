// npx vitest run src/integrations/terminal/__tests__/TerminalProfile.spec.ts

import * as vscode from "vscode"

import { Terminal } from "../Terminal"
import { TerminalRegistry } from "../TerminalRegistry"

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

describe("Terminal inline terminal profile (#119)", () => {
	let getConfigurationSpy: ReturnType<typeof vi.spyOn>
	let createTerminalSpy: ReturnType<typeof vi.spyOn>

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
	const stubProfiles = (profilesByPlatform: Record<string, unknown>) => {
		getConfigurationSpy = vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation((section?: string) => {
			if (section === "terminal.integrated.profiles") {
				return {
					get: (platformKey: string) => profilesByPlatform[platformKey],
				} as any
			}

			return { get: (_key: string, defaultValue?: unknown) => defaultValue } as any
		})
	}

	beforeEach(() => {
		createTerminalSpy = vi.spyOn(vscode.window, "createTerminal").mockImplementation(() => mockTerminal())
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

		it("uses the first path candidate when path is an array", () => {
			stubProfiles({
				windows: {
					"Git Bash": {
						path: ["C:\\missing\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe"],
					},
				},
			})

			Terminal.setTerminalProfile("Git Bash")

			expect(Terminal.getProfileShell("win32")).toEqual({
				shellPath: "C:\\missing\\bash.exe",
				shellArgs: undefined,
			})
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
				[Terminal["getPlatformProfileKey"](process.platform)]: {
					"Git Bash": { path: "/usr/bin/bash", args: ["-i"] },
				},
			})

			Terminal.setTerminalProfile("Git Bash")
			TerminalRegistry.createTerminal("/test/path", "vscode")

			const options = createTerminalSpy.mock.calls[0][0] as vscode.TerminalOptions
			expect(options.shellPath).toBe("/usr/bin/bash")
			expect(options.shellArgs).toEqual(["-i"])
		})
	})
})
