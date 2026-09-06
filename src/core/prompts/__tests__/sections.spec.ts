import { addCustomInstructions } from "../sections/custom-instructions"
import { getCapabilitiesSection } from "../sections/capabilities"
import { getRulesSection, getCommandChainOperator } from "../sections/rules"
import { getSystemInfoSection } from "../sections/system-info"
import { getObjectiveSection } from "../sections/objective"
import { getToolUseGuidelinesSection } from "../sections/tool-use-guidelines"
import { getSkillsSection } from "../sections/skills"
import type { EffectiveToolPolicy } from "../tools/effective-tool-policy"
import { resolveEffectiveToolPolicy } from "../tools/effective-tool-policy"
import type { EffectiveToolPolicyInput } from "../tools/effective-tool-policy"
import type { GroupEntry, ModelInfo } from "@roo-code/types"
import { McpHub } from "../../../services/mcp/McpHub"
import type { CodeIndexManager } from "../../../services/code-index/manager"
import type { SkillsManager } from "../../../services/skills/SkillsManager"
import * as shellUtils from "../../../utils/shell"

// Mock os-name so getSystemInfoSection never spawns PowerShell on Windows (cold
// launches can exceed the CI test timeout). Matches the form used in
// sections/__tests__/system-info.spec.ts, but returns a constant since no test
// here asserts on the OS string itself.
vi.mock("os-name", () => ({
	default: vi.fn(() => "MockOS"),
}))

/**
 * Build an {@link EffectiveToolPolicy} for arbitrary mode groups. `mode` is the
 * custom-mode slug so the resolver derives everything from `groups` (never from
 * built-in names), which keeps assertions mode-neutral.
 */
function policyFor(
	groups: GroupEntry[],
	extra: Partial<{
		mcpHub: McpHub
		disabledTools: string[]
		modelInfo: ModelInfo
		experiments: Record<string, boolean>
		todoListEnabled: boolean
		codeIndexManager: CodeIndexManager
		allowedMcpServers: string[]
	}> = {},
): EffectiveToolPolicy {
	return resolveEffectiveToolPolicy({
		mode: "p",
		customModes: [{ slug: "p", name: "Policy Under Test", roleDefinition: "", groups }],
		...extra,
	})
}

/** Minimal McpHub stub. `tools`/`resources` mirror the McpServer shape the resolver reads. */
function makeMcpHub(servers: Array<{ name: string; tools?: unknown[]; resources?: unknown[] }>): McpHub {
	return { getServers: () => servers } as unknown as McpHub
}

/** Minimal SkillsManager stub returning a fixed skill list. */
function makeSkillsManager(n: number): SkillsManager {
	return {
		getSkillsForMode: () =>
			Array.from({ length: n }, (_, i) => ({
				name: `skill-${i}`,
				description: `Skill ${i}`,
				path: `./skills/${i}`,
			})),
	} as unknown as SkillsManager
}

describe("addCustomInstructions", () => {
	it("adds vscode language to custom instructions", async () => {
		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/test/path",
			"test-mode",
			{ language: "fr" },
		)

		expect(result).toContain("Language Preference:")
		expect(result).toContain('You should always speak and think in the "Français" (fr) language')
	})

	it("works without vscode language", async () => {
		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/test/path",
			"test-mode",
		)

		expect(result).not.toContain("Language Preference:")
		expect(result).not.toContain("You should always speak and think in")
	})
})

describe("getCapabilitiesSection", () => {
	it("includes standard clauses for a full-tool mode", () => {
		const result = getCapabilitiesSection(policyFor(["read", "edit", "command"]))

		expect(result).toContain("CAPABILITIES")
		expect(result).toContain("execute CLI commands on the user's computer")
		expect(result).toContain("list files")
		expect(result).toContain("read files")
		expect(result).toContain("write and edit files")
		// the task tail is a plain sentence — assert no over-claiming enumeration
		expect(result).not.toContain("such as writing code")
	})

	it("uses the fallback sentence when zero per-tool clauses exist", () => {
		// control-tools-only mode: only switch_mode/new_task remain (no read/edit/command clauses)
		const result = getCapabilitiesSection(policyFor(["modes"]))

		expect(result).toContain("You have access to a limited set of tools for this mode")
		expect(result).not.toContain("You have access to tools that let you")
	})

	it("emits the edit-restriction suffix when the mode declares a fileRegex", () => {
		const result = getCapabilitiesSection(
			policyFor(["read", ["edit", { fileRegex: "\\.md$", description: "Markdown files only" }]]),
		)

		expect(result).toContain("only files matching")
		expect(result).toContain("\\.md$")
		expect(result).toContain("Markdown files only")
		// The suffix binds to the capability sentence, not the last emitted bullet.
		expect(result).toContain(
			"You have access to tools that let you list files, regex search, read files, write and edit files. (in this mode only files matching '\\.md$' can be edited — Markdown files only)",
		)
	})

	it("keeps the edit-restriction suffix off the MCP bullet when MCP is active", () => {
		// With the mcp group + an enabled MCP server the MCP bullet is the last
		// bullet; the restriction suffix must stay on the capability sentence.
		const result = getCapabilitiesSection(
			policyFor(["read", ["edit", { fileRegex: "\\.md$" }], "mcp"], {
				mcpHub: makeMcpHub([{ name: "s", tools: [{ name: "t", description: "d" }] }]),
			}),
		)

		expect(result).toContain("MCP servers")
		expect(result).not.toContain("accomplish tasks more effectively. (in this mode")
		expect(result).toContain("write and edit files. (in this mode only files matching")
	})

	it("omits the edit-restriction suffix without a fileRegex", () => {
		const result = getCapabilitiesSection(policyFor(["read", "edit"]))
		expect(result).not.toContain("only files matching")
	})

	it("lists files guidance only when list_files is available", () => {
		const withListFiles = getCapabilitiesSection(policyFor(["read"]))
		expect(withListFiles).toContain("you can use the list_files tool")
		// the file-tree *fact* lives in SYSTEM INFORMATION, not CAPABILITIES
		expect(withListFiles).not.toContain("a recursive list of all filepaths")

		const withoutListFiles = getCapabilitiesSection(policyFor(["command"]))
		expect(withoutListFiles).not.toContain("you can use the list_files tool")
	})

	it("only emits the execute_command paragraph when execute_command is available", () => {
		const withCmd = getCapabilitiesSection(policyFor(["command"]))
		expect(withCmd).toContain("You can use the execute_command tool")

		const withoutCmd = getCapabilitiesSection(policyFor(["read"]))
		expect(withoutCmd).not.toContain("You can use the execute_command tool")
	})

	it("emits the MCP bullet only when the mode has the mcp group AND effective MCP availability", () => {
		// mcp group, server with a prompt-enabled tool -> present
		const hasTools = getCapabilitiesSection(
			policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s", tools: [{ name: "t", description: "d" }] }]) }),
		)
		expect(hasTools).toContain("MCP servers")

		// mcp group, server with no tools but a resource -> present via resources
		const hasResources = getCapabilitiesSection(
			policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s", resources: [{ uri: "x" }] }]) }),
		)
		expect(hasResources).toContain("MCP servers")

		// mcp group, empty server (no tools, no resources) -> absent
		const nothing = getCapabilitiesSection(policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s" }]) }))
		expect(nothing).not.toContain("MCP servers")

		// no mcp group -> absent even with a working server
		const noGroup = getCapabilitiesSection(
			policyFor(["read"], { mcpHub: makeMcpHub([{ name: "s", tools: [{ name: "t", description: "d" }] }]) }),
		)
		expect(noGroup).not.toContain("MCP servers")
	})

	it("omits the MCP bullet when every tool is enabledForPrompt:false and no resources exist", () => {
		const result = getCapabilitiesSection(
			policyFor(["mcp"], {
				mcpHub: makeMcpHub([{ name: "s", tools: [{ name: "t", description: "d", enabledForPrompt: false }] }]),
			}),
		)
		expect(result).not.toContain("MCP servers")
	})

	it("omits the MCP bullet when a disallowed server is the only one with tools/resources", () => {
		const result = getCapabilitiesSection(
			policyFor(["mcp"], {
				mcpHub: makeMcpHub([
					{ name: "allowed", tools: [] },
					{ name: "blocked", tools: [{ name: "t", description: "d" }], resources: [{ uri: "x" }] },
				]),
				allowedMcpServers: [],
			}),
		)
		expect(result).not.toContain("MCP servers")
	})

	it("includes the MCP bullet for an allowed server under an allowlist", () => {
		const result = getCapabilitiesSection(
			policyFor(["mcp"], {
				mcpHub: makeMcpHub([{ name: "allowed", tools: [{ name: "t", description: "d" }] }]),
				allowedMcpServers: ["allowed"],
			}),
		)
		expect(result).toContain("MCP servers")
	})
})

describe("getRulesSection", () => {
	const cwd = "/test/path"

	const settings = {
		todoListEnabled: true,
		useAgentRules: true,
		newTaskRequireTodos: false,
	}

	it("includes standard rules", () => {
		const result = getRulesSection(cwd, settings, policyFor(["read", "edit", "command"]))

		expect(result).toContain("RULES")
		expect(result).toContain("project base directory")
		expect(result).toContain(cwd)
	})

	it("includes vendor confidentiality section when isStealthModel is true", () => {
		const stealthSettings = { ...settings, isStealthModel: true }
		const result = getRulesSection(cwd, stealthSettings, policyFor(["read", "edit", "command"]))

		expect(result).toContain("VENDOR CONFIDENTIALITY")
		expect(result).toContain("Never reveal the vendor or company that created you")
		expect(result).toContain("I was created by a team of developers")
		expect(result).toContain("I'm an open-source project maintained by contributors")
		expect(result).toContain("I don't have information about specific vendors")
	})

	it("excludes vendor confidentiality section when isStealthModel is false", () => {
		const stealthSettings = { ...settings, isStealthModel: false }
		const result = getRulesSection(cwd, stealthSettings, policyFor(["read", "edit", "command"]))

		expect(result).not.toContain("VENDOR CONFIDENTIALITY")
		expect(result).not.toContain("Never reveal the vendor or company")
	})

	it("excludes vendor confidentiality section when isStealthModel is undefined", () => {
		const result = getRulesSection(cwd, settings, policyFor(["read", "edit", "command"]))

		expect(result).not.toContain("VENDOR CONFIDENTIALITY")
		expect(result).not.toContain("Never reveal the vendor or company")
	})

	it("omits the execute_command bullet when execute_command is absent", () => {
		const result = getRulesSection(cwd, settings, policyFor(["read"]))

		expect(result).not.toContain("Before using the execute_command tool")
		expect(result).not.toContain("Actively Running Terminals")
		// the terminal-aware "working directory" clause is gone too
		expect(result).not.toContain("commands may change directories in terminals")
		// but the base path rule stays
		expect(result).toContain("All file paths must be relative to this directory")
	})

	it("includes the execute_command bullet when execute_command is present", () => {
		const result = getRulesSection(cwd, settings, policyFor(["command"]))

		expect(result).toContain("Before using the execute_command tool")
		expect(result).toContain("Actively Running Terminals")
	})

	it("does not contain the removed hardcoded architect example line", () => {
		const result = getRulesSection(cwd, settings, policyFor(["read", "edit", "command"]))

		expect(result).not.toContain("in architect mode")
		expect(result).not.toContain("trying to edit app.js")
	})

	it("uses ask_followup_question when the tool is available", () => {
		const result = getRulesSection(cwd, settings, policyFor(["read"]))
		expect(result).toContain("ask the user questions using the ask_followup_question tool")
	})

	it("uses the replacement bullet when ask_followup_question is absent", () => {
		// Both sub-cases — list_files present and list_files absent — take the single
		// best-effort replacement bullet, emitted exactly when ask_followup_question is absent.
		const withListFiles = getRulesSection(
			cwd,
			settings,
			policyFor(["read"], { disabledTools: ["ask_followup_question"] }),
		)
		expect(withListFiles).toContain("Provide your best-effort result and state your assumptions")
		expect(withListFiles).not.toContain(
			"You are only allowed to ask the user questions using the ask_followup_question tool",
		)
		expect(withListFiles).not.toContain("enumerate the filesystem yourself")

		const withoutListFiles = getRulesSection(
			cwd,
			settings,
			policyFor(["edit", "command"], { disabledTools: ["ask_followup_question", "list_files"] }),
		)
		expect(withoutListFiles).toContain("Provide your best-effort result and state your assumptions")
		expect(withoutListFiles).not.toContain(
			"You are only allowed to ask the user questions using the ask_followup_question tool",
		)
		expect(withoutListFiles).not.toContain("enumerate the filesystem yourself")
	})

	it("uses the fallback phrasing in the terminal-output rule when ask_followup_question is absent", () => {
		// The execute_command bullet is always present, but its tail must not reference a disabled tool.
		const withoutAsk = getRulesSection(
			cwd,
			settings,
			policyFor(["command"], { disabledTools: ["ask_followup_question"] }),
		)
		expect(withoutAsk).toContain("When executing commands")
		expect(withoutAsk).not.toContain("ask_followup_question")

		const withAsk = getRulesSection(cwd, settings, policyFor(["command"]))
		expect(withAsk).toContain(
			"use the ask_followup_question tool to request the user to copy and paste it back to you",
		)
	})

	it("omits the read_file rule when read_file is absent", () => {
		const result = getRulesSection(cwd, settings, policyFor(["command"]))
		expect(result).not.toContain("The user may provide a file's contents directly")
	})

	it("includes the read_file rule when read_file is present", () => {
		const result = getRulesSection(cwd, settings, policyFor(["read"]))
		expect(result).toContain("The user may provide a file's contents directly")
	})

	it("keeps a stable RULES baseline", () => {
		// duplicate guard: ensure the describe still asserts a stable baseline even if other tests change
		const result = getRulesSection(cwd, settings, policyFor(["read", "edit", "command"]))
		expect(result).toContain("RULES")
	})

	it("states the attempt_completion protocol rule unconditionally", () => {
		// The completion sentence is protocol wording — emitted even when the policy
		// does not advertise attempt_completion. A raw literal is required: the
		// resolver-backed policyFor cannot express this (protocol guarantee re-adds the
		// tool in resolveEffectiveToolPolicy step 11).
		const rawPolicy: EffectiveToolPolicy = {
			tools: new Set<string>(["read_file"]),
			hasMcpGroup: false,
			hasMcpTools: false,
			hasMcpResources: false,
		}

		expect(rawPolicy.tools.has("attempt_completion")).toBe(false)
		expect(getRulesSection(cwd, settings, rawPolicy)).toContain(
			"you must use the attempt_completion tool to present the result to the user",
		)
	})
})

describe("getSystemInfoSection", () => {
	const cwd = "/some/real/path"

	it("keeps the header lines", () => {
		const result = getSystemInfoSection(cwd, policyFor(["read", "edit", "command"]))
		expect(result).toContain("SYSTEM INFORMATION")
		expect(result).toContain("Operating System:")
		expect(result).toContain("Default Shell:")
		expect(result).toContain("Home Directory:")
		expect(result).toContain(`Current Workspace Directory: ${cwd}`)
	})

	it("contains no /test/path literal", () => {
		const result = getSystemInfoSection(cwd, policyFor(["read", "edit", "command"]))
		expect(result).not.toContain("/test/path")
	})

	it("omits the terminal-cd sentence when execute_command is absent", () => {
		const result = getSystemInfoSection(cwd, policyFor(["read"]))
		expect(result).not.toContain("New terminals will be created")
		expect(result).not.toContain("change directories in a terminal")
	})

	it("includes the terminal-cd sentence when execute_command is present", () => {
		const result = getSystemInfoSection(cwd, policyFor(["command"]))
		expect(result).toContain("New terminals will be created")
	})

	it("states the file-tree fact once and omits list_files guidance here", () => {
		const result = getSystemInfoSection(cwd, policyFor(["read"]))
		expect(result).toContain(
			"a recursive list of all filepaths in the current workspace directory will be included in environment_details",
		)
		// the list_files *guidance* belongs in CAPABILITIES, not SYSTEM INFORMATION
		expect(result).not.toContain("you can use the list_files tool")
	})
})

describe("getObjectiveSection", () => {
	it("names ask_followup_question when the tool is available", () => {
		const result = getObjectiveSection(policyFor(["read"]))
		expect(result).toContain("ask the user to provide the missing parameters using the ask_followup_question tool")
	})

	it("uses best-effort phrasing when ask_followup_question is absent", () => {
		const result = getObjectiveSection(
			policyFor(["read", "edit", "command"], { disabledTools: ["ask_followup_question"] }),
		)
		expect(result).toContain("state your assumptions and proceed with the best available value")
		expect(result).not.toContain("ask the user to provide the missing parameters")
	})
})

describe("getToolUseGuidelinesSection", () => {
	it("includes the list_files example when list_files is available", () => {
		const result = getToolUseGuidelinesSection(policyFor(["read"]))
		expect(result).toContain(
			"For example using the list_files tool is more effective than running a command like `ls` in the terminal.",
		)
	})

	it("omits the list_files example when list_files is absent", () => {
		const result = getToolUseGuidelinesSection(policyFor(["command"]))
		expect(result).not.toContain("using the list_files tool is more effective")
	})
})

describe("getSkillsSection", () => {
	it("returns the skills XML when the skill tool is available", async () => {
		const result = await getSkillsSection(makeSkillsManager(2), "code", policyFor(["read", "edit", "command"]))
		expect(result).toContain("AVAILABLE SKILLS")
		expect(result).toContain("<name>skill-0</name>")
	})

	it("returns an empty string when the skill tool is disabled", async () => {
		const result = await getSkillsSection(
			makeSkillsManager(2),
			"code",
			policyFor(["read", "edit", "command"], { disabledTools: ["skill"] }),
		)
		expect(result).toBe("")
	})
})

describe("getCommandChainOperator", () => {
	it("returns && for bash shell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for zsh shell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/zsh")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns ; for PowerShell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		expect(getCommandChainOperator()).toBe(";")
	})

	it("returns ; for PowerShell Core (pwsh)", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		expect(getCommandChainOperator()).toBe(";")
	})

	it("returns && for cmd.exe", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for Git Bash on Windows", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Program Files\\Git\\bin\\bash.exe")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for WSL bash", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		expect(getCommandChainOperator()).toBe("&&")
	})
})

describe("getRulesSection shell-aware command chaining", () => {
	const cwd = "/test/path"
	const settings = { todoListEnabled: true, useAgentRules: true, newTaskRequireTodos: false }

	const codePolicy = policyFor(["read", "edit", "command"])

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("uses && for Unix shells in command chaining example", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		const result = getRulesSection(cwd, settings, codePolicy)

		expect(result).toContain("cd (path to project) && (command")
		expect(result).not.toContain("cd (path to project) ; (command")
		expect(result).not.toContain("cd (path to project) & (command")
	})

	it("uses ; for PowerShell in command chaining example", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		const result = getRulesSection(cwd, settings, codePolicy)

		expect(result).toContain("cd (path to project) ; (command")
		expect(result).toContain("Note: Using `;` for PowerShell command chaining")
	})

	it("uses && for cmd.exe in command chaining example", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		const result = getRulesSection(cwd, settings, codePolicy)

		expect(result).toContain("cd (path to project) && (command")
		expect(result).toContain("Note: Using `&&` for cmd.exe command chaining")
	})

	it("includes Unix utility guidance for PowerShell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		const result = getRulesSection(cwd, settings, codePolicy)

		expect(result).toContain("IMPORTANT: When using PowerShell, avoid Unix-specific utilities")
		expect(result).toContain("`sed`, `grep`, `awk`, `cat`, `rm`, `cp`, `mv`")
		expect(result).toContain("`Select-String` for grep")
		expect(result).toContain("`Get-Content` for cat")
		expect(result).toContain("PowerShell's `-replace` operator")
	})

	it("includes Unix utility guidance for cmd.exe", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		const result = getRulesSection(cwd, settings, codePolicy)

		expect(result).toContain("IMPORTANT: When using cmd.exe, avoid Unix-specific utilities")
		expect(result).toContain("`sed`, `grep`, `awk`, `cat`, `rm`, `cp`, `mv`")
		expect(result).toContain("`type` for cat")
		expect(result).toContain("`del` for rm")
		expect(result).toContain("`find`/`findstr` for grep")
	})

	it("does not include Unix utility guidance for Unix shells", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		const result = getRulesSection(cwd, settings, codePolicy)

		expect(result).not.toContain("IMPORTANT: When using PowerShell")
		expect(result).not.toContain("IMPORTANT: When using cmd.exe")
		expect(result).not.toContain("`Select-String` for grep")
	})

	it("does not include note for Unix shells", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/zsh")
		const result = getRulesSection(cwd, settings, codePolicy)

		expect(result).not.toContain("Note: Using")
	})
})
