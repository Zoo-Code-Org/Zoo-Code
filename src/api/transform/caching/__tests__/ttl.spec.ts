// npx vitest run src/api/transform/caching/__tests__/ttl.spec.ts

import OpenAI from "openai"

import { addCacheBreakpoints as addAnthropicBreakpoints } from "../anthropic"
import { addCacheBreakpoints as addVertexBreakpoints } from "../vertex"
import { addCacheBreakpoints as addGatewayBreakpoints } from "../vercel-ai-gateway"
import { cacheControl, resolveCacheTtl } from "../ttl"

/**
 * Collect every `cache_control` object reachable in a serialized request.
 *
 * Counting occurrences rather than spot-checking one marker is the point: a
 * transform that forgot one of its marker sites would still pass a single-site
 * assertion, which is exactly the failure mode ADR-0006 I4 is meant to exclude.
 */
const collectCacheControls = (value: unknown): Array<Record<string, unknown>> => {
	const found: Array<Record<string, unknown>> = []

	const walk = (node: unknown) => {
		if (Array.isArray(node)) {
			node.forEach(walk)
			return
		}

		if (node && typeof node === "object") {
			for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
				if (key === "cache_control" && child && typeof child === "object") {
					found.push(child as Record<string, unknown>)
				}
				walk(child)
			}
		}
	}

	walk(value)
	return found
}

/** The serialized request body, so assertions run on the bytes that would be sent. */
const serialize = (value: unknown) => JSON.parse(JSON.stringify(value))

describe("resolveCacheTtl", () => {
	it("returns undefined when the knob is unset, even for a capable model", () => {
		expect(resolveCacheTtl({}, { promptCacheTtlSupport: ["5m", "1h"] })).toBeUndefined()
		expect(resolveCacheTtl(undefined, { promptCacheTtlSupport: ["5m", "1h"] })).toBeUndefined()
	})

	it("returns undefined for an explicit 5m so the wire shape stays unchanged", () => {
		expect(resolveCacheTtl({ promptCacheTtl: "5m" }, { promptCacheTtlSupport: ["5m", "1h"] })).toBeUndefined()
	})

	it("returns 1h when the knob asks for it and the model advertises it", () => {
		expect(resolveCacheTtl({ promptCacheTtl: "1h" }, { promptCacheTtlSupport: ["5m", "1h"] })).toBe("1h")
	})

	it("fails closed when the model advertises no capability at all", () => {
		expect(resolveCacheTtl({ promptCacheTtl: "1h" }, {})).toBeUndefined()
		expect(resolveCacheTtl({ promptCacheTtl: "1h" }, undefined)).toBeUndefined()
	})

	it("fails closed when the model advertises 5m only", () => {
		expect(resolveCacheTtl({ promptCacheTtl: "1h" }, { promptCacheTtlSupport: ["5m"] })).toBeUndefined()
	})
})

describe("cacheControl", () => {
	it("is the historical literal when no TTL is resolved", () => {
		expect(cacheControl(undefined)).toEqual({ type: "ephemeral" })
		expect(Object.keys(cacheControl(undefined))).toEqual(["type"])
	})

	it("carries the ttl key only when a TTL is resolved", () => {
		expect(cacheControl("1h")).toEqual({ type: "ephemeral", ttl: "1h" })
	})
})

describe("caching transforms under a prompt cache TTL", () => {
	const systemPrompt = "You are a helpful assistant."

	const buildOpenAiMessages = (): OpenAI.Chat.ChatCompletionMessageParam[] => [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: "First message" },
		{ role: "assistant", content: "First response" },
		{ role: "user", content: "Second message" },
	]

	const buildAnthropicMessages = () => [
		{ role: "user" as const, content: "First message" },
		{ role: "assistant" as const, content: "First response" },
		{ role: "user" as const, content: "Second message" },
	]

	describe("default parity (ADR-0006 I3)", () => {
		it("emits no ttl key anywhere when the TTL argument is omitted", () => {
			const messages = buildOpenAiMessages()
			addAnthropicBreakpoints(systemPrompt, messages)

			const serialized = serialize(messages)
			const rawJson = JSON.stringify(messages)

			expect(rawJson).not.toContain("ttl")
			expect(serialized).not.toContain("ttl")

			const controls = collectCacheControls(serialized)
			expect(controls).toHaveLength(3)
			expect(controls.every((control) => control.ttl === undefined)).toBe(true)
		})

		it("is byte-identical to the pre-knob literal for every transform", () => {
			const anthropicMessages = buildOpenAiMessages()
			addAnthropicBreakpoints(systemPrompt, anthropicMessages)

			const gatewayMessages = buildOpenAiMessages()
			addGatewayBreakpoints(systemPrompt, gatewayMessages)

			const vertexMessages = addVertexBreakpoints(buildAnthropicMessages())

			expect(serialize(anthropicMessages)).toEqual(
				serialize([
					{
						role: "system",
						content: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
					},
					{
						role: "user",
						content: [{ type: "text", text: "First message", cache_control: { type: "ephemeral" } }],
					},
					{ role: "assistant", content: "First response" },
					{
						role: "user",
						content: [{ type: "text", text: "Second message", cache_control: { type: "ephemeral" } }],
					},
				]),
			)

			expect(serialize(gatewayMessages)).toEqual(
				serialize([
					{ role: "system", content: systemPrompt, cache_control: { type: "ephemeral" } },
					{
						role: "user",
						content: [{ type: "text", text: "First message", cache_control: { type: "ephemeral" } }],
					},
					{ role: "assistant", content: "First response" },
					{
						role: "user",
						content: [{ type: "text", text: "Second message", cache_control: { type: "ephemeral" } }],
					},
				]),
			)

			expect(serialize(vertexMessages)).toEqual(
				serialize([
					{
						role: "user",
						content: [{ type: "text", text: "First message", cache_control: { type: "ephemeral" } }],
					},
					{ role: "assistant", content: "First response" },
					{
						role: "user",
						content: [{ type: "text", text: "Second message", cache_control: { type: "ephemeral" } }],
					},
				]),
			)
		})
	})

	describe("opt-in uniformity (ADR-0006 I4)", () => {
		it("puts ttl 1h on every anthropic marker, not just the first", () => {
			const messages = buildOpenAiMessages()
			addAnthropicBreakpoints(systemPrompt, messages, "1h")

			const controls = collectCacheControls(serialize(messages))
			expect(controls).toHaveLength(3)
			expect(controls.every((control) => control.ttl === "1h")).toBe(true)
			expect(controls.every((control) => control.type === "ephemeral")).toBe(true)
		})

		it("puts ttl 1h on every gateway marker", () => {
			const messages = buildOpenAiMessages()
			addGatewayBreakpoints(systemPrompt, messages, "1h")

			const controls = collectCacheControls(serialize(messages))
			expect(controls).toHaveLength(3)
			expect(controls.every((control) => control.ttl === "1h")).toBe(true)
		})

		it("puts ttl 1h on every vertex marker", () => {
			const messages = addVertexBreakpoints(buildAnthropicMessages(), "1h")

			const controls = collectCacheControls(serialize(messages))
			expect(controls).toHaveLength(2)
			expect(controls.every((control) => control.ttl === "1h")).toBe(true)
		})

		it("never mixes TTLs within one request", () => {
			const messages = buildOpenAiMessages()
			addAnthropicBreakpoints(systemPrompt, messages, "1h")

			const ttls = new Set(collectCacheControls(serialize(messages)).map((control) => control.ttl))
			expect(ttls).toEqual(new Set(["1h"]))
		})
	})

	describe("signature is additive-optional", () => {
		it("keeps the two-argument call compiling and byte-identical", () => {
			const withDefault = buildOpenAiMessages()
			const withExplicitUndefined = buildOpenAiMessages()

			addAnthropicBreakpoints(systemPrompt, withDefault)
			addAnthropicBreakpoints(systemPrompt, withExplicitUndefined, undefined)

			expect(serialize(withDefault)).toEqual(serialize(withExplicitUndefined))
		})
	})
})
