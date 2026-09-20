import type OpenAI from "openai"
import { toolNamesSchema, type ModeConfig } from "@roo-code/types"
import type { CodeIndexManager } from "../../../../services/code-index/manager"
import type { CodeIndexWorkspaceScope } from "../../../../services/code-index/code-index-workspace-scope"
import { filterNativeToolsForMode } from "../filter-tools-for-mode"
import { resolveEffectiveToolPolicy } from "../effective-tool-policy"
import { getNativeTools } from "../native-tools"

const tools = toolNamesSchema.enum
const ordinaryReadTools = [tools.read_file, tools.list_files, tools.search_files]
type Readiness = Pick<CodeIndexManager, "isFeatureEnabled" | "isFeatureConfigured" | "isInitialized">

function makeManager(flags: Readiness): CodeIndexManager {
	// These consumers only read the public readiness getters, not manager services.
	return flags as CodeIndexManager
}

function makeScope(flags: Readiness): CodeIndexWorkspaceScope {
	return { codeIndexManager: makeManager(flags) } as CodeIndexWorkspaceScope
}

function toolNames(definitions: OpenAI.Chat.ChatCompletionTool[]) {
	return definitions.flatMap((tool) => ("function" in tool ? [tool.function.name] : []))
}

describe("codebase_search readiness", () => {
	it("excludes search without a manager but retains ordinary read tools", () => {
		const policy = resolveEffectiveToolPolicy({ mode: "code" })
		const filtered = filterNativeToolsForMode(getNativeTools(), "code", [], {})

		expect(policy.tools).not.toContain(tools.codebase_search)
		expect(toolNames(filtered)).not.toContain(tools.codebase_search)
		for (const tool of ordinaryReadTools) {
			expect(policy.tools).toContain(tool)
			expect(toolNames(filtered)).toContain(tool)
		}
	})

	it.each([
		{ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false },
		{ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: true },
		{ isFeatureEnabled: false, isFeatureConfigured: true, isInitialized: false },
		{ isFeatureEnabled: false, isFeatureConfigured: true, isInitialized: true },
		{ isFeatureEnabled: true, isFeatureConfigured: false, isInitialized: false },
		{ isFeatureEnabled: true, isFeatureConfigured: false, isInitialized: true },
		{ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: false },
	])(
		"excludes search for enabled=$isFeatureEnabled, configured=$isFeatureConfigured, initialized=$isInitialized",
		(flags) => {
			const manager = makeManager(flags)
			const policy = resolveEffectiveToolPolicy({ mode: "code", codeIndexManager: manager })
			const filtered = filterNativeToolsForMode(getNativeTools(), "code", [], {}, makeScope(flags))

			expect(policy.tools).not.toContain(tools.codebase_search)
			expect(toolNames(filtered)).not.toContain(tools.codebase_search)
			for (const tool of ordinaryReadTools) {
				expect(policy.tools).toContain(tool)
				expect(toolNames(filtered)).toContain(tool)
			}
		},
	)

	it("includes search when all three readiness conditions are met", () => {
		const manager = makeManager({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true })
		const policy = resolveEffectiveToolPolicy({ mode: "code", codeIndexManager: manager })
		const filtered = filterNativeToolsForMode(
			getNativeTools(),
			"code",
			[],
			{},
			makeScope({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }),
		)

		expect(policy.tools).toContain(tools.codebase_search)
		expect(toolNames(filtered)).toContain(tools.codebase_search)
		for (const tool of ordinaryReadTools) {
			expect(policy.tools).toContain(tool)
			expect(toolNames(filtered)).toContain(tool)
		}
	})

	it.each(["isFeatureEnabled", "isFeatureConfigured", "isInitialized"] as const)(
		"rereads %s when the same manager becomes unavailable and recovers",
		(flag) => {
			const flags = { isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }
			const manager = makeManager(flags)

			expect(resolveEffectiveToolPolicy({ mode: "code", codeIndexManager: manager }).tools).toContain(
				tools.codebase_search,
			)
			expect(toolNames(filterNativeToolsForMode(getNativeTools(), "code", [], {}, makeScope(flags)))).toContain(
				tools.codebase_search,
			)

			flags[flag] = false

			expect(resolveEffectiveToolPolicy({ mode: "code", codeIndexManager: manager }).tools).not.toContain(
				tools.codebase_search,
			)
			expect(
				toolNames(filterNativeToolsForMode(getNativeTools(), "code", [], {}, makeScope(flags))),
			).not.toContain(tools.codebase_search)

			flags[flag] = true

			expect(resolveEffectiveToolPolicy({ mode: "code", codeIndexManager: manager }).tools).toContain(
				tools.codebase_search,
			)
			expect(toolNames(filterNativeToolsForMode(getNativeTools(), "code", [], {}, makeScope(flags)))).toContain(
				tools.codebase_search,
			)
		},
	)

	it("does not reuse readiness from another manager or a missing manager", () => {
		const ready = makeManager({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true })
		const disabled = makeManager({ isFeatureEnabled: false, isFeatureConfigured: true, isInitialized: true })

		expect(resolveEffectiveToolPolicy({ mode: "code", codeIndexManager: ready }).tools).toContain(
			tools.codebase_search,
		)
		expect(
			toolNames(
				filterNativeToolsForMode(
					getNativeTools(),
					"code",
					[],
					{},
					makeScope({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }),
				),
			),
		).toContain(tools.codebase_search)

		for (const manager of [disabled, undefined]) {
			expect(resolveEffectiveToolPolicy({ mode: "code", codeIndexManager: manager }).tools).not.toContain(
				tools.codebase_search,
			)
			const scope = manager ? ({ codeIndexManager: manager } as CodeIndexWorkspaceScope) : undefined
			expect(toolNames(filterNativeToolsForMode(getNativeTools(), "code", [], {}, scope))).not.toContain(
				tools.codebase_search,
			)
		}

		expect(resolveEffectiveToolPolicy({ mode: "code", codeIndexManager: ready }).tools).toContain(
			tools.codebase_search,
		)
		expect(
			toolNames(
				filterNativeToolsForMode(
					getNativeTools(),
					"code",
					[],
					{},
					makeScope({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }),
				),
			),
		).toContain(tools.codebase_search)
	})

	it("does not grant read permissions merely because the manager is ready", () => {
		const manager = makeManager({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true })
		const mode: ModeConfig = { slug: "no-read", name: "No read", roleDefinition: "No reading", groups: ["command"] }
		const policy = resolveEffectiveToolPolicy({ mode: mode.slug, customModes: [mode], codeIndexManager: manager })
		const filtered = filterNativeToolsForMode(
			getNativeTools(),
			mode.slug,
			[mode],
			{},
			makeScope({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }),
		)

		for (const tool of [tools.codebase_search, ...ordinaryReadTools]) {
			expect(policy.tools).not.toContain(tool)
			expect(toolNames(filtered)).not.toContain(tool)
		}
		// The mode remains usable; this is not an accidentally empty result.
		expect(policy.tools).toContain(tools.execute_command)
		expect(toolNames(filtered)).toContain(tools.execute_command)
	})

	it("honors explicit search disabling without disabling ordinary read tools", () => {
		const manager = makeManager({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true })
		const disabledTools = [tools.codebase_search]
		const policy = resolveEffectiveToolPolicy({ mode: "code", codeIndexManager: manager, disabledTools })
		const filtered = filterNativeToolsForMode(
			getNativeTools(),
			"code",
			[],
			{},
			makeScope({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }),
			{ disabledTools },
		)

		expect(policy.tools).not.toContain(tools.codebase_search)
		expect(toolNames(filtered)).not.toContain(tools.codebase_search)
		for (const tool of ordinaryReadTools) {
			expect(policy.tools).toContain(tool)
			expect(toolNames(filtered)).toContain(tool)
		}
	})
})
