import type { ExtensionState } from "@roo-code/types"
import { checkAutoApproval, type AutoApprovalState, type AutoApprovalStateOptions } from ".."

type AutoApprovalFields = Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>

describe("Follow-up question auto-approval", () => {
	const baseState: AutoApprovalFields = {
		autoApprovalEnabled: true,
		alwaysAllowFollowupQuestions: true,
		followupAutoApproveTimeoutMs: 10_000,
	}

	const followupText = (suggest: unknown) => JSON.stringify({ question: "Pick one?", suggest }) as string

	const run = (state: AutoApprovalFields, text: string) => checkAutoApproval({ state, ask: "followup", text })

	it("schedules a timeout that auto-answers with the first valid suggestion", async () => {
		const result = await run(baseState, followupText([{ answer: "Yes, proceed" }]))

		expect(result.decision).toBe("timeout")
		if (result.decision === "timeout") {
			expect(result.timeout).toBe(10_000)
			expect(result.fn()).toEqual({
				askResponse: "messageResponse",
				text: "Yes, proceed",
			})
		}
	})

	it("falls back to asking when the follow-up has no text payload", async () => {
		// Exercises the `text || "{}"` fallback: a follow-up without any payload must
		// not schedule an auto-answer timeout.
		const result = await checkAutoApproval({ state: baseState, ask: "followup" })

		expect(result).toEqual({ decision: "ask" })
	})

	it("skips a blank or missing first answer and uses the next valid suggestion (issue #1226)", async () => {
		// Mirrors a malformed model response where JSON round-tripping drops
		// `answer: undefined` and the first item is unusable.
		const result = await run(baseState, followupText([{}, { answer: "   " }, { answer: "Valid answer" }]))

		expect(result.decision).toBe("timeout")
		if (result.decision === "timeout") {
			expect(result.fn()).toEqual({
				askResponse: "messageResponse",
				text: "Valid answer",
			})
		}
	})

	it("falls back to asking when every suggestion answer is blank or missing (issue #1226)", async () => {
		// Before the #1226 fix this scheduled a timeout that auto-answered the
		// follow-up with `undefined` text, silently accepting an empty answer.
		const result = await run(baseState, followupText([{ answer: "" }, { answer: "  \n\t " }, {}]))

		expect(result).toEqual({ decision: "ask" })
	})

	it("falls back to asking when the suggestion answer is not a string", async () => {
		const result = await run(baseState, followupText([{ answer: 42 }]))

		expect(result).toEqual({ decision: "ask" })
	})

	it("falls back to asking when the follow-up has no suggestions", async () => {
		const result = await run(baseState, JSON.stringify({ question: "Pick one?" }))

		expect(result).toEqual({ decision: "ask" })
	})

	it("falls back to asking when the follow-up text is not valid JSON", async () => {
		const result = await run(baseState, "not-json")

		expect(result).toEqual({ decision: "ask" })
	})

	it("falls back to asking when the auto-approve timeout is not positive", async () => {
		const result = await run({ ...baseState, followupAutoApproveTimeoutMs: 0 }, followupText([{ answer: "Yes" }]))

		expect(result).toEqual({ decision: "ask" })
	})

	it("does not auto-approve when follow-up auto-approval is disabled", async () => {
		const result = await run(
			{ ...baseState, alwaysAllowFollowupQuestions: false },
			followupText([{ answer: "Yes" }]),
		)

		expect(result).toEqual({ decision: "ask" })
	})

	it("does not auto-approve when global auto-approval is disabled", async () => {
		const result = await run({ ...baseState, autoApprovalEnabled: false }, followupText([{ answer: "Yes" }]))

		expect(result).toEqual({ decision: "ask" })
	})
})
