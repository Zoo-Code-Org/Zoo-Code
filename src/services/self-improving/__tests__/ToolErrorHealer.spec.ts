import { describe, it, expect, vi, beforeEach } from "vitest"
import { ToolErrorHealer } from "../ToolErrorHealer"

describe("ToolErrorHealer", () => {
	let healer: ToolErrorHealer

	beforeEach(() => {
		healer = new ToolErrorHealer({ appendLine: vi.fn() } as any)
	})

	describe("handleToolError", () => {
		it("should return known fix for search_files regex", () => {
			const result = healer.handleToolError("search_files", "regex")
			expect(result).not.toBeNull()
			expect(result!.fix).toContain("regex")
			expect(result!.autoCorrectable).toBe(true)
		})

		it("should return null for unknown tool", () => {
			const result = healer.handleToolError("unknown_tool", "param")
			expect(result).toBeNull()
		})

		it("should return null when disabled", () => {
			const disabled = new ToolErrorHealer({ appendLine: vi.fn() } as any, { enabled: false })
			expect(disabled.handleToolError("search_files", "regex")).toBeNull()
		})

		it("should learn from repeated errors", () => {
			healer.handleToolError("search_files", "regex")
			healer.handleToolError("search_files", "regex")
			const summary = healer.getCorrectionSummary()
			const searchEntry = summary.find((s) => s.toolName === "search_files" && s.missingParam === "regex")
			expect(searchEntry).toBeDefined()
			expect(searchEntry!.occurrences).toBe(2)
		})
	})

	describe("getToolRequirements", () => {
		it("should return requirements for known tools", () => {
			const reqs = healer.getToolRequirements("search_files")
			expect(reqs.length).toBeGreaterThan(0)
			expect(reqs.some((r) => r.param === "regex")).toBe(true)
		})

		it("should return empty array for unknown tools", () => {
			expect(healer.getToolRequirements("unknown_tool")).toEqual([])
		})
	})

	describe("hasKnownRequirements", () => {
		it("should return true for known tools", () => {
			expect(healer.hasKnownRequirements("search_files")).toBe(true)
			expect(healer.hasKnownRequirements("read_file")).toBe(true)
		})

		it("should return false for unknown tools", () => {
			expect(healer.hasKnownRequirements("unknown_tool")).toBe(false)
		})
	})

	describe("getStatus", () => {
		it("should return status object", () => {
			const status = healer.getStatus()
			expect(status.enabled).toBe(true)
			expect(status.knownTools).toBeGreaterThan(0)
		})
	})
})
