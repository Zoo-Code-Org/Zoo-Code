import type OpenAI from "openai"
import { providerIdentifiers, type McpServer } from "@roo-code/types"
import type { ClineProvider } from "../../webview/ClineProvider"
import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"
import { TelemetryService } from "@roo-code/telemetry"
import { Task } from "../Task"
import { RooIgnoreController } from "../../ignore/RooIgnoreController"
import { ToolRouter } from "../../../services/tools/ToolRouter"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"

vi.mock("vscode", async (importOriginal) => ({
	...(await importOriginal<typeof import("vscode")>()),
	RelativePattern: class {
		constructor(
			readonly base: string,
			readonly pattern: string,
		) {}
	},
}))

vi.mock("../../../services/code-index/code-index-manager-registry", () => ({
	CodeIndexManagerRegistry: { getOrCreate: () => undefined },
}))

type Options = Parameters<typeof buildNativeToolsArrayWithRestrictions>[0]

function names(tools: OpenAI.Chat.ChatCompletionTool[]) {
	return tools.flatMap((tool) => ("function" in tool ? [tool.function.name] : []))
}

const tasks: Task[] = []
beforeEach(() => {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	vi.spyOn(RooIgnoreController.prototype, "initialize").mockResolvedValue(undefined)
})
afterEach(() => {
	for (const task of tasks) task.rooIgnoreController?.dispose()
	tasks.length = 0
	vi.restoreAllMocks()
})

function setup(count: number, savedNames?: string[]) {
	const server: McpServer = {
		name: "catalog",
		config: "{}",
		status: "connected",
		tools: Array.from({ length: count }, (_, index) => ({ name: `tool_${index}`, description: "search tickets" })),
	}
	const servers = [server]
	// Task construction reads context, state, log, and the hub. The builder uses
	// the same hub. This partial double cannot implement the full provider, which
	// owns unrelated webview and task services; cast once at construction.
	const provider = {
		context: makeExtensionContext({ globalStorageUri: makeUri("/test-storage") }),
		getMcpHub: () => ({ getServers: () => servers }),
		getState: async () => ({ mode: "code", currentApiConfigName: "default" }),
		log: vi.fn(),
		postStateToWebviewWithoutClineMessages: vi.fn().mockResolvedValue(undefined),
	} as unknown as ClineProvider
	const task = new Task({
		provider,
		apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiKey: "test-key" },
		task: savedNames === undefined ? "search tickets" : undefined,
		historyItem:
			savedNames === undefined
				? undefined
				: {
						id: "restored-selection",
						number: 1,
						ts: 1,
						task: "search tickets",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
						attachedMcpToolNames: savedNames,
					},
		startTask: false,
		workspacePath: "/test",
		enableCheckpoints: false,
	})
	// Stub disk I/O, keeping Task's selection, restore, and builder wiring real.
	task["saveClineMessages"] = vi.fn().mockResolvedValue(true)
	vi.spyOn(task, "initializeAttachedMcpTools")
	tasks.push(task)
	const options: Options = {
		provider,
		task,
		cwd: "/test",
		mode: "code",
		customModes: [],
		experiments: {},
		apiConfiguration: {},
	}
	return { server, servers, task, options, provider }
}

describe("MCP tool status", () => {
	it("reports the declared tools of a gated build one time", async () => {
		const { task, options, provider } = setup(100)
		const result = await buildNativeToolsArrayWithRestrictions({ ...options, mcpDynamicLoadInitialK: 3 })
		await buildNativeToolsArrayWithRestrictions({ ...options, mcpDynamicLoadInitialK: 3 })

		expect(task.mcpToolStatus.value).toEqual({
			attachedToolNames: names(result.tools).filter((name) => name.startsWith("mcp--")),
			totalScoped: 100,
		})
		expect(task.mcpToolStatus.value?.attachedToolNames).toHaveLength(3)
		expect(provider.postStateToWebviewWithoutClineMessages).toHaveBeenCalledTimes(1)
	})

	it("clears the status when a later build is at the threshold", async () => {
		const { server, task, options, provider } = setup(100)
		await buildNativeToolsArrayWithRestrictions(options)
		server.tools = server.tools?.slice(0, 50)
		await buildNativeToolsArrayWithRestrictions(options)

		expect(task.mcpToolStatus.value).toBeNull()
		expect(provider.postStateToWebviewWithoutClineMessages).toHaveBeenCalledTimes(2)
	})
})

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

	it.each([undefined, [], ["mcp--catalog--tool_99"]])(
		"preserves the real Task selection across repeated builds (saved: %j)",
		async (savedNames) => {
			const { task, options } = setup(100, savedNames)
			const rank = vi.spyOn(ToolRouter.getInstance(), "attachInitial")
			const build = () =>
				buildNativeToolsArrayWithRestrictions({
					...options,
					mcpDynamicLoadInitialK: 7,
					includeAllToolsWithRestrictions,
				})
			const first = await build()
			const second = await build()
			const declarations = names(first.tools).filter((name) => name.startsWith("mcp--"))
			expect(names(second.tools)).toEqual(names(first.tools))
			expect(new Set(declarations)).toEqual(task.attachedMcpToolNames)
			if (savedNames !== undefined) {
				expect(declarations).toEqual(savedNames)
				expect(rank).not.toHaveBeenCalled()
				expect(task["saveClineMessages"]).not.toHaveBeenCalled()
			} else {
				expect(declarations).toHaveLength(7)
				expect(rank).toHaveBeenCalledTimes(1)
				expect(task["saveClineMessages"]).toHaveBeenCalledExactlyOnceWith(true, true)
			}
			if (includeAllToolsWithRestrictions) {
				expect(second.allowedFunctionNames?.filter((name) => name.startsWith("mcp--"))).toEqual(declarations)
			}
		},
	)

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
			mcpDynamicLoadSearchTurns: NaN,
			includeAllToolsWithRestrictions,
		})
		expect(names(result.tools).filter((name) => name.startsWith("mcp--"))).toHaveLength(30)
	})

	it.each([
		{ searchTurns: 0, advertised: 100, ranked: false },
		{ searchTurns: 1, advertised: 30, ranked: true },
	])("advertises $advertised tools when searchTurns is $searchTurns", async ({ searchTurns, advertised, ranked }) => {
		const { task, options } = setup(100)
		const result = await buildNativeToolsArrayWithRestrictions({
			...options,
			mcpDynamicLoadSearchTurns: searchTurns,
			includeAllToolsWithRestrictions,
		})
		expect(names(result.tools).filter((name) => name.startsWith("mcp--"))).toHaveLength(advertised)
		expect(task.initializeAttachedMcpTools).toHaveBeenCalledTimes(ranked ? 1 : 0)
		expect(task.mcpToolStatus.value?.attachedToolNames.length).toBe(ranked ? advertised : undefined)
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
