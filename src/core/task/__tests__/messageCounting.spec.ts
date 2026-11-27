import { shouldAddUserMessageToHistory } from "../messageCounting"

describe("shouldAddUserMessageToHistory", () => {
	it.each([
		{ retryAttempt: undefined, expected: true },
		{ retryAttempt: 0, expected: true },
		{ retryAttempt: 1, expected: false },
		{ retryAttempt: 2, expected: false },
		{ retryAttempt: 3, expected: false },
	])("attempt $retryAttempt adds non-empty content: $expected; skips empty content", ({ retryAttempt, expected }) => {
		expect(shouldAddUserMessageToHistory({ retryAttempt, isEmptyUserContent: false })).toBe(expected)
		expect(shouldAddUserMessageToHistory({ retryAttempt, isEmptyUserContent: true })).toBe(false)
	})
})
