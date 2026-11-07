import { renderHook } from "@testing-library/react"

import type { ClineMessage, HistoryItem } from "@roo-code/types"

import { usePromptHistory } from "../usePromptHistory"

const userFeedback = (text: string, ts: number): ClineMessage => ({
	type: "say",
	say: "user_feedback",
	text,
	ts,
})

const sayText = (text: string, ts: number): ClineMessage => ({ type: "say", say: "text", text, ts })

// Keep these references stable across renders. The hook memoizes on them, so a
// fresh array per render would re-run the sync effect on every pass.
const taskHistory: HistoryItem[] = []
const setInputValue = () => undefined

const renderPromptHistory = (clineMessages: ClineMessage[]) =>
	renderHook(() =>
		usePromptHistory({
			clineMessages,
			taskHistory,
			cwd: "/test/workspace",
			inputValue: "",
			setInputValue,
		}),
	)

describe("usePromptHistory", () => {
	it("includes the initial task prompt as the oldest entry", () => {
		const { result } = renderPromptHistory([sayText("Initial task", 1), userFeedback("Follow up", 2)])

		expect(result.current.promptHistory).toEqual(["Follow up", "Initial task"])
	})

	it("returns the task prompt when the task has no user feedback yet", () => {
		const { result } = renderPromptHistory([sayText("Initial task", 1)])

		expect(result.current.promptHistory).toEqual(["Initial task"])
	})

	it("ignores assistant text messages after the first entry", () => {
		const { result } = renderPromptHistory([
			sayText("Initial task", 1),
			sayText("Assistant reply", 2),
			userFeedback("Follow up", 3),
		])

		expect(result.current.promptHistory).toEqual(["Follow up", "Initial task"])
	})

	it("does not look past the first entry for an image-only task", () => {
		const { result } = renderPromptHistory([sayText("", 1), sayText("Assistant reply", 2)])

		expect(result.current.promptHistory).toEqual([])
	})
})
