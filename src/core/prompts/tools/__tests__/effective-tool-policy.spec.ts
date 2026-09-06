import { customToolRegistry } from "@roo-code/core"
import type { ModeConfig, ModelInfo } from "@roo-code/types"

import type { EffectiveToolPolicy } from "../effective-tool-policy"
import {
	PROTOCOL_TOOLS,
	resolveEffectiveToolPolicy,
	resolveToolAlias,
	buildToolRequirements,
} from "../effective-tool-policy"
import { getModeBySlug, defaultModeSlug } from "../../../../shared/modes"
import type { McpHub } from "../../../../services/mcp/McpHub"
import type { CodeIndexManager } from "../../../../services/code-index/manager"

/** Build a policy by giving the custom mode `groups` (derived from a real custom mode config). */
function policyFor(
	groups: ModeConfig["groups"],
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
	const customMode: ModeConfig = {
		slug: "policy-test",
		name: "Policy Under Test",
		roleDefinition: "",
		groups,
	}
	return resolveEffectiveToolPolicy({
		mode: "policy-test",
		customModes: [customMode],
		...extra,
	})
}

/** Minimal McpHub stub. Mirrors the McpServer shape the resolver reads (getServers, resources). */
function makeMcpHub(servers: Array<{ name: string; resources?: unknown[]; tools?: unknown[] }>): McpHub {
	return { getServers: () => servers } as unknown as McpHub
}

/** CodeIndexManager stub with all "ready" flags true. */
function enabledCodeIndexManager(): CodeIndexManager {
	return { isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true } as CodeIndexManager
}

/** Build a ModelInfo satisfying the required schema fields, merged with test-specific overrides. */
function modelInfo(partial?: Partial<ModelInfo>): ModelInfo {
	return { contextWindow: 100_000, supportsPromptCache: true, ...partial }
}

describe("resolveEffectiveToolPolicy - groups", () => {
	it("grants read-group tools for a read mode", () => {
		const policy = policyFor(["read"])
		expect(policy.tools.has("read_file")).toBe(true)
		expect(policy.tools.has("codebase_search")).toBe(false) // gated by code index, off by default
		expect(policy.tools.has("list_files")).toBe(true)
		expect(policy.tools.has("search_files")).toBe(true)
	})

	it("grants edit-group tools for an edit mode", () => {
		const policy = policyFor(["edit"])
		expect(policy.tools.has("write_to_file")).toBe(true)
		expect(policy.tools.has("apply_diff")).toBe(true)
	})

	it("grants command-group tools for a command mode", () => {
		const policy = policyFor(["command"])
		expect(policy.tools.has("execute_command")).toBe(true)
		expect(policy.tools.has("read_command_output")).toBe(true)
	})

	it("combines groups", () => {
		const policy = policyFor(["read", "edit", "command"])
		expect(policy.tools.has("read_file")).toBe(true)
		expect(policy.tools.has("write_to_file")).toBe(true)
		expect(policy.tools.has("execute_command")).toBe(true)
	})

	it("keeps always-available tools regardless of groups", () => {
		const policy = policyFor([])
		// switch_mode/new_task are in the "modes" group but also always-available
		expect(policy.tools.has("ask_followup_question")).toBe(true)
		expect(policy.tools.has("update_todo_list")).toBe(true)
		expect(policy.tools.has("skill")).toBe(true)
		// run_slash_command is always-available but gated by the runSlashCommand experiment
		expect(policy.tools.has("run_slash_command")).toBe(false)
	})

	it("sets hasMcpGroup only when the mode has the mcp group", () => {
		expect(policyFor(["mcp"]).hasMcpGroup).toBe(true)
		expect(policyFor(["read"]).hasMcpGroup).toBe(false)
	})

	it("extracts the first edit-restriction tuple with fileRegex", () => {
		const policy = policyFor(["read", ["edit", { fileRegex: "\\.md$", description: "Markdown files only" }]])
		expect(policy.editRestriction).toEqual({ fileRegex: "\\.md$", description: "Markdown files only" })
	})

	it("returns undefined editRestriction when no edit tuple has a fileRegex", () => {
		expect(policyFor(["edit"]).editRestriction).toBeUndefined()
	})
})

describe("resolveEffectiveToolPolicy - disabledTools", () => {
	it("removes tools listed in disabledTools (canonical)", () => {
		const policy = policyFor(["read", "edit", "command"], { disabledTools: ["execute_command"] })
		expect(policy.tools.has("execute_command")).toBe(false)
		expect(policy.tools.has("read_file")).toBe(true)
	})

	it("removes tools by alias (alias normalization)", () => {
		const policy = policyFor(["edit"], { disabledTools: ["write_file"] })
		expect(policy.tools.has("write_to_file")).toBe(false)
	})

	it("does not remove the protocol guarantee", () => {
		expect(
			policyFor(["read", "edit", "command"], { disabledTools: [...PROTOCOL_TOOLS] }).tools.has(
				"attempt_completion",
			),
		).toBe(true)
	})
})

describe("resolveEffectiveToolPolicy - model customization", () => {
	it("removes tools in modelInfo.excludedTools", () => {
		const policy = policyFor(["read", "edit", "command"], {
			modelInfo: modelInfo({ excludedTools: ["read_file"] }),
		})
		expect(policy.tools.has("read_file")).toBe(false)
	})

	it("removes tools by excludedTools alias", () => {
		const policy = policyFor(["edit"], { modelInfo: modelInfo({ excludedTools: ["write_file"] }) })
		expect(policy.tools.has("write_to_file")).toBe(false)
	})

	it("re-adds excludedTools that are protocol tools", () => {
		const policy = policyFor(["read", "edit", "command"], {
			modelInfo: modelInfo({ excludedTools: ["attempt_completion"] }),
		})
		expect(policy.tools.has("attempt_completion")).toBe(true)
	})

	it("adds includedTools only when their group is allowed", () => {
		// read group is allowed; codebase_search is in read.
		const policy = policyFor(["read"], {
			modelInfo: modelInfo({ excludedTools: [], includedTools: ["codebase_search"] }),
			codeIndexManager: enabledCodeIndexManager(),
		})
		expect(policy.tools.has("codebase_search")).toBe(true)
	})

	it("ignores includedTools outside the allowed group", () => {
		// command group only; codebase_search is in read -> not added even when requested.
		const policy = policyFor(["command"], { modelInfo: modelInfo({ includedTools: ["read_file"] }) })
		expect(policy.tools.has("read_file")).toBe(false)
	})
})

describe("resolveEffectiveToolPolicy - conditional gates", () => {
	it("drops codebase_search unless the code index is enabled/configured/initialized", () => {
		const modeWithIndex = policyFor(["read"], { codeIndexManager: enabledCodeIndexManager() })
		expect(modeWithIndex.tools.has("codebase_search")).toBe(true)

		const modeWithoutIndex = policyFor(["read"])
		expect(modeWithoutIndex.tools.has("codebase_search")).toBe(false)
	})

	it("drops update_todo_list when todoListEnabled is false", () => {
		expect(policyFor(["read", "edit", "command"], { todoListEnabled: false }).tools.has("update_todo_list")).toBe(
			false,
		)
		expect(policyFor(["read", "edit", "command"], { todoListEnabled: true }).tools.has("update_todo_list")).toBe(
			true,
		)
	})

	it("drops generate_image unless the imageGeneration experiment is enabled", () => {
		expect(
			policyFor(["read", "edit", "command"], { experiments: { imageGeneration: true } }).tools.has(
				"generate_image",
			),
		).toBe(true)
		expect(policyFor(["read", "edit", "command"]).tools.has("generate_image")).toBe(false)
	})

	it("drops run_slash_command unless the runSlashCommand experiment is enabled", () => {
		expect(
			policyFor(["read", "edit", "command"], { experiments: { runSlashCommand: true } }).tools.has(
				"run_slash_command",
			),
		).toBe(true)
		expect(policyFor(["read", "edit", "command"]).tools.has("run_slash_command")).toBe(false)
	})
})

describe("resolveEffectiveToolPolicy - MCP resource gate", () => {
	it("keeps access_mcp_resource iff an allowed server exposes resources", () => {
		const hasResources = policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s", resources: [{ uri: "r" }] }]) })
		expect(hasResources.tools.has("access_mcp_resource")).toBe(true)

		const noResources = policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s" }]) })
		expect(noResources.tools.has("access_mcp_resource")).toBe(false)
	})

	it("respects an explicit allowlist over the mode-config allowlist", () => {
		const allowed = policyFor(["mcp"], {
			mcpHub: makeMcpHub([{ name: "allowed", resources: [{ uri: "r" }] }]),
			allowedMcpServers: ["allowed"],
		})
		expect(allowed.tools.has("access_mcp_resource")).toBe(true)

		const wrongAllow = policyFor(["mcp"], {
			mcpHub: makeMcpHub([{ name: "allowed", resources: [{ uri: "r" }] }]),
			allowedMcpServers: ["blocked"],
		})
		expect(wrongAllow.tools.has("access_mcp_resource")).toBe(false)
	})

	it("falls back to the mode config allowlist when no explicit allowlist is provided", () => {
		const customMode: ModeConfig = {
			slug: "policy-test",
			name: "Restricted Mode",
			roleDefinition: "",
			groups: ["mcp"],
			allowedMcpServers: ["blocked"],
		}
		const policy = resolveEffectiveToolPolicy({
			mode: "policy-test",
			customModes: [customMode],
			mcpHub: makeMcpHub([{ name: "allowed", resources: [{ uri: "r" }] }]),
		})
		expect(policy.tools.has("access_mcp_resource")).toBe(false)
	})

	it("computes hasMcpTools from effective enabled tools and hasMcpResources from resources", () => {
		const hasToolsOnly = policyFor(["mcp"], {
			mcpHub: makeMcpHub([{ name: "s", tools: [{ name: "t", description: "d" }] }]),
		})
		expect(hasToolsOnly.hasMcpTools).toBe(true)
		expect(hasToolsOnly.hasMcpResources).toBe(false)

		const hasResourcesOnly = policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s", resources: [{ uri: "r" }] }]) })
		expect(hasResourcesOnly.hasMcpTools).toBe(false)
		expect(hasResourcesOnly.hasMcpResources).toBe(true)

		const hasNeither = policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s" }]) })
		expect(hasNeither.hasMcpTools).toBe(false)
		expect(hasNeither.hasMcpResources).toBe(false)
	})

	it("returns hasMcpTools false when the only tool has enabledForPrompt: false", () => {
		const policy = policyFor(["mcp"], {
			mcpHub: makeMcpHub([{ name: "s", tools: [{ name: "t", enabledForPrompt: false }] }]),
		})
		expect(policy.hasMcpTools).toBe(false)
	})

	it("returns hasMcpTools true when a tool has enabledForPrompt: true", () => {
		const policy = policyFor(["mcp"], {
			mcpHub: makeMcpHub([{ name: "s", tools: [{ name: "t", enabledForPrompt: true }] }]),
		})
		expect(policy.hasMcpTools).toBe(true)
	})

	it("returns hasMcpTools false for a server excluded by the allowlist", () => {
		const policy = policyFor(["mcp"], {
			mcpHub: makeMcpHub([{ name: "excluded", tools: [{ name: "t", enabledForPrompt: true }] }]),
			allowedMcpServers: ["other"],
		})
		expect(policy.hasMcpTools).toBe(false)
		expect(policy.tools.has("use_mcp_tool")).toBe(false)
	})

	it("keeps use_mcp_tool only when an allowed server exposes a prompt-enabled tool", () => {
		const withTools = policyFor(["mcp"], {
			mcpHub: makeMcpHub([{ name: "s", tools: [{ name: "t", enabledForPrompt: true }] }]),
		})
		expect(withTools.tools.has("use_mcp_tool")).toBe(true)

		const allDisabled = policyFor(["mcp"], {
			mcpHub: makeMcpHub([{ name: "s", tools: [{ name: "t", enabledForPrompt: false }] }]),
		})
		expect(allDisabled.tools.has("use_mcp_tool")).toBe(false)
	})

	it("drops use_mcp_tool when mcpHub is undefined even though the mcp group is granted", () => {
		const policy = policyFor(["mcp"])
		expect(policy.hasMcpGroup).toBe(true)
		expect(policy.hasMcpTools).toBe(false)
		expect(policy.tools.has("use_mcp_tool")).toBe(false)
		expect(policy.tools.has("access_mcp_resource")).toBe(false)
	})

	it("drops use_mcp_tool when the allowedMcpServers list is empty", () => {
		const policy = policyFor(["mcp"], {
			mcpHub: makeMcpHub([
				{ name: "s", tools: [{ name: "t", enabledForPrompt: true }], resources: [{ uri: "r" }] },
			]),
			allowedMcpServers: [],
		})
		// An empty allowlist permits no servers: both MCP group tools must go,
		// even though the hub itself exposes a live tool and a resource.
		expect(policy.hasMcpTools).toBe(false)
		expect(policy.hasMcpResources).toBe(false)
		expect(policy.tools.has("use_mcp_tool")).toBe(false)
		expect(policy.tools.has("access_mcp_resource")).toBe(false)
	})

	it("keeps use_mcp_tool with resources-only hub and access_mcp_resource pruned", () => {
		// The two group tools are gated independently: resources alone keep
		// access_mcp_resource but must not resurrect use_mcp_tool.
		const policy = policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s", resources: [{ uri: "r" }] }]) })
		expect(policy.tools.has("access_mcp_resource")).toBe(true)
		expect(policy.tools.has("use_mcp_tool")).toBe(false)
	})
})

describe("resolveEffectiveToolPolicy - worst case (control-tools-only mode)", () => {
	it("only exposes always-available + protocol tools when groups is empty", () => {
		const policy = policyFor([])
		expect(policy.tools.has("read_file")).toBe(false)
		expect(policy.tools.has("write_to_file")).toBe(false)
		expect(policy.tools.has("execute_command")).toBe(false)
		expect(policy.tools.has("attempt_completion")).toBe(true) // protocol guarantee
		expect(policy.tools.has("switch_mode")).toBe(true) // always-available
	})
})

describe("buildToolRequirements", () => {
	it("returns an empty map when disabledTools is undefined or empty", () => {
		expect(buildToolRequirements(undefined)).toEqual({})
		expect(buildToolRequirements([])).toEqual({})
	})

	it("maps disabled tools to false (including alias + canonical)", () => {
		const reqs = buildToolRequirements(["write_file"])
		expect(reqs).toEqual({ write_file: false, write_to_file: false })
	})

	it("skips protocol tools and their aliases", () => {
		const reqs = buildToolRequirements([...PROTOCOL_TOOLS, "ask_followup_question", "switch_mode"])
		expect(Object.keys(reqs)).not.toContain("attempt_completion")
		expect(reqs).toEqual({ ask_followup_question: false, switch_mode: false })
	})

	it("adds alias + canonical for real aliases", () => {
		const reqs = buildToolRequirements(["write_file"])
		expect(Object.keys(reqs).sort()).toEqual(["write_file", "write_to_file"].sort())
	})

	it("skips protocol tools but keeps regular tools in a mixed list", () => {
		// A protocol tool must be skipped while the regular tool in the same list
		// still produces its alias + canonical entries.
		expect(buildToolRequirements(["attempt_completion", "write_file"])).toEqual({
			write_file: false,
			write_to_file: false,
		})
	})
})

describe("resolveToolAlias", () => {
	it("resolves every registered alias to its canonical tool", () => {
		// Exercises the module-load ALIAS_TO_CANONICAL map for both registered aliases.
		expect(resolveToolAlias("write_file")).toBe("write_to_file")
		expect(resolveToolAlias("search_and_replace")).toBe("edit")
	})

	it("returns canonical and unknown names unchanged", () => {
		expect(resolveToolAlias("read_file")).toBe("read_file")
		expect(resolveToolAlias("not_a_tool")).toBe("not_a_tool")
	})
})

describe("PROTOCOL_TOOLS", () => {
	it("lists the single protocol tool by canonical name", () => {
		expect([...PROTOCOL_TOOLS]).toEqual(["attempt_completion"])
	})
})

describe("resolveEffectiveToolPolicy - edit restriction edge cases", () => {
	it("skips non-edit group tuples even when they declare a fileRegex", () => {
		// Only an actual `edit` tuple can establish the restriction: a `read` tuple
		// carrying a fileRegex must be skipped, and an edit tuple without a fileRegex
		// must not produce one either.
		const policy = policyFor([["read", { fileRegex: "\\.ts$" }], ["edit", {}], "command"])
		expect(policy.editRestriction).toBeUndefined()
	})

	it("does not crash on a malformed edit tuple without options", () => {
		// Runtime guard: the extraction uses `group[1]?.fileRegex`, so an options-less
		// tuple must be skipped rather than throwing.
		const groups = JSON.parse('[["edit"]]') as ModeConfig["groups"]
		expect(policyFor(groups).editRestriction).toBeUndefined()
	})
})

describe("resolveEffectiveToolPolicy - step 3 validator removal", () => {
	it("drops granted tools when the validator does not recognize the mode", () => {
		const customMode: ModeConfig = {
			slug: "policy-test",
			name: "Policy Under Test",
			roleDefinition: "",
			groups: ["read", "edit", "command"],
		}
		// The requested slug matches no mode, so the fallback (architect) grants its
		// read/edit/mcp tools but the per-tool validator rejects every non-always-available
		// tool, and the step-3 removal loop drops them.
		const policy = resolveEffectiveToolPolicy({ mode: "ghost-mode", customModes: [customMode] })
		expect(policy.tools.has("read_file")).toBe(false)
		expect(policy.tools.has("write_to_file")).toBe(false)
		expect(policy.tools.has("use_mcp_tool")).toBe(false)
		expect(policy.tools.has("switch_mode")).toBe(true)
		expect(policy.tools.has("attempt_completion")).toBe(true)
	})

	it("re-adds validator-removed group tools via includedTools (regular-tool mapping)", () => {
		// The includedTools branch maps every regular group tool through
		// TOOL_GROUPS; when a granted tool was dropped by the step-3 validator
		// (unknown mode slug), including it re-adds it because its group is allowed
		// by the fallback mode config.
		const customMode: ModeConfig = {
			slug: "policy-test",
			name: "Policy Under Test",
			roleDefinition: "",
			groups: ["read", "edit", "command"],
		}
		const policy = resolveEffectiveToolPolicy({
			mode: "ghost-mode",
			customModes: [customMode],
			modelInfo: modelInfo({ includedTools: ["read_file"] }),
		})
		expect(policy.tools.has("read_file")).toBe(true)
	})

	it("threads the experiments flags into the per-mode validator", () => {
		// The resolver forwards `experiments ?? {}` to the validator; the customTools
		// escape hatch in isToolAllowedForMode only fires when that flag actually
		// arrives. A registered custom tool is therefore retained for an otherwise
		// unknown mode when (and only when) the flag is passed through.
		const customMode: ModeConfig = {
			slug: "policy-test",
			name: "Policy Under Test",
			roleDefinition: "",
			groups: ["read"],
		}
		customToolRegistry.register({ name: "shadow_read_tool", description: "test double", execute: async () => "ok" })
		try {
			const withFlag = resolveEffectiveToolPolicy({
				mode: "ghost-mode",
				customModes: [customMode],
				experiments: { customTools: true },
			})
			// shadow_read_tool is not granted by any group, so the flag alone cannot
			// re-add it; instead the flag must keep granted tools that the validator
			// would otherwise reject for the unknown mode.
			expect(withFlag.tools.has("read_file")).toBe(false)

			// Direct proof of flag threading: register under a granted tool's name.
			customToolRegistry.register({ name: "read_file", description: "shadow", execute: async () => "ok" })
			const shadowed = resolveEffectiveToolPolicy({
				mode: "ghost-mode",
				customModes: [customMode],
				experiments: { customTools: true },
			})
			expect(shadowed.tools.has("read_file")).toBe(true)

			// Without the flag the same shadowed tool is still rejected.
			const withoutFlag = resolveEffectiveToolPolicy({ mode: "ghost-mode", customModes: [customMode] })
			expect(withoutFlag.tools.has("read_file")).toBe(false)
		} finally {
			customToolRegistry.clear()
		}
	})

	it("forwards an empty customModes default to the per-mode validator", async () => {
		// The step-3 permission filter forwards `customModes ?? []` (and
		// `experiments ?? {}`) to isToolAllowedForMode. A phantom default entry would
		// behave identically downstream (a non-object never matches a mode slug), so
		// the forwarded argument itself is the only observable. Wrap the real
		// validator for one fresh module instance and assert what it receives.
		const seen: unknown[][] = []
		vi.doMock("../../../../core/tools/validateToolUse", async (importOriginal) => {
			const original = await importOriginal<typeof import("../../../../core/tools/validateToolUse")>()
			return {
				...original,
				isToolAllowedForMode: (...args: Parameters<typeof original.isToolAllowedForMode>) => {
					seen.push(args)
					return original.isToolAllowedForMode(...args)
				},
			}
		})
		vi.resetModules()
		const mod = await import("../effective-tool-policy")
		try {
			mod.resolveEffectiveToolPolicy({ mode: "code" })
			expect(seen.length).toBeGreaterThan(0)
			for (const args of seen) {
				expect(args[2]).toEqual([])
			}

			// Provided custom modes are forwarded by reference, unchanged.
			const customModes: ModeConfig[] = [
				{ slug: "passthrough-test", name: "PT", roleDefinition: "", groups: ["read"] },
			]
			seen.length = 0
			mod.resolveEffectiveToolPolicy({ mode: "code", customModes })
			expect(seen.some((args) => args[2] === customModes)).toBe(true)
		} finally {
			vi.doUnmock("../../../../core/tools/validateToolUse")
			vi.resetModules()
		}
	})
})

describe("resolveEffectiveToolPolicy - opt-in custom tools via includedTools", () => {
	it("adds opt-in custom tools only when their group is allowed", () => {
		// "edit" is an opt-in custom tool of the edit group: absent from the group grant,
		// it is re-added only when model customization includes it AND the mode allows
		// the owning group (the toolToGroup map includes customTools entries).
		const withEditGroup = policyFor(["edit"], { modelInfo: modelInfo({ includedTools: ["edit"] }) })
		expect(withEditGroup.tools.has("edit")).toBe(true)

		const withoutEditGroup = policyFor(["read"], { modelInfo: modelInfo({ includedTools: ["edit"] }) })
		expect(withoutEditGroup.tools.has("edit")).toBe(false)
	})

	it("resolves aliased opt-in custom tools through the group's customTools", () => {
		// "search_and_replace" is an alias of the opt-in custom tool "edit".
		const policy = policyFor(["edit"], { modelInfo: modelInfo({ includedTools: ["search_and_replace"] }) })
		expect(policy.tools.has("edit")).toBe(true)
	})
})

describe("resolveEffectiveToolPolicy - code index readiness flags", () => {
	it("drops codebase_search when the feature is disabled", () => {
		const manager = {
			isFeatureEnabled: false,
			isFeatureConfigured: true,
			isInitialized: true,
		} as CodeIndexManager
		expect(policyFor(["read"], { codeIndexManager: manager }).tools.has("codebase_search")).toBe(false)
	})

	it("drops codebase_search when the feature is not configured", () => {
		const manager = {
			isFeatureEnabled: true,
			isFeatureConfigured: false,
			isInitialized: true,
		} as CodeIndexManager
		expect(policyFor(["read"], { codeIndexManager: manager }).tools.has("codebase_search")).toBe(false)
	})

	it("drops codebase_search when the index is not initialized", () => {
		const manager = {
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			isInitialized: false,
		} as CodeIndexManager
		expect(policyFor(["read"], { codeIndexManager: manager }).tools.has("codebase_search")).toBe(false)
	})
})

describe("resolveEffectiveToolPolicy - MCP capability flags", () => {
	it("reports no MCP capabilities without an mcpHub", () => {
		const policy = policyFor(["mcp"])
		expect(policy.hasMcpTools).toBe(false)
		expect(policy.hasMcpResources).toBe(false)
	})

	it("keeps hasMcpGroup true when mcp is mixed with other groups", () => {
		expect(policyFor(["read", "mcp", "command"]).hasMcpGroup).toBe(true)
	})

	it("returns hasMcpTools true for an allowlisted server even when other servers are dropped", () => {
		const policy = policyFor(["mcp"], {
			mcpHub: makeMcpHub([
				{ name: "other", tools: [{ name: "t", enabledForPrompt: true }] },
				{ name: "listed", tools: [{ name: "t", enabledForPrompt: true }] },
			]),
			allowedMcpServers: ["listed"],
		})
		expect(policy.hasMcpTools).toBe(true)
	})

	it("returns hasMcpTools true when at least one of several tools is prompt-enabled", () => {
		const policy = policyFor(["mcp"], {
			mcpHub: makeMcpHub([
				{
					name: "s",
					tools: [
						{ name: "off-a", enabledForPrompt: false },
						{ name: "off-b", enabledForPrompt: false },
						{ name: "live", enabledForPrompt: true },
					],
				},
			]),
		})
		expect(policy.hasMcpTools).toBe(true)
	})

	it("returns hasMcpTools false when every tool of the server is prompt-disabled", () => {
		const policy = policyFor(["mcp"], {
			mcpHub: makeMcpHub([
				{
					name: "s",
					tools: [
						{ name: "off-a", enabledForPrompt: false },
						{ name: "off-b", enabledForPrompt: false },
					],
				},
			]),
		})
		expect(policy.hasMcpTools).toBe(false)
	})
})

describe("resolveEffectiveToolPolicy - protocol override warning (fresh module)", () => {
	// The warn-dedupe set is module state and other tests in this file already resolve
	// policies that disable protocol tools (priming the set), so each test reloads a
	// fresh module instance whose dedupe set starts empty.
	async function freshResolve() {
		vi.resetModules()
		const mod = await import("../effective-tool-policy")
		return mod.resolveEffectiveToolPolicy
	}

	it("skips an alias of a protocol tool when building tool requirements", async () => {
		// buildToolRequirements skips a tool when its canonical name OR its raw name
		// is a protocol tool. Register a temporary alias of attempt_completion so the
		// two operands of that `||` differ: the alias must still be skipped.
		vi.resetModules()
		const toolsMod = await import("../../../../shared/tools")
		toolsMod.TOOL_ALIASES.wp4_attempt_alias = "attempt_completion"
		const mod = await import("../effective-tool-policy")
		try {
			expect(mod.buildToolRequirements(["wp4_attempt_alias"])).toEqual({})
			// Sanity: the injected alias actually resolves through the fresh module.
			expect(mod.resolveToolAlias("wp4_attempt_alias")).toBe("attempt_completion")
		} finally {
			delete toolsMod.TOOL_ALIASES.wp4_attempt_alias
		}
	})

	it("warns once per protocol tool, names the tool, and keeps it available", async () => {
		vi.resetModules()
		// Import shared/tools first and assert the alias map right after the fresh
		// import, so a broken module-load alias map (ALIAS_TO_CANONICAL) fails here.
		const mod = await import("../effective-tool-policy")
		expect(mod.resolveToolAlias("write_file")).toBe("write_to_file")
		expect(mod.resolveToolAlias("search_and_replace")).toBe("edit")
		expect([...mod.PROTOCOL_TOOLS]).toEqual(["attempt_completion"])
		const resolve = mod.resolveEffectiveToolPolicy
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const policy = resolve({ mode: "code", disabledTools: ["attempt_completion"] })
			expect(warnSpy).toHaveBeenCalledTimes(1)
			const message = String(warnSpy.mock.calls[0]?.[0])
			expect(message).toContain("[effective-tool-policy]")
			expect(message).toContain("'attempt_completion'")
			expect(message).toContain("no-op")
			expect(policy.tools.has("attempt_completion")).toBe(true)

			// Second resolve on the same module instance: deduped, no additional warn.
			const policy2 = resolve({ mode: "code", disabledTools: ["attempt_completion", "execute_command"] })
			expect(warnSpy).toHaveBeenCalledTimes(1)
			expect(policy2.tools.has("execute_command")).toBe(false)
		} finally {
			warnSpy.mockRestore()
		}
	})

	it("does not warn or throw for empty or missing disabledTools", async () => {
		const resolve = await freshResolve()
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			expect(() => resolve({ mode: "code", disabledTools: [] })).not.toThrow()
			expect(() => resolve({ mode: "code" })).not.toThrow()
			expect(warnSpy).not.toHaveBeenCalled()
		} finally {
			warnSpy.mockRestore()
		}
	})

	it("warns again on a fresh module instance (per-process dedupe)", async () => {
		const first = await freshResolve()
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			first({ mode: "code", disabledTools: ["attempt_completion"] })
			expect(warnSpy).toHaveBeenCalledTimes(1)

			// A different module instance has its own dedupe set and warns again.
			const second = await freshResolve()
			second({ mode: "code", disabledTools: ["attempt_completion"] })
			expect(warnSpy).toHaveBeenCalledTimes(2)
		} finally {
			warnSpy.mockRestore()
		}
	})
})
