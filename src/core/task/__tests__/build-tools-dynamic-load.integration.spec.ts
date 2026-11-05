import type OpenAI from "openai"
import type { McpServer } from "@roo-code/types"
import type { ClineProvider } from "../../webview/ClineProvider"
import { makeExtensionContext } from "../../../test-utils/vscode"
import { ToolRouter } from "../../../services/tools/ToolRouter"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"

vi.mock("../../../services/code-index/code-index-manager-registry", () => ({
	CodeIndexManagerRegistry: { getOrCreate: () => undefined },
}))

type Options = Parameters<typeof buildNativeToolsArrayWithRestrictions>[0]

function names(tools: OpenAI.Chat.ChatCompletionTool[]) {
	return tools.flatMap((tool) => ("function" in tool ? [tool.function.name] : []))
}

function setup(count: number) {
	const server: McpServer = {
		name: "catalog",
		config: "{}",
		status: "connected",
		tools: Array.from({ length: count }, (_, index) => ({ name: `tool_${index}`, description: "search tickets" })),
	}
	const servers = [server]
	// Tool construction only uses context and the hub's getServers method.
	const provider = {
		context: makeExtensionContext(),
		getMcpHub: () => ({ getServers: () => servers }),
	} as ClineProvider
	let initialized = false
	const task: NonNullable<Options["task"]> = {
		attachedMcpToolNames: new Set<string>(),
		initializeAttachedMcpTools: vi.fn(async (scope, k) => {
			if (initialized) return
			const selected = await ToolRouter.getInstance().attachInitial("search tickets", scope, k)
			for (const name of selected) task.attachedMcpToolNames.add(name)
			initialized = true
		}),
	}
	const options: Options = {
		provider,
		task,
		cwd: "/test",
		mode: "code",
		customModes: [],
		experiments: {},
		apiConfiguration: {},
	}
	return { server, servers, task, options }
}

describe.each([false, true])("MCP dynamic loading (all definitions: %s)", (includeAllToolsWithRestrictions) => {
	it.each([0, 49, 50])("keeps %s tools at or below the threshold", async (count) => {
		const { task, options } = setup(count)
		const result = await buildNativeToolsArrayWithRestrictions({ ...options, includeAllToolsWithRestrictions })
		expect(names(result.tools).filter((name) => name.startsWith("mcp--"))).toHaveLength(count)
		expect(task.initializeAttachedMcpTools).not.toHaveBeenCalled()
	})

	it.each([undefined, 7])("limits 100 tools to initialK=%s and retains native tools", async (initialK) => {
		const { task, options } = setup(100)
		const baseline = await buildNativeToolsArrayWithRestrictions({
			...setup(0).options,
			includeAllToolsWithRestrictions,
		})
		const result = await buildNativeToolsArrayWithRestrictions({
			...options,
			mcpDynamicLoadInitialK: initialK,
			includeAllToolsWithRestrictions,
		})
		const declarations = names(result.tools)
		const attached = declarations.filter((name) => name.startsWith("mcp--"))
		expect(attached).toHaveLength(initialK ?? 30)
		expect(new Set(attached)).toEqual(task.attachedMcpToolNames)
		expect(declarations.filter((name) => !name.startsWith("mcp--"))).toEqual(names(baseline.tools))
		expect(declarations).not.toContain("mcp_load")
		if (includeAllToolsWithRestrictions) {
			expect(result.allowedFunctionNames?.filter((name) => name.startsWith("mcp--"))).toEqual(attached)
		}
	})

	it("starts routing at exactly 51 tools", async () => {
		const { task, options } = setup(51)
		const result = await buildNativeToolsArrayWithRestrictions({ ...options, includeAllToolsWithRestrictions })
		expect(names(result.tools).filter((name) => name.startsWith("mcp--"))).toHaveLength(30)
		expect(task.initializeAttachedMcpTools).toHaveBeenCalledTimes(1)
	})

	it("defaults polluted runtime settings instead of bypassing the gate", async () => {
		const { options } = setup(100)
		const result = await buildNativeToolsArrayWithRestrictions({
			...options,
			mcpDynamicLoadThreshold: NaN,
			mcpDynamicLoadInitialK: Infinity,
			includeAllToolsWithRestrictions,
		})
		expect(names(result.tools).filter((name) => name.startsWith("mcp--"))).toHaveLength(30)
	})

	it("uses a configured threshold, including zero", async () => {
		const { options, task } = setup(2)
		const result = await buildNativeToolsArrayWithRestrictions({
			...options,
			mcpDynamicLoadThreshold: 0,
			mcpDynamicLoadInitialK: 1,
			includeAllToolsWithRestrictions,
		})
		expect(names(result.tools).filter((name) => name.startsWith("mcp--"))).toHaveLength(1)
		expect(task.initializeAttachedMcpTools).toHaveBeenCalledTimes(1)
	})

	it("ranks only the mode's allowed servers and prompt-enabled tools", async () => {
		const { options, servers, server, task } = setup(100)
		servers.push({ ...server, name: "forbidden" })
		server.tools?.push({ name: "hidden", description: "tickets", enabledForPrompt: false })
		await buildNativeToolsArrayWithRestrictions({
			...options,
			mode: "scoped",
			includeAllToolsWithRestrictions,
			customModes: [
				{
					slug: "scoped",
					name: "Scoped",
					roleDefinition: "Scoped",
					groups: ["mcp"],
					allowedMcpServers: ["catalog"],
				},
			],
		})
		const scope = vi.mocked(task.initializeAttachedMcpTools).mock.calls[0][0]
		expect(scope).toHaveLength(100)
		expect(scope.every((tool) => tool.serverName === "catalog" && tool.toolName !== "hidden")).toBe(true)
	})

	it("does not rank MCP tools when policy disables them", async () => {
		const { options, task } = setup(100)
		const result = await buildNativeToolsArrayWithRestrictions({
			...options,
			disabledTools: ["use_mcp_tool"],
			includeAllToolsWithRestrictions,
		})
		expect(task.initializeAttachedMcpTools).not.toHaveBeenCalled()
		const callable = result.allowedFunctionNames ?? names(result.tools)
		expect(callable.some((name) => name.startsWith("mcp--"))).toBe(false)
	})
})
