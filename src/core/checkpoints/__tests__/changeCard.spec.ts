import { describe, expect, it } from "vitest"

import type { ChangeCardData } from "@roo-code/types"

import {
	buildChangeCard,
	buildChangeCardPayload,
	isAutoApprovedStep,
	resolveChangeCardDetail,
	type ChangeCardWrite,
} from "../changeCard"

describe("changeCard (B3a)", () => {
	function write(overrides: Partial<ChangeCardWrite> = {}): ChangeCardWrite {
		return {
			path: "src/a.ts",
			diffStats: { additions: 2, deletions: 1 },
			diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new-1\n+new-2",
			...overrides,
		}
	}

	describe("isAutoApprovedStep", () => {
		it("returns false for an empty step", () => {
			expect(isAutoApprovedStep([])).toBe(false)
		})

		it("returns true only when every write was auto-approved", () => {
			expect(isAutoApprovedStep([write({ autoApproved: true }), write({ autoApproved: true })])).toBe(true)
			expect(isAutoApprovedStep([write({ autoApproved: true }), write()])).toBe(false)
			expect(isAutoApprovedStep([write()])).toBe(false)
		})
	})

	describe("resolveChangeCardDetail", () => {
		it("forces summary for auto-approved steps even when the setting is full", () => {
			const writes = [write({ autoApproved: true })]
			expect(resolveChangeCardDetail(writes, "full")).toBe("summary")
			expect(resolveChangeCardDetail(writes, undefined)).toBe("summary")
		})

		it("follows the setting for interactive steps, defaulting to summary when unset", () => {
			const writes = [write()]
			expect(resolveChangeCardDetail(writes, "full")).toBe("full")
			expect(resolveChangeCardDetail(writes, "summary")).toBe("summary")
			expect(resolveChangeCardDetail(writes, undefined)).toBe("summary")
		})
	})

	describe("buildChangeCard", () => {
		it("carries the inline diff per file for full detail on a multi-file step", () => {
			const card = buildChangeCard(
				"sha-1",
				[write(), write({ path: "src/b.ts", diffStats: { additions: 1, deletions: 0 }, diff: "+b" })],
				"full",
			)

			expect(card).toEqual({
				checkpointIds: ["sha-1"],
				files: [
					{
						path: "src/a.ts",
						additions: 2,
						deletions: 1,
						diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new-1\n+new-2",
					},
					{ path: "src/b.ts", additions: 1, deletions: 0, diff: "+b" },
				],
				totalFiles: 2,
				detail: "full",
			})
		})

		it("omits the diff per file for summary detail (lazy fetch is B3b)", () => {
			const card = buildChangeCard("sha-1", [write()], "summary")

			expect(card.files).toEqual([{ path: "src/a.ts", additions: 2, deletions: 1 }])
			expect(card.files[0]).not.toHaveProperty("diff")
			expect(card.detail).toBe("summary")
			expect(card.totalFiles).toBe(1)
		})

		it("defaults missing diffStats to zero counts and keeps full detail without diff for a write without one", () => {
			const card = buildChangeCard("sha-1", [write({ diffStats: undefined, diff: undefined })], "full")

			expect(card.files[0]).toEqual({ path: "src/a.ts", additions: 0, deletions: 0 })
		})
	})

	describe("buildChangeCardPayload", () => {
		it("resolves the detail level and builds the payload in one call", () => {
			// The expectations are typed against the shared ChangeCardData
			// contract in @roo-code/types, so the builder's output is checked
			// against the same single source of truth the webview consumes.
			// Interactive step with the full setting: diff inline.
			const full: ChangeCardData = buildChangeCardPayload("sha-1", [write()], "full")
			expect(full.detail).toBe("full")
			expect(full.files[0].diff).toBe("--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new-1\n+new-2")

			// Auto-approved step with the full setting: compact summary, no diff.
			const compact: ChangeCardData = buildChangeCardPayload("sha-1", [write({ autoApproved: true })], "full")
			expect(compact.detail).toBe("summary")
			expect(compact.files[0]).not.toHaveProperty("diff")
			expect(compact.checkpointIds).toEqual(["sha-1"])
			expect(compact.totalFiles).toBe(1)
		})
	})
})
