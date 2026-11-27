import { DEFAULT_MCP_DYNAMIC_LOAD_SEARCH_TURNS } from "@roo-code/types"
import { McpToolSelection } from "../mcpToolSelection"
import { ToolRouter } from "../../../services/tools/ToolRouter"
import { buildMcpToolName } from "../../../utils/mcp-name"
import type { ToolDoc } from "../../../services/tools/types"
import type { Anthropic } from "@anthropic-ai/sdk"
import type { ApiMessage } from "../../task-persistence/apiMessages"

const limits = (initialK: number) => ({ initialK, searchTurns: DEFAULT_MCP_DYNAMIC_LOAD_SEARCH_TURNS })

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
			await selection.initialize(scope, limits(1), "search", history, persist)
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
					limits(1),
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
		for (const saved of selections) {
			for (const first of scopes) {
				for (const second of scopes) {
					const selection = new McpToolSelection(saved)
					const persist = vi.fn().mockResolvedValue(undefined)
					for (const scope of [first, second]) {
						const before = [...selection.names]
						await selection.initialize(scope, limits(1), "search", [], persist)
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
		const first = selection.initialize([tools[0]], limits(1), "search", [], persist)
		const second = selection.initialize([tools[1]], limits(1), "search", [], persist)
		release([names[0]])
		await Promise.all([first, second])
		expect(rank).toHaveBeenCalledTimes(2)
		expect([...selection.names]).toEqual(names)
	})

	it.each([false, true])("rechecks live scope after initialization (blank task: %s)", async (blank) => {
		const selection = new McpToolSelection()
		const persist = vi.fn().mockResolvedValue(undefined)
		await selection.initialize([tools[0]], limits(1), blank ? "" : "search", [], persist)
		await selection.initialize([tools[1]], limits(1), blank ? "" : "search", [], persist)
		expect([...selection.names]).toEqual(names)
		expect(persist).toHaveBeenCalledTimes(2)
	})

	it("preserves an explicit empty selection without ranking", async () => {
		const rank = vi.spyOn(ToolRouter.getInstance(), "attachInitial")
		const selection = new McpToolSelection([])
		await selection.initialize(tools, limits(1), "search", [], vi.fn())
		expect(rank).not.toHaveBeenCalled()
		expect([...selection.names]).toEqual([])
	})
})

describe("ranking on the latest user message", () => {
	const jiraTools: ToolDoc[] = ["search", "get"].map((t) => ({
		serverName: "jira",
		toolName: t,
		description: "jira",
	}))
	const slackTools: ToolDoc[] = ["read", "send"].map((t) => ({
		serverName: "slack",
		toolName: t,
		description: "slack",
	}))
	const allTools = [...jiraTools, ...slackTools]
	const jiraNames = jiraTools.map((t) => buildMcpToolName(t.serverName, t.toolName))
	const slackNames = slackTools.map((t) => buildMcpToolName(t.serverName, t.toolName))
	const tagged = (text: string) => `<user_message>\n${text}\n</user_message>`
	const userTurn = (text: string): ApiMessage => ({ role: "user", content: [{ type: "text", text: tagged(text) }] })
	const toolTurn = (tag: string): ApiMessage => ({
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: tag, content: "ok" },
			{ type: "text", text: `<environment_details>\n${tag}\n</environment_details>` },
		],
	})
	const usedTool = (name: string): ApiMessage => ({
		role: "assistant",
		content: [{ type: "tool_use", id: name, name, input: {} }],
	})
	const summary: ApiMessage = { role: "user", content: [{ type: "text", text: tagged("summary") }], isSummary: true }

	function setup(saved?: string[], searchTurns = DEFAULT_MCP_DYNAMIC_LOAD_SEARCH_TURNS) {
		const rank = vi.fn<(_query: string, _scope: ToolDoc[], _k: number) => Promise<string[]>>()
		const selection = new McpToolSelection(saved, rank)
		const persist = vi.fn().mockResolvedValue(undefined)
		const select = (history: ApiMessage[]) =>
			selection.initialize(allTools, { initialK: 5, searchTurns }, "search jira tickets", history, persist)
		return { rank, selection, select }
	}

	it("supplements once per new user message and ignores tool-result turns", async () => {
		const { rank, selection, select } = setup()
		rank.mockResolvedValueOnce(jiraNames).mockResolvedValueOnce(slackNames)
		await select([userTurn("search jira tickets")])
		const history = [userTurn("search jira tickets"), userTurn("check slack messages")]
		await select(history)
		await select([...history, toolTurn("turn-1")])
		await select([...history, toolTurn("turn-1"), toolTurn("turn-2")])
		expect(rank.mock.calls).toEqual([
			[tagged("search jira tickets"), allTools, 5],
			[tagged("check slack messages"), slackTools, 7],
		])
		expect([...selection.names]).toEqual([...jiraNames, ...slackNames])
	})

	it("uses the task text only for the first rank of a history without user text", async () => {
		const { rank, select } = setup()
		rank.mockResolvedValueOnce(jiraNames)
		await select([])
		await select([toolTurn("turn-1")])
		expect(rank.mock.calls).toEqual([["search jira tickets", allTools, 5]])
	})

	it("supplements on a follow-up answer inside a tool result", async () => {
		const { rank, select } = setup(jiraNames)
		rank.mockResolvedValueOnce(slackNames)
		const answer: ApiMessage = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "ask", content: [{ type: "text", text: tagged("slack") }] }],
		}
		await select([userTurn("search jira tickets"), answer, toolTurn("turn-1")])
		expect(rank.mock.calls).toEqual([[tagged("slack"), slackTools, 7]])
	})

	it("supplements on resume with a new user message", async () => {
		const { rank, selection, select } = setup(jiraNames)
		rank.mockResolvedValueOnce(slackNames)
		await select([userTurn("now check slack")])
		expect(rank).toHaveBeenCalledWith(tagged("now check slack"), slackTools, 7)
		expect([...selection.names]).toEqual([...jiraNames, ...slackNames])
	})

	it("re-ranks the latest real user message after reset and drops tools used before the summary", async () => {
		const { rank, selection, select } = setup([...jiraNames, slackNames[0]])
		rank.mockResolvedValueOnce([slackNames[1]])
		selection.reset()
		await select([userTurn("search jira tickets"), usedTool(jiraNames[0]), userTurn("send a slack dm"), summary])
		expect(rank).toHaveBeenCalledWith(tagged("send a slack dm"), allTools, 5)
		expect([...selection.names]).toEqual([slackNames[1]])
	})

	it("recovers tools used after the summary", async () => {
		const { rank, selection, select } = setup()
		rank.mockResolvedValueOnce([])
		await select([usedTool(jiraNames[0]), summary, usedTool(slackNames[0])])
		expect([...selection.names]).toEqual([slackNames[0]])
	})

	it("stops supplementing after searchTurns user turns and restarts after a summary", async () => {
		const { rank, select } = setup(jiraNames, 2)
		rank.mockResolvedValue([])
		const turns = ["one", "two", "three"].map(userTurn)
		await select(turns.slice(0, 2))
		await select(turns)
		await select([...turns, summary, userTurn("four")])
		expect(rank.mock.calls.map(([query]) => query)).toEqual([tagged("two"), tagged("four")])
	})

	it("does not supplement after the task message when searchTurns is 1", async () => {
		const { rank, select } = setup()
		rank.mockResolvedValueOnce(jiraNames).mockResolvedValue([])
		await select([userTurn("search jira tickets")])
		await select([userTurn("search jira tickets"), userTurn("check slack")])
		expect(rank.mock.calls.map(([query]) => query)).toEqual([tagged("search jira tickets"), tagged("check slack")])

		const sticky = setup(undefined, 1)
		sticky.rank.mockResolvedValueOnce(jiraNames)
		await sticky.select([userTurn("search jira tickets")])
		await sticky.select([userTurn("search jira tickets"), userTurn("check slack")])
		expect(sticky.rank.mock.calls.map(([query]) => query)).toEqual([tagged("search jira tickets")])
	})

	it.each([
		{ saved: 10, k: 7, warned: false },
		{ saved: 58, k: 2, warned: true },
		{ saved: 60, k: 0, warned: true },
		{ saved: 70, k: 0, warned: true },
	])("limits a supplement to the room under the attach cap ($saved saved)", async ({ saved, k, warned }) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const fillers = Array.from({ length: saved - jiraNames.length }, (_, i) => `mcp--other--t${i}`)
		const { rank, selection, select } = setup([...jiraNames, ...fillers])
		rank.mockResolvedValue(slackNames.slice(0, k))
		await select([userTurn("check slack")])
		expect(rank.mock.calls).toEqual(k ? [[tagged("check slack"), slackTools, k]] : [])
		expect(selection.names.size).toBe(saved + Math.min(k, slackNames.length))
		expect(warn).toHaveBeenCalledTimes(warned ? 1 : 0)
	})
})
