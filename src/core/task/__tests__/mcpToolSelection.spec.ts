import { McpToolSelection } from "../mcpToolSelection"
import { ToolRouter } from "../../../services/tools/ToolRouter"
import { buildMcpToolName } from "../../../utils/mcp-name"
import type { ToolDoc } from "../../../services/tools/types"
import type { Anthropic } from "@anthropic-ai/sdk"

const tools: ToolDoc[] = ["a", "b"].map((toolName) => ({ serverName: "catalog", toolName, description: "search" }))
const names = tools.map((tool) => buildMcpToolName(tool.serverName, tool.toolName))
const scopes = [[], [tools[0]], [tools[1]], tools]
const selections = [undefined, [], [names[0]], [names[1]], names]

afterEach(() => vi.restoreAllMocks())

describe("MCP selection scope invariant", () => {
	it.each(
		["mcp--catalog--get-info", "mcp--catalog--get_info", "mcp__catalog__get_info"].flatMap((historical) =>
			[[], ["get-info"], ["get_info"], ["get-info", "get_info"]].map((toolNames) => ({ historical, toolNames })),
		),
	)(
		"resolves history $historical against $toolNames and retains names on reconnection",
		async ({ historical, toolNames }) => {
			const scope = [tools[0], ...toolNames.map((toolName) => ({ ...tools[0], toolName }))]
			const rank = vi.fn<(_query: string, _scope: ToolDoc[], _k: number) => Promise<string[]>>()
			const selection = new McpToolSelection([names[0]], rank)
			const history: Anthropic.MessageParam[] = [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "historical", name: historical, input: {} }],
				},
			]
			const persist = vi.fn().mockResolvedValue(undefined)
			await selection.initialize(scope, 1, "search", history, persist)
			const canonicalNames = toolNames.map((toolName) => buildMcpToolName("catalog", toolName))
			const expected = canonicalNames.includes(historical)
				? historical
				: toolNames.length === 1
					? canonicalNames[0]
					: historical.replace(/__/g, "--")
			expect([...selection.names]).toEqual([names[0], expected])
			expect(persist).toHaveBeenCalledTimes(1)
			if (toolNames.length === 0) {
				await selection.initialize(
					[tools[0], { ...tools[0], toolName: "get-info" }],
					1,
					"search",
					history,
					persist,
				)
				expect(selection.names.has("mcp--catalog--get-info")).toBe(true)
				expect(selection.names.has(expected)).toBe(true)
			}
			expect(rank).not.toHaveBeenCalled()
		},
	)

	it("keeps names and supplies a live selection through every pair of scopes", async () => {
		// Same invariant as check-mcp-tool-selection.ts: a completed nonempty selection
		// intersects the caller's nonempty scope. Saved names never disappear.
		for (const saved of selections) {
			for (const first of scopes) {
				for (const second of scopes) {
					const selection = new McpToolSelection(saved)
					const persist = vi.fn().mockResolvedValue(undefined)
					for (const scope of [first, second]) {
						const before = [...selection.names]
						await selection.initialize(scope, 1, "search", [], persist)
						for (const name of before) expect(selection.names.has(name)).toBe(true)
						if (saved?.length !== 0 && scope.length > 0) {
							expect(
								scope.some((tool) =>
									selection.names.has(buildMcpToolName(tool.serverName, tool.toolName)),
								),
							).toBe(true)
						}
					}
				}
			}
		}
	})

	it("checks a waiting caller's scope after an earlier rank completes", async () => {
		let release!: (names: string[]) => void
		const gate = new Promise<string[]>((resolve) => {
			release = resolve
		})
		const rank = vi.spyOn(ToolRouter.getInstance(), "attachInitial").mockReturnValueOnce(gate)
		const selection = new McpToolSelection()
		const persist = vi.fn().mockResolvedValue(undefined)
		const first = selection.initialize([tools[0]], 1, "search", [], persist)
		const second = selection.initialize([tools[1]], 1, "search", [], persist)
		release([names[0]])
		await Promise.all([first, second])
		expect(rank).toHaveBeenCalledTimes(2)
		expect([...selection.names]).toEqual(names)
	})

	it.each([false, true])("rechecks live scope after initialization (blank task: %s)", async (blank) => {
		const selection = new McpToolSelection()
		const persist = vi.fn().mockResolvedValue(undefined)
		await selection.initialize([tools[0]], 1, blank ? "" : "search", [], persist)
		await selection.initialize([tools[1]], 1, blank ? "" : "search", [], persist)
		expect([...selection.names]).toEqual(names)
		expect(persist).toHaveBeenCalledTimes(2)
	})

	it("preserves an explicit empty selection without ranking", async () => {
		const rank = vi.spyOn(ToolRouter.getInstance(), "attachInitial")
		const selection = new McpToolSelection([])
		await selection.initialize(tools, 1, "search", [], vi.fn())
		expect(rank).not.toHaveBeenCalled()
		expect([...selection.names]).toEqual([])
	})
})
