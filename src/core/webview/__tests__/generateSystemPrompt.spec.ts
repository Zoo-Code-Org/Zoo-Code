// npx vitest src/core/webview/__tests__/generateSystemPrompt.spec.ts
//
// Preview parity: generateSystemPrompt (the webview preview path) must produce
// the same CAPABILITIES / RULES / SYSTEM INFORMATION sections as a direct
// SYSTEM_PROMPT call built from the *same* inputs — including a full ModelInfo,
// so model-level excludedTools/includedTools are honored in the preview exactly
// like the runtime path. The old `{ isStealthModel }`-only typing silently
// allowed the preview to ignore them.

vi.mock("os", () => ({
	default: {
		homedir: () => "/home/user",
		platform: () => "linux",
		arch: () => "x64",
		type: () => "Linux",
		release: () => "5.4.0",
		hostname: () => "test-host",
		tmpdir: () => "/tmp",
		endianness: () => "LE",
		loadavg: () => [0, 0, 0],
		totalmem: () => 8589934592,
		freemem: () => 4294967296,
		cpus: () => [],
		networkInterfaces: () => ({}),
		userInfo: () => ({ username: "test", uid: 1000, gid: 1000, shell: "/bin/bash", homedir: "/home/user" }),
	},
	homedir: () => "/home/user",
	platform: () => "linux",
	arch: () => "x64",
	type: () => "Linux",
	release: () => "5.4.0",
	hostname: () => "test-host",
	tmpdir: () => "/tmp",
	endianness: () => "LE",
	loadavg: () => [0, 0, 0],
	totalmem: () => 8589934592,
	freemem: () => 4294967296,
	cpus: () => [],
	networkInterfaces: () => ({}),
	userInfo: () => ({ username: "test", uid: 1000, gid: 1000, shell: "/bin/bash", homedir: "/home/user" }),
}))

vi.mock("os-name", () => ({
	default: () => "Linux",
}))

vi.mock("fs/promises")

import * as vscode from "vscode"

import type { ModelInfo } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { SYSTEM_PROMPT } from "../../prompts/system"
import { getCapabilitiesSection } from "../../prompts/sections/capabilities"
import { getRulesSection } from "../../prompts/sections/rules"
import type { EffectiveToolPolicy } from "../../prompts/tools/effective-tool-policy"
import { generateSystemPrompt } from "../generateSystemPrompt"
import type { ClineProvider } from "../ClineProvider"
import "../../../utils/path"

// Mock vscode — generateSystemPrompt reads env.language and workspace config.
vi.mock("vscode", () => ({
	env: {
		language: "en",
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/test/path" } }],
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue(undefined),
		}),
		getWorkspaceFolder: vi.fn().mockReturnValue({ uri: { fsPath: "/test/path" } }),
	},
	window: {
		activeTextEditor: undefined,
	},
	EventEmitter: vi.fn().mockImplementation(function () {
		return {
			event: vi.fn(),
			fire: vi.fn(),
			dispose: vi.fn(),
		}
	}),
}))

// Mutable shell mock: getShell feeds the command-chaining text in RULES, so the
// fragment-gating describe below can retarget the shell per test without
// re-registering the module mock (which would leak across the parity tests).
const shellMock = vi.hoisted(() => ({ shell: "/bin/zsh" }))

vi.mock("../../../utils/shell", () => ({
	getShell: () => shellMock.shell,
}))

// Mock the section builders that touch the filesystem / extension context so the
// parity comparison is stable and independent of workspace state.
vi.mock("../../prompts/sections/modes", () => ({
	getModesSection: vi.fn().mockImplementation(async () => `====\n\nMODES\n\n- Test modes section`),
}))

vi.mock("../../prompts/sections/custom-instructions", () => ({
	addCustomInstructions: vi.fn().mockImplementation(async () => ""),
}))

// The preview must consume a *complete* ModelInfo from the API handler. This
// locks in that contract: if generateSystemPrompt ever narrows the local
// modelInfo back down, the excludedTools sub-assertion below fails.
const fullModelInfo: ModelInfo = {
	contextWindow: 100_000,
	supportsPromptCache: true,
	excludedTools: ["read_file"],
}

// Note: the module under test imports `../../api` from src/core/webview, which
// resolves to src/api — from this spec's directory (one level deeper) that is
// `../../../api`.
vi.mock("../../../api", () => ({
	buildApiHandler: () => ({
		getModel: () => ({ id: "m", info: fullModelInfo }),
	}),
}))

// Minimal mock ExtensionContext, mirroring the pattern in system-prompt.spec.ts.
const mockContext = {
	extensionPath: "/mock/extension/path",
	globalStoragePath: "/mock/storage/path",
	storagePath: "/mock/storage/path",
	logPath: "/mock/log/path",
	subscriptions: [],
	workspaceState: {
		get: () => undefined,
		update: () => Promise.resolve(),
	},
	globalState: {
		get: () => undefined,
		update: () => Promise.resolve(),
		setKeysForSync: () => {},
	},
	extensionUri: { fsPath: "/mock/extension/path" },
	globalStorageUri: { fsPath: "/mock/settings/path" },
	asAbsolutePath: (relativePath: string) => `/mock/extension/path/${relativePath}`,
	extension: {
		packageJSON: {
			version: "1.0.0",
		},
	},
} as unknown as vscode.ExtensionContext

const fullSettings = {
	todoListEnabled: true,
	useAgentRules: true,
	newTaskRequireTodos: false,
}

describe("generateSystemPrompt preview parity", () => {
	// Section-scoped extraction: capture the text between two "====" headers so
	// the comparison is limited to the sections the tool policy drives.
	function extractSection(prompt: string, header: string): string {
		const marker = `\n\n${header}\n\n`
		const idx = prompt.indexOf(marker)
		expect(idx).toBeGreaterThan(-1)
		const afterHeader = prompt.slice(idx + marker.length)
		const nextMarker = afterHeader.indexOf("\n\n====")
		return nextMarker === -1 ? afterHeader : afterHeader.slice(0, nextMarker)
	}

	/**
	 * ClineProvider is a heavy class; the preview only touches these members, so
	 * a minimal object literal stands in for it. This is the single double
	 * assertion in this spec.
	 */
	// The preview only destructures a handful of getState() fields, so the mock
	// returns that subset instead of a full ExtensionState; keeping the raw
	// vi.fn() (rather than vi.mocked) avoids casting the partial doubles.
	const getStateMock = vi.fn().mockResolvedValue({
		apiConfiguration: { apiProvider: providerIdentifiers.openai, apiModelId: "gpt-4o" },
		customModePrompts: undefined,
		customInstructions: undefined,
		mcpEnabled: false,
		experiments: {},
		language: undefined,
		enableSubfolderRules: false,
		disabledTools: undefined,
	})

	const fakeProvider = {
		context: mockContext,
		cwd: "/test/path",
		getState: getStateMock,
		getMcpHub: vi.fn(),
		getCurrentTask: vi.fn().mockReturnValue(undefined),
		getSkillsManager: vi.fn().mockReturnValue(undefined),
		customModesManager: {
			getCustomModes: vi.fn().mockResolvedValue([]),
		},
	} as unknown as ClineProvider

	it("produces identical CAPABILITIES, RULES, and SYSTEM INFORMATION sections for the same inputs", async () => {
		const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })

		// The direct SYSTEM_PROMPT call uses exactly the inputs the webview path
		// builds: same disabledTools (undefined), same full modelInfo, same
		// settings shape.
		const direct = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			undefined, // mcpHub
			undefined, // diffStrategy
			"code",
			undefined, // customModePrompts
			undefined, // customModes
			undefined, // globalCustomInstructions
			{}, // experiments
			undefined, // language
			undefined, // rooIgnoreInstructions
			fullSettings, // settings
			undefined, // todoList
			undefined, // modelId
			undefined, // skillsManager
			undefined, // disabledTools
			fullModelInfo, // modelInfo
		)

		for (const header of ["CAPABILITIES", "RULES", "SYSTEM INFORMATION"]) {
			expect(extractSection(preview, header)).toEqual(extractSection(direct, header))
		}
	})

	it("honors the full modelInfo.excludedTools in the preview output", async () => {
		const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })
		const capabilities = extractSection(preview, "CAPABILITIES")

		// read_file is excluded by the model info: no "read files" clause.
		expect(capabilities).not.toContain("read files")
		// Other clauses survive, proving the exclusion is scoped to that tool.
		expect(capabilities).toContain("execute CLI commands")
	})

	it("omits command guidance from the preview when execute_command is disabled", async () => {
		// The preview must forward state.disabledTools to SYSTEM_PROMPT: with
		// execute_command disabled, the CAPABILITIES section drops every
		// command-related fragment. The once-value overrides the shared default
		// without mutating it for other tests.
		getStateMock.mockResolvedValueOnce({
			apiConfiguration: { apiProvider: providerIdentifiers.openai, apiModelId: "gpt-4o" },
			customModePrompts: undefined,
			customInstructions: undefined,
			mcpEnabled: false,
			experiments: {},
			language: undefined,
			enableSubfolderRules: false,
			disabledTools: ["execute_command"],
		})

		const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })
		const capabilities = extractSection(preview, "CAPABILITIES")

		expect(capabilities).not.toContain("execute CLI commands")
		expect(capabilities).not.toContain("You can use the execute_command tool")
		// Anchor: the section is still populated, proving only execute_command
		// guidance was removed.
		expect(capabilities).toContain("list files")
	})

	it("resolves when settings are omitted instead of dereferencing them", async () => {
		// generatePrompt reads `settings?.todoListEnabled`; without the optional
		// chain this call rejects with a TypeError on the undefined settings object.
		const prompt = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			undefined, // mcpHub
			undefined, // diffStrategy
			"code",
			undefined, // customModePrompts
			undefined, // customModes
			undefined, // globalCustomInstructions
			{}, // experiments
			undefined, // language
			undefined, // rooIgnoreInstructions
			undefined, // settings -> exercises the `settings?.` optional chain
		)

		expect(prompt).toContain("OBJECTIVE")
	})
})

// ---------------------------------------------------------------------------
// Mutation coverage for the CAPABILITIES and RULES fragment builders. These
// sections have no name-matched spec file, so this spec — the gate's direct
// test file for the prompt pipeline — drives every fragment gate, fallback
// sentence, and MCP-availability branch directly against the section builders.
// ---------------------------------------------------------------------------
describe("getCapabilitiesSection / getRulesSection fragment gating", () => {
	const cwd = "/test/path"
	const settings = { ...fullSettings }

	/**
	 * Raw policy double: the section builders only read `tools` plus the MCP and
	 * edit-restriction fields, so a literal captures every branch the resolver
	 * could produce for these two sections.
	 */
	function sectionPolicy(
		tools: string[],
		extra: Partial<
			Pick<EffectiveToolPolicy, "hasMcpGroup" | "hasMcpTools" | "hasMcpResources" | "editRestriction">
		> = {},
	): EffectiveToolPolicy {
		return {
			tools: new Set(tools),
			hasMcpGroup: false,
			hasMcpTools: false,
			hasMcpResources: false,
			...extra,
		}
	}

	afterEach(() => {
		shellMock.shell = "/bin/zsh"
	})

	describe("getCapabilitiesSection", () => {
		it("emits every clause and paragraph when all capability tools are advertised", () => {
			const result = getCapabilitiesSection(
				sectionPolicy(
					[
						"execute_command",
						"list_files",
						"codebase_search",
						"search_files",
						"read_file",
						"write_to_file",
						"apply_diff",
					],
					{ hasMcpGroup: true, hasMcpTools: true },
				),
			)

			expect(result).toContain("====\n\nCAPABILITIES\n\n")
			expect(result).toContain(
				"You have access to tools that let you execute CLI commands on the user's computer, list files, view source code definitions, regex search, read files, write and edit files.",
			)
			expect(result).toContain("\n- These tools help you accomplish tasks.\n")
			expect(result).toContain("you can use the list_files tool")
			expect(result).toContain("You can use the execute_command tool to run commands on the user's computer")
			expect(result).toContain(
				"You have access to MCP servers that may provide additional tools and/or resources",
			)
			expect(result).not.toContain("Stryker was here")
			// The trailing newline is trimmed; the result must end with the last bullet.
			expect(result.endsWith("accomplish tasks more effectively.")).toBe(true)
		})

		it("falls back to the limited-tools sentence and omits every fragment when no capability tools are advertised", () => {
			const result = getCapabilitiesSection(sectionPolicy([]))

			expect(result).toContain(
				"You have access to a limited set of tools for this mode; only the tools you are provided may be called.",
			)
			expect(result).not.toContain("You have access to tools that let you")
			expect(result).not.toContain("execute CLI commands")
			expect(result).not.toContain("list files")
			expect(result).not.toContain("view source code definitions")
			expect(result).not.toContain("regex search")
			expect(result).not.toContain("read files")
			expect(result).not.toContain("write and edit files")
			expect(result).not.toContain("you can use the list_files tool")
			expect(result).not.toContain("You can use the execute_command tool")
			expect(result).not.toContain("MCP servers")
		})

		it("gates each clause on exactly its advertised tool", () => {
			expect(getCapabilitiesSection(sectionPolicy(["list_files"]))).toContain(
				"You have access to tools that let you list files.",
			)
			expect(getCapabilitiesSection(sectionPolicy(["codebase_search"]))).toContain(
				"You have access to tools that let you view source code definitions.",
			)
			expect(getCapabilitiesSection(sectionPolicy(["search_files"]))).toContain(
				"You have access to tools that let you regex search.",
			)
			expect(getCapabilitiesSection(sectionPolicy(["search_files"]))).not.toContain(
				"view source code definitions",
			)
			expect(getCapabilitiesSection(sectionPolicy(["read_file"]))).toContain(
				"You have access to tools that let you read files.",
			)
			expect(getCapabilitiesSection(sectionPolicy(["write_to_file"]))).toContain("write and edit files")
			expect(getCapabilitiesSection(sectionPolicy(["apply_diff"]))).toContain("write and edit files")
			expect(getCapabilitiesSection(sectionPolicy(["read_file"]))).not.toContain("write and edit files")
		})

		it("binds the edit-restriction suffix with and without a description", () => {
			const withDescription = getCapabilitiesSection(
				sectionPolicy(["read_file"], {
					editRestriction: { fileRegex: "\\.md$", description: "Markdown files only" },
				}),
			)
			expect(withDescription).toContain(
				"(in this mode only files matching '\\.md$' can be edited — Markdown files only)",
			)

			const withoutDescription = getCapabilitiesSection(
				sectionPolicy(["read_file"], { editRestriction: { fileRegex: "\\.md$" } }),
			)
			// "Stryker was here" (no trailing !) covers both the StringLiteral and
			// ArrayDeclaration sentinel replacements Stryker injects.
			expect(withoutDescription).toContain("(in this mode only files matching '\\.md$' can be edited)")
			expect(withoutDescription).not.toContain("Stryker was here")

			const unrestricted = getCapabilitiesSection(sectionPolicy(["read_file"]))
			expect(unrestricted).not.toContain("(in this mode only files matching")
			expect(unrestricted).not.toContain("Stryker was here")
		})

		it("emits the MCP bullet only when the mcp group is present and tools or resources are effective", () => {
			const mcpBullet = "You have access to MCP servers that may provide additional tools"

			// group + effective tools, and group + effective resources -> present
			expect(getCapabilitiesSection(sectionPolicy([], { hasMcpGroup: true, hasMcpTools: true }))).toContain(
				mcpBullet,
			)
			expect(getCapabilitiesSection(sectionPolicy([], { hasMcpGroup: true, hasMcpResources: true }))).toContain(
				mcpBullet,
			)
			// group but nothing effective -> absent
			expect(getCapabilitiesSection(sectionPolicy([], { hasMcpGroup: true }))).not.toContain(mcpBullet)
			// effective tools/resources but no group -> absent
			expect(
				getCapabilitiesSection(sectionPolicy([], { hasMcpTools: true, hasMcpResources: true })),
			).not.toContain(mcpBullet)
		})
	})

	describe("getRulesSection", () => {
		it("includes every tool-gated fragment when all relevant tools are advertised", () => {
			const result = getRulesSection(
				cwd,
				settings,
				sectionPolicy(["execute_command", "ask_followup_question", "list_files", "read_file"]),
			)

			expect(result).toContain("====\n\nRULES\n\n- ")
			expect(result).toContain("The project base directory is: /test/path")
			expect(result).toContain(
				"All file paths must be relative to this directory. However, commands may change directories in terminals, so respect working directory specified by the response to execute_command.",
			)
			expect(result).toContain("You are stuck operating from '/test/path'")
			expect(result).toContain("Do not use the ~ character or $HOME to refer to the home directory.")
			expect(result).toContain(
				"Before using the execute_command tool, you must first think about the SYSTEM INFORMATION context",
			)
			expect(result).toContain("Some modes have restrictions on which files they can edit")
			expect(result).toContain("Be sure to consider the type of project")
			expect(result).toContain("When making changes to code, always consider the context")
			expect(result).toContain("Do not ask for more information than necessary")
			expect(result).toContain(
				"You are only allowed to ask the user questions using the ask_followup_question tool",
			)
			expect(result).toContain("you should use the list_files tool to list the files in the Desktop")
			expect(result).not.toContain("Provide your best-effort result")
			expect(result).toContain("When executing commands, if you don't see the expected output")
			expect(result).toContain(
				"use the ask_followup_question tool to request the user to copy and paste it back to you",
			)
			expect(result).not.toContain("note what you expected and proceed with the task")
			expect(result).toContain("The user may provide a file's contents directly")
			expect(result).toContain(
				"Your goal is to try to accomplish the user's task, NOT engage in a back and forth conversation.",
			)
			expect(result).toContain("NEVER end attempt_completion result with a question")
			expect(result).toContain("STRICTLY FORBIDDEN from starting your messages")
			expect(result).toContain("When presented with images, utilize your vision capabilities")
			expect(result).toContain("you will automatically receive environment_details")
			expect(result).toContain('"Actively Running Terminals"')
			expect(result).toContain("It is critical you wait for the user's response after each tool use")
			expect(result).not.toContain("MCP operations should be used one at a time")
			expect(result).not.toContain("VENDOR CONFIDENTIALITY")
			// join separator: rules are bulleted one per line, not concatenated
			expect(result).toContain("/test/path\n- All file paths must be relative")
			expect(result).not.toContain("Stryker was here")
		})

		it("uses the fallback fragments when execute_command, ask_followup_question, and read_file are absent", () => {
			const result = getRulesSection(cwd, settings, sectionPolicy([]))

			expect(result).toContain("- All file paths must be relative to this directory.\n")
			expect(result).not.toContain("However, commands may change directories in terminals")
			expect(result).not.toContain("Before using the execute_command tool")
			expect(result).toContain("Provide your best-effort result and state your assumptions")
			expect(result).not.toContain("You are only allowed to ask the user questions")
			expect(result).not.toContain("When executing commands")
			expect(result).not.toContain("The user may provide a file's contents directly")
			expect(result).not.toContain("Actively Running Terminals")
		})

		it("keeps the ask guidance but drops the list_files example when only ask_followup_question is advertised", () => {
			const result = getRulesSection(cwd, settings, sectionPolicy(["ask_followup_question"]))

			expect(result).toContain(
				"You are only allowed to ask the user questions using the ask_followup_question tool",
			)
			expect(result).not.toContain("the list_files tool")
			expect(result).not.toContain("Stryker was here!")
		})

		it("uses the fallback phrasing in the terminal-output rule when ask_followup_question is absent", () => {
			const result = getRulesSection(cwd, settings, sectionPolicy(["execute_command"]))

			expect(result).toContain("When executing commands, if you don't see the expected output")
			expect(result).toContain("note what you expected and proceed with the task, stating your assumptions")
			expect(result).not.toContain("use the ask_followup_question tool to request")
		})

		it("emits the MCP usage rule only when the mcp group is present and tools or resources are effective", () => {
			const mcpRule = "MCP operations should be used one at a time"

			expect(
				getRulesSection(cwd, settings, sectionPolicy([], { hasMcpGroup: true, hasMcpTools: true })),
			).toContain(mcpRule)
			expect(
				getRulesSection(cwd, settings, sectionPolicy([], { hasMcpGroup: true, hasMcpResources: true })),
			).toContain(mcpRule)
			expect(getRulesSection(cwd, settings, sectionPolicy([], { hasMcpGroup: true }))).not.toContain(mcpRule)
			expect(
				getRulesSection(cwd, settings, sectionPolicy([], { hasMcpTools: true, hasMcpResources: true })),
			).not.toContain(mcpRule)
		})

		it("tolerates undefined settings and emits vendor confidentiality only for stealth models", () => {
			const full = sectionPolicy(["execute_command", "ask_followup_question", "list_files", "read_file"])

			// The `settings?.isStealthModel` optional chain must survive an undefined settings
			// object; dropping the chain throws a TypeError inside getRulesSection.
			expect(() => getRulesSection(cwd, undefined, full)).not.toThrow()
			expect(getRulesSection(cwd, undefined, full)).not.toContain("VENDOR CONFIDENTIALITY")
			expect(getRulesSection(cwd, { ...settings, isStealthModel: true }, full)).toContain(
				"VENDOR CONFIDENTIALITY",
			)
		})

		it("appends the PowerShell chain note and omits it for Unix shells", () => {
			const full = sectionPolicy(["execute_command"])

			shellMock.shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
			const powershell = getRulesSection(cwd, settings, full)
			expect(powershell).toContain("cd (path to project) ; (command, in this case npm install)")
			expect(powershell).toContain(" Note: Using `;` for PowerShell command chaining")

			shellMock.shell = "/bin/bash"
			const unix = getRulesSection(cwd, settings, full)
			expect(unix).toContain("cd (path to project) && (command, in this case npm install)")
			expect(unix).not.toContain("Note: Using")
			expect(unix).not.toContain("Stryker was here")
		})
	})
})
