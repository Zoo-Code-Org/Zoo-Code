// npx vitest run src/api/providers/__tests__/bedrock-cache-ttl.spec.ts

const mockCaptureException = vi.fn()

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: (...args: unknown[]) => mockCaptureException(...args),
		},
	},
}))

vi.mock("@aws-sdk/credential-providers", () => {
	const mockFromIni = vi.fn().mockReturnValue({
		accessKeyId: "profile-access-key",
		secretAccessKey: "profile-secret-key",
	})
	return { fromIni: mockFromIni }
})

vi.mock("../../../utils/networkProxy", () => ({
	getSystemProxyUrl: vi.fn().mockReturnValue(undefined),
}))

vi.mock("@smithy/node-http-handler", () => ({
	NodeHttpHandler: vi.fn(),
}))

vi.mock("http-proxy-agent", () => ({
	HttpProxyAgent: vi.fn(),
}))

vi.mock("https-proxy-agent", () => ({
	HttpsProxyAgent: vi.fn(),
}))

vi.mock("@aws-sdk/client-bedrock-runtime", async () => {
	const actual = await vi.importActual<typeof import("@aws-sdk/client-bedrock-runtime")>(
		"@aws-sdk/client-bedrock-runtime",
	)
	const mockSend = vi.fn().mockResolvedValue({ stream: [] })
	const mockConverseStreamCommand = vi.fn()

	return {
		...actual,
		BedrockRuntimeClient: vi.fn().mockImplementation(function () {
			return { send: mockSend }
		}),
		ConverseStreamCommand: mockConverseStreamCommand,
		ConverseCommand: vi.fn(),
	}
})

import { AwsBedrockHandler } from "../bedrock"
import { ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime"
import { bedrockModels, BEDROCK_CUSTOM_ARN_OTHER_BASE_MODEL, type ProviderSettings } from "@roo-code/types"

import type { Anthropic } from "@anthropic-ai/sdk"
import { clearAllMocks } from "../../../test-utils/reset"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"

const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)

/**
 * Bedrock Converse cache-point TTL emission (ADR-0006 PR-C7).
 *
 * Every assertion here runs on the serialized `ConverseStreamCommand` input, i.e.
 * the bytes that would reach AWS. Bedrock rejects an explicit `ttl` for a model
 * that does not support it (`ValidationException`, 400, no fallback), and it also
 * rejects a shorter TTL appearing before a longer one across tools -> system ->
 * messages, so both "did we emit it everywhere" and "did we emit it nowhere" have
 * to be checked by counting cache points rather than by spot-checking one.
 */

/** Collect every `cachePoint` object reachable in a serialized request. */
const collectCachePoints = (value: unknown): Array<Record<string, unknown>> => {
	const found: Array<Record<string, unknown>> = []

	const walk = (node: unknown) => {
		if (Array.isArray(node)) {
			node.forEach(walk)
			return
		}

		if (node && typeof node === "object") {
			for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
				if (key === "cachePoint" && child && typeof child === "object") {
					found.push(child as Record<string, unknown>)
				}
				walk(child)
			}
		}
	}

	walk(value)
	return found
}

/** True when any `ttl` key exists anywhere in the serialized request. */
const containsTtlKey = (value: unknown): boolean => {
	if (Array.isArray(value)) return value.some(containsTtlKey)
	if (value && typeof value === "object") {
		return Object.entries(value as Record<string, unknown>).some(
			([key, child]) => key === "ttl" || containsTtlKey(child),
		)
	}
	return false
}

/** The serialized command input, so assertions run on the bytes that would be sent. */
const serialize = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>

// The system prompt must clear minTokensPerCachePoint (1024 for the Claude rows) so
// the strategy actually places a system cache point, and the message tail must clear
// it too so a message-level cache point is placed. Both emitters then appear in one
// request, which is the case a single-emitter assertion would miss.
const longSystemPrompt = "You are a helpful assistant. ".repeat(200)
const longUserMessage = "Please review this file. ".repeat(200)

const messages: Anthropic.Messages.MessageParam[] = [
	{ role: "user", content: longUserMessage },
	{ role: "assistant", content: "Here is the review. ".repeat(200) },
	{ role: "user", content: longUserMessage },
]

const createHandler = (overrides: Partial<ProviderSettings> = {}) =>
	new AwsBedrockHandler({
		apiModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
		awsAccessKey: "test-access-key",
		awsSecretKey: "test-secret-key",
		awsRegion: "us-east-1",
		...overrides,
	})

/** Run one createMessage and return the serialized ConverseStreamCommand input. */
const captureConverseInput = async (handler: AwsBedrockHandler): Promise<Record<string, unknown>> => {
	mockConverseStreamCommand.mockClear()
	const stream = handler.createMessage(longSystemPrompt, messages)
	await collectStream(stream)

	expect(mockConverseStreamCommand).toHaveBeenCalledTimes(1)
	return serialize(mockConverseStreamCommand.mock.calls[0][0])
}

describe("Bedrock cache-point TTL emission", () => {
	beforeEach(() => {
		clearAllMocks()
		mockCaptureException.mockClear()
	})

	describe("1h-capable model with the knob at 1h", () => {
		it("carries ttl 1h on every cache point in the request", async () => {
			const handler = createHandler({
				apiModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
				promptCacheTtl: "1h",
			})
			handler["client"].send = vi.fn().mockResolvedValue({ stream: asyncStreamFrom([]) })

			const input = await captureConverseInput(handler)
			const cachePoints = collectCachePoints(input)

			// Both emitters must be present, otherwise the "every cache point" claim is vacuous.
			const systemCachePoints = collectCachePoints(input.system)
			const messageCachePoints = collectCachePoints(input.messages)
			expect(systemCachePoints.length).toBeGreaterThan(0)
			expect(messageCachePoints.length).toBeGreaterThan(0)
			expect(cachePoints.length).toBe(systemCachePoints.length + messageCachePoints.length)

			for (const cachePoint of cachePoints) {
				expect(cachePoint).toEqual({ type: "default", ttl: "1h" })
			}
		})

		it("emits one uniform TTL per request, so the tools -> system -> messages ordering hazard stays unreachable", async () => {
			const handler = createHandler({
				apiModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
				promptCacheTtl: "1h",
			})
			handler["client"].send = vi.fn().mockResolvedValue({ stream: asyncStreamFrom([]) })

			const input = await captureConverseInput(handler)
			const ttls = new Set(collectCachePoints(input).map((cachePoint) => cachePoint.ttl))

			// A set of size 1 is the whole invariant: with one value there is no
			// "shorter before longer" pair to reject, regardless of placement order.
			expect(ttls).toEqual(new Set(["1h"]))
		})

		it("keeps the cache-point placement identical to the unset-knob request", async () => {
			const capable = { apiModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0" } as const

			const withoutKnob = createHandler(capable)
			withoutKnob["client"].send = vi.fn().mockResolvedValue({ stream: asyncStreamFrom([]) })
			const baseInput = await captureConverseInput(withoutKnob)

			const withKnob = createHandler({ ...capable, promptCacheTtl: "1h" })
			withKnob["client"].send = vi.fn().mockResolvedValue({ stream: asyncStreamFrom([]) })
			const ttlInput = await captureConverseInput(withKnob)

			// Strip the ttl the knob adds and the two requests must be byte-identical:
			// adding a TTL must not move a single cache point.
			const stripTtl = (value: unknown): unknown =>
				JSON.parse(JSON.stringify(value, (key, child) => (key === "ttl" ? undefined : child)))

			expect(stripTtl(ttlInput)).toEqual(baseInput)
			expect(collectCachePoints(baseInput).length).toBe(collectCachePoints(ttlInput).length)
		})
	})

	describe("5m-only models with the knob at 1h (ValidationException tripwire)", () => {
		// AWS rejects an explicit ttl for these with a 400 that kills the turn, so the
		// assertion is that no `ttl` key exists anywhere in the serialized request.
		it.each([
			["Opus 4.1 (4.x generation, 5m-only)", "anthropic.claude-opus-4-1-20250805-v1:0"],
			["Opus 4 (pre-4.1, 5m-only)", "anthropic.claude-opus-4-20250514-v1:0"],
			["Claude 3.7 Sonnet (3.x, 5m-only)", "anthropic.claude-3-7-sonnet-20250219-v1:0"],
			["Nova Pro (non-Anthropic, 5m-only)", "amazon.nova-pro-v1:0"],
		])("emits no ttl for %s", async (_label, apiModelId) => {
			const handler = createHandler({ apiModelId, promptCacheTtl: "1h" })
			handler["client"].send = vi.fn().mockResolvedValue({ stream: asyncStreamFrom([]) })

			const input = await captureConverseInput(handler)

			expect(containsTtlKey(input)).toBe(false)
			// The cache points themselves must still be there: the gate suppresses the
			// ttl, not the caching.
			for (const cachePoint of collectCachePoints(input)) {
				expect(cachePoint).toEqual({ type: "default" })
			}
		})
	})

	describe("knob unset (default parity)", () => {
		it("serializes a byte-identical request to a pre-knob build for a capable model", async () => {
			const handler = createHandler({ apiModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0" })
			handler["client"].send = vi.fn().mockResolvedValue({ stream: asyncStreamFrom([]) })

			const input = await captureConverseInput(handler)

			expect(containsTtlKey(input)).toBe(false)
			expect(collectCachePoints(input).length).toBeGreaterThan(0)
			for (const cachePoint of collectCachePoints(input)) {
				expect(cachePoint).toEqual({ type: "default" })
			}
		})

		it("treats an explicit 5m knob as unset so the wire shape does not change", async () => {
			const capable = { apiModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0" } as const

			const unset = createHandler(capable)
			unset["client"].send = vi.fn().mockResolvedValue({ stream: asyncStreamFrom([]) })
			const unsetInput = await captureConverseInput(unset)

			const explicit5m = createHandler({ ...capable, promptCacheTtl: "5m" })
			explicit5m["client"].send = vi.fn().mockResolvedValue({ stream: asyncStreamFrom([]) })
			const explicit5mInput = await captureConverseInput(explicit5m)

			expect(explicit5mInput).toEqual(unsetInput)
			expect(containsTtlKey(explicit5mInput)).toBe(false)
		})
	})

	describe("custom ARN / inference-profile resolution (fail closed)", () => {
		it("emits 1h for an inference profile whose resolved base id is exactly listed", async () => {
			// `us.` is a cross-region prefix, not part of the catalog id, so this only
			// works if the prefix is stripped before the capability lookup.
			const handler = createHandler({
				apiModelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
				promptCacheTtl: "1h",
			})
			handler["client"].send = vi.fn().mockResolvedValue({ stream: asyncStreamFrom([]) })

			const input = await captureConverseInput(handler)

			expect(collectCachePoints(input).length).toBeGreaterThan(0)
			for (const cachePoint of collectCachePoints(input)) {
				expect(cachePoint).toEqual({ type: "default", ttl: "1h" })
			}
		})

		it("emits no ttl for an inference-profile ARN that names a 5m-only model", async () => {
			// The ARN names Opus 4.1, which is 5m-only despite being a 4.x generation.
			// Resolution succeeds (so cache points are placed), but the capability
			// lookup must still refuse the TTL.
			const handler = createHandler({
				awsCustomArn:
					"arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-1-20250805-v1:0",
				promptCacheTtl: "1h",
			})
			handler["client"].send = vi.fn().mockResolvedValue({ stream: asyncStreamFrom([]) })

			const input = await captureConverseInput(handler)

			// Cache points exist, so the assertion is about the gate rather than about
			// caching being off for an unrelated reason.
			expect(collectCachePoints(input).length).toBeGreaterThan(0)
			expect(containsTtlKey(input)).toBe(false)
		})

		it("places no cache points at all when the ARN resolves to no catalog model", async () => {
			// The deepest fail-closed path: an application inference profile the user
			// marked as "other" resolves to no catalog entry, so the guessed ModelInfo
			// reports no prompt-cache support and no capability can exist.
			const handler = createHandler({
				awsCustomArn: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123",
				awsCustomArnBaseModelId: BEDROCK_CUSTOM_ARN_OTHER_BASE_MODEL,
				promptCacheTtl: "1h",
			})
			handler["client"].send = vi.fn().mockResolvedValue({ stream: asyncStreamFrom([]) })

			const input = await captureConverseInput(handler)

			expect(collectCachePoints(input)).toEqual([])
			expect(containsTtlKey(input)).toBe(false)
		})

		it("emits no ttl for an unlisted model that the heuristic fallback guesses", async () => {
			// The fallback spreads the default row (which is 1h-capable) and then overlays
			// the guess, so the capability is inherited unless it is cleared. An unlisted
			// id is exactly the case where we cannot prove the model accepts 1h, and Bedrock
			// answers an unsupported ttl with a ValidationException that kills the turn.
			const handler = createHandler({
				awsCustomArn:
					"arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v1:0",
				promptCacheTtl: "1h",
			})
			handler["client"].send = vi.fn().mockResolvedValue({ stream: asyncStreamFrom([]) })

			const input = await captureConverseInput(handler)

			// The guess still reports caching support, so cache points exist and the
			// assertion is about the capability gate rather than caching being off.
			expect(collectCachePoints(input).length).toBeGreaterThan(0)
			expect(containsTtlKey(input)).toBe(false)
		})

		it("emits 1h for a foundation-model ARN that names a listed model", async () => {
			const handler = createHandler({
				awsCustomArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0",
				promptCacheTtl: "1h",
			})
			handler["client"].send = vi.fn().mockResolvedValue({ stream: asyncStreamFrom([]) })

			const input = await captureConverseInput(handler)

			expect(collectCachePoints(input).length).toBeGreaterThan(0)
			for (const cachePoint of collectCachePoints(input)) {
				expect(cachePoint).toEqual({ type: "default", ttl: "1h" })
			}
		})
	})

	describe("usage cacheDetails split", () => {
		it("reports the 1h share of the cache writes when Converse returns a split", async () => {
			const handler = createHandler({
				apiModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
				promptCacheTtl: "1h",
			})
			handler["client"].send = vi.fn().mockResolvedValue({
				stream: asyncStreamFrom([
					{
						metadata: {
							usage: {
								inputTokens: 10,
								outputTokens: 5,
								cacheWriteInputTokens: 3000,
								cacheDetails: [
									{ ttl: "1h", inputTokens: 2000 },
									{ ttl: "5m", inputTokens: 1000 },
								],
							},
						},
					},
				]),
			})

			const chunks = await collectStream(handler.createMessage(longSystemPrompt, messages))
			const usage = chunks.find((chunk) => chunk.type === "usage")

			expect(usage).toMatchObject({
				type: "usage",
				cacheWriteTokens: 3000,
				cacheWrite1hTokens: 2000,
			})
		})

		it("omits the 1h share when the response carries no cacheDetails", async () => {
			const handler = createHandler({ apiModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0" })
			handler["client"].send = vi.fn().mockResolvedValue({
				stream: asyncStreamFrom([
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5, cacheWriteInputTokens: 3000 } } },
				]),
			})

			const chunks = await collectStream(handler.createMessage(longSystemPrompt, messages))
			const usage = chunks.find((chunk) => chunk.type === "usage")

			expect(usage).toMatchObject({ type: "usage", cacheWriteTokens: 3000 })
			expect((usage as { cacheWrite1hTokens?: number }).cacheWrite1hTokens).toBeUndefined()
		})

		it.each([
			["a 5m entry and no 1h entry", [{ ttl: "5m", inputTokens: 1000 }]],
			["a negative 1h count", [{ ttl: "1h", inputTokens: -5 }]],
			["a zero 1h count", [{ ttl: "1h", inputTokens: 0 }]],
		])("omits the 1h share when the split carries %s", async (_label, cacheDetails) => {
			// Each row is a distinct malformed shape the reader must absorb rather than
			// bill: an absent 1h entry (optional chain), a negative count (the `<= 0`
			// guard, which `!oneHour` alone does not cover), and a zero count.
			const handler = createHandler({ apiModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0" })
			handler["client"].send = vi.fn().mockResolvedValue({
				stream: asyncStreamFrom([
					{
						metadata: {
							usage: {
								inputTokens: 10,
								outputTokens: 5,
								cacheWriteInputTokens: 3000,
								cacheDetails,
							},
						},
					},
				]),
			})

			const chunks = await collectStream(handler.createMessage(longSystemPrompt, messages))
			const usage = chunks.find((chunk) => chunk.type === "usage")

			expect(usage).toMatchObject({ type: "usage", cacheWriteTokens: 3000 })
			expect((usage as { cacheWrite1hTokens?: number }).cacheWrite1hTokens).toBeUndefined()
		})

		it("reads the 1h entry wherever it sits in the split, not just the first entry", async () => {
			// Converse orders the split longest-TTL-first today, but the reader must match
			// on the ttl value rather than trusting position: a 5m entry ahead of the 1h
			// entry would otherwise report the 5m count as the 1h share.
			const handler = createHandler({ apiModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0" })
			handler["client"].send = vi.fn().mockResolvedValue({
				stream: asyncStreamFrom([
					{
						metadata: {
							usage: {
								inputTokens: 10,
								outputTokens: 5,
								cacheWriteInputTokens: 3000,
								cacheDetails: [
									{ ttl: "5m", inputTokens: 1000 },
									{ ttl: "1h", inputTokens: 2000 },
								],
							},
						},
					},
				]),
			})

			const chunks = await collectStream(handler.createMessage(longSystemPrompt, messages))
			const usage = chunks.find((chunk) => chunk.type === "usage")

			expect(usage).toMatchObject({ type: "usage", cacheWriteTokens: 3000, cacheWrite1hTokens: 2000 })
		})

		it("clamps the 1h share to the reported aggregate so a malformed split cannot over-bill", async () => {
			const handler = createHandler({ apiModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0" })
			handler["client"].send = vi.fn().mockResolvedValue({
				stream: asyncStreamFrom([
					{
						metadata: {
							usage: {
								inputTokens: 10,
								outputTokens: 5,
								cacheWriteInputTokens: 500,
								cacheDetails: [{ ttl: "1h", inputTokens: 900 }],
							},
						},
					},
				]),
			})

			const chunks = await collectStream(handler.createMessage(longSystemPrompt, messages))
			const usage = chunks.find((chunk) => chunk.type === "usage")

			expect(usage).toMatchObject({ type: "usage", cacheWriteTokens: 500, cacheWrite1hTokens: 500 })
		})
	})
})

describe("Bedrock cache TTL capability catalog", () => {
	const oneHourIds = Object.entries(bedrockModels)
		.filter(([, info]) => (info as { promptCacheTtlSupport?: string[] }).promptCacheTtlSupport?.includes("1h"))
		.map(([id]) => id)
		.sort()

	it("marks exactly the 1h-capable Claude rows the AWS TTL table lists", () => {
		// Pinned by exact id, not by pattern: Opus 4.1 and Opus 4 are 5m-only while
		// Opus 4.6/4.7/4.8 are 1h-capable, so a version heuristic mis-classifies the
		// boundary in both directions. Adding a row here means adding it to the AWS
		// table first.
		expect(oneHourIds).toEqual(
			[
				"anthropic.claude-fable-5",
				"anthropic.claude-fable-5-1",
				"anthropic.claude-haiku-4-5-20251001-v1:0",
				"anthropic.claude-haiku-5-5",
				"anthropic.claude-opus-4-5-20251101-v1:0",
				"anthropic.claude-opus-4-6-v1",
				"anthropic.claude-opus-4-7",
				"anthropic.claude-opus-4-8",
				"anthropic.claude-opus-5",
				"anthropic.claude-opus-5-5",
				"anthropic.claude-sonnet-4-5-20250929-v1:0",
				"anthropic.claude-sonnet-4-6",
				"anthropic.claude-sonnet-5",
			].sort(),
		)
	})

	it("never marks a Nova row, because Nova rejects an extended TTL outright", () => {
		// The observed error for a Nova model is "Extended TTL prompt caching is only
		// supported for Anthropic models", and Nova Premier is unresolved in the AWS
		// table, so no Nova row may claim 1h.
		const novaRows = Object.entries(bedrockModels)
			.filter(([id]) => id.startsWith("amazon.nova"))
			.filter(([, info]) => (info as { promptCacheTtlSupport?: string[] }).promptCacheTtlSupport !== undefined)
			.map(([id]) => id)

		expect(novaRows).toEqual([])
	})

	it("leaves the 5m-only Claude rows without capability so they fail closed", () => {
		const fiveMinuteOnly = [
			"anthropic.claude-3-5-haiku-20241022-v1:0",
			"anthropic.claude-3-5-sonnet-20241022-v2:0",
			"anthropic.claude-3-7-sonnet-20250219-v1:0",
			"anthropic.claude-opus-4-1-20250805-v1:0",
			"anthropic.claude-opus-4-20250514-v1:0",
			"anthropic.claude-sonnet-4-20250514-v1:0",
		]

		for (const id of fiveMinuteOnly) {
			const info = (bedrockModels as Record<string, { promptCacheTtlSupport?: string[] }>)[id]
			expect(info, id).toBeDefined()
			expect(info.promptCacheTtlSupport, id).toBeUndefined()
		}
	})

	it("keys every 1h cache-write rate off the same tier's input price", () => {
		// The tier-shadow bug class: a tier that overrides inputPrice must override
		// cacheWritesPrice1h too, otherwise a long-context 1h write bills at the base
		// tier's rate. Checked per entry and per tier, not just on the top-level row.
		for (const [id, info] of Object.entries(bedrockModels)) {
			const entry = info as {
				inputPrice?: number
				cacheWritesPrice1h?: number
				tiers?: Array<{ inputPrice?: number; cacheWritesPrice1h?: number }>
			}
			if (entry.cacheWritesPrice1h !== undefined && entry.inputPrice !== undefined) {
				expect(entry.cacheWritesPrice1h, id).toBeCloseTo(entry.inputPrice * 2, 9)
			}

			for (const [index, tier] of (entry.tiers ?? []).entries()) {
				// A tier that reprices input without repricing the 1h write is exactly the
				// shadow this test exists to catch, so it must fail rather than be skipped.
				// The exemption is only for rows that price no 1h write at all: a 5m-only
				// model's tier has no 1h rate to shadow.
				if (tier.cacheWritesPrice1h === undefined) {
					expect(
						tier.inputPrice === undefined || entry.cacheWritesPrice1h === undefined,
						`${id} tier ${index} reprices input but not the 1h write`,
					).toBe(true)
					continue
				}
				expect(tier.inputPrice, `${id} tier ${index}`).toBeDefined()
				expect(tier.cacheWritesPrice1h, `${id} tier ${index}`).toBeCloseTo((tier.inputPrice as number) * 2, 9)
			}
		}
	})
})
