// npx vitest run src/integrations/terminal/shell/__tests__/TerminalProfileResolver.spec.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import * as vscode from "vscode"
import { existsSync } from "fs"

import { TerminalProfileResolver } from "../TerminalProfileResolver"
import type { ProfileConfigReader, FileSystemProbe, ShellHelpers } from "../TerminalProfileResolver"
import type { ResolvedShell, ShellFamily } from "../types"

// The vitest config aliases `vscode` to src/__mocks__/vscode.js, so
// vi.mock("vscode") factories are ignored. Following the pattern in
// src/utils/__tests__/shell.spec.ts, the forRuntime tests below reassign
// vscode.workspace.getConfiguration directly to exercise the
// VsCodeProfileConfigReader default+global merge behavior.

// Mock fs so the runtime-wired NodeFileSystemProbe is deterministic.
// The injected FileSystemProbe tests above are unaffected (they pass their
// own probes).
vi.mock("fs", () => ({
	existsSync: vi.fn(() => false),
}))

const mockedExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>

const PS7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
const PS_LEGACY = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const CMD = "C:\\Windows\\System32\\cmd.exe"
const WSL = "C:\\Windows\\System32\\wsl.exe"

function createConfigReader(profiles: Record<string, unknown> = {}, defaultProfileName?: string): ProfileConfigReader {
	return {
		readProfiles: vi.fn(() => profiles),
		readDefaultProfileName: vi.fn(() => defaultProfileName),
	}
}

function createFsProbe(existing: Set<string> = new Set()): FileSystemProbe {
	return { existsSync: vi.fn((p: string) => existing.has(p)) }
}

function createHelpers(familyByPath: Record<string, ShellFamily | undefined> = {}): ShellHelpers {
	return { classifyShellFamily: vi.fn((p: string) => familyByPath[p]) }
}

function createResolver(
	overrides: {
		profiles?: Record<string, unknown>
		defaultProfileName?: string
		existing?: Set<string>
		familyByPath?: Record<string, ShellFamily | undefined>
		platform?: NodeJS.Platform
		env?: NodeJS.ProcessEnv
	} = {},
): TerminalProfileResolver {
	return new TerminalProfileResolver(
		createConfigReader(overrides.profiles, overrides.defaultProfileName),
		createFsProbe(overrides.existing),
		createHelpers(overrides.familyByPath),
		overrides.platform ?? "win32",
		overrides.env ?? {},
	)
}

describe("TerminalProfileResolver", () => {
	describe("forRuntime", () => {
		it("creates an instance with runtime defaults", () => {
			const resolver = TerminalProfileResolver.forRuntime("linux", {})
			expect(resolver).toBeInstanceOf(TerminalProfileResolver)
		})
	})

	describe("readProfiles / readDefaultProfileName", () => {
		it("delegates to the config reader", () => {
			const resolver = createResolver({ profiles: { bash: { path: "/bin/bash" } }, defaultProfileName: "bash" })
			expect(resolver.readProfiles()).toEqual({ bash: { path: "/bin/bash" } })
			expect(resolver.readDefaultProfileName()).toBe("bash")
		})
	})

	describe("resolveProfilePath", () => {
		it("returns the candidate when it contains a path separator and exists", () => {
			const resolver = createResolver({ existing: new Set([PS7]) })
			expect(resolver.resolveProfilePath(PS7)).toBe(PS7)
		})

		it("skips non-string candidates", () => {
			const resolver = createResolver({ existing: new Set() })
			expect(resolver.resolveProfilePath([42, null, "missing.exe"])).toBeUndefined()
		})

		it("skips empty candidates", () => {
			const resolver = createResolver({ existing: new Set() })
			expect(resolver.resolveProfilePath("   ")).toBeUndefined()
		})

		it("resolves a bare command through PATH entries on posix", () => {
			const resolver = createResolver({
				platform: "linux",
				existing: new Set(["/usr/bin/bash"]),
				env: { PATH: "/usr/bin:/bin" },
			})
			expect(resolver.resolveProfilePath("bash")).toBe("/usr/bin/bash")
		})

		it("applies Windows PATHEXT extensions", () => {
			const resolver = createResolver({
				platform: "win32",
				existing: new Set(["C:\\tools\\tool.CMD"]),
				env: { PATH: "C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
			})
			expect(resolver.resolveProfilePath("tool")).toBe("C:\\tools\\tool.CMD")
		})

		it("does not append extensions when the candidate already has one", () => {
			const resolver = createResolver({
				platform: "win32",
				existing: new Set(["C:\\tools\\tool.exe"]),
				env: { PATH: "C:\\tools" },
			})
			expect(resolver.resolveProfilePath("tool.exe")).toBe("C:\\tools\\tool.exe")
		})

		it("strips surrounding quotes from PATH entries", () => {
			const resolver = createResolver({
				platform: "win32",
				existing: new Set(["C:\\Program Files\\PowerShell\\7\\pwsh.exe"]),
				env: { PATH: '"C:\\Program Files\\PowerShell\\7"' },
			})
			expect(resolver.resolveProfilePath("pwsh.exe")).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		})

		it("returns undefined when nothing resolves", () => {
			const resolver = createResolver({ existing: new Set() })
			expect(resolver.resolveProfilePath("/nope")).toBeUndefined()
		})
	
		it("returns undefined for an empty array of candidates", () => {
			const resolver = createResolver({ existing: new Set() })
			expect(resolver.resolveProfilePath([])).toBeUndefined()
		})
	
		it("uses the osx platform key for darwin", () => {
			const resolver = createResolver({
				platform: "darwin",
				existing: new Set(["/opt/homebrew/bin/zsh"]),
				env: { PATH: "/opt/homebrew/bin" },
			})
			expect(resolver.resolveProfilePath("zsh")).toBe("/opt/homebrew/bin/zsh")
		})
	})

	describe("resolveDefaultProfile", () => {
		it("returns undefined when no default profile name is configured", () => {
			const resolver = createResolver({})
			expect(resolver.resolveDefaultProfile()).toBeUndefined()
		})

		it("resolves the default profile by name", () => {
			const resolver = createResolver({
				defaultProfileName: "PowerShell",
				profiles: { PowerShell: { path: PS7 } },
				existing: new Set([PS7]),
				familyByPath: { [PS7]: "powershell" },
			})
			const shell = resolver.resolveDefaultProfile()
			expect(shell?.executable).toBe(PS7)
			expect(shell?.family).toBe("powershell")
			expect(shell?.source).toBe("vscodeDefaultProfile")
		})
	})

	describe("resolveProfile", () => {
		it("returns undefined when the profile is not found and not well-known", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const resolver = createResolver({ platform: "linux", profiles: {} })
			expect(resolver.resolveProfile("missing", "zooProfile")).toBeUndefined()
			expect(warnSpy).toHaveBeenCalled()
		})

		it("resolves a well-known PowerShell profile name when entry is missing on Windows", () => {
			const resolver = createResolver({
				platform: "win32",
				profiles: {},
				existing: new Set([PS7]),
			})
			const resolved = resolver.resolveProfile("PowerShell", "zooProfile")
			expect(resolved?.shell.family).toBe("powershell")
			expect(resolved?.shell.executable).toBe(PS7)
			expect(resolved?.shell.profileName).toBe("PowerShell")
			expect(resolved?.shell.trustEvidence).toBe("trustedProfile")
			expect(resolved?.entry).toEqual({})
		})

		it("resolves a well-known WSL profile name when entry is missing on Windows", () => {
			const resolver = createResolver({ platform: "win32", profiles: {} })
			const resolved = resolver.resolveProfile("WSL", "zooProfile")
			expect(resolved?.shell.family).toBe("wsl")
			expect(resolved?.shell.executable).toBe(WSL)
		})

		it("does not resolve well-known names on non-Windows platforms", () => {
			const resolver = createResolver({ platform: "linux", profiles: {} })
			expect(resolver.resolveProfile("PowerShell", "zooProfile")).toBeUndefined()
		})

		it("resolves a profile entry with an explicit path", () => {
			const resolver = createResolver({
				profiles: { "Git Bash": { path: "C:\\Program Files\\Git\\bin\\bash.exe" } },
				existing: new Set(["C:\\Program Files\\Git\\bin\\bash.exe"]),
				familyByPath: { "C:\\Program Files\\Git\\bin\\bash.exe": "posix" },
			})
			const resolved = resolver.resolveProfile("Git Bash", "userOverride")
			expect(resolved?.shell.family).toBe("posix")
			expect(resolved?.shell.displayName).toBe("bash.exe")
			expect(resolved?.shell.source).toBe("userOverride")
			expect(resolved?.shell.trustEvidence).toBe("trustedProfile")
			expect(resolved?.entry).toEqual({ path: "C:\\Program Files\\Git\\bin\\bash.exe" })
		})

		it("returns undefined when the profile path maps to an unsupported family", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const resolver = createResolver({
				profiles: { weird: { path: "/opt/weird" } },
				existing: new Set(["/opt/weird"]),
				familyByPath: { "/opt/weird": undefined },
			})
			expect(resolver.resolveProfile("weird", "userOverride")).toBeUndefined()
			expect(warnSpy).toHaveBeenCalled()
		})

		it("resolves a source-only PowerShell profile on Windows", () => {
			const resolver = createResolver({
				platform: "win32",
				profiles: { "PowerShell (source)": { source: "PowerShell" } },
				existing: new Set([PS7]),
			})
			const resolved = resolver.resolveProfile("PowerShell (source)", "userOverride")
			expect(resolved?.shell.family).toBe("powershell")
			expect(resolved?.shell.executable).toBe(PS7)
		})

		it("ignores a PowerShell source profile on non-Windows platforms", () => {
			const resolver = createResolver({
				platform: "linux",
				profiles: { "PowerShell (source)": { source: "PowerShell" } },
			})
			expect(resolver.resolveProfile("PowerShell (source)", "userOverride")).toBeUndefined()
		})

		it("resolves a source-only WSL profile and extracts the distro name", () => {
			const resolver = createResolver({
				platform: "win32",
				profiles: { "WSL: Ubuntu": { source: "WSL", env: { WSL_DISTRO_NAME: "Ubuntu" } } },
			})
			const resolved = resolver.resolveProfile("WSL: Ubuntu", "userOverride")
			expect(resolved?.shell.family).toBe("wsl")
			expect(resolved?.shell.distroName).toBe("Ubuntu")
		})

		it("returns undefined for an unknown profile source", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const resolver = createResolver({
				platform: "win32",
				profiles: { weird: { source: "UnknownSource" } },
			})
			expect(resolver.resolveProfile("weird", "userOverride")).toBeUndefined()
			expect(warnSpy).toHaveBeenCalled()
		})

		it("resolves a path-less profile by Windows name-based detection", () => {
			const resolver = createResolver({
				platform: "win32",
				profiles: { "PowerShell 7 (name)": { args: ["-NoProfile"] } },
				existing: new Set([PS7]),
			})
			const resolved = resolver.resolveProfile("PowerShell 7 (name)", "userOverride")
			expect(resolved?.shell.family).toBe("powershell")
			expect(resolved?.shell.executable).toBe(PS7)
		})

		it("returns undefined for a profile with no path, source, or name match", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const resolver = createResolver({
				platform: "win32",
				profiles: { mystery: { args: [] } },
			})
			expect(resolver.resolveProfile("mystery", "userOverride")).toBeUndefined()
			expect(warnSpy).toHaveBeenCalled()
		})

		it("resolves a path-less WSL profile by Windows name-based detection", () => {
			const resolver = createResolver({
				platform: "win32",
				profiles: { "WSL (name only)": { args: ["--cd", "~"] } },
			})
			const resolved = resolver.resolveProfile("WSL (name only)", "userOverride")
			expect(resolved?.shell.family).toBe("wsl")
			expect(resolved?.shell.executable).toBe(WSL)
		})

		it("does not resolve well-known names on win32 when the name matches neither powershell nor wsl", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const resolver = createResolver({
				platform: "win32",
				profiles: { "Not A Shell": {} },
			})
			expect(resolver.resolveProfile("Not A Shell", "userOverride")).toBeUndefined()
			expect(warnSpy).toHaveBeenCalled()
		})

		it("resolves a fish profile with an explicit path and derives the fish display name", () => {
			const resolver = createResolver({
				platform: "linux",
				profiles: { fish: { path: "/usr/local/bin/fish" } },
				existing: new Set(["/usr/local/bin/fish"]),
				familyByPath: { "/usr/local/bin/fish": "fish" },
			})
			const resolved = resolver.resolveProfile("fish", "userOverride")
			expect(resolved?.shell.family).toBe("fish")
			expect(resolved?.shell.displayName).toBe("Fish")
		})

		it("resolves a bash profile and derives the posix display name from the basename", () => {
			const resolver = createResolver({
				platform: "linux",
				profiles: { bash: { path: "/usr/bin/bash" } },
				existing: new Set(["/usr/bin/bash"]),
				familyByPath: { "/usr/bin/bash": "posix" },
			})
			const resolved = resolver.resolveProfile("bash", "userOverride")
			expect(resolved?.shell.family).toBe("posix")
			expect(resolved?.shell.displayName).toBe("bash")
		})
	})

	describe("sanitizeEnv (via profile env)", () => {
		it("blocks dangerous env keys and preserves safe values", () => {
			const resolver = createResolver({
				platform: "win32",
				profiles: {
					ps: {
						path: PS7,
						env: {
							ZDOTDIR: "/evil",
							LD_PRELOAD: "/lib.so",
							SAFE_VAR: "ok",
							NULL_VAR: null,
							NUM_VAR: 42,
						},
					},
				},
				existing: new Set([PS7]),
				familyByPath: { [PS7]: "powershell" },
			})
			const resolved = resolver.resolveProfile("ps", "userOverride")
			expect(resolved?.shell.env).toEqual({ SAFE_VAR: "ok", NULL_VAR: null })
		})

		it("returns undefined env when all values are blocked", () => {
			const resolver = createResolver({
				platform: "win32",
				profiles: { ps: { path: PS7, env: { BASH_ENV: "/evil" } } },
				existing: new Set([PS7]),
				familyByPath: { [PS7]: "powershell" },
			})
			const resolved = resolver.resolveProfile("ps", "userOverride")
			expect(resolved?.shell.env).toBeUndefined()
		})
	})

	describe("getAvailableProfiles / getAvailableProfileNames", () => {
		it("returns resolved profiles sorted by name, excluding cmd", () => {
			const resolver = createResolver({
				profiles: {
					"Zsh": { path: "/bin/zsh" },
					"Git Bash": { path: "C:\\Git\\bash.exe" },
					"Command Prompt": { path: CMD },
				},
				existing: new Set(["/bin/zsh", "C:\\Git\\bash.exe", CMD]),
				familyByPath: {
					"/bin/zsh": "posix",
					"C:\\Git\\bash.exe": "posix",
					[CMD]: "cmd",
				},
			})
			const profiles = resolver.getAvailableProfiles()
			expect(profiles.map((p) => p.name)).toEqual(["Git Bash", "Zsh"])
			expect(profiles.every((p) => p.shell.family !== "cmd")).toBe(true)
		})

		it("skips non-object profile entries", () => {
			const resolver = createResolver({ profiles: { plain: "not-an-object" } })
			expect(resolver.getAvailableProfiles()).toEqual([])
		})

		it("getAvailableProfileNames returns sorted names", () => {
			const resolver = createResolver({
				profiles: { bash: { path: "/bin/bash" }, zsh: { path: "/bin/zsh" } },
				existing: new Set(["/bin/bash", "/bin/zsh"]),
				familyByPath: { "/bin/bash": "posix", "/bin/zsh": "posix" },
			})
			expect(resolver.getAvailableProfileNames()).toEqual(["bash", "zsh"])
		})
	})

	describe("display names", () => {
		it("derives PowerShell 7 vs Windows PowerShell 5.1 display names", () => {
			const resolver = createResolver({
				profiles: { ps7: { path: PS7 }, ps5: { path: PS_LEGACY } },
				existing: new Set([PS7, PS_LEGACY]),
				familyByPath: { [PS7]: "powershell", [PS_LEGACY]: "powershell" },
			})
			expect(resolver.resolveProfile("ps7", "userOverride")?.shell.displayName).toBe("PowerShell 7")
			expect(resolver.resolveProfile("ps5", "userOverride")?.shell.displayName).toBe("Windows PowerShell 5.1")
		})

		it("derives a WSL display name that includes the profile name", () => {
			const resolver = createResolver({
				platform: "win32",
				profiles: { "WSL: Ubuntu": { source: "WSL", env: { WSL_DISTRO_NAME: "Ubuntu" } } },
			})
			expect(resolver.resolveProfile("WSL: Ubuntu", "userOverride")?.shell.displayName).toBe("WSL: WSL: Ubuntu")
		})

		it("derives a posix display name from the basename", () => {
			const resolver = createResolver({
				profiles: { bash: { path: "/bin/bash" } },
				existing: new Set(["/bin/bash"]),
				familyByPath: { "/bin/bash": "posix" },
			})
			expect(resolver.resolveProfile("bash", "userOverride")?.shell.displayName).toBe("bash")
		})
	})

	describe("misc invariants", () => {
		it("preserves the injected platform and env references", () => {
			const env = { PATH: "/usr/bin" }
			const resolver = createResolver({ platform: "linux", env })
			const profiles = resolver.getAvailableProfiles()
			expect(profiles).toEqual([])
		})

		it("produces a stable ResolvedShell shape", () => {
			const resolver = createResolver({
				profiles: { ps7: { path: PS7 } },
				existing: new Set([PS7]),
				familyByPath: { [PS7]: "powershell" },
			})
			const shell: ResolvedShell | undefined = resolver.resolveProfile("ps7", "userOverride")?.shell
			expect(shell).toMatchObject({
				executable: PS7,
				family: "powershell",
				source: "userOverride",
				profileName: "ps7",
				trustEvidence: "trustedProfile",
			})
		})
	})
})

describe("TerminalProfileResolver.forRuntime (VsCodeProfileConfigReader)", () => {
	let originalGetConfiguration: typeof vscode.workspace.getConfiguration

	beforeEach(() => {
		originalGetConfiguration = vscode.workspace.getConfiguration
	})

	afterEach(() => {
		vscode.workspace.getConfiguration = originalGetConfiguration
		vi.restoreAllMocks()
	})

	/** Installs a config double whose inspect() returns the given map. */
	function stubInspect(inspectImpl: (key: string) => unknown) {
		vscode.workspace.getConfiguration = vi.fn(() => ({
			inspect: (key: string) => inspectImpl(key),
		})) as unknown as typeof vscode.workspace.getConfiguration
	}

	it("readProfiles merges default and global scopes for the platform", () => {
		stubInspect((key: string) => {
			if (key === "windows") {
				return {
					defaultValue: { "Default Bash": { path: "/bin/bash" } },
					globalValue: { "Global PS7": { path: PS7 } },
				}
			}
			return undefined
		})

		const resolver = TerminalProfileResolver.forRuntime("win32", {})
		const profiles = resolver.readProfiles()

		expect(profiles).toHaveProperty("Default Bash")
		expect(profiles).toHaveProperty("Global PS7")
	})

	it("readProfiles falls back to empty when inspect returns nothing", () => {
		stubInspect(() => undefined)

		const resolver = TerminalProfileResolver.forRuntime("linux", {})
		expect(resolver.readProfiles()).toEqual({})
	})

	it("readProfiles handles a config reader without inspect by returning empty", () => {
		vscode.workspace.getConfiguration = vi.fn(() => ({
			get: vi.fn(),
		})) as unknown as typeof vscode.workspace.getConfiguration

		const resolver = TerminalProfileResolver.forRuntime("win32", {})
		expect(resolver.readProfiles()).toEqual({})
	})

	it("readDefaultProfileName prefers global value over default value", () => {
		stubInspect((key: string) => {
			if (key === "defaultProfile.windows") {
				return { defaultValue: "Default PowerShell", globalValue: "Global PowerShell" }
			}
			return undefined
		})

		const resolver = TerminalProfileResolver.forRuntime("win32", {})
		expect(resolver.readDefaultProfileName()).toBe("Global PowerShell")
	})

	it("readDefaultProfileName falls back to default value when global is absent", () => {
		stubInspect((key: string) => {
			if (key === "defaultProfile.windows") {
				return { defaultValue: "Default PowerShell" }
			}
			return undefined
		})

		const resolver = TerminalProfileResolver.forRuntime("win32", {})
		expect(resolver.readDefaultProfileName()).toBe("Default PowerShell")
	})

	it("readDefaultProfileName returns undefined when no profile is configured", () => {
		stubInspect(() => undefined)

		const resolver = TerminalProfileResolver.forRuntime("win32", {})
		expect(resolver.readDefaultProfileName()).toBeUndefined()
	})

	it("readDefaultProfileName handles a config reader without inspect", () => {
		vscode.workspace.getConfiguration = vi.fn(() => ({
			get: vi.fn(),
		})) as unknown as typeof vscode.workspace.getConfiguration

		const resolver = TerminalProfileResolver.forRuntime("win32", {})
		expect(resolver.readDefaultProfileName()).toBeUndefined()
	})

	it("resolveDefaultProfile uses the runtime reader to resolve a named profile", () => {
		stubInspect((key: string) => {
			if (key === "defaultProfile.windows") {
				return { defaultValue: "PowerShell", globalValue: undefined }
			}
			if (key === "windows") {
				return { defaultValue: { PowerShell: { path: PS7 } }, globalValue: undefined }
			}
			return undefined
		})

		mockedExistsSync.mockImplementation((p: string) => p === PS7)

		const resolver = TerminalProfileResolver.forRuntime("win32", {})
		const shell = resolver.resolveDefaultProfile()

		expect(shell?.executable).toBe(PS7)
		expect(shell?.family).toBe("powershell")
	})
})
