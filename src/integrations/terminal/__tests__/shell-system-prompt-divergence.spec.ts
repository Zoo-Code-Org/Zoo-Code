// Regression test for https://github.com/Zoo-Code-Org/Zoo-Code/issues/634
//
// When the user sets terminal.integrated.defaultProfile.windows in *workspace*
// settings, getShell() (used for the system prompt) picks it up via config.get()
// which merges all scopes, but Terminal.getConfiguredDefaultProfileName() only
// reads inspect().globalValue ?? inspect().defaultValue — intentionally excluding
// workspace for security.
//
// The result: the system prompt tells the model "you have PowerShell" but the
// actual terminal VS Code opens defaults to cmd.exe (or whatever VS Code picks
// when no global/default profile is set), so every PowerShell command fails.
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
	 *
	 * getShell() (shell.ts) uses getConfiguration("terminal.integrated").get() which
	 * returns the merged/effective value across all scopes — workspace value wins.
	 *
	 * Terminal.getConfiguredDefaultProfileName() uses inspect().globalValue ?? defaultValue,
	 * intentionally excluding workspace scope for security. Both undefined here.
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

	it("divergence: getShell() reports PowerShell but Terminal sees no profile when set at workspace scope only", () => {
		stubWorkspaceScopedProfile("PowerShell", "C:\\Program Files\\PowerShell\\7\\pwsh.exe")

		// getShell() uses config.get() → picks up workspace value → sees "PowerShell" name
		// → name-match path returns pwsh.exe (since existsSync mocked true for it)
		const shellForSystemPrompt = getShell()
		expect(shellForSystemPrompt).toContain("PowerShell")

		// Terminal.getConfiguredDefaultProfileName() uses inspect().globalValue → undefined
		const terminalSeesProfileName = Terminal.getConfiguredDefaultProfileName("win32")
		expect(terminalSeesProfileName).toBeUndefined()

		// Terminal therefore can't identify the active shell as PowerShell
		expect(Terminal.isActiveShellPowerShell("win32")).toBe(false)

		// Divergence: system prompt claims PowerShell, Terminal has no profile → falls
		// through to VS Code's own autodetect which may open cmd.exe on this machine.
	})
})
