// npx vitest src/api/providers/__tests__/bedrock-max-tokens-probe.spec.ts

import { describe, expect, it, vi } from "vitest"

import { probeBedrockMaxOutputTokens, BEDROCK_MAX_OUTPUT_PROBE_CEILING } from "../bedrock-discovery"

const baseOptions = {
	awsRegion: "us-west-2",
	awsAccessKey: "AKIA",
	awsSecretKey: "secret",
} as const

const buildValidationError = (message: string) => {
	const err = new Error(message)
	err.name = "ValidationException"
	;(err as any).$metadata = { httpStatusCode: 400 }
	return err
}

describe("probeBedrockMaxOutputTokens", () => {
	it("returns the ceiling when AWS accepts the first probe", async () => {
		const runProbe = vi.fn().mockResolvedValue(undefined)

		const result = await probeBedrockMaxOutputTokens({
			options: baseOptions,
			modelId: "anthropic.claude-opus-4-7",
			probeCeiling: 256_000,
			runProbe,
		})

		expect(result).toEqual({
			maxOutputTokens: 256_000,
			source: "accepted",
			attempts: 1,
		})
		expect(runProbe).toHaveBeenCalledTimes(1)
		expect(runProbe).toHaveBeenCalledWith(256_000)
	})

	it("recovers the cap from a parsable AWS error message hint", async () => {
		const runProbe = vi
			.fn()
			.mockRejectedValueOnce(
				buildValidationError("max_tokens: 256000 must be less than or equal to 128000 for this model"),
			)
			.mockResolvedValueOnce(undefined)

		const result = await probeBedrockMaxOutputTokens({
			options: baseOptions,
			modelId: "anthropic.claude-opus-4-7",
			probeCeiling: 256_000,
			runProbe,
		})

		expect(result.maxOutputTokens).toBe(128_000)
		expect(result.source).toBe("hint")
		expect(result.attempts).toBe(2)
		expect(runProbe).toHaveBeenNthCalledWith(2, 128_000)
	})

	it("falls back to binary search when no hint is present", async () => {
		// Simulate a model that caps at 65_536. AWS rejects anything above with an opaque message.
		const cap = 65_536
		const runProbe = vi.fn(async (maxTokens: number) => {
			if (maxTokens > cap) {
				throw buildValidationError("max_tokens validation failed: invalid request")
			}
			return undefined
		})

		const result = await probeBedrockMaxOutputTokens({
			options: baseOptions,
			modelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
			probeCeiling: 200_000,
			runProbe,
		})

		// Binary search should converge to the exact cap (within 1 token).
		expect(result.source).toBe("binary-search")
		expect(result.maxOutputTokens).toBeLessThanOrEqual(cap)
		expect(result.maxOutputTokens).toBeGreaterThan(cap - 4) // tight bound
		expect(result.attempts).toBeGreaterThan(2)
	})

	it("propagates non-validation errors immediately", async () => {
		const networkError = Object.assign(new Error("connect ETIMEDOUT"), { name: "TimeoutError" })
		const runProbe = vi.fn().mockRejectedValue(networkError)

		await expect(
			probeBedrockMaxOutputTokens({
				options: baseOptions,
				modelId: "anthropic.claude-opus-4-7",
				probeCeiling: 256_000,
				runProbe,
			}),
		).rejects.toMatchObject({ message: "connect ETIMEDOUT" })
		// We never recover from non-validation errors, so only one probe should have been issued.
		expect(runProbe).toHaveBeenCalledTimes(1)
	})

	it("rejects when AWS region is missing", async () => {
		await expect(
			probeBedrockMaxOutputTokens({
				options: { ...baseOptions, awsRegion: undefined },
				modelId: "anthropic.claude-opus-4-7",
				runProbe: vi.fn(),
			}),
		).rejects.toThrow(/region/i)
	})

	it("respects the documented probe ceiling default", () => {
		expect(BEDROCK_MAX_OUTPUT_PROBE_CEILING).toBe(1_000_000)
	})
})
