// npx vitest run core/prompts/__tests__/responses-tool-auto-denied.spec.ts

import { formatResponse } from "../responses"

// `note`/`suggestion` are hardcoded model-facing copy: the payload must never
// advise asking the user, and wording edits must be deliberate, so they are
// pinned verbatim here rather than matched loosely.
const NOTE = "The command chain was rejected in its entirety; none of the chained commands were executed."
const SUGGESTION =
	"Re-run the remaining commands as separate execute_command calls using approved commands only, or choose an approved alternative."

describe("formatResponse.toolAutoDenied", () => {
	it("emits the full auto_deny payload when every field is supplied", () => {
		const parsed = JSON.parse(
			formatResponse.toolAutoDenied({
				reason: "Command `rm x` is not on the command allowlist.",
				offendingCommand: "rm x",
				ruleId: "R-1",
			}),
		)

		expect(parsed.status).toBe("denied")
		expect(parsed.type).toBe("auto_deny")
		expect(parsed.reason).toBe("Command `rm x` is not on the command allowlist.")
		expect(parsed.offending_command).toBe("rm x")
		expect(parsed.rule_id).toBe("R-1")
		expect(parsed.note).toBe(NOTE)
		expect(parsed.suggestion).toBe(SUGGESTION)
	})

	it("omits offending_command and rule_id keys when the detail carries neither", () => {
		const parsed = JSON.parse(formatResponse.toolAutoDenied({ reason: "Denied by policy." }))

		expect(parsed.status).toBe("denied")
		expect(parsed.type).toBe("auto_deny")
		expect(parsed.reason).toBe("Denied by policy.")
		expect(parsed).not.toHaveProperty("offending_command")
		expect(parsed).not.toHaveProperty("rule_id")
	})

	it("pins the note and suggestion copy verbatim, including the no-ask-the-user wording", () => {
		const parsed = JSON.parse(formatResponse.toolAutoDenied({ reason: "Denied by policy." }))

		expect(parsed.note).toBe(NOTE)
		expect(parsed.suggestion).toBe(SUGGESTION)
		// Asking the user would stall a hands-free session; the suggestion must
		// route the model to re-issue approved commands instead.
		expect(parsed.note).not.toMatch(/ask the user/i)
		expect(parsed.suggestion).not.toMatch(/ask the user/i)
	})
})
