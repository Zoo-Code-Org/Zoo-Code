import { resolveAutocompleteConfig } from "@roo-code/types"

import { ContextGatherer, type SnippetSource, type SnippetSourceInput } from "../ContextGatherer"
import type { AutocompleteSnippet } from "../../types"

const config = resolveAutocompleteConfig({ useOpenTabs: true, useImportDefinitions: true })

const input = {} as SnippetSourceInput

const makeSource = (
	id: string,
	snippets: AutocompleteSnippet[],
	options: { delayMs?: number; throws?: boolean; enabled?: boolean } = {},
): SnippetSource => ({
	id,
	isEnabled: () => options.enabled ?? true,
	async gather() {
		if (options.throws) {
			throw new Error(`${id} exploded`)
		}

		if (options.delayMs) {
			await new Promise((resolve) => setTimeout(resolve, options.delayMs))
		}

		return snippets
	},
})

const snippet = (content: string, score = 0): AutocompleteSnippet => ({ content, filePath: "/a.py", score })

describe("ContextGatherer", () => {
	it("merges snippets from every enabled source", async () => {
		const gatherer = new ContextGatherer([
			makeSource("a", [snippet("import os")]),
			makeSource("b", [snippet("def helper(): ...")]),
		])

		const result = await gatherer.gather(input, config, 100)

		expect(result).toHaveLength(2)
	})

	it("skips disabled sources", async () => {
		const gatherer = new ContextGatherer([makeSource("a", [snippet("x")], { enabled: false })])

		expect(await gatherer.gather(input, config, 100)).toEqual([])
	})

	it("survives a source that throws", async () => {
		// One broken source must not deny the user every other kind of context.
		const gatherer = new ContextGatherer([
			makeSource("bad", [], { throws: true }),
			makeSource("good", [snippet("import os")]),
		])

		const result = await gatherer.gather(input, config, 100)

		expect(result).toHaveLength(1)
		expect(result[0].content).toBe("import os")
	})

	it("de-duplicates identical content, keeping the higher score", async () => {
		const gatherer = new ContextGatherer([
			makeSource("a", [snippet("import os", 0.2)]),
			makeSource("b", [snippet("import os", 0.9)]),
		])

		const result = await gatherer.gather(input, config, 100)

		expect(result).toHaveLength(1)
		expect(result[0].score).toBe(0.9)
	})

	it("orders snippets by score so the budget keeps the best", async () => {
		const gatherer = new ContextGatherer([
			makeSource("a", [snippet("low", 0.1)]),
			makeSource("b", [snippet("high", 0.9)]),
		])

		const result = await gatherer.gather(input, config, 100)

		expect(result.map((entry) => entry.content)).toEqual(["high", "low"])
	})

	it("returns early rather than waiting on a slow source", async () => {
		const gatherer = new ContextGatherer([makeSource("slow", [snippet("late")], { delayMs: 400 })])

		const startedAt = Date.now()
		await gatherer.gather(input, config, 50)

		// The abort signal fires at the budget; the source resolves on its own
		// schedule but the user is never made to wait for a full round trip.
		expect(Date.now() - startedAt).toBeLessThan(400)
	})
})
