// npx vitest run core/auto-approval/__tests__/webFetch.spec.ts

import { checkAutoApproval } from ".."

import { baseState, CWD, type State } from "./fixtures"

describe("fetch_web_content auto-approval", () => {
	const fetchText = JSON.stringify({ tool: "fetchWebContent", url: "https://example.com/docs" })

	const run = (state: Partial<State>) =>
		checkAutoApproval({ state: { ...baseState, ...state }, ask: "tool", text: fetchText, cwd: CWD })

	it("asks for approval by default (alwaysAllowWebFetch unset)", async () => {
		const { alwaysAllowWebFetch: _omit, ...withoutToggle } = baseState
		expect(await checkAutoApproval({ state: withoutToggle, ask: "tool", text: fetchText, cwd: CWD })).toEqual({
			decision: "ask",
		})
	})

	it("asks for approval when alwaysAllowWebFetch is false", async () => {
		expect(await run({ alwaysAllowWebFetch: false })).toEqual({ decision: "ask" })
	})

	it("approves when alwaysAllowWebFetch is true", async () => {
		expect(await run({ alwaysAllowWebFetch: true })).toEqual({ decision: "approve" })
	})

	it("still asks when alwaysAllowWebFetch is true but the master auto-approval switch is off", async () => {
		expect(await run({ alwaysAllowWebFetch: true, autoApprovalEnabled: false })).toEqual({ decision: "ask" })
	})

	it("is not approved by the read-only toggle", async () => {
		expect(await run({ alwaysAllowReadOnly: true, alwaysAllowReadOnlyOutsideWorkspace: true })).toEqual({
			decision: "ask",
		})
	})
})
