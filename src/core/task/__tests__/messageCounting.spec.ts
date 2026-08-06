// npx vitest run core/task/__tests__/messageCounting.spec.ts

import { shouldAddUserMessageToHistory } from "../messageCounting"

describe("shouldAddUserMessageToHistory", () => {
	it("adds the message on a first attempt with non-empty content", () => {
		expect(
			shouldAddUserMessageToHistory({
				retryAttempt: 0,
				isEmptyUserContent: false,
				userMessageWasRemoved: false,
			}),
		).toBe(true)
	})

	it("adds the message when retryAttempt is undefined (treated as first attempt) with non-empty content", () => {
		expect(
			shouldAddUserMessageToHistory({
				retryAttempt: undefined,
				isEmptyUserContent: false,
				userMessageWasRemoved: undefined,
			}),
		).toBe(true)
	})

	it("skips an empty-content first attempt (delegation resume - already in history)", () => {
		expect(
			shouldAddUserMessageToHistory({
				retryAttempt: 0,
				isEmptyUserContent: true,
				userMessageWasRemoved: false,
			}),
		).toBe(false)
	})

	it("skips a retry attempt (retryAttempt > 0) with non-empty content", () => {
		expect(
			shouldAddUserMessageToHistory({
				retryAttempt: 1,
				isEmptyUserContent: false,
				userMessageWasRemoved: false,
			}),
		).toBe(false)
	})

	it("re-adds the message on a retry attempt if it was previously removed", () => {
		expect(
			shouldAddUserMessageToHistory({
				retryAttempt: 2,
				isEmptyUserContent: false,
				userMessageWasRemoved: true,
			}),
		).toBe(true)
	})

	it("re-adds an empty-content message if it was previously removed", () => {
		expect(
			shouldAddUserMessageToHistory({
				retryAttempt: 0,
				isEmptyUserContent: true,
				userMessageWasRemoved: true,
			}),
		).toBe(true)
	})

	it("skips a retry attempt with empty content that was not removed", () => {
		expect(
			shouldAddUserMessageToHistory({
				retryAttempt: 3,
				isEmptyUserContent: true,
				userMessageWasRemoved: false,
			}),
		).toBe(false)
	})
})
