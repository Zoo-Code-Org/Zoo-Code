// npx vitest run core/task/__tests__/messageCounting.retrySymmetry.spec.ts

import { shouldAddUserMessageToHistory } from "../messageCounting"

/**
 * Regression coverage for the empty-assistant-response retry cycle in
 * Task#recursivelyMakeClineRequests: the user message is added once (incrementing
 * messageCounts.user), popped when the assistant fails to respond (decrementing
 * messageCounts.user to match), then re-added on retry via userMessageWasRemoved
 * (incrementing messageCounts.user again). This exercises that increment/decrement/
 * increment sequence end-to-end using the same primitives Task.ts calls, without
 * needing to drive the full streaming loop.
 */
describe("empty-assistant-response retry keeps messageCounts.user symmetric", () => {
	function simulateAttempt(
		messageCounts: { user: number; assistant: number },
		params: {
			retryAttempt: number | undefined
			isEmptyUserContent: boolean
			userMessageWasRemoved: boolean | undefined
		},
	) {
		if (shouldAddUserMessageToHistory(params)) {
			messageCounts.user++
		}
	}

	function simulatePopOnEmptyResponse(
		messageCounts: { user: number; assistant: number },
		shouldAddUserMessage = true,
	) {
		// Mirrors Task.ts: pop the last user message from apiConversationHistory and
		// decrement messageCounts.user only if this iteration actually incremented it.
		// Messages added by flushPendingToolResultsToHistory or loaded from resumed
		// history are not counted, so popping them must not decrement.
		if (shouldAddUserMessage) {
			messageCounts.user--
		}
	}

	function simulateDeclineRetry(messageCounts: { user: number; assistant: number }) {
		// Mirrors Task.ts's "User declined to retry" branch: the popped user message is
		// re-added directly (not via shouldAddUserMessageToHistory) and a synthetic failure
		// assistant message is appended, so both increments are paired explicitly here
		// rather than going through simulateAttempt.
		messageCounts.user++
		messageCounts.assistant++
	}

	it("ends at 1 after one empty-response retry that then succeeds (not 2)", () => {
		const messageCounts = { user: 0, assistant: 0 }

		// First attempt: message added, count incremented.
		simulateAttempt(messageCounts, { retryAttempt: 0, isEmptyUserContent: false, userMessageWasRemoved: false })
		expect(messageCounts.user).toBe(1)

		// Assistant returns nothing -- Task.ts pops the message it just added.
		simulatePopOnEmptyResponse(messageCounts)
		expect(messageCounts.user).toBe(0)

		// Retry (either auto or manual-approved branch) re-adds it via userMessageWasRemoved.
		simulateAttempt(messageCounts, { retryAttempt: 1, isEmptyUserContent: false, userMessageWasRemoved: true })

		// Exactly one logical user turn occurred -- the count must reflect that, not 2.
		expect(messageCounts.user).toBe(1)
	})

	it("stays symmetric across multiple consecutive empty-response retries", () => {
		const messageCounts = { user: 0, assistant: 0 }

		simulateAttempt(messageCounts, { retryAttempt: 0, isEmptyUserContent: false, userMessageWasRemoved: false })
		simulatePopOnEmptyResponse(messageCounts)

		simulateAttempt(messageCounts, { retryAttempt: 1, isEmptyUserContent: false, userMessageWasRemoved: true })
		simulatePopOnEmptyResponse(messageCounts)

		simulateAttempt(messageCounts, { retryAttempt: 2, isEmptyUserContent: false, userMessageWasRemoved: true })
		simulatePopOnEmptyResponse(messageCounts)

		// Final successful attempt.
		simulateAttempt(messageCounts, { retryAttempt: 3, isEmptyUserContent: false, userMessageWasRemoved: true })

		expect(messageCounts.user).toBe(1)
	})

	it("never goes negative when a message is popped and correctly re-added", () => {
		const messageCounts = { user: 0, assistant: 0 }

		simulateAttempt(messageCounts, { retryAttempt: 0, isEmptyUserContent: false, userMessageWasRemoved: false })
		simulatePopOnEmptyResponse(messageCounts)
		simulateAttempt(messageCounts, { retryAttempt: 1, isEmptyUserContent: false, userMessageWasRemoved: true })

		expect(messageCounts.user).toBeGreaterThanOrEqual(0)
	})

	it("stays symmetric when the user declines to retry after an empty response", () => {
		const messageCounts = { user: 0, assistant: 0 }

		// First attempt: user message added, count incremented.
		simulateAttempt(messageCounts, { retryAttempt: 0, isEmptyUserContent: false, userMessageWasRemoved: false })
		expect(messageCounts).toEqual({ user: 1, assistant: 0 })

		// Assistant returns nothing -- popped, decremented.
		simulatePopOnEmptyResponse(messageCounts)
		expect(messageCounts).toEqual({ user: 0, assistant: 0 })

		// User declines to retry: message is re-added directly, plus a synthetic failure
		// assistant message -- exactly one logical user turn and one assistant turn
		// occurred overall, so both counters must end at 1, not 0.
		simulateDeclineRetry(messageCounts)
		expect(messageCounts).toEqual({ user: 1, assistant: 1 })
	})

	it("does not go negative when the popped message was not counted by this iteration (e.g. flushPendingToolResultsToHistory)", () => {
		// Scenario: a user message was appended to apiConversationHistory by
		// flushPendingToolResultsToHistory (or loaded from resumed history) without
		// incrementing messageCounts.user. shouldAddUserMessage is false for this
		// turn (empty content). The assistant returns nothing and the pop fires.
		// The count must stay at 0, not go to -1.
		const messageCounts = { user: 0, assistant: 0 }

		// This turn: empty content, so shouldAddUserMessageToHistory returns false.
		const shouldAddUserMessage = false
		simulateAttempt(messageCounts, { retryAttempt: 0, isEmptyUserContent: true, userMessageWasRemoved: false })
		expect(messageCounts.user).toBe(0)

		// Assistant returns nothing -- pop fires but guard skips the decrement.
		simulatePopOnEmptyResponse(messageCounts, shouldAddUserMessage)
		expect(messageCounts.user).toBe(0)
	})
})
