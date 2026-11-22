import { describe, it, expect, beforeEach } from "vitest"
import { TelemetryService } from "@roo-code/telemetry"
import { truncateConversation } from "../index"
import { getEffectiveApiHistory, cleanupAfterTruncation } from "../../condense"
import { ApiMessage } from "../../task-persistence/apiMessages"

describe("Non-Destructive Sliding Window Truncation", () => {
	let messages: ApiMessage[]

	beforeEach(() => {
		// Initialize TelemetryService for tests
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		// Create a sample conversation with 11 messages (1 initial + 10 conversation messages)
		messages = [
			{ role: "user", content: "Initial task", ts: 1000 },
			{ role: "assistant", content: "Response 1", ts: 1100 },
			{ role: "user", content: "Message 2", ts: 1200 },
			{ role: "assistant", content: "Response 2", ts: 1300 },
			{ role: "user", content: "Message 3", ts: 1400 },
			{ role: "assistant", content: "Response 3", ts: 1500 },
			{ role: "user", content: "Message 4", ts: 1600 },
			{ role: "assistant", content: "Response 4", ts: 1700 },
			{ role: "user", content: "Message 5", ts: 1800 },
			{ role: "assistant", content: "Response 5", ts: 1900 },
			{ role: "user", content: "Message 6", ts: 2000 },
		]
	})

	describe("truncateConversation()", () => {
		it("should tag messages with truncationParent instead of deleting", () => {
			const result = truncateConversation(messages, 0.5, "test-task-id")

			// All messages should still be present plus the truncation marker
			expect(result.messages.length).toBe(messages.length + 1) // +1 for truncation marker

			// Calculate expected messages to remove: floor((11-1) * 0.5) = 5, rounded to even = 4
			const expectedMessagesToRemove = 4

			// Find which messages have truncationParent set
			const taggedMessages = result.messages.filter((msg) => msg.truncationParent)
			expect(taggedMessages.length).toBe(expectedMessagesToRemove)

			// All tagged messages should point to the truncationId
			for (const msg of taggedMessages) {
				expect(msg.truncationParent).toBe(result.truncationId)
			}

			// First message should not be tagged
			expect(result.messages[0].truncationParent).toBeUndefined()

			// Marker should not have truncationParent
			const marker = result.messages.find((msg) => msg.isTruncationMarker)
			expect(marker?.truncationParent).toBeUndefined()
		})

		it("should insert truncation marker with truncationId", () => {
			const result = truncateConversation(messages, 0.5, "test-task-id")

			// Truncation marker should be at the boundary (after truncated messages)
			// With 4 messages truncated (indices 1-4), marker should be at index 5
			const marker = result.messages.find((msg) => msg.isTruncationMarker)
			expect(marker).toBeDefined()
			expect(marker!.isTruncationMarker).toBe(true)
			expect(marker!.truncationId).toBeDefined()
			expect(marker!.truncationId).toBe(result.truncationId)
			expect(marker!.role).toBe("user")
			expect(marker!.content).toContain("Sliding window truncation")
		})

		it("should return truncationId and messagesRemoved", () => {
			const result = truncateConversation(messages, 0.5, "test-task-id")

			expect(result.truncationId).toBeDefined()
			expect(typeof result.truncationId).toBe("string")
			expect(result.messagesRemoved).toBe(4) // floor((11-1) * 0.5) rounded to even
		})

		it("should round messagesToRemove to an even number", () => {
			// Test with 12 messages (1 initial + 11 conversation)
			const manyMessages: ApiMessage[] = [
				{ role: "user", content: "Initial", ts: 1000 },
				...Array.from({ length: 11 }, (_, i) => ({
					role: (i % 2 === 0 ? "assistant" : "user") as "assistant" | "user",
					content: `Message ${i + 1}`,
					ts: 1100 + i * 100,
				})),
			]

			// fracToRemove=0.5 -> rawMessagesToRemove = floor(11 * 0.5) = 5
			// messagesToRemove = 5 - (5 % 2) = 4 (rounded down to even)
			const result = truncateConversation(manyMessages, 0.5, "test-task-id")
			expect(result.messagesRemoved).toBe(4)
		})
	})

	describe("getEffectiveApiHistory()", () => {
		it("should filter out truncated messages when truncation marker exists", () => {
			const truncationResult = truncateConversation(messages, 0.5, "test-task-id")
			const effective = getEffectiveApiHistory(truncationResult.messages)

			// Should exclude 4 truncated messages but keep the first message and truncation marker
			// Original: 11 messages
			// After truncation: 11 + 1 marker = 12
			// Effective: 11 - 4 (hidden) + 1 (marker) = 8
			expect(effective.length).toBe(8)

			// First message should be present
			expect(effective[0].content).toBe("Initial task")

			// Truncation marker should be present
			expect(effective[1].isTruncationMarker).toBe(true)

			// Messages with truncationParent should be filtered out
			for (const msg of effective) {
				if (msg.truncationParent) {
					throw new Error("Message with truncationParent should be filtered out")
				}
			}
		})

		it("should include truncated messages when truncation marker is removed", () => {
			const truncationResult = truncateConversation(messages, 0.5, "test-task-id")

			// Remove the truncation marker (simulate rewind past truncation)
			const messagesWithoutMarker = truncationResult.messages.filter((msg) => !msg.isTruncationMarker)

			const effective = getEffectiveApiHistory(messagesWithoutMarker)

			// All messages should be visible now
			expect(effective.length).toBe(messages.length)

			// Verify first and last messages are present
			expect(effective[0].content).toBe("Initial task")
			expect(effective[effective.length - 1].content).toBe("Message 6")
		})

		it("should handle both condenseParent and truncationParent filtering", () => {
			// Create a scenario with both condensing and truncation
			const messagesWithCondense: ApiMessage[] = [
				{ role: "user", content: "Initial", ts: 1000 },
				{ role: "assistant", content: "Msg 1", ts: 1100, condenseParent: "condense-1" },
				{ role: "user", content: "Msg 2", ts: 1200, condenseParent: "condense-1" },
				{
					role: "assistant",
					content: "Summary 1",
					ts: 1250,
					isSummary: true,
					condenseId: "condense-1",
				},
				{ role: "user", content: "Msg 3", ts: 1300 },
				{ role: "assistant", content: "Msg 4", ts: 1400 },
			]

			const truncationResult = truncateConversation(messagesWithCondense, 0.5, "test-task-id")
			const effective = getEffectiveApiHistory(truncationResult.messages)

			// Should filter both condensed messages and truncated messages
			// Messages with condenseParent="condense-1" should be filtered (summary exists)
			// Messages with truncationParent should be filtered (marker exists)
			const hasCondensedMessage = effective.some((msg) => msg.condenseParent === "condense-1")
			const hasTruncatedMessage = effective.some((msg) => msg.truncationParent)

			expect(hasCondensedMessage).toBe(false)
			expect(hasTruncatedMessage).toBe(false)
		})
	})

	describe("cleanupAfterTruncation()", () => {
		it("should clear orphaned truncationParent tags when marker is deleted", () => {
			const truncationResult = truncateConversation(messages, 0.5, "test-task-id")

			// Remove the truncation marker (simulate rewind)
			const messagesWithoutMarker = truncationResult.messages.filter((msg) => !msg.isTruncationMarker)

			const cleaned = cleanupAfterTruncation(messagesWithoutMarker)

			// All truncationParent tags should be cleared
			for (const msg of cleaned) {
				expect(msg.truncationParent).toBeUndefined()
			}
		})

		it("should preserve truncationParent tags when marker still exists", () => {
			const truncationResult = truncateConversation(messages, 0.5, "test-task-id")

			const cleaned = cleanupAfterTruncation(truncationResult.messages)

			// truncationParent tags should be preserved (marker still exists)
			const taggedMessages = cleaned.filter((msg) => msg.truncationParent)
			expect(taggedMessages.length).toBeGreaterThan(0)

			// All tagged messages should point to the existing marker
			for (const msg of taggedMessages) {
				expect(msg.truncationParent).toBe(truncationResult.truncationId)
			}
		})

		it("should handle both condenseParent and truncationParent cleanup", () => {
			const messagesWithBoth: ApiMessage[] = [
				{ role: "user", content: "Initial", ts: 1000 },
				{ role: "assistant", content: "Msg 1", ts: 1100, condenseParent: "orphan-condense" },
				{ role: "user", content: "Msg 2", ts: 1200, truncationParent: "orphan-truncation" },
				{ role: "assistant", content: "Msg 3", ts: 1300 },
			]

			const cleaned = cleanupAfterTruncation(messagesWithBoth)

			// Both orphaned parent references should be cleared
			expect(cleaned[1].condenseParent).toBeUndefined()
			expect(cleaned[2].truncationParent).toBeUndefined()
		})

		it("should preserve valid parent references", () => {
			const messagesWithValidParents: ApiMessage[] = [
				{ role: "user", content: "Initial", ts: 1000 },
				{ role: "assistant", content: "Msg 1", ts: 1100, condenseParent: "valid-condense" },
				{
					role: "assistant",
					content: "Summary",
					ts: 1150,
					isSummary: true,
					condenseId: "valid-condense",
				},
				{ role: "user", content: "Msg 2", ts: 1200, truncationParent: "valid-truncation" },
				{
					role: "assistant",
					content: "Truncation marker",
					ts: 1250,
					isTruncationMarker: true,
					truncationId: "valid-truncation",
				},
			]

			const cleaned = cleanupAfterTruncation(messagesWithValidParents)

			// Valid parent references should be preserved
			expect(cleaned[1].condenseParent).toBe("valid-condense")
			expect(cleaned[3].truncationParent).toBe("valid-truncation")
		})
	})

	describe("Rewind past truncation integration", () => {
		it("should restore hidden messages when rewinding past truncation point", () => {
			// Step 1: Perform truncation
			const truncationResult = truncateConversation(messages, 0.5, "test-task-id")

			// Step 2: Verify messages are hidden initially
			const effectiveBeforeRewind = getEffectiveApiHistory(truncationResult.messages)
			expect(effectiveBeforeRewind.length).toBeLessThan(messages.length)

			// Step 3: Simulate rewind by removing truncation marker and subsequent messages
			// In practice this would be done via removeMessagesThisAndSubsequent
			const markerIndex = truncationResult.messages.findIndex((msg) => msg.isTruncationMarker)
			const messagesAfterRewind = truncationResult.messages.slice(0, markerIndex)

			// Step 4: Clean up orphaned parent references
			const cleanedAfterRewind = cleanupAfterTruncation(messagesAfterRewind)

			// Step 5: Get effective history after cleanup
			const effectiveAfterRewind = getEffectiveApiHistory(cleanedAfterRewind)

			// All original messages before the marker should be restored
			expect(effectiveAfterRewind.length).toBe(markerIndex)

			// No messages should have truncationParent
			for (const msg of effectiveAfterRewind) {
				expect(msg.truncationParent).toBeUndefined()
			}
		})

		it("should handle multiple truncations correctly", () => {
			// Step 1: First truncation
			const firstTruncation = truncateConversation(messages, 0.5, "task-1")

			// Step 2: Get effective history and simulate more messages being added
			const moreMessages: ApiMessage[] = [
				...firstTruncation.messages,
				{ role: "user", content: "New message 1", ts: 3000 },
				{ role: "assistant", content: "New response 1", ts: 3100 },
				{ role: "user", content: "New message 2", ts: 3200 },
				{ role: "assistant", content: "New response 2", ts: 3300 },
			]

			// Step 3: Second truncation
			const secondTruncation = truncateConversation(moreMessages, 0.5, "task-1")

			// Step 4: Get effective history after second truncation
			const effectiveAfterSecond = getEffectiveApiHistory(secondTruncation.messages)

			// Should have messages hidden by both truncations filtered out
			const firstMarker = secondTruncation.messages.find(
				(msg) => msg.isTruncationMarker && msg.truncationId === firstTruncation.truncationId,
			)
			const secondMarker = secondTruncation.messages.find(
				(msg) => msg.isTruncationMarker && msg.truncationId === secondTruncation.truncationId,
			)

			expect(firstMarker).toBeDefined()
			expect(secondMarker).toBeDefined()

			// Messages tagged with either truncationId should be filtered
			for (const msg of effectiveAfterSecond) {
				if (msg.truncationParent === firstTruncation.truncationId) {
					throw new Error("First truncation messages should be filtered")
				}
				if (msg.truncationParent === secondTruncation.truncationId) {
					throw new Error("Second truncation messages should be filtered")
				}
			}
		})

		it("should handle rewinding when second truncation affects first truncation marker", () => {
			// Step 1: First truncation
			const firstTruncation = truncateConversation(messages, 0.5, "task-1")

			// Step 2: Add more messages AFTER getting effective history
			// This simulates real usage where we only send effective messages to API
			const moreMessages: ApiMessage[] = [
				...firstTruncation.messages, // Keep full history with tagged messages
				{ role: "user", content: "New message 1", ts: 3000 },
				{ role: "assistant", content: "New response 1", ts: 3100 },
				{ role: "user", content: "New message 2", ts: 3200 },
				{ role: "assistant", content: "New response 2", ts: 3300 },
			]

			// Step 3: Second truncation - this will tag some messages including possibly the first marker
			const secondTruncation = truncateConversation(moreMessages, 0.5, "task-1")

			// Step 4: Simulate rewind past second truncation marker
			const secondMarkerIndex = secondTruncation.messages.findIndex(
				(msg) => msg.isTruncationMarker && msg.truncationId === secondTruncation.truncationId,
			)
			const afterSecondRewind = secondTruncation.messages.slice(0, secondMarkerIndex)

			// Step 5: Clean up orphaned references
			const cleaned = cleanupAfterTruncation(afterSecondRewind)

			// Step 6: Get effective history
			const effective = getEffectiveApiHistory(cleaned)

			// The second truncation marker should be removed
			const hasSecondTruncationMarker = effective.some(
				(msg) => msg.isTruncationMarker && msg.truncationId === secondTruncation.truncationId,
			)
			expect(hasSecondTruncationMarker).toBe(false)

			// Messages that were tagged by the second truncation should have those tags cleared
			const hasSecondTruncationParent = cleaned.some(
				(msg) => msg.truncationParent === secondTruncation.truncationId,
			)
			expect(hasSecondTruncationParent).toBe(false)

			// First truncation marker and its tagged messages may or may not be present
			// depending on whether the second truncation affected them
			// The important thing is that cleanup works correctly
			expect(cleaned.length).toBeGreaterThan(0)
		})
	})

	describe("Edge cases", () => {
		it("should handle truncateConversation with fracToRemove=0", () => {
			const result = truncateConversation(messages, 0, "test-task-id")

			// No messages should be tagged (messagesToRemove = 0)
			const taggedMessages = result.messages.filter((msg) => msg.truncationParent)
			expect(taggedMessages.length).toBe(0)
			expect(result.messagesRemoved).toBe(0)

			// When nothing is truncated, no marker is inserted
			expect(result.messages).toEqual(messages)
		})

		it("should handle truncateConversation with very few messages", () => {
			const fewMessages: ApiMessage[] = [
				{ role: "user", content: "Initial", ts: 1000 },
				{ role: "assistant", content: "Response", ts: 1100 },
			]

			const result = truncateConversation(fewMessages, 0.5, "test-task-id")

			// With only 1 message after first, 0.5 fraction = 0.5, floored to 0, rounded to even = 0
			// So no messages should be removed and no marker inserted
			expect(result.messages.length).toBe(2)
			expect(result.messagesRemoved).toBe(0)
		})

		it("should handle truncating all visible messages except first", () => {
			// This tests the edge case where visibleIndices[messagesToRemove + 1] would be undefined
			// 3 messages total: first is preserved, 2 others can be truncated
			const threeMessages: ApiMessage[] = [
				{ role: "user", content: "Initial", ts: 1000 },
				{ role: "assistant", content: "Response 1", ts: 1100 },
				{ role: "user", content: "Message 2", ts: 1200 },
			]

			// With fracToRemove = 1.0:
			// visibleCount = 3
			// rawMessagesToRemove = floor((3-1) * 1.0) = 2
			// messagesToRemove = 2 (already even)
			// This truncates ALL messages except the first
			const result = truncateConversation(threeMessages, 1.0, "test-task-id")

			expect(result.messagesRemoved).toBe(2)
			// Should have 3 original messages + 1 marker = 4
			expect(result.messages.length).toBe(4)

			// First message should be untouched
			expect(result.messages[0].truncationParent).toBeUndefined()
			expect(result.messages[0].content).toBe("Initial")

			// Messages at indices 1 and 2 should be tagged
			expect(result.messages[1].truncationParent).toBe(result.truncationId)
			expect(result.messages[2].truncationParent).toBe(result.truncationId)

			// Marker should be at the end (index 3)
			expect(result.messages[3].isTruncationMarker).toBe(true)
			expect(result.messages[3].role).toBe("user")
		})

		it("should handle empty condenseParent and truncationParent gracefully", () => {
			const messagesWithoutTags: ApiMessage[] = [
				{ role: "user", content: "Message 1", ts: 1000 },
				{ role: "assistant", content: "Response 1", ts: 1100 },
			]

			const cleaned = cleanupAfterTruncation(messagesWithoutTags)

			// Should return same messages unchanged
			expect(cleaned).toEqual(messagesWithoutTags)
		})
	})

	describe("condensation-aware truncation (issue 1823)", () => {
		// A history after a condensation: every message before the summary carries
		// condenseParent, so the API receives only the summary and the new turns.
		const condensedHistory: ApiMessage[] = [
			{ role: "user", content: "Dead 1", ts: 1000, condenseParent: "condense-1" },
			{ role: "assistant", content: "Dead 2", ts: 1100, condenseParent: "condense-1" },
			{ role: "user", content: "Dead 3", ts: 1200, condenseParent: "condense-1" },
			{ role: "assistant", content: "Dead 4", ts: 1300, condenseParent: "condense-1" },
			{ role: "user", content: "Dead 5", ts: 1400, condenseParent: "condense-1" },
			{ role: "assistant", content: "Dead 6", ts: 1500, condenseParent: "condense-1" },
			{
				role: "assistant",
				content: "Summary of the conversation",
				ts: 1600,
				isSummary: true,
				condenseId: "condense-1",
			},
			{ role: "user", content: "Live 1", ts: 1700 },
			{ role: "assistant", content: "Live 2", ts: 1800 },
			{ role: "user", content: "Live 3", ts: 1900 },
			{ role: "assistant", content: "Live 4", ts: 2000 },
			{ role: "user", content: "Live 5", ts: 2100 },
			{ role: "assistant", content: "Live 6", ts: 2200 },
		]

		it("should not count messages hidden by condensation as visible", () => {
			const result = truncateConversation(condensedHistory, 0.5, "test-task-id")

			// The candidates are the six live messages after the summary.
			// raw = floor((6 - 1) * 0.5) = 2, already even.
			expect(result.messagesRemoved).toBe(2)
		})

		it("should tag only live messages, never condensed ones or the summary", () => {
			const result = truncateConversation(condensedHistory, 0.5, "test-task-id")

			const tagged = result.messages.filter((msg) => msg.truncationParent === result.truncationId)
			expect(tagged.length).toBe(2)

			// The summary is the first candidate; skip-first protects it, and the
			// two oldest live messages are hidden.
			expect(result.messages.find((m) => m.content === "Live 1")?.truncationParent).toBe(result.truncationId)
			expect(result.messages.find((m) => m.content === "Live 2")?.truncationParent).toBe(result.truncationId)
			expect(result.messages.find((m) => m.content === "Live 3")?.truncationParent).toBeUndefined()

			// Messages already hidden by condensation must not get a truncationParent.
			for (const msg of result.messages) {
				if (msg.condenseParent === "condense-1") {
					expect(msg.truncationParent).toBeUndefined()
				}
			}

			// The summary must stay visible.
			const summary = result.messages.find((m) => m.content === "Summary of the conversation")
			expect(summary?.truncationParent).toBeUndefined()
		})

		it("should shrink the live history that the API receives", () => {
			const before = getEffectiveApiHistory(condensedHistory).filter((m) => !m.isTruncationMarker)
			const result = truncateConversation(condensedHistory, 0.5, "test-task-id")
			const after = getEffectiveApiHistory(result.messages).filter((m) => !m.isTruncationMarker)

			// Before: summary + 6 live messages. After: summary + 4 live messages.
			expect(before.length).toBe(7)
			expect(after.length).toBe(5)
		})

		it("selects messages with orphaned condenseParent for truncation (rewind case)", () => {
			// A rewind deleted the summary, so these tags match nothing that exists.
			// The sink keeps such messages live, so truncation must be able to select them.
			const history: ApiMessage[] = [
				...Array.from({ length: 4 }, (_, i) => ({
					role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
					content: `Orphan ${i + 1}`,
					ts: 1000 + i * 100,
					condenseParent: "condense-gone",
				})),
				...Array.from({ length: 8 }, (_, i) => ({
					role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
					content: `Live ${i + 1}`,
					ts: 1500 + i * 100,
				})),
			]

			const result = truncateConversation(history, 0.5, "test-task-id")

			// All 12 messages are live: raw = floor((12 - 1) * 0.5) = 5, rounded to even = 4.
			expect(result.messagesRemoved).toBe(4)

			// The first visible message stays untagged; the next orphans are selected,
			// which proves that revived messages are selectable again.
			expect(result.messages.find((m) => m.content === "Orphan 1")?.truncationParent).toBeUndefined()
			expect(result.messages.find((m) => m.content === "Orphan 2")?.truncationParent).toBe(result.truncationId)
			expect(result.messages.find((m) => m.content === "Orphan 3")?.truncationParent).toBe(result.truncationId)
			expect(result.messages.find((m) => m.content === "Orphan 4")?.truncationParent).toBe(result.truncationId)
		})

		it("applies the latest-summary boundary: pre-summary orphans are not candidates and the summary is never tagged", () => {
			// A rewind left an orphan tag before the summary. The sink's fresh-start
			// slice starts at the summary, so the orphan is dead to the API and must
			// not be a candidate. The summary is the first effective message and is
			// never tagged (PR 2647 review round 3).
			const history: ApiMessage[] = [
				{ role: "user", content: "Orphan", ts: 1000, condenseParent: "condense-gone" },
				{
					role: "assistant",
					content: "Summary of the conversation",
					ts: 1100,
					isSummary: true,
					condenseId: "c1",
				},
				...Array.from({ length: 6 }, (_, i) => ({
					role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
					content: `Live ${i + 1}`,
					ts: 1200 + i * 100,
				})),
			]

			const result = truncateConversation(history, 0.5, "test-task-id")

			// The candidates are the summary plus six live: raw = floor((7 - 1) * 0.5) = 3, even 2.
			expect(result.messagesRemoved).toBe(2)

			// The summary and the pre-summary orphan carry no truncation tag.
			const summary = result.messages.find((m) => m.content === "Summary of the conversation")
			expect(summary?.truncationParent).toBeUndefined()
			expect(result.messages.find((m) => m.content === "Orphan")?.truncationParent).toBeUndefined()

			// Skip-first keeps the summary; the two oldest live messages are tagged.
			expect(result.messages.find((m) => m.content === "Live 1")?.truncationParent).toBe(result.truncationId)
			expect(result.messages.find((m) => m.content === "Live 2")?.truncationParent).toBe(result.truncationId)
			expect(result.messages.find((m) => m.content === "Live 3")?.truncationParent).toBeUndefined()
		})

		it("keeps tool_use/tool_result pairs whole when a user-role summary leads the candidates", () => {
			// Real summaries carry role "user" (summarizeConversation). The summary
			// is the first candidate, so skip-first protects it and truncation hides
			// the oldest tool exchange whole. Excluding the summary split a pair,
			// and the Messages API rejects split pairs (PR 2647 review round 4).
			const toolUse = (id: string) => [{ type: "tool_use" as const, id, name: "probe", input: {} }]
			const toolResult = (id: string) => [{ type: "tool_result" as const, tool_use_id: id, content: "ok" }]
			const history: ApiMessage[] = [
				{ role: "user", content: "The summary text", ts: 1000, isSummary: true, condenseId: "c-1" },
				{ role: "assistant", content: toolUse("t1"), ts: 1100 },
				{ role: "user", content: toolResult("t1"), ts: 1200 },
				{ role: "assistant", content: toolUse("t2"), ts: 1300 },
				{ role: "user", content: toolResult("t2"), ts: 1400 },
				{ role: "assistant", content: toolUse("t3"), ts: 1500 },
				{ role: "user", content: toolResult("t3"), ts: 1600 },
			]

			const result = truncateConversation(history, 0.5, "test-task-id")

			// Seven candidates: the summary plus six turns. raw = 3, even 2.
			expect(result.messagesRemoved).toBe(2)

			// The summary stays untagged; the first tool exchange goes, whole.
			expect(result.messages.find((m) => m.content === "The summary text")?.truncationParent).toBeUndefined()
			const tagged = result.messages.filter((m) => m.truncationParent === result.truncationId)
			expect(tagged.length).toBe(2)
			const blocks = (m: ApiMessage) => (Array.isArray(m.content) ? m.content : [])
			expect(blocks(tagged[0])[0]).toMatchObject({ type: "tool_use", id: "t1" })
			expect(blocks(tagged[1])[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" })

			// Every remaining tool_result still follows its tool_use at the sink.
			const effective = getEffectiveApiHistory(result.messages).filter((m) => !m.isTruncationMarker)
			effective.forEach((msg, index) => {
				for (const block of blocks(msg)) {
					if (block.type === "tool_result") {
						const prev = effective[index - 1]
						const prevIds =
							prev === undefined
								? []
								: blocks(prev)
										.filter((b) => b.type === "tool_use")
										.map((b) => (b as { id?: string }).id)
						expect(prevIds).toContain((block as { tool_use_id?: string }).tool_use_id)
					}
				}
			})
		})

		it("nested summaries: only the latest summary bounds truncation", () => {
			// Two condensations: the sink slices from the second summary, so every
			// message before it is dead regardless of which tag it carries.
			const tagged = (n: number, prefix: string, parent: string, startTs: number) =>
				Array.from({ length: n }, (_, i) => ({
					role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
					content: `${prefix} ${i + 1}`,
					ts: startTs + i * 100,
					condenseParent: parent,
				}))

			const history: ApiMessage[] = [
				...tagged(4, "Dead", "c1", 1000),
				{
					role: "assistant",
					content: "Summary one",
					ts: 1500,
					isSummary: true,
					condenseId: "c1",
				},
				...tagged(4, "Dead2", "c2", 1600),
				{
					role: "assistant",
					content: "Summary two",
					ts: 2100,
					isSummary: true,
					condenseId: "c2",
				},
				...Array.from({ length: 5 }, (_, i) => ({
					role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
					content: `Live ${i + 1}`,
					ts: 2200 + i * 100,
				})),
			]

			const result = truncateConversation(history, 0.5, "test-task-id")

			// The candidates are the second summary plus five live: raw = floor((6 - 1) * 0.5) = 2.
			expect(result.messagesRemoved).toBe(2)

			// Skip-first keeps the second summary; the two oldest live are tagged.
			expect(result.messages.find((m) => m.content === "Live 1")?.truncationParent).toBe(result.truncationId)
			expect(result.messages.find((m) => m.content === "Live 2")?.truncationParent).toBe(result.truncationId)
			expect(result.messages.find((m) => m.content === "Live 3")?.truncationParent).toBeUndefined()
			expect(result.messages.find((m) => m.content === "Live 4")?.truncationParent).toBeUndefined()
			expect(result.messages.find((m) => m.content === "Live 5")?.truncationParent).toBeUndefined()

			// Both summaries and every dead message stay untagged.
			for (const msg of result.messages) {
				if (msg.isSummary || msg.condenseParent) {
					expect(msg.truncationParent).toBeUndefined()
				}
			}
		})
	})

	describe("property: a truncation removes exactly the live messages that it reports", () => {
		// The sink (getEffectiveApiHistory) decides which messages the API receives.
		// Use it as the oracle so this test cannot drift from the real rule.
		const liveMessages = (msgs: ApiMessage[]) => getEffectiveApiHistory(msgs).filter((m) => !m.isTruncationMarker)

		const plain = (n: number, prefix: string, startTs: number) =>
			Array.from({ length: n }, (_, i) => ({
				role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
				content: `${prefix} ${i + 1}`,
				ts: startTs + i * 100,
			}))

		const scenarios: ApiMessage[][] = [
			// Plain history without tags.
			plain(11, "Plain", 1000),
			// One condensation, then new turns (issue 1823).
			[
				...plain(6, "Dead", 1000).map((m) => ({ ...m, condenseParent: "condense-1" })),
				{
					role: "assistant" as const,
					content: "Summary one",
					ts: 1700,
					isSummary: true,
					condenseId: "condense-1",
				},
				...plain(6, "Live", 1800),
			],
			// A condensation and an earlier truncation, then new turns.
			[
				...plain(6, "Dead", 1000).map((m) => ({ ...m, condenseParent: "condense-1" })),
				{
					role: "assistant" as const,
					content: "Summary one",
					ts: 1700,
					isSummary: true,
					condenseId: "condense-1",
				},
				...plain(4, "Trunc", 1800).map((m) => ({ ...m, truncationParent: "trunc-1" })),
				{
					role: "user" as const,
					content: "[Sliding window truncation: 4 messages hidden]",
					ts: 2250,
					isTruncationMarker: true,
					truncationId: "trunc-1",
				},
				...plain(5, "Live", 2300),
			],
			// Nested condensation: two summaries, all older messages tagged.
			[
				...plain(4, "Dead", 1000).map((m) => ({ ...m, condenseParent: "condense-1" })),
				{
					role: "assistant" as const,
					content: "Summary one",
					ts: 1500,
					isSummary: true,
					condenseId: "condense-1",
				},
				...plain(4, "Dead2", 1600).map((m) => ({ ...m, condenseParent: "condense-2" })),
				{
					role: "assistant" as const,
					content: "Summary two",
					ts: 2100,
					isSummary: true,
					condenseId: "condense-2",
				},
				...plain(5, "Live", 2200),
			],
			// A rewind deleted the summary; its tagged messages are live again.
			[
				...plain(6, "Revived", 1000).map((m) => ({ ...m, condenseParent: "condense-gone" })),
				...plain(6, "Live", 1700),
			],
		]

		for (const scenario of scenarios) {
			it(`removes only live messages (${scenario.length} messages)`, () => {
				const liveBefore = liveMessages(scenario)
				const result = truncateConversation(scenario, 0.5, "test-task-id")

				// Every reported removal is a live message that became hidden.
				const hiddenLive = liveBefore.filter(
					(m) =>
						result.messages.find((r) => r.content === m.content)?.truncationParent === result.truncationId,
				)
				expect(result.messagesRemoved).toBe(hiddenLive.length)

				// When the code reports removals, the live history must shrink.
				if (result.messagesRemoved > 0) {
					const liveAfter = liveMessages(result.messages)
					expect(liveAfter.length).toBeLessThan(liveBefore.length)
				}
			})
		}
	})
})
