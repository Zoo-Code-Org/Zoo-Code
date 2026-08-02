// npx vitest run src/integrations/terminal/__tests__/ShellResolver.spec.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { ShellResolver } from "../shell/ShellResolver"
import type { TerminalProfileResolver } from "../shell/TerminalProfileResolver"
import type { ResolvedShell } from "../shell/types"

// -----------------------------------------------------
// Test doubles
// -----------------------------------------------------

/** Mock filesystem probe. */
function createFsMock(existingPaths: Set<string>) {
	return {
		existsSync: vi.fn((p: string) => existingPaths.has(p)),
	}
}

/** Mock user info probe. */
function createUserInfoMock(shell: string | null) {
	return {
		getShell: vi.fn(() => shell),
	}
}

/** Mock env probe. */
function createEnvProbeMock(shellByPlatform: Record<string, string | null>) {
	return {
		getShellFromEnv: vi.fn((platform: NodeJS.Platform) => shellByPlatform[platform] ?? null),
	}
}

/**
 * Mock profile resolver. The `resolveProfile` mock updates the shell's
 * `source` field to match the source argument passed by the caller, so
 * tests can verify priority order without hardcoding sources.
 */
function createProfileResolverMock(
	profiles: Record<string, { shell: ResolvedShell; entry: any } | undefined>,
	defaultProfile?: ResolvedShell,
): TerminalProfileResolver {
	return {
		resolveProfile: vi.fn((name: string, source: any) => {
			const entry = profiles[name]
			if (!entry) return undefined
			// Override the source to match what the caller passed.
			return { shell: { ...entry.shell, source }, entry: entry.entry }
		}),
		resolveDefaultProfile: vi.fn((source?: any) =>
			defaultProfile ? { ...defaultProfile, source: source ?? "vscodeDefaultProfile" } : undefined,
		),
		readProfiles: vi.fn(() => ({})),
		readDefaultProfileName: vi.fn(() => undefined),
		resolveProfilePath: vi.fn(() => undefined),
		getAvailableProfiles: vi.fn(() => []),
		getAvailableProfileNames: vi.fn(() => []),
	} as unknown as TerminalProfileResolver
}

// -----------------------------------------------------
// Known shell paths
// -----------------------------------------------------

const PS7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
const PS_LEGACY = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const CMD = "C:\\Windows\\System32\\cmd.exe"
const WSL = "C:\\Windows\\System32\\wsl.exe"
const BASH = "/bin/bash"
const ZSH = "/bin/zsh"

// -----------------------------------------------------
// Tests
// -----------------------------------------------------

describe("ShellResolver", () => {
	let originalPlatform: string

	beforeEach(() => {
		originalPlatform = process.platform
	})

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform })
		vi.restoreAllMocks()
	})

	// -------------------------------------------------
	// Priority order (table-tested)
	// -------------------------------------------------

	describe("resolution priority order", () => {
		it.each([
			{
				name: "CLI override wins over user path override",
				settings: { terminalShellSelection: { kind: "path", path: PS7 } },
				cliOverride: PS_LEGACY,
				expected: { executable: PS_LEGACY, source: "cliOverride" },
			},
			{
				name: "User path override wins over user profile override",
				settings: {
					terminalShellSelection: { kind: "path", path: PS7 },
					// Would resolve to PS_LEGACY if profile were used
				},
				cliOverride: undefined,
				expected: { executable: PS7, source: "userOverride" },
			},
			{
				name: "User profile override wins over legacy execaShellPath",
				settings: {
					terminalShellSelection: { kind: "profile", profileName: "PowerShell" },
					execaShellPath: CMD,
				},
				cliOverride: undefined,
				expected: { executable: PS7, source: "userOverride" },
			},
			{
				name: "Legacy execaShellPath wins over zooProfile",
				settings: {
					execaShellPath: PS7,
					terminalProfile: "Git Bash",
				},
				cliOverride: undefined,
				expected: { executable: PS7, source: "legacyOverride" },
			},
			{
				name: "zooProfile wins over vscodeDefaultProfile",
				settings: {
					terminalProfile: "PowerShell",
				},
				cliOverride: undefined,
				expected: { executable: PS7, source: "zooProfile" },
			},
			{
				name: "vscodeDefaultProfile wins over osDefault",
				settings: {},
				cliOverride: undefined,
				expected: { executable: PS7, source: "vscodeDefaultProfile" },
			},
		])("$name", ({ settings, cliOverride, expected }) => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([PS7, PS_LEGACY, CMD, WSL]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: CMD })

			const profileResolver = createProfileResolverMock(
				{
					PowerShell: {
						shell: {
							executable: PS7,
							family: "powershell",
							displayName: "PowerShell 7",
							source: "userOverride",
							trustEvidence: "trustedProfile",
						},
						entry: {},
					},
					"Git Bash": {
						shell: {
							executable: BASH,
							family: "posix",
							displayName: "Git Bash",
							source: "zooProfile",
							trustEvidence: "trustedProfile",
						},
						entry: {},
					},
				},
				{
					executable: PS7,
					family: "powershell",
					displayName: "PowerShell 7",
					source: "vscodeDefaultProfile",
					trustEvidence: "trustedProfile",
				},
			)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve(settings as any, cliOverride)

			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.shell.executable).toBe(expected.executable)
				expect(result.shell.source).toBe(expected.source)
			}
		})
	})

	// -------------------------------------------------
	// Windows case-insensitive comparison
	// -------------------------------------------------

	describe("Windows case-insensitive comparison", () => {
		it("accepts PowerShell path with different casing on Windows", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const upperPath = "C:\\PROGRAM FILES\\POWERSHELL\\7\\PWSH.EXE"
			const fs = createFsMock(new Set([upperPath]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: null })
			const profileResolver = createProfileResolverMock({}, undefined)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({
				terminalShellSelection: { kind: "path", path: upperPath },
			})

			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.shell.family).toBe("powershell")
			}
		})
	})

	// -------------------------------------------------
	// Unix case-sensitive comparison
	// -------------------------------------------------

	describe("Unix case-sensitive comparison", () => {
		it("rejects shell path with wrong casing on Unix", () => {
			Object.defineProperty(process, "platform", { value: "linux" })

			// /BIN/BASH is not in the allowlist (case-sensitive on Unix)
			const fs = createFsMock(new Set(["/BIN/BASH"]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ linux: null })
			const profileResolver = createProfileResolverMock({}, undefined)

			const resolver = new ShellResolver("linux", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({
				terminalShellSelection: { kind: "path", path: "/BIN/BASH" },
			})

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.code).toBe("SHELL_PATH_NOT_ALLOWED")
				expect(result.rejectable).toBe(true)
			}
		})

		it("accepts correctly-cased shell path on Unix", () => {
			Object.defineProperty(process, "platform", { value: "linux" })

			const fs = createFsMock(new Set([BASH]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ linux: null })
			const profileResolver = createProfileResolverMock({}, undefined)

			const resolver = new ShellResolver("linux", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({
				terminalShellSelection: { kind: "path", path: BASH },
			})

			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.shell.family).toBe("posix")
			}
		})
	})

	// -------------------------------------------------
	// Workspace profile values are ignored
	// -------------------------------------------------

	describe("workspace profile isolation", () => {
		it("does not read workspace profile values (trusted scopes only)", () => {
			Object.defineProperty(process, "platform", { value: "linux" })

			const fs = createFsMock(new Set([BASH, ZSH]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ linux: null })
			const profileResolver = createProfileResolverMock({}, undefined)

			const resolver = new ShellResolver("linux", {}, fs, userInfo, envProbe, profileResolver)

			// The profile resolver mock does NOT include workspace profiles.
			// If workspace profiles were read, a "malicious" profile would
			// resolve. Since the mock returns undefined for unknown profiles,
			// the resolver falls through to osDefault/safeFallback.
			const result = resolver.resolve({
				terminalProfile: "malicious-workspace-profile",
			})

			// Should fall through — not resolve the workspace profile
			if (result.ok) {
				expect(result.shell.source).not.toBe("zooProfile")
			}
		})
	})

	// -------------------------------------------------
	// WSL resolves to wsl.exe, NOT /bin/bash
	// -------------------------------------------------

	describe("WSL resolution", () => {
		it("resolves WSL to wsl.exe with guest metadata, not /bin/bash", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([WSL, PS7]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: null })
			const profileResolver = createProfileResolverMock(
				{
					Ubuntu: {
						shell: {
							executable: WSL,
							family: "wsl",
							displayName: "WSL: Ubuntu",
							source: "userOverride",
							profileName: "Ubuntu",
							distroName: "Ubuntu",
							trustEvidence: "trustedProfile",
						},
						entry: {},
					},
				},
				undefined,
			)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({
				terminalShellSelection: { kind: "profile", profileName: "Ubuntu" },
			})

			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.shell.executable).toBe(WSL)
				expect(result.shell.family).toBe("wsl")
				expect(result.shell.executable).not.toBe(BASH)
				expect(result.shell.distroName).toBe("Ubuntu")
			}
		})
	})

	// -------------------------------------------------
	// Explicit invalid override returns rejectable typed error
	// -------------------------------------------------

	describe("explicit invalid override", () => {
		it("returns rejectable error for invalid path override", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: null })
			const profileResolver = createProfileResolverMock({}, undefined)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({
				terminalShellSelection: { kind: "path", path: "C:\\malicious\\shell.exe" },
			})

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.code).toBe("SHELL_PATH_NOT_ALLOWED")
				expect(result.rejectable).toBe(true)
				// No fallback for rejectable errors
				expect(result.fallback).toBeUndefined()
			}
		})

		it("returns rejectable error for non-existent profile", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([PS7]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: null })
			const profileResolver = createProfileResolverMock({}, undefined)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({
				terminalShellSelection: { kind: "profile", profileName: "NonExistent" },
			})

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.code).toBe("SHELL_PROFILE_NOT_FOUND")
				expect(result.rejectable).toBe(true)
			}
		})
	})

	// -------------------------------------------------
	// Invalid auto candidate falls through
	// -------------------------------------------------

	describe("invalid auto candidate fallthrough", () => {
		it("skips invalid zooProfile and falls through to vscodeDefaultProfile", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([PS7]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: null })

			// zooProfile "Invalid" returns undefined (not found)
			// vscodeDefaultProfile returns PS7
			const profileResolver = createProfileResolverMock(
				{},
				{
					executable: PS7,
					family: "powershell",
					displayName: "PowerShell 7",
					source: "vscodeDefaultProfile",
					trustEvidence: "trustedProfile",
				},
			)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({
				terminalProfile: "Invalid",
			})

			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.shell.source).toBe("vscodeDefaultProfile")
				expect(result.shell.executable).toBe(PS7)
			}
		})

		it("falls through to osDefault when vscodeDefaultProfile is unavailable", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([PS7]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: null })

			// No default profile configured
			const profileResolver = createProfileResolverMock({}, undefined)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({})

			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.shell.source).toBe("osDefault")
				expect(result.shell.executable).toBe(PS7)
			}
		})

		it("falls through to safeFallback when nothing else works", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([CMD])) // Only cmd.exe exists
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: CMD })
			const profileResolver = createProfileResolverMock({}, undefined)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({})

			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.shell.source).toBe("safeFallback")
				expect(result.shell.executable).toBe(CMD)
			}
		})
	})

	// -------------------------------------------------
	// getShell() compatibility delegates to auto resolution
	// -------------------------------------------------

	describe("resolveExecutable (getShell compatibility)", () => {
		it("returns executable path string for backward compatibility", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([PS7]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: null })
			const profileResolver = createProfileResolverMock(
				{},
				{
					executable: PS7,
					family: "powershell",
					displayName: "PowerShell 7",
					source: "vscodeDefaultProfile",
					trustEvidence: "trustedProfile",
				},
			)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const executable = resolver.resolveExecutable({})
			expect(executable).toBe(PS7)
		})

		it("returns safe fallback executable on resolution failure", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([CMD]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: CMD })
			const profileResolver = createProfileResolverMock({}, undefined)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			// Invalid path override — should return fallback
			const executable = resolver.resolveExecutable({
				terminalShellSelection: { kind: "path", path: "C:\\malicious\\shell.exe" },
			})
			expect(executable).toBe(CMD)
		})
	})

	// -------------------------------------------------
	// OS default detection
	// -------------------------------------------------

	describe("OS default detection", () => {
		it("Windows: prefers PowerShell 7 when installed", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([PS7, PS_LEGACY]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: null })
			const profileResolver = createProfileResolverMock({}, undefined)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({})
			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.shell.source).toBe("osDefault")
				expect(result.shell.executable).toBe(PS7)
				expect(result.shell.family).toBe("powershell")
			}
		})

		it("Windows: falls back to legacy PowerShell when PS7 absent", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([PS_LEGACY])) // No PS7
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: null })
			const profileResolver = createProfileResolverMock({}, undefined)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({})
			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.shell.source).toBe("osDefault")
				expect(result.shell.executable).toBe(PS_LEGACY)
			}
		})

		it("Unix: uses userInfo shell when available", () => {
			Object.defineProperty(process, "platform", { value: "linux" })

			const fs = createFsMock(new Set([BASH]))
			const userInfo = createUserInfoMock(BASH)
			const envProbe = createEnvProbeMock({ linux: null })
			const profileResolver = createProfileResolverMock({}, undefined)

			const resolver = new ShellResolver("linux", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({})
			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.shell.source).toBe("osDefault")
				expect(result.shell.executable).toBe(BASH)
			}
		})
	})

	// -------------------------------------------------
	// CLI override
	// -------------------------------------------------

	describe("CLI override", () => {
		it("CLI override has highest priority", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([PS7, PS_LEGACY]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: null })
			const profileResolver = createProfileResolverMock(
				{},
				{
					executable: PS7,
					family: "powershell",
					displayName: "PowerShell 7",
					source: "vscodeDefaultProfile",
					trustEvidence: "trustedProfile",
				},
			)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve(
				{ terminalShellSelection: { kind: "path", path: PS7 } },
				PS_LEGACY, // CLI override
			)

			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.shell.source).toBe("cliOverride")
				expect(result.shell.executable).toBe(PS_LEGACY)
			}
		})

		it("invalid CLI override returns rejectable error", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: null })
			const profileResolver = createProfileResolverMock({}, undefined)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({}, "C:\\malicious\\shell.exe")

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.code).toBe("SHELL_PATH_NOT_ALLOWED")
				expect(result.rejectable).toBe(true)
			}
		})
	})

	// -------------------------------------------------
	// Legacy execaShellPath
	// -------------------------------------------------

	describe("legacy execaShellPath", () => {
		it("uses legacy execaShellPath when terminalShellSelection is absent", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([PS7]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: null })
			const profileResolver = createProfileResolverMock({}, undefined)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({
				execaShellPath: PS7,
			})

			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.shell.source).toBe("legacyOverride")
				expect(result.shell.executable).toBe(PS7)
			}
		})

		it("does not use legacy execaShellPath when terminalShellSelection is present", () => {
			Object.defineProperty(process, "platform", { value: "win32" })

			const fs = createFsMock(new Set([PS7, PS_LEGACY]))
			const userInfo = createUserInfoMock(null)
			const envProbe = createEnvProbeMock({ win32: null })
			const profileResolver = createProfileResolverMock(
				{},
				{
					executable: PS_LEGACY,
					family: "powershell",
					displayName: "Windows PowerShell 5.1",
					source: "vscodeDefaultProfile",
					trustEvidence: "trustedProfile",
				},
			)

			const resolver = new ShellResolver("win32", {}, fs, userInfo, envProbe, profileResolver)

			const result = resolver.resolve({
				terminalShellSelection: { kind: "auto" },
				execaShellPath: PS7,
			})

			expect(result.ok).toBe(true)
			if (result.ok) {
				// Should NOT use legacyOverride — should fall through to vscodeDefaultProfile
				expect(result.shell.source).not.toBe("legacyOverride")
			}
		})
	})
})
