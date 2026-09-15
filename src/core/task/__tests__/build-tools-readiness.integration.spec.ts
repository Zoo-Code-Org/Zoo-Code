import type OpenAI from "openai"
import type { CodeIndexManager } from "../../../services/code-index/manager"
import { CodeIndexManagerRegistry } from "../../../services/code-index/code-index-manager-registry"
import { makeExtensionContext } from "../../../test-utils/vscode"
import type { ClineProvider } from "../../webview/ClineProvider"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"

vi.mock("../../../services/code-index/code-index-manager-registry", () => ({
	CodeIndexManagerRegistry: { getInstance: vi.fn() },
}))

function toolNames(tools: OpenAI.Chat.ChatCompletionTool[]) {
	return tools.flatMap((tool) => ("function" in tool ? [tool.function.name] : []))
}

describe("task tool building with real readiness filtering", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each([false, true])("uses task cwd/context and live manager readiness (restrictions=%s)", async (restricted) => {
		const context = makeExtensionContext()
		// The builder only consumes context and getMcpHub; avoid constructing the webview provider.
		const provider = { context, getMcpHub: () => undefined } as ClineProvider
		const flags = { isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }
		// Only the public readiness getters are consumed by the real filter.
		const readyManager = flags as CodeIndexManager
		const unreadyManager = { ...flags, isInitialized: false } as CodeIndexManager
		const managers = new Map([
			["/tasks/ready", readyManager],
			["/tasks/unready", unreadyManager],
		])
		vi.mocked(CodeIndexManagerRegistry.getInstance).mockImplementation((receivedContext, cwd) => {
			expect(receivedContext).toBe(context)
			return managers.get(cwd ?? "")
		})

		async function check(cwd: string, expected: boolean, mode = "code", disabledTools: string[] = []) {
			const result = await buildNativeToolsArrayWithRestrictions({
				provider,
				cwd,
				mode,
				customModes: [{ slug: "no-read", name: "No read", roleDefinition: "No reading", groups: ["command"] }],
				experiments: {},
				apiConfiguration: {},
				disabledTools,
				includeAllToolsWithRestrictions: restricted,
			})
			expect(CodeIndexManagerRegistry.getInstance).toHaveBeenLastCalledWith(context, cwd)
			const definitions = toolNames(result.tools)
			const callable = restricted ? result.allowedFunctionNames : definitions
			expect(callable).toBeDefined()
			expect(callable?.includes("codebase_search")).toBe(expected)
			expect(callable?.includes("read_file")).toBe(mode === "code")
			if (restricted) {
				// Historical definitions remain present; only allowedFunctionNames controls calls.
				expect(definitions).toContain("codebase_search")
			} else {
				expect(result.allowedFunctionNames).toBeUndefined()
			}
		}

		await check("/tasks/ready", true)
		await check("/tasks/unready", false)
		await check("/tasks/missing", false)
		await check("/tasks/ready", true)
		for (const flag of ["isFeatureEnabled", "isFeatureConfigured", "isInitialized"] as const) {
			flags[flag] = false
			await check("/tasks/ready", false)
			flags[flag] = true
			await check("/tasks/ready", true)
		}
		await check("/tasks/ready", false, "no-read")
		await check("/tasks/ready", false, "code", ["codebase_search"])
	})
})
