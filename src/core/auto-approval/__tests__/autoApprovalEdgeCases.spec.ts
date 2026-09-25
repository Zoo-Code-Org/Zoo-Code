import type { ExtensionState } from "@roo-code/types"
import { checkAutoApproval, type AutoApprovalState, type AutoApprovalStateOptions } from ".."
import { getCommandDecisionDetailed } from "../commands"

type State = Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>

// Edge cases around the command auto-approval path that the blanket-deny
// matrix does not cover: command lists absent from state entirely, a
// DCG-enabled ask arriving without a verdict, and the original-cased denied
// pattern reported back for the model-facing denial detail.
describe("command auto-approval edge cases", () => {
	const stateWithoutCommandLists: State = {
		autoApprovalEnabled: true,
		alwaysAllowExecute: true,
	}

	it("asks for an unlisted command when the state omits both command lists", async () => {
		expect(await checkAutoApproval({ state: stateWithoutCommandLists, ask: "command", text: "some-tool" })).toEqual(
			{ decision: "ask" },
		)
	})

	it("auto-denies an unlisted command with blanket on when the state omits both command lists", async () => {
		expect(
			await checkAutoApproval({
				state: { ...stateWithoutCommandLists, alwaysDenyUnapprovedCommands: true },
				ask: "command",
				text: "some-tool",
			}),
		).toEqual({ decision: "deny", autoDeny: { kind: "not_allowlisted", command: "some-tool" } })
	})

	it("denies a DCG-enabled command ask that carries no verdict with a retryable guard-state detail", async () => {
		expect(
			await checkAutoApproval({
				state: { ...stateWithoutCommandLists, destructiveCommandGuardEnabled: true },
				ask: "command",
				text: "rm file",
			}),
		).toEqual({ decision: "deny", autoDeny: { kind: "guard_unavailable", command: "rm file" } })
	})

	it("reports the denied prefix in its original casing", () => {
		expect(getCommandDecisionDetailed("rm x", ["git"], ["RM"])).toEqual({
			decision: "auto_deny",
			offendingCommand: "rm x",
			matchedPattern: "RM",
		})
	})
})
