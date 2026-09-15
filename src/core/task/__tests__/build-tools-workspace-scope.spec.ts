import type OpenAI from "openai"

import type { ClineProvider } from "../../webview/ClineProvider"
import type { CodeIndexManager } from "../../../services/code-index/manager"
import type { CodeIndexWorkspaceScope } from "../../../services/code-index/code-index-workspace-scope"
import { makeExtensionContext } from "../../../test-utils/vscode"
import { codeIndexWorkspaceScopeRegistry } from "../../../services/code-index/code-index-workspace-scope-registry"
import * as filtering from "../../prompts/tools/filter-tools-for-mode"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"

vi.mock("../../../services/code-index/code-index-workspace-scope-registry", () => ({
	codeIndexWorkspaceScopeRegistry: { getScope: vi.fn() },
}))
vi.mock("@roo-code/core", () => ({ customToolRegistry: {}, formatNative: vi.fn() }))
vi.mock("../../../services/roo-config/index.js", () => ({ getRooDirectoriesForCwd: vi.fn() }))
vi.mock("../../prompts/tools/native-tools", () => ({
	getNativeTools: () =>
		["read_file", "codebase_search"].map((name) => ({
			type: "function",
			function: { name, description: name, parameters: { type: "object", properties: {} } },
		})),
	getMcpServerTools: () => [],
}))

function toolNames(tools: OpenAI.Chat.ChatCompletionTool[]): string[] {
	return tools.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))
}

describe("build tools workspace scope", () => {
	afterEach(() => vi.restoreAllMocks())

	it("forwards the full workspace scope and request cwd to real native filtering", async () => {
		const context = makeExtensionContext()
		// Building tools needs only the context and MCP accessor, not a webview host.
		const provider = { context, getMcpHub: () => undefined } as ClineProvider
		const readiness = { isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }
		const scope: CodeIndexWorkspaceScope = {
			// The real filter consumes only readiness; no indexing services are started.
			codeIndexManager: readiness as CodeIndexManager,
			initialize: vi.fn<CodeIndexWorkspaceScope["initialize"]>(),
			dispose: vi.fn(),
		}
		vi.mocked(codeIndexWorkspaceScopeRegistry.getScope).mockReturnValue(scope)
		const filter = vi.spyOn(filtering, "filterNativeToolsForMode")
		const options = {
			provider,
			cwd: "/task-workspace",
			mode: "code",
			customModes: undefined,
			experiments: undefined,
			apiConfiguration: undefined,
		}

		const result = await buildNativeToolsArrayWithRestrictions(options)

		expect(codeIndexWorkspaceScopeRegistry.getScope).toHaveBeenCalledWith(context, options.cwd)
		expect(filter.mock.calls[0][4]).toBe(scope)
		expect(toolNames(result.tools)).toEqual(["read_file", "codebase_search"])
		expect(result.allowedFunctionNames).toBeUndefined()
	})

	it.each([false, true])(
		"updates search availability across scope changes with restrictions=%s",
		async (includeAllToolsWithRestrictions) => {
			const context = makeExtensionContext()
			// Only the provider members read by the builder are needed at this boundary.
			const provider = { context, getMcpHub: () => undefined } as ClineProvider
			const readiness = { isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: false }
			const scope: CodeIndexWorkspaceScope = {
				// The filter reads these live flags; the remaining manager services are irrelevant here.
				codeIndexManager: readiness as CodeIndexManager,
				initialize: vi.fn<CodeIndexWorkspaceScope["initialize"]>(),
				dispose: vi.fn(),
			}
			const options = {
				provider,
				cwd: "/other-workspace",
				mode: "code",
				customModes: undefined,
				experiments: undefined,
				apiConfiguration: undefined,
				includeAllToolsWithRestrictions,
			}
			const expectSearch = async (expected: boolean) => {
				const result = await buildNativeToolsArrayWithRestrictions(options)
				const allowed = includeAllToolsWithRestrictions ? result.allowedFunctionNames : toolNames(result.tools)
				expect(allowed).toEqual(expected ? ["read_file", "codebase_search"] : ["read_file"])
				if (includeAllToolsWithRestrictions) {
					expect(toolNames(result.tools)).toEqual(["read_file", "codebase_search"])
				}
			}

			vi.mocked(codeIndexWorkspaceScopeRegistry.getScope).mockReturnValue(undefined)
			await expectSearch(false)
			vi.mocked(codeIndexWorkspaceScopeRegistry.getScope).mockReturnValue(scope)
			await expectSearch(false)
			readiness.isInitialized = true
			await expectSearch(true)
			readiness.isFeatureEnabled = false
			await expectSearch(false)
		},
	)
})
