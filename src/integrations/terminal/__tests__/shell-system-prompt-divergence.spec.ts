// Regression test for https://github.com/Zoo-Code-Org/Zoo-Code/issues/634
//
// Root cause: getShell() (system prompt) used config.get() which merges all scopes
// including workspace, while Terminal.getConfiguredDefaultProfileName() used
// inspect().globalValue — intentionally excluding workspace scope for security.
// terminal.integrated.defaultProfile.* is APPLICATION-scoped; workspace values are
// technically accepted by VS Code but ignored by the terminal itself.
//
// Fix: getShell() now delegates to Terminal.getConfiguredDefaultProfileName() and
// Terminal.getConfiguredProfiles(), so both paths read the same inspect()-based values
// and can never disagree.
//
// Run: node_modules/.bin/vitest run integrations/terminal/__tests__/shell-system-prompt-divergence.spec.ts

import { existsSync } from "fs"
import * as vscode from "vscode"

vi.mock("execa", () => ({ execa: vi.fn() }))
vi.mock("fs", () => ({ existsSync: vi.fn(() => false) }))
vi.mock("os", () => ({ userInfo: vi.fn(() => ({ shell: null })) }))

const mockedExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>

const { Terminal } = await import("../Terminal")
const { getShell } = await import("../../../utils/shell")

describe("issue #634 — system prompt shell vs actual terminal shell divergence", () => {
	let originalPlatform: NodeJS.Platform

	beforeEach(() => {
		originalPlatform = process.platform
		Object.defineProperty(process, "platform", { value: "win32", configurable: true })
		Terminal.setTerminalProfile(undefined)
		mockedExistsSync.mockReset()
		// pwsh.exe exists — getShell() fallback path prefers PowerShell 7 over legacy
		mockedExistsSync.mockImplementation((p: string) => p === "C:\\Program Files\\PowerShell\\7\\pwsh.exe")
	})

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
		Terminal.setTerminalProfile(undefined)
		vi.restoreAllMocks()
	})

	/**
	 * Stubs VS Code config to simulate a workspace-scoped default profile.
	 * globalValue is undefined for both the profile name and profiles map,
	 * so Terminal (which reads only globalValue ?? defaultValue) sees no profile.
	 * The workspace-scoped value is present to verify it is correctly ignored.
	 */
	function stubWorkspaceScopedProfile(profileName: string, profilePath: string) {
		const profiles = { [profileName]: { path: profilePath } }
		vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation((section?: string) => {
			if (section === "terminal.integrated") {
				return {
					// get() merges all scopes — shell.ts uses this, picks up workspace value
					get: (key: string) => {
						if (key === "defaultProfile.windows") return profileName
						if (key === "profiles.windows") return profiles
						return undefined
					},
					// Terminal uses inspect() and only reads globalValue ?? defaultValue
					inspect: (_key: string) => ({
						defaultValue: undefined,
						globalValue: undefined,
						workspaceValue: profileName,
					}),
				} as unknown as vscode.WorkspaceConfiguration
			}

			if (section === "terminal.integrated.profiles") {
				return {
					inspect: (_key: string) => ({
						defaultValue: undefined,
						globalValue: undefined,
						workspaceValue: profiles,
					}),
				} as unknown as vscode.WorkspaceConfiguration
			}

			return {
				get: (_key: string, dv?: unknown) => dv,
				inspect: () => undefined,
			} as unknown as vscode.WorkspaceConfiguration
		})
	}

	it("Terminal.getConfiguredDefaultProfileName ignores workspace-scoped profile (confirms the bug)", () => {
		// User set PowerShell as default only in their workspace .vscode/settings.json
		stubWorkspaceScopedProfile("PowerShell", "C:\\Program Files\\PowerShell\\7\\pwsh.exe")

		// Terminal intentionally excludes workspace scope for security.
		// With no global/default profile set, it returns undefined.
		const terminalSeesProfileName = Terminal.getConfiguredDefaultProfileName("win32")
		expect(terminalSeesProfileName).toBeUndefined()

		// As a consequence, isActiveShellPowerShell returns false even though the
		// user configured PowerShell — the terminal will not be treated as PowerShell.
		expect(Terminal.isActiveShellPowerShell("win32")).toBe(false)
	})

	it("getShell() and Terminal agree on PowerShell when the default profile is set at global/user scope", () => {
		// When the profile is set at user (global) scope, both paths see the same value.
		const profilePath = "C:\\Program Files\\Git\\bin\\bash.exe" // non-PowerShell so name-matching doesn't hide the bug
		const profileName = "Git Bash"
		vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation((section?: string) => {
			if (section === "terminal.integrated") {
				return {
					get: (key: string) => {
						if (key === "defaultProfile.windows") return profileName
						if (key === "profiles.windows") return { [profileName]: { path: profilePath } }
						return undefined
					},
					inspect: (_key: string) => ({
						defaultValue: undefined,
						globalValue: profileName,
						workspaceValue: undefined,
					}),
				} as unknown as vscode.WorkspaceConfiguration
			}

			if (section === "terminal.integrated.profiles") {
				const profiles = { [profileName]: { path: profilePath } }
				return {
					inspect: (_key: string) => ({
						defaultValue: undefined,
						globalValue: profiles,
						workspaceValue: undefined,
					}),
				} as unknown as vscode.WorkspaceConfiguration
			}

			return {
				get: (_key: string, dv?: unknown) => dv,
				inspect: () => undefined,
			} as unknown as vscode.WorkspaceConfiguration
		})
		mockedExistsSync.mockImplementation((p: string) => p === profilePath)

		const shellForSystemPrompt = getShell()
		const terminalSeesProfileName = Terminal.getConfiguredDefaultProfileName("win32")

		// Both agree: Git Bash
		expect(terminalSeesProfileName).toBe(profileName)
		expect(shellForSystemPrompt).toBe(profilePath)
	})

	it("convergence: getShell() and Terminal both ignore a workspace-scoped-only profile (fix verification)", () => {
		// beforeEach mocks existsSync to return true only for PS7 path.
		// Here we want to test the no-profile fallback, so make existsSync return false.
		mockedExistsSync.mockReturnValue(false)
		stubWorkspaceScopedProfile("PowerShell", "C:\\Program Files\\PowerShell\\7\\pwsh.exe")

		// Terminal reads only inspect().globalValue → no profile configured at global scope.
		const terminalSeesProfileName = Terminal.getConfiguredDefaultProfileName("win32")
		expect(terminalSeesProfileName).toBeUndefined()

		// After the fix, getShell() delegates to Terminal's inspect()-based methods,
		// so it also sees no profile. It falls back to the Windows no-profile default
		// (PS legacy, since existsSync returns false for PS7 in this test).
		const shellForSystemPrompt = getShell()
		expect(shellForSystemPrompt).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")

		// Both paths agree: no profile resolved → no active shell identified as PowerShell.
		expect(Terminal.isActiveShellPowerShell("win32")).toBe(false)
	})
})
