import { shouldAddUserMessageToHistory } from "../messageCounting"

describe("shouldAddUserMessageToHistory", () => {
	it.each([
		{ retryAttempt: undefined, expected: true },
		{ retryAttempt: 0, expected: true },
		{ retryAttempt: 1, expected: false },
		{ retryAttempt: 2, expected: false },
		{ retryAttempt: 3, expected: false },
	])("adds non-empty content at attempt $retryAttempt: $expected", ({ retryAttempt, expected }) => {
		expect(shouldAddUserMessageToHistory({ retryAttempt, isEmptyUserContent: false })).toBe(expected)
		expect(shouldAddUserMessageToHistory({ retryAttempt, isEmptyUserContent: true })).toBe(false)
	})
})
