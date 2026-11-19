import { McpToolSelection } from "../mcpToolSelection"
import { ToolRouter } from "../../../services/tools/ToolRouter"
import { buildMcpToolName } from "../../../utils/mcp-name"
import type { ToolDoc } from "../../../services/tools/types"

const tools: ToolDoc[] = ["a", "b"].map((toolName) => ({ serverName: "catalog", toolName, description: "search" }))
const names = tools.map((tool) => buildMcpToolName(tool.serverName, tool.toolName))
const scopes = [[], [tools[0]], [tools[1]], tools]
const selections = [undefined, [], [names[0]], [names[1]], names]

afterEach(() => vi.restoreAllMocks())

describe("MCP selection scope invariant", () => {
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
