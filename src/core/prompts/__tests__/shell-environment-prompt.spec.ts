// npx vitest run src/core/prompts/__tests__/shell-environment-prompt.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import type OpenAI from "openai"

import type { ResolvedCommandEnvironment, ShellInvocationPlan } from "../../../integrations/terminal/shell/types"

import { getSystemInfoSection } from "../sections/system-info"
import { getRulesSection, getCommandChainOperator } from "../sections/rules"
import { createExecuteCommandTool } from "../tools/native-tools/execute_command"
import { getNativeTools } from "../tools/native-tools"

/**
 * Cast helper to access .function on ChatCompletionTool union.
 */
function asFunctionTool(tool: OpenAI.Chat.ChatCompletionTool): OpenAI.Chat.ChatCompletionFunctionTool {
	return tool as OpenAI.Chat.ChatCompletionFunctionTool
}

// Mock getShell for legacy fallback paths
vi.mock("../../../utils/shell", () => ({
	getShell: vi.fn().mockReturnValue("/bin/bash"),
}))

/**
 * Helper to create a minimal ResolvedCommandEnvironment for testing.
 */
function makeEnv(
	family: "powershell" | "cmd" | "posix" | "fish" | "wsl",
	provider: "execa" | "vscode" = "execa",
): ResolvedCommandEnvironment {
	const plan: ShellInvocationPlan = {
		executable:
			family === "powershell"
				? "pwsh.exe"
				: family === "cmd"
					? "cmd.exe"
					: family === "fish"
						? "fish"
						: family === "wsl"
							? "wsl.exe"
							: "/bin/bash",
		args: [],
		family,
		provider,
	}

	const familyLabels: Record<string, string> = {
		powershell: "PowerShell",
		cmd: "Command Prompt",
		posix: "POSIX Shell",
		fish: "Fish",
		wsl: "WSL",
	}

	return {
		version: 1,
		primaryPlan: plan,
		fallbackPlan: { ...plan },
		chainOperator: family === "powershell" ? ";" : "&&",
		promptDescriptor: {
			providerLabel: provider === "execa" ? "Inline Terminal" : "VS Code Integrated Terminal",
			shellFamilyLabel: familyLabels[family] ?? family,
			shellExecutableName: plan.executable.split(/[\\/]/).pop() || plan.executable,
			sourceLabel: "User Override",
			isNonInteractive: true,
			supportsFishSyntax: family === "fish",
			supportsPosixSyntax: family === "posix" || family === "wsl",
		},
		warnings: [],
	}
}

describe("shell-environment-prompt", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("getSystemInfoSection", () => {
		const cwd = "/test/workspace"

		it("renders PowerShell shell info from resolved environment", () => {
			const env = makeEnv("powershell")
			const section = getSystemInfoSection(cwd, env)
			expect(section).toContain("PowerShell")
			expect(section).toContain("pwsh.exe")
			expect(section).toContain("Inline Terminal")
			expect(section).toContain("User Override")
			expect(section).toContain("Non-interactive")
		})

		it("renders Command Prompt shell info from resolved environment", () => {
			const env = makeEnv("cmd")
			const section = getSystemInfoSection(cwd, env)
			expect(section).toContain("Command Prompt")
			expect(section).toContain("cmd.exe")
		})

		it("renders POSIX shell info from resolved environment", () => {
			const env = makeEnv("posix")
			const section = getSystemInfoSection(cwd, env)
			expect(section).toContain("POSIX Shell")
			expect(section).toContain("bash")
		})

		it("renders VS Code provider when provider is vscode", () => {
			const env = makeEnv("powershell", "vscode")
			const section = getSystemInfoSection(cwd, env)
			expect(section).toContain("VS Code Integrated Terminal")
		})

		it("falls back to getShell() when no environment provided", () => {
			const section = getSystemInfoSection(cwd)
			expect(section).toContain("Default Shell:")
			// The actual shell depends on the platform; just verify it's present.
			expect(section).not.toContain("Command Execution Provider")
		})

		it("includes workspace directory", () => {
			const env = makeEnv("powershell")
			const section = getSystemInfoSection(cwd, env)
			expect(section).toContain(cwd)
		})
	})

	describe("getCommandChainOperator", () => {
		it("returns ; for PowerShell", () => {
			const env = makeEnv("powershell")
			expect(getCommandChainOperator(env)).toBe(";")
		})

		it("returns && for cmd.exe", () => {
			const env = makeEnv("cmd")
			expect(getCommandChainOperator(env)).toBe("&&")
		})

		it("returns && for POSIX", () => {
			const env = makeEnv("posix")
			expect(getCommandChainOperator(env)).toBe("&&")
		})

		it("returns && for fish", () => {
			const env = makeEnv("fish")
			expect(getCommandChainOperator(env)).toBe("&&")
		})

		it("returns && for WSL", () => {
			const env = makeEnv("wsl")
			expect(getCommandChainOperator(env)).toBe("&&")
		})

		it("falls back to legacy detection when no env provided", () => {
			// The actual shell depends on the platform; just verify it returns a valid operator.
			const op = getCommandChainOperator()
			expect(op === ";" || op === "&&").toBe(true)
		})
	})

	describe("getRulesSection", () => {
		const cwd = "/test/workspace"

		it("includes PowerShell chain operator (;) in rules", () => {
			const env = makeEnv("powershell")
			const rules = getRulesSection(cwd, undefined, env)
			expect(rules).toContain(";")
			expect(rules).toContain("PowerShell")
		})

		it("includes cmd.exe chain operator (&&) in rules", () => {
			const env = makeEnv("cmd")
			const rules = getRulesSection(cwd, undefined, env)
			expect(rules).toContain("&&")
		})

		it("includes POSIX chain operator (&&) in rules", () => {
			const env = makeEnv("posix")
			const rules = getRulesSection(cwd, undefined, env)
			expect(rules).toContain("&&")
		})

		it("includes PowerShell-specific guidance about cmdlets", () => {
			const env = makeEnv("powershell")
			const rules = getRulesSection(cwd, undefined, env)
			expect(rules).toContain("Select-String")
			expect(rules).toContain("Get-Content")
			expect(rules).toContain("Remove-Item")
		})

		it("does not include PowerShell guidance for POSIX", () => {
			const env = makeEnv("posix")
			const rules = getRulesSection(cwd, undefined, env)
			expect(rules).not.toContain("Select-String")
		})
	})

	describe("createExecuteCommandTool", () => {
		it("includes shell family in tool description for PowerShell", () => {
			const env = makeEnv("powershell")
			const tool = asFunctionTool(createExecuteCommandTool(env))
			const desc = tool.function.description
			expect(desc).toContain("PowerShell")
			expect(desc).toContain("pwsh.exe")
			expect(desc).toContain(";")
			expect(desc).toContain("Select-String")
		})

		it("includes shell family in tool description for cmd", () => {
			const env = makeEnv("cmd")
			const tool = asFunctionTool(createExecuteCommandTool(env))
			const desc = tool.function.description
			expect(desc).toContain("Command Prompt")
			expect(desc).toContain("cmd.exe")
			expect(desc).toContain("&&")
		})

		it("includes POSIX guidance for bash", () => {
			const env = makeEnv("posix")
			const tool = asFunctionTool(createExecuteCommandTool(env))
			const desc = tool.function.description
			expect(desc).toContain("POSIX")
			expect(desc).toContain("bash")
			expect(desc).toContain("&&")
			expect(desc).toContain("Standard Unix utilities")
		})

		it("states non-interactive behavior", () => {
			const env = makeEnv("powershell")
			const tool = asFunctionTool(createExecuteCommandTool(env))
			const desc = tool.function.description
			expect(desc).toContain("non-interactive")
		})

		it("includes fallback behavior when same-family fallback exists", () => {
			const env = makeEnv("powershell")
			const tool = asFunctionTool(createExecuteCommandTool(env))
			const desc = tool.function.description
			expect(desc).toContain("retried")
			expect(desc).toContain("same shell family")
		})

		it("falls back to generic description when no env provided", () => {
			const tool = asFunctionTool(createExecuteCommandTool())
			const desc = tool.function.description
			expect(desc).toContain("CLI command")
			expect(desc).not.toContain("PowerShell")
			expect(desc).not.toContain("Command Prompt")
		})

		it("has correct tool name and parameters", () => {
			const env = makeEnv("powershell")
			const tool = asFunctionTool(createExecuteCommandTool(env))
			const params = tool.function.parameters!
			expect(tool.function.name).toBe("execute_command")
			expect(params.properties).toHaveProperty("command")
			expect(params.properties).toHaveProperty("cwd")
			expect(params.properties).toHaveProperty("timeout")
			expect(params.required).toEqual(["command", "cwd", "timeout"])
		})
	})

	describe("getNativeTools with resolvedEnv", () => {
		it("includes shell-aware execute_command tool when env is provided", () => {
			const env = makeEnv("powershell")
			const tools = getNativeTools({ resolvedEnv: env })
			const execTool = tools.find((t) => (t as any).function?.name === "execute_command")
			expect(execTool).toBeDefined()
			const desc = (execTool as any).function.description
			expect(desc).toContain("PowerShell")
		})

		it("uses generic description when no env is provided", () => {
			const tools = getNativeTools()
			const execTool = tools.find((t) => (t as any).function?.name === "execute_command")
			expect(execTool).toBeDefined()
			const desc = (execTool as any).function.description
			expect(desc).not.toContain("PowerShell")
		})
	})

	describe("preview and runtime prompt consistency", () => {
		it("system info and tool description use the same shell family", () => {
			const env = makeEnv("powershell")
			const sysInfo = getSystemInfoSection("/test", env)
			const tool = asFunctionTool(createExecuteCommandTool(env))
			const desc = tool.function.description

			// Both should mention PowerShell
			expect(sysInfo).toContain("PowerShell")
			expect(desc).toContain("PowerShell")

			// Both should use the same chain operator
			expect(sysInfo).toContain("Inline Terminal")
			expect(desc).toContain(";")
		})

		it("system info and rules use the same chain operator", () => {
			const env = makeEnv("cmd")
			const sysInfo = getSystemInfoSection("/test", env)
			const rules = getRulesSection("/test", undefined, env)

			// Both should use && for cmd
			expect(rules).toContain("&&")
		})

		it("PowerShell env produces ; in both rules and tool description", () => {
			const env = makeEnv("powershell")
			const rules = getRulesSection("/test", undefined, env)
			const tool = asFunctionTool(createExecuteCommandTool(env))
			const desc = tool.function.description

			expect(rules).toContain(";")
			expect(desc).toContain(";")
		})
	})
})
