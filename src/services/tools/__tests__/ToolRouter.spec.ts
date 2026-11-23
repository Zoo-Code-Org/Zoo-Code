import { Bm25Ranker } from "../Bm25Ranker"
import { ToolRouter } from "../ToolRouter"
import type { ToolDoc } from "../types"

const tools: ToolDoc[] = [
	{ serverName: "github", toolName: "issues", description: "search tickets" },
	{ serverName: "slack", toolName: "messages", description: "search messages" },
]

describe("ToolRouter", () => {
	afterEach(() => vi.restoreAllMocks())

	it("shares a process-wide singleton", () => {
		expect(ToolRouter.getInstance()).toBe(ToolRouter.getInstance())
	})

	it.each(["attachInitial", "search"] as const)("%s ranks only the supplied scope", async (method) => {
		const router = ToolRouter.getInstance()
		expect(await router[method]("tickets", tools, 1)).toEqual(["mcp--github--issues"])
		expect(await router[method]("tickets", [tools[1]], 1)).toEqual([])
		expect(await router[method]("search", tools, 1)).toHaveLength(1)
		expect(await router[method]("search", [], 5)).toEqual([])
		expect(await router[method]("search", tools, 0)).toEqual([])
	})

	it("reuses an index for equivalent arrays and snapshots mutable caller documents", async () => {
		const rank = vi.spyOn(Bm25Ranker.prototype, "rank")
		const router = ToolRouter.getInstance()
		const scope = tools.map((tool) => ({ ...tool }))
		await router.search("search", scope, 2)
		await router.search(
			"tickets",
			scope.map((tool) => ({ ...tool })),
			2,
		)
		const firstIndex = rank.mock.calls[0][1]
		expect(rank.mock.calls[1][1]).toBe(firstIndex)
		scope[0].description = "calendar"
		expect(await router.search("tickets", scope, 2)).toEqual([])
		expect(rank.mock.calls[2][1]).not.toBe(firstIndex)
		expect(firstIndex[0].description).toBe("search tickets")
	})

	it.each(["attachInitial", "search"] as const)(
		"%s skips blank queries before indexing or ranking",
		async (method) => {
			const router = ToolRouter.getInstance()
			expect(await router[method]("tickets", tools, 5)).toEqual(["mcp--github--issues"])
			const index = router["indexedTools"]
			const rank = vi.spyOn(Bm25Ranker.prototype, "rank")
			for (const query of ["", "   ", "\t\n"]) {
				expect(await router[method](query, [tools[1]], 5)).toEqual([])
				expect(router["indexedTools"]).toBe(index)
			}
			expect(rank).not.toHaveBeenCalled()
		},
	)

	it.each(["attachInitial", "search"] as const)("%s qualifies duplicate tool names by server", async (method) => {
		expect(
			await ToolRouter.getInstance()[method](
				"tickets",
				[
					{ serverName: "github", toolName: "issues", description: "tickets" },
					{ serverName: "jira", toolName: "issues", description: "tickets" },
				],
				2,
			),
		).toEqual(["mcp--github--issues", "mcp--jira--issues"])
	})

	it.each(["attachInitial", "search"] as const)("%s drops colliding canonical names before Top-K", async (method) => {
		const result = await ToolRouter.getInstance()[method](
			"tickets",
			[
				{ serverName: "a b", toolName: "t", description: "tickets" },
				{ serverName: "a_b", toolName: "t", description: "tickets" },
				{ serverName: "other", toolName: "u", description: "tickets" },
			],
			2,
		)
		expect(result).toHaveLength(2)
		expect(result).toEqual(expect.arrayContaining(["mcp--a_b--t", "mcp--other--u"]))
	})

	it.each(["attachInitial", "search"] as const)("%s validates and floors limits", async (method) => {
		const router = ToolRouter.getInstance()
		for (const limit of [NaN, Infinity, -Infinity, -1, 0, 0.5]) {
			expect(await router[method]("search", tools, limit)).toEqual([])
		}
		expect(await router[method]("search", tools, 1.9)).toHaveLength(1)
		expect(await router[method]("search", tools, 2)).toHaveLength(2)
	})
})
