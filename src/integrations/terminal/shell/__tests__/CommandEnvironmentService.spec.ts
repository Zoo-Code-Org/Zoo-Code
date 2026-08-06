// npx vitest run src/integrations/terminal/shell/__tests__/CommandEnvironmentService.spec.ts

import { describe, expect, it, vi } from "vitest"

import { CommandEnvironmentService } from "../CommandEnvironmentService"
import type { ShellResolver, ShellResolverSettings } from "../ShellResolver"
import type { ResolvedCommandEnvironment, ResolvedShell, ShellResolutionResult } from "../types"

function makeShell(overrides: Partial<ResolvedShell> = {}): ResolvedShell {
	return {
		executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
		family: "powershell",
		displayName: "PowerShell 7",
		source: "userOverride",
		trustEvidence: "allowlist",
		...overrides,
	}
}

/**
 * Creates a ShellResolver test double. The resolve mock applies the
 * configured result factory so tests can exercise both success and
 * failure paths.
 */
function createResolverMock(
	resultFactory: (settings: ShellResolverSettings, cliOverride?: string) => ShellResolutionResult,
): ShellResolver {
	return {
		resolve: vi.fn(resultFactory),
		resolveExecutable: vi.fn(),
	} as unknown as ShellResolver
}

function makeSettings(overrides: Partial<Parameters<CommandEnvironmentService["getEnvironment"]>[0]> = {}) {
	return {
		terminalShellSelection: { kind: "path" as const, path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
		...overrides,
	}
}

describe("CommandEnvironmentService", () => {
	it("resolves a fresh environment on the first call", () => {
		const shell = makeShell()
		const resolver = createResolverMock(() => ({ ok: true, shell }))
		const service = new CommandEnvironmentService(resolver)

		const env = service.getEnvironment(makeSettings(), "/workspace")

		expect(resolver.resolve).toHaveBeenCalledTimes(1)
		expect(env.version).toBe(0)
		expect(env.primaryPlan.family).toBe("powershell")
		expect(env.primaryPlan.cwd).toBe("/workspace")
		expect(env.primaryPlan.provider).toBe("vscode")
		expect(env.chainOperator).toBe(";")
		expect(env.warnings).toEqual([])
	})

	it("returns the cached environment when the version has not changed", () => {
		const shell = makeShell()
		const resolver = createResolverMock(() => ({ ok: true, shell }))
		const service = new CommandEnvironmentService(resolver)

		const first = service.getEnvironment(makeSettings())
		const second = service.getEnvironment(makeSettings())

		expect(resolver.resolve).toHaveBeenCalledTimes(1)
		expect(second).toBe(first)
	})

	it("invalidates the cache after settings change", () => {
		const shell = makeShell()
		const resolver = createResolverMock(() => ({ ok: true, shell }))
		const service = new CommandEnvironmentService(resolver)

		service.getEnvironment(makeSettings())
		service.invalidate()
		const second = service.getEnvironment(makeSettings())

		expect(resolver.resolve).toHaveBeenCalledTimes(2)
		expect(second.version).toBe(1)
		expect(service.getVersion()).toBe(1)
	})

	it("uses execa provider when shell integration is disabled", () => {
		const shell = makeShell({ family: "posix", executable: "/bin/bash" })
		const resolver = createResolverMock(() => ({ ok: true, shell }))
		const service = new CommandEnvironmentService(resolver)

		const env = service.getEnvironment(makeSettings({ terminalShellIntegrationDisabled: true }))

		expect(env.primaryPlan.provider).toBe("execa")
		expect(env.fallbackPlan?.provider).toBe("execa")
	})

	it("uses execa provider for cmd.exe family even when shell integration is enabled", () => {
		const shell = makeShell({ family: "cmd", executable: "C:\\Windows\\System32\\cmd.exe" })
		const resolver = createResolverMock(() => ({ ok: true, shell }))
		const service = new CommandEnvironmentService(resolver)

		const env = service.getEnvironment(makeSettings({ terminalShellIntegrationDisabled: false }))

		expect(env.primaryPlan.provider).toBe("execa")
	})

	// -------------------------------------------------
	// Failure paths
	// -------------------------------------------------

	it("uses the fallback shell and records a warning when resolution fails with a fallback", () => {
		const fallback = makeShell({ family: "cmd", executable: "C:\\Windows\\System32\\cmd.exe", source: "safeFallback" })
		const resolver = createResolverMock(() => ({
			ok: false,
			error: { code: "SHELL_PATH_NOT_ALLOWED", message: "path not allowed" },
			fallback,
			rejectable: true,
		}))
		const service = new CommandEnvironmentService(resolver)

		const env = service.getEnvironment(makeSettings())

		expect(env.primaryPlan.family).toBe("cmd")
		expect(env.warnings).toHaveLength(1)
		expect(env.warnings[0]).toContain("SHELL_PATH_NOT_ALLOWED")
		expect(env.warnings[0]).toContain("Using fallback")
	})

	it("constructs an emergency fallback shell when resolution fails without a fallback", () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, "platform", { value: "win32" })
		try {
			const resolver = createResolverMock(() => ({
				ok: false,
				error: { code: "SHELL_PROFILE_NOT_FOUND", message: "profile missing" },
				rejectable: false,
			}))
			const service = new CommandEnvironmentService(resolver)

			const env = service.getEnvironment(makeSettings())

			expect(env.primaryPlan.executable).toBe("C:\\Windows\\System32\\cmd.exe")
			expect(env.primaryPlan.family).toBe("cmd")
			expect(env.warnings[0]).toContain("Using emergency fallback")
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform })
		}
	})

	it("constructs a posix emergency fallback on non-Windows platforms", () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, "platform", { value: "linux" })
		try {
			const resolver = createResolverMock(() => ({
				ok: false,
				error: { code: "SHELL_EXECUTABLE_NOT_FOUND", message: "missing" },
				rejectable: false,
			}))
			const service = new CommandEnvironmentService(resolver)

			const env = service.getEnvironment(makeSettings())

			expect(env.primaryPlan.executable).toBe("/bin/sh")
			expect(env.primaryPlan.family).toBe("posix")
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform })
		}
	})

	// -------------------------------------------------
	// Prompt descriptor construction
	// -------------------------------------------------

	it("builds a prompt descriptor for PowerShell with correct labels", () => {
		const shell = makeShell({
			family: "powershell",
			executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			source: "userOverride",
		})
		const resolver = createResolverMock(() => ({ ok: true, shell }))
		const service = new CommandEnvironmentService(resolver)

		const env = service.getEnvironment(makeSettings())

		expect(env.promptDescriptor.providerLabel).toBe("VS Code Integrated Terminal")
		expect(env.promptDescriptor.shellFamilyLabel).toBe("PowerShell")
		expect(env.promptDescriptor.shellExecutableName).toBe("pwsh.exe")
		expect(env.promptDescriptor.sourceLabel).toBe("User Override")
		expect(env.promptDescriptor.isNonInteractive).toBe(true)
		expect(env.promptDescriptor.supportsFishSyntax).toBe(false)
		expect(env.promptDescriptor.supportsPosixSyntax).toBe(false)
	})

	it("builds a prompt descriptor for a CLI override source", () => {
		const shell = makeShell({ family: "posix", executable: "/usr/bin/zsh", source: "cliOverride" })
		const resolver = createResolverMock(() => ({ ok: true, shell }))
		const service = new CommandEnvironmentService(resolver)

		const env = service.getEnvironment(makeSettings())

		expect(env.promptDescriptor.shellFamilyLabel).toBe("POSIX Shell")
		expect(env.promptDescriptor.shellExecutableName).toBe("zsh")
		expect(env.promptDescriptor.sourceLabel).toBe("CLI Override")
		expect(env.promptDescriptor.supportsPosixSyntax).toBe(true)
	})

	it("builds a prompt descriptor for WSL with posix syntax support", () => {
		const shell = makeShell({ family: "wsl", executable: "wsl.exe", source: "osDefault", distroName: "Ubuntu" })
		const resolver = createResolverMock(() => ({ ok: true, shell }))
		const service = new CommandEnvironmentService(resolver)

		const env = service.getEnvironment(makeSettings())

		expect(env.promptDescriptor.shellFamilyLabel).toBe("WSL")
		expect(env.promptDescriptor.shellExecutableName).toBe("wsl.exe")
		expect(env.promptDescriptor.sourceLabel).toBe("OS Default")
		expect(env.promptDescriptor.supportsPosixSyntax).toBe(true)
	})

	it("builds a prompt descriptor for fish with fish syntax support", () => {
		const shell = makeShell({ family: "fish", executable: "/usr/local/bin/fish", source: "safeFallback" })
		const resolver = createResolverMock(() => ({ ok: true, shell }))
		const service = new CommandEnvironmentService(resolver)

		const env = service.getEnvironment(makeSettings())

		expect(env.promptDescriptor.shellFamilyLabel).toBe("Fish")
		expect(env.promptDescriptor.shellExecutableName).toBe("fish")
		expect(env.promptDescriptor.sourceLabel).toBe("Safe Fallback")
		expect(env.promptDescriptor.supportsFishSyntax).toBe(true)
	})

	it("handles a profile source label", () => {
		const shell = makeShell({ family: "cmd", executable: "cmd.exe", source: "zooProfile", profileName: "Command Prompt" })
		const resolver = createResolverMock(() => ({ ok: true, shell }))
		const service = new CommandEnvironmentService(resolver)

		const env = service.getEnvironment(makeSettings())

		expect(env.promptDescriptor.sourceLabel).toBe("Zoo Code Profile")
		expect(env.promptDescriptor.shellExecutableName).toBe("cmd.exe")
	})

	it("maps a legacy source label", () => {
		const shell = makeShell({ family: "posix", executable: "/bin/bash", source: "legacyOverride" })
		const resolver = createResolverMock(() => ({ ok: true, shell }))
		const service = new CommandEnvironmentService(resolver)

		const env = service.getEnvironment(makeSettings())

		expect(env.promptDescriptor.sourceLabel).toBe("Legacy Setting")
	})

	it("maps a vscode default profile source label", () => {
		const shell = makeShell({ family: "posix", executable: "/bin/zsh", source: "vscodeDefaultProfile" })
		const resolver = createResolverMock(() => ({ ok: true, shell }))
		const service = new CommandEnvironmentService(resolver)

		const env = service.getEnvironment(makeSettings())

		expect(env.promptDescriptor.sourceLabel).toBe("VS Code Default Profile")
	})

	it("resolves the fallback plan with the same family", () => {
		const shell = makeShell()
		const resolver = createResolverMock(() => ({ ok: true, shell }))
		const service = new CommandEnvironmentService(resolver)

		const env = service.getEnvironment(makeSettings())

		expect(env.fallbackPlan).toBeDefined()
		expect(env.fallbackPlan?.family).toBe("powershell")
		expect(env.fallbackPlan?.provider).toBe("execa")
	})

	it("forwards settings to the resolver and passes the cliOverride", () => {
		const shell = makeShell()
		const resolveMock = vi.fn<ShellResolver["resolve"]>(() => ({ ok: true, shell }))
		const resolver = { resolve: resolveMock, resolveExecutable: vi.fn() } as unknown as ShellResolver
		const service = new CommandEnvironmentService(resolver)

		service.getEnvironment(makeSettings({ cliOverride: "/opt/shell" }), "/cwd")

		expect(resolveMock).toHaveBeenCalledTimes(1)
		const [settingsArg, cliArg] = resolveMock.mock.calls[0]
		expect(settingsArg).toMatchObject({
			terminalShellSelection: { kind: "path", path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
		})
		expect(cliArg).toBe("/opt/shell")
	})

	it("builds a stable ResolvedCommandEnvironment shape", () => {
		const shell = makeShell()
		const resolver = createResolverMock(() => ({ ok: true, shell }))
		const service = new CommandEnvironmentService(resolver)

		const env: ResolvedCommandEnvironment = service.getEnvironment(makeSettings(), "/w")

		expect(env).toMatchObject({
			version: 0,
			primaryPlan: {
				executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
				family: "powershell",
				cwd: "/w",
				provider: "vscode",
			},
			chainOperator: ";",
			warnings: [],
		})
	})
})
