import { describe, expect, it } from "vitest"
import { Bm25Ranker } from "../Bm25Ranker"
import { ToolDoc } from "../types"

const tool = (serverName: string, toolName: string, description: string): ToolDoc => ({
	serverName,
	toolName,
	description,
})

describe("Bm25Ranker", () => {
	it("ranks matching MCP tools by BM25 relevance", () => {
		const items = [
			tool("slack", "postMessage", "Send a Slack message"),
			tool("jira", "createIssue", "Send messages and create Jira issues"),
			tool("postgres", "query", "Send data and query a Postgres database"),
		]

		expect(new Bm25Ranker().rank("send slack message", items, 3)).toEqual([items[0], items[1], items[2]])
	})

	it("returns an empty result for empty queries, empty items, and no matches", () => {
		const ranker = new Bm25Ranker()
		const items = [tool("slack", "postMessage", "Send a message")]

		expect(ranker.rank("   ", items, 10)).toEqual([])
		expect(ranker.rank("message", [], 10)).toEqual([])
		expect(ranker.rank("unrelated", items, 10)).toEqual([])
	})

	it("truncates results to the requested top-k", () => {
		const items = [
			tool("one", "search", "Search records"),
			tool("two", "search", "Search records"),
			tool("three", "search", "Search records"),
		]

		expect(new Bm25Ranker().rank("search", items, 2)).toEqual(items.slice(0, 2))
		expect(new Bm25Ranker().rank("search", items, 0)).toEqual([])
	})

	it("preserves input order for equal scores", () => {
		const items = [tool("first", "lookup", "Find a record"), tool("second", "lookup", "Find a record")]

		expect(new Bm25Ranker().rank("record", items, 10)).toEqual(items)
	})

	it("tokenizes case-insensitively around punctuation", () => {
		const matching = tool("Slack-Server", "POST.Message", "Send a message")
		const nonMatching = tool("calendar", "createEvent", "Create a calendar event")

		expect(new Bm25Ranker().rank("SLACK post message", [nonMatching, matching], 10)).toEqual([matching])
	})

	it("handles tools with empty descriptions", () => {
		const item = tool("GitHub", "listRepos", "")

		expect(new Bm25Ranker().rank("github repos", [item], 10)).toEqual([item])
	})

	it("rebuilds only when the items array reference changes", () => {
		const items = [tool("slack", "send", "Send a message")]
		const ranker = new Bm25Ranker()

		ranker.rank("send", items, 10)
		items.push(tool("jira", "create", "Create an issue"))
		expect(ranker.rank("issue", items, 10)).toEqual([])

		const newItems = items.slice()
		expect(ranker.rank("issue", newItems, 10)).toEqual([newItems[1]])
	})
})
