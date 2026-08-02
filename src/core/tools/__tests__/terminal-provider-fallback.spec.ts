// npx vitest run src/core/tools/__tests__/terminal-provider-fallback.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { ResolvedCommandEnvironment, ShellInvocationPlan } from "../../../integrations/terminal/shell/types"
import { ShellIntegrationError } from "../../../integrations/terminal/types"

import {
	getTerminalProviderForExecution,
	canRetryShellIntegrationError,
	ShellFallbackMismatchError,
} from "../ExecuteCommandTool"

// Mock Terminal.isActiveShellCmdExe for the legacy path
vi.mock("../../../integrations/terminal/Terminal", () => ({
	Terminal: {
		isActiveShellCmdExe: vi.fn().mockReturnValue(false),
	},
}))

/**
 * Helper to create a minimal ResolvedCommandEnvironment for testing.
 */
function makeEnv(
	family: "powershell" | "cmd" | "posix" | "fish" | "wsl",
	provider: "execa" | "vscode" = "execa",
): ResolvedCommandEnvironment {
	const plan: ShellInvocationPlan = {
		executable: family === "powershell" ? "pwsh.exe" : family === "cmd" ? "cmd.exe" : "/bin/bash",
		args: [],
		family,
		provider,
	}

	const fallbackPlan: ShellInvocationPlan | undefined =
		family === "powershell"
			? { ...plan }
			: family === "cmd"
				? { ...plan, family: "powershell" as const } // cross-family fallback (mismatch)
				: undefined

	return {
		version: 1,
		primaryPlan: plan,
		fallbackPlan,
		chainOperator: family === "powershell" ? ";" : "&&",
		promptDescriptor: {
			providerLabel: provider === "execa" ? "Inline Terminal" : "VS Code Integrated Terminal",
			shellFamilyLabel: family,
			shellExecutableName: plan.executable,
			sourceLabel: "Test",
			isNonInteractive: true,
			supportsFishSyntax: family === "fish",
			supportsPosixSyntax: family === "posix" || family === "wsl",
		},
		warnings: [],
	}
}

describe("terminal-provider-fallback", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("getTerminalProviderForExecution", () => {
		describe("with resolved environment", () => {
			it("returns execa provider when primary plan is execa", () => {
				const env = makeEnv("powershell", "execa")
				const result = getTerminalProviderForExecution(false, env)
				expect(result.terminalProvider).toBe("execa")
				expect(result.isCmdExeFallback).toBe(false)
			})

			it("returns vscode provider when primary plan is vscode", () => {
				const env = makeEnv("powershell", "vscode")
				const result = getTerminalProviderForExecution(false, env)
				expect(result.terminalProvider).toBe("vscode")
				expect(result.isCmdExeFallback).toBe(false)
			})

			it("detects cmd.exe fallback when execa provider and cmd family", () => {
				const env = makeEnv("cmd", "execa")
				const result = getTerminalProviderForExecution(false, env)
				expect(result.terminalProvider).toBe("execa")
				expect(result.isCmdExeFallback).toBe(true)
			})

			it("does not flag cmd.exe fallback when vscode provider", () => {
				const env = makeEnv("cmd", "vscode")
				const result = getTerminalProviderForExecution(false, env)
				expect(result.terminalProvider).toBe("vscode")
				expect(result.isCmdExeFallback).toBe(false)
			})

			it("returns execa for posix family", () => {
				const env = makeEnv("posix", "execa")
				const result = getTerminalProviderForExecution(false, env)
				expect(result.terminalProvider).toBe("execa")
				expect(result.isCmdExeFallback).toBe(false)
			})
		})

		describe("without resolved environment (legacy path)", () => {
			it("returns execa when shell integration is disabled", () => {
				const result = getTerminalProviderForExecution(true)
				expect(result.terminalProvider).toBe("execa")
			})

			it("returns vscode when shell integration is enabled and not cmd.exe", () => {
				const result = getTerminalProviderForExecution(false)
				expect(result.terminalProvider).toBe("vscode")
			})
		})
	})

	describe("same-family fallback", () => {
		it("PowerShell primary has same-family PowerShell fallback", () => {
			const env = makeEnv("powershell", "execa")
			expect(env.fallbackPlan).toBeDefined()
			expect(env.fallbackPlan!.family).toBe("powershell")
			expect(env.fallbackPlan!.family).toBe(env.primaryPlan.family)
		})

		it("PowerShell fallback preserves shell syntax (same chain operator)", () => {
			const env = makeEnv("powershell", "execa")
			expect(env.chainOperator).toBe(";")
			expect(env.fallbackPlan!.family).toBe("powershell")
		})
	})

	describe("cross-family rejection (SHELL_FALLBACK_MISMATCH)", () => {
		it("cmd.exe primary with PowerShell fallback is a cross-family mismatch", () => {
			const env = makeEnv("cmd", "execa")
			// In our test helper, cmd's fallback is powershell (mismatch)
			expect(env.fallbackPlan).toBeDefined()
			expect(env.fallbackPlan!.family).not.toBe(env.primaryPlan.family)
		})

		it("ShellFallbackMismatchError carries correct family info", () => {
			const error = new ShellFallbackMismatchError("powershell", "cmd")
			expect(error.code).toBe("SHELL_FALLBACK_MISMATCH")
			expect(error.primaryFamily).toBe("powershell")
			expect(error.fallbackFamily).toBe("cmd")
			expect(error.message).toContain("SHELL_FALLBACK_MISMATCH")
			expect(error.message).toContain("powershell")
		})

		it("ShellFallbackMismatchError with no fallback plan", () => {
			const error = new ShellFallbackMismatchError("posix", undefined)
			expect(error.code).toBe("SHELL_FALLBACK_MISMATCH")
			expect(error.primaryFamily).toBe("posix")
			expect(error.fallbackFamily).toBeUndefined()
			expect(error.message).toContain("no fallback plan available")
		})
	})

	describe("post-submit failure never replays", () => {
		it("canRetryShellIntegrationError returns false when commandSubmitted is true", () => {
			const error = new ShellIntegrationError("test", true)
			expect(canRetryShellIntegrationError(error)).toBe(false)
		})

		it("canRetryShellIntegrationError returns true when commandSubmitted is false", () => {
			const error = new ShellIntegrationError("test", false)
			expect(canRetryShellIntegrationError(error)).toBe(true)
		})

		it("canRetryShellIntegrationError returns false for non-ShellIntegrationError", () => {
			expect(canRetryShellIntegrationError(new Error("generic"))).toBe(false)
		})

		it("canRetryShellIntegrationError returns false for null/undefined", () => {
			expect(canRetryShellIntegrationError(null)).toBe(false)
			expect(canRetryShellIntegrationError(undefined)).toBe(false)
		})
	})
})
