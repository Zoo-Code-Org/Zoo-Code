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
			req({
				apiProvider: providerIdentifiers.githubCopilot,
				modelId: "claude-opus-5.5",
				tokensIn: 500,
				tokensOut: 50,
				cost: 0,
			}),
			req({
				apiProvider: providerIdentifiers.gemini,
				modelId: "gemini-3.1-pro-preview",
				tokensIn: 200,
				tokensOut: 20,
				cost: 0.4,
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
	const msg = (text: string) =>
		({ ts: 1, type: "say", say: "api_req_started", text }) as unknown as Parameters<
			typeof summarizeUsageByModel
		>[0][number]

	it.each(["null", "42", '"text"', "true", "[]"])("skips %s and keeps reading the other messages", (text) => {
		const summary = summarizeUsageByModel([
			msg(text),
			msg(JSON.stringify({ apiProvider: "p", modelId: "m", tokensIn: 5, tokensOut: 2, cost: 0.5 })),
		])

		expect(summary).toEqual([{ apiProvider: "p", modelId: "m", requests: 1, tokensIn: 5, tokensOut: 2, cost: 0.5 }])
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
