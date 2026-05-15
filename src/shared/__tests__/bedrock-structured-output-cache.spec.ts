import { describe, it, expect } from "vitest"

import {
	isUnsupported,
	markUnsupported,
	THIRTY_DAYS_MS,
	type StructuredOutputUnsupportedMap,
} from "../bedrock-structured-output-cache"

describe("bedrock-structured-output-cache", () => {
	describe("isUnsupported", () => {
		it("returns false when the map is undefined", () => {
			expect(isUnsupported(undefined, "anthropic.claude")).toBe(false)
		})

		it("returns false when the model is not in the map", () => {
			expect(isUnsupported({}, "anthropic.claude")).toBe(false)
		})

		it("returns true when the entry is in the future", () => {
			const now = 1_000_000_000
			const map: StructuredOutputUnsupportedMap = { "anthropic.claude": now + 1000 }
			expect(isUnsupported(map, "anthropic.claude", now)).toBe(true)
		})

		it("returns false when the entry has expired", () => {
			const now = 1_000_000_000
			const map: StructuredOutputUnsupportedMap = { "anthropic.claude": now - 1 }
			expect(isUnsupported(map, "anthropic.claude", now)).toBe(false)
		})

		it("treats exact-now boundary as expired (strict >)", () => {
			const now = 1_000_000_000
			const map: StructuredOutputUnsupportedMap = { "anthropic.claude": now }
			expect(isUnsupported(map, "anthropic.claude", now)).toBe(false)
		})
	})

	describe("markUnsupported", () => {
		it("inserts the model with expiry 30 days in the future", () => {
			const now = 1_000_000_000
			const result = markUnsupported(undefined, "anthropic.claude", now)
			expect(result["anthropic.claude"]).toBe(now + THIRTY_DAYS_MS)
		})

		it("preserves other unexpired entries", () => {
			const now = 1_000_000_000
			const existing: StructuredOutputUnsupportedMap = {
				"model-a": now + 10_000,
				"model-b": now + 20_000,
			}
			const result = markUnsupported(existing, "model-c", now)
			expect(result["model-a"]).toBe(now + 10_000)
			expect(result["model-b"]).toBe(now + 20_000)
			expect(result["model-c"]).toBe(now + THIRTY_DAYS_MS)
		})

		it("prunes expired entries on write", () => {
			const now = 1_000_000_000
			const existing: StructuredOutputUnsupportedMap = {
				"old-expired": now - 1,
				"still-fresh": now + 10_000,
			}
			const result = markUnsupported(existing, "new-model", now)
			expect("old-expired" in result).toBe(false)
			expect(result["still-fresh"]).toBe(now + 10_000)
			expect(result["new-model"]).toBe(now + THIRTY_DAYS_MS)
		})

		it("replaces an existing entry for the same model with a fresh 30-day expiry", () => {
			const now = 1_000_000_000
			const existing: StructuredOutputUnsupportedMap = {
				"anthropic.claude": now + 1000, // old expiry, about to be updated
			}
			const result = markUnsupported(existing, "anthropic.claude", now)
			expect(result["anthropic.claude"]).toBe(now + THIRTY_DAYS_MS)
		})

		it("returns a new object (does not mutate the input)", () => {
			const now = 1_000_000_000
			const existing: StructuredOutputUnsupportedMap = { "model-a": now + 1000 }
			const result = markUnsupported(existing, "model-b", now)
			expect(result).not.toBe(existing)
			expect(existing["model-b"]).toBeUndefined()
		})
	})
})
