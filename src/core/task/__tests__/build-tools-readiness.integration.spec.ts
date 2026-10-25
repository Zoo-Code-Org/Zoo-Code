import type OpenAI from "openai"
import { toolNamesSchema } from "@roo-code/types"
import type { CodeIndexManager } from "../../../services/code-index/manager"
import { CodeIndexManagerRegistry } from "../../../services/code-index/code-index-manager-registry"
import { makeExtensionContext } from "../../../test-utils/vscode"
import type { ClineProvider } from "../../webview/ClineProvider"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"

vi.mock("../../../services/code-index/code-index-manager-registry", () => ({
	CodeIndexManagerRegistry: { getOrCreate: vi.fn() },
}))

const tools = toolNamesSchema.enum
const ordinaryReadTools = [tools.read_file, tools.list_files, tools.search_files]

function toolNames(definitions: OpenAI.Chat.ChatCompletionTool[]) {
	return definitions.flatMap((tool) => ("function" in tool ? [tool.function.name] : []))
}

function makeManager(flags: Pick<CodeIndexManager, "isFeatureEnabled" | "isFeatureConfigured" | "isInitialized">) {
	// The real filter only consumes these public readiness getters, not manager services.
	return flags as CodeIndexManager
}

describe.each([
	{ strategy: "filtered definitions", includeAllToolsWithRestrictions: false },
	{ strategy: "all definitions with an allowlist", includeAllToolsWithRestrictions: true },
])("task readiness with $strategy", ({ includeAllToolsWithRestrictions }) => {
	beforeEach(() => vi.mocked(CodeIndexManagerRegistry.getOrCreate).mockReset())

	function makeOptions() {
		const context = makeExtensionContext()
		// Only context and getMcpHub are needed; constructing a webview provider is unrelated to this test.
		const provider = { context, getMcpHub: () => undefined } as ClineProvider
		return {
			provider,
			cwd: "/tasks/ready",
			mode: "code",
			customModes: [],
			experiments: {},
			apiConfiguration: {},
			includeAllToolsWithRestrictions,
		}
	}

	function callable(result: Awaited<ReturnType<typeof buildNativeToolsArrayWithRestrictions>>) {
		return includeAllToolsWithRestrictions ? result.allowedFunctionNames : toolNames(result.tools)
	}

	it("uses the task context and cwd without leaking readiness between workspaces", async () => {
		const options = makeOptions()
		const ready = makeManager({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true })
		const unready = makeManager({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: false })
		const managers = new Map([
			["/tasks/ready", ready],
			["/tasks/unready", unready],
		])
		vi.mocked(CodeIndexManagerRegistry.getOrCreate).mockImplementation((_context, cwd) => managers.get(cwd ?? ""))

		const first = await buildNativeToolsArrayWithRestrictions(options)
		expect(CodeIndexManagerRegistry.getOrCreate).toHaveBeenLastCalledWith(options.provider.context, "/tasks/ready")
		expect(callable(first)).toContain(tools.codebase_search)

		const other = await buildNativeToolsArrayWithRestrictions({ ...options, cwd: "/tasks/unready" })
		expect(CodeIndexManagerRegistry.getOrCreate).toHaveBeenLastCalledWith(
			options.provider.context,
			"/tasks/unready",
		)
		if (includeAllToolsWithRestrictions) {
			expect(other.allowedFunctionNames).toBeDefined()
			expect(other.allowedFunctionNames).not.toContain(tools.codebase_search)
			// Keep definitions for historical calls, while forbidding new calls.
			expect(toolNames(other.tools)).toContain(tools.codebase_search)
		} else {
			expect(other.allowedFunctionNames).toBeUndefined()
			expect(toolNames(other.tools)).not.toContain(tools.codebase_search)
		}
		for (const tool of ordinaryReadTools) {
			expect(callable(other)).toContain(tool)
		}

		const restored = await buildNativeToolsArrayWithRestrictions(options)
		expect(CodeIndexManagerRegistry.getOrCreate).toHaveBeenLastCalledWith(options.provider.context, "/tasks/ready")
		expect(callable(restored)).toContain(tools.codebase_search)
		expect(CodeIndexManagerRegistry.getOrCreate).toHaveBeenCalledTimes(3)
	})

	it("omits search without a manager while retaining ordinary read tools", async () => {
		vi.mocked(CodeIndexManagerRegistry.getOrCreate).mockReturnValue(undefined)
		const result = await buildNativeToolsArrayWithRestrictions({ ...makeOptions(), cwd: "/tasks/missing" })

		if (includeAllToolsWithRestrictions) {
			expect(result.allowedFunctionNames).toBeDefined()
			expect(result.allowedFunctionNames).not.toContain(tools.codebase_search)
			expect(toolNames(result.tools)).toContain(tools.codebase_search)
		} else {
			expect(result.allowedFunctionNames).toBeUndefined()
			expect(toolNames(result.tools)).not.toContain(tools.codebase_search)
		}
		for (const tool of ordinaryReadTools) {
			expect(callable(result)).toContain(tool)
		}
	})

	it.each(["isFeatureEnabled", "isFeatureConfigured", "isInitialized"] as const)(
		"rereads %s on subsequent builds with the same manager",
		async (flag) => {
			const options = makeOptions()
			const flags = { isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }
			vi.mocked(CodeIndexManagerRegistry.getOrCreate).mockReturnValue(makeManager(flags))

			const initial = await buildNativeToolsArrayWithRestrictions(options)
			expect(callable(initial)).toContain(tools.codebase_search)

			flags[flag] = false
			const unavailable = await buildNativeToolsArrayWithRestrictions(options)
			if (includeAllToolsWithRestrictions) {
				expect(unavailable.allowedFunctionNames).toBeDefined()
				expect(unavailable.allowedFunctionNames).not.toContain(tools.codebase_search)
				expect(toolNames(unavailable.tools)).toContain(tools.codebase_search)
			} else {
				expect(unavailable.allowedFunctionNames).toBeUndefined()
				expect(toolNames(unavailable.tools)).not.toContain(tools.codebase_search)
			}
			for (const tool of ordinaryReadTools) {
				expect(callable(unavailable)).toContain(tool)
			}

			flags[flag] = true
			const recovered = await buildNativeToolsArrayWithRestrictions(options)
			expect(callable(recovered)).toContain(tools.codebase_search)
		},
	)

	it("does not grant read tools to a command-only mode even with a ready manager", async () => {
		vi.mocked(CodeIndexManagerRegistry.getOrCreate).mockReturnValue(
			makeManager({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }),
		)
		const result = await buildNativeToolsArrayWithRestrictions({
			...makeOptions(),
			mode: "no-read",
			customModes: [{ slug: "no-read", name: "No read", roleDefinition: "No reading", groups: ["command"] }],
		})

		if (includeAllToolsWithRestrictions) {
			expect(result.allowedFunctionNames).toBeDefined()
			expect(toolNames(result.tools)).toContain(tools.codebase_search)
		} else {
			expect(result.allowedFunctionNames).toBeUndefined()
		}
		const callableSet = callable(result)
		for (const tool of [tools.codebase_search, ...ordinaryReadTools]) {
			expect(callableSet).not.toContain(tool)
		}
		expect(callableSet).toContain(tools.execute_command)
	})

	it("honors disabledTools with a ready manager without disabling ordinary read tools", async () => {
		vi.mocked(CodeIndexManagerRegistry.getOrCreate).mockReturnValue(
			makeManager({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }),
		)
		const result = await buildNativeToolsArrayWithRestrictions({
			...makeOptions(),
			disabledTools: [tools.codebase_search],
		})

		if (includeAllToolsWithRestrictions) {
			expect(result.allowedFunctionNames).toBeDefined()
			expect(result.allowedFunctionNames).not.toContain(tools.codebase_search)
			expect(toolNames(result.tools)).toContain(tools.codebase_search)
		} else {
			expect(result.allowedFunctionNames).toBeUndefined()
			expect(toolNames(result.tools)).not.toContain(tools.codebase_search)
		}
		for (const tool of ordinaryReadTools) {
			expect(callable(result)).toContain(tool)
		}
	})
})
