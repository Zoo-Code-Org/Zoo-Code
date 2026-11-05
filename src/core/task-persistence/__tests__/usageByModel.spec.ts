import { describe, expect, it } from "vitest"

import { providerIdentifiers, type ClineMessage } from "@roo-code/types"

import { bindRequestToHandler, resolveRecordedModelId, summarizeUsageByModel } from "../usageByModel"

const req = (data: Record<string, unknown>, ts = 1): ClineMessage => ({
	ts,
	type: "say",
	say: "api_req_started",
	text: JSON.stringify(data),
})

describe("summarizeUsageByModel", () => {
	it("groups requests by the provider+model recorded on each request", () => {
		const result = summarizeUsageByModel([
			req({
				apiProvider: providerIdentifiers.githubCopilot,
				modelId: "claude-opus-5.5",
				tokensIn: 1000,
				tokensOut: 100,
				cost: 0,
			}),
			// Another model between the two requests of the first: they are grouped, not only merged when adjacent.
			req({
				apiProvider: providerIdentifiers.gemini,
				modelId: "gemini-3.1-pro-preview",
				tokensIn: 200,
				tokensOut: 20,
				cost: 0.4,
			}),
			req({
				apiProvider: providerIdentifiers.githubCopilot,
				modelId: "claude-opus-5.5",
				tokensIn: 500,
				tokensOut: 50,
				cost: 0,
			}),
		])

		expect(result).toEqual([
			{
				apiProvider: providerIdentifiers.githubCopilot,
				modelId: "claude-opus-5.5",
				requests: 2,
				tokensIn: 1500,
				tokensOut: 150,
				cost: 0,
			},
			{
				apiProvider: providerIdentifiers.gemini,
				modelId: "gemini-3.1-pro-preview",
				requests: 1,
				tokensIn: 200,
				tokensOut: 20,
				cost: 0.4,
			},
		])
	})

	it("keeps a task that switched providers mid-way split by what actually served each request", () => {
		const result = summarizeUsageByModel([
			req({
				apiProvider: providerIdentifiers.githubCopilot,
				modelId: "claude-opus-5.5",
				tokensIn: 100,
				tokensOut: 10,
			}),
			req({ apiProvider: providerIdentifiers.gemini, modelId: "gemini-pro", tokensIn: 300, tokensOut: 30 }),
		])
		expect(result.map((r) => r.apiProvider)).toEqual([
			providerIdentifiers.githubCopilot,
			providerIdentifiers.gemini,
		])
	})

	it("sums cache counters only when reported", () => {
		const [entry] = summarizeUsageByModel([
			req({
				apiProvider: providerIdentifiers.anthropic,
				modelId: "m",
				tokensIn: 1,
				tokensOut: 1,
				cacheReads: 5,
				cacheWrites: 2,
			}),
			req({ apiProvider: providerIdentifiers.anthropic, modelId: "m", tokensIn: 1, tokensOut: 1, cacheReads: 3 }),
		])
		expect(entry.cacheReads).toBe(8)
		expect(entry.cacheWrites).toBe(2)

		const [bare] = summarizeUsageByModel([req({ apiProvider: "a", modelId: "m", tokensIn: 1, tokensOut: 1 })])
		expect(bare).not.toHaveProperty("cacheReads")
	})

	it("puts requests recorded before this was tracked in an unrecorded entry rather than guessing", () => {
		const [entry] = summarizeUsageByModel([req({ apiProtocol: "openai", tokensIn: 10, tokensOut: 5, cost: 0 })])
		expect(entry).toMatchObject({ apiProvider: undefined, modelId: undefined, requests: 1, tokensIn: 10 })
	})

	it("ignores in-flight placeholders and non-request messages", () => {
		const result = summarizeUsageByModel([
			req({ apiProtocol: "openai", apiProvider: providerIdentifiers.gemini, modelId: "m" }), // no counts yet
			{ ts: 2, type: "say", say: "text", text: "hello" },
			{ ts: 3, type: "say", say: "api_req_started", text: "not json" },
			{ ts: 4, type: "say", say: "api_req_started" },
		])
		expect(result).toEqual([])
	})

	it("returns an empty list for no messages", () => {
		expect(summarizeUsageByModel([])).toEqual([])
	})
})

describe("summarizeUsageByModel with stored text that is not a request object", () => {
	const msg = (text: string): ClineMessage => ({ ts: 1, type: "say", say: "api_req_started", text })

	it.each(["null", "42", '"text"', "true", "[]"])("skips %s and keeps reading the other messages", (text) => {
		const summary = summarizeUsageByModel([
			msg(text),
			msg(JSON.stringify({ apiProvider: "p", modelId: "m", tokensIn: 5, tokensOut: 2, cost: 0.5 })),
		])

		expect(summary).toEqual([{ apiProvider: "p", modelId: "m", requests: 1, tokensIn: 5, tokensOut: 2, cost: 0.5 }])
	})
})

describe("summarizeUsageByModel with corrupted numbers", () => {
	const raw = (fields: string): ClineMessage => ({ ts: 1, type: "say", say: "api_req_started", text: `{${fields}}` })
	const head = '"apiProvider":"p","modelId":"m"'

	// JSON has no NaN or Infinity: JSON.stringify writes NaN as null, and a number too big for a double is read back
	// as Infinity (1e999).
	it.each([
		["a number too big to be finite (Infinity)", "1e999"],
		["a number too small to be finite (-Infinity)", "-1e999"],
		["NaN, written as null", "null"],
		["a string", '"100"'],
		["a boolean", "true"],
		["an object", "{}"],
		["an array", "[5]"],
	])("counts the request and reads %s as 0 in a token field, keeping the numeric ones", (_name, value) => {
		const summary = summarizeUsageByModel([raw(`${head},"tokensIn":${value},"tokensOut":7,"cost":0.5`)])

		expect(summary).toEqual([{ apiProvider: "p", modelId: "m", requests: 1, tokensIn: 0, tokensOut: 7, cost: 0.5 }])
	})

	it.each([
		["Infinity", "1e999"],
		["-Infinity", "-1e999"],
		["NaN, written as null", "null"],
		["a string", '"0.5"'],
	])("reads %s as 0 in the cost, and keeps the tokens", (_name, value) => {
		const summary = summarizeUsageByModel([raw(`${head},"tokensIn":3,"tokensOut":4,"cost":${value}`)])

		expect(summary).toEqual([{ apiProvider: "p", modelId: "m", requests: 1, tokensIn: 3, tokensOut: 4, cost: 0 }])
	})

	it("does not let a corrupted request spoil the sums of the others of the same model", () => {
		const summary = summarizeUsageByModel([
			raw(`${head},"tokensIn":100,"tokensOut":10,"cost":1`),
			raw(`${head},"tokensIn":1e999,"tokensOut":-1e999,"cost":null`),
			raw(`${head},"tokensIn":200,"tokensOut":20,"cost":2`),
		])

		expect(summary).toEqual([
			{ apiProvider: "p", modelId: "m", requests: 3, tokensIn: 300, tokensOut: 30, cost: 3 },
		])
		expect(Object.values(summary[0]).every((value) => typeof value !== "number" || Number.isFinite(value))).toBe(
			true,
		)
	})

	it.each([
		["both token fields are not numbers", '"tokensIn":"1","tokensOut":null,"cost":5'],
		["both token fields are missing", '"cost":5'],
	])("does not count a request whose %s: it has not finished", (_name, fields) => {
		expect(summarizeUsageByModel([raw(`${head},${fields}`)])).toEqual([])
	})

	it.each([
		["Infinity", "1e999"],
		["-Infinity", "-1e999"],
		["NaN, written as null", "null"],
		["a string", '"5"'],
	])("leaves a cache counter that is %s out, so the sums stay finite", (_name, value) => {
		const summary = summarizeUsageByModel([
			raw(`${head},"tokensIn":1,"tokensOut":1,"cost":0,"cacheReads":${value},"cacheWrites":${value}`),
			raw(`${head},"tokensIn":1,"tokensOut":1,"cost":0,"cacheReads":30,"cacheWrites":4`),
		])

		expect(summary).toEqual([
			{
				apiProvider: "p",
				modelId: "m",
				requests: 2,
				tokensIn: 2,
				tokensOut: 2,
				cost: 0,
				cacheReads: 30,
				cacheWrites: 4,
			},
		])
	})
})

describe("resolveRecordedModelId", () => {
	it("keeps a model that was recorded when the request started", () => {
		expect(resolveRecordedModelId("gpt-5", "gpt-5-mini")).toBe("gpt-5")
	})

	it("uses the model that served the request when the profile named none", () => {
		expect(resolveRecordedModelId(undefined, "claude-sonnet-5")).toBe("claude-sonnet-5")
		expect(resolveRecordedModelId("", "claude-sonnet-5")).toBe("claude-sonnet-5")
		expect(resolveRecordedModelId(null, "claude-sonnet-5")).toBe("claude-sonnet-5")
	})

	it("stays unrecorded when neither is known", () => {
		expect(resolveRecordedModelId(undefined, undefined)).toBeUndefined()
	})

	it("ignores a recorded value that is not a string", () => {
		expect(resolveRecordedModelId(42, "claude-sonnet-5")).toBe("claude-sonnet-5")
	})
})

describe("bindRequestToHandler", () => {
	const placeholder = JSON.stringify({ apiProtocol: "openai", apiProvider: "old-provider", modelId: "old-model" })

	it("records the provider of the handler that serves the request, over the one the placeholder was written with", () => {
		const bound = JSON.parse(
			bindRequestToHandler(placeholder, {
				apiProvider: "new-provider",
				configuredModelId: "new-model",
				servedModelId: "served-model",
			}),
		)
		expect(bound).toEqual({ apiProtocol: "openai", apiProvider: "new-provider", modelId: "new-model" })
	})

	it("records the pricing protocol of the handler too, over the one the placeholder was written with", () => {
		const bound = JSON.parse(
			bindRequestToHandler(placeholder, {
				apiProvider: "new-provider",
				configuredModelId: "new-model",
				servedModelId: undefined,
				apiProtocol: "anthropic",
			}),
		)

		expect(bound).toEqual({ apiProtocol: "anthropic", apiProvider: "new-provider", modelId: "new-model" })
	})

	it("keeps the protocol of the placeholder when the handler's is not given", () => {
		const bound = JSON.parse(
			bindRequestToHandler(placeholder, { apiProvider: "p", configuredModelId: "m", servedModelId: undefined }),
		)

		expect(bound.apiProtocol).toBe("openai")
	})

	it("records the model the handler reports when the profile names none", () => {
		const bound = JSON.parse(
			bindRequestToHandler(placeholder, {
				apiProvider: "p",
				configuredModelId: undefined,
				servedModelId: "served-model",
			}),
		)
		expect(bound.modelId).toBe("served-model")
	})

	it.each([[undefined], [""], ["not json"]])("starts from nothing when the placeholder is %j", (text) => {
		const bound = JSON.parse(
			bindRequestToHandler(text as string | undefined, {
				apiProvider: "p",
				configuredModelId: "m",
				servedModelId: undefined,
			}),
		)
		expect(bound).toEqual({ apiProvider: "p", modelId: "m" })
	})
})
