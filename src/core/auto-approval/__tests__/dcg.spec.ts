import { checkAutoApproval } from ".."

describe("Destructive Command Guard auto-approval precedence", () => {
	const baseState = {
		autoApprovalEnabled: true,
		alwaysAllowExecute: true,
		alwaysAllowReadOnly: false,
		alwaysAllowReadOnlyOutsideWorkspace: false,
		alwaysAllowWrite: false,
		alwaysAllowWriteOutsideWorkspace: false,
		alwaysAllowWriteProtected: false,
		alwaysAllowMcp: false,
		alwaysAllowModeSwitch: false,
		alwaysAllowSubtasks: false,
		alwaysAllowFollowupQuestions: false,
		allowedCommands: ["echo"],
		deniedCommands: ["rm"],
		destructiveCommandGuardEnabled: true,
		mcpServers: [],
	}

	it("auto-approves commands allowed by DCG without consulting Zoo's deny list", async () => {
		expect(await checkAutoApproval({ state: baseState, ask: "command", text: "rm file" })).toEqual({
			decision: "approve",
		})
	})

	it("requires explicit approval for a DCG-protected command", async () => {
		expect(
			await checkAutoApproval({ state: baseState, ask: "command", text: "echo safe", isProtected: true }),
		).toEqual({ decision: "ask" })
	})

	it("auto-approves DCG-allowed commands without consulting Zoo's allowlist", async () => {
		expect(await checkAutoApproval({ state: baseState, ask: "command", text: "unlisted-command" })).toEqual({
			decision: "approve",
		})
	})

	it("does not auto-approve via DCG when execute auto-approval is off", async () => {
		const state = { ...baseState, alwaysAllowExecute: false }

		expect(await checkAutoApproval({ state, ask: "command", text: "echo safe" })).toEqual({ decision: "ask" })
	})

	it("keeps ordinary allowlist auto-approval when DCG is disabled", async () => {
		const state = { ...baseState, destructiveCommandGuardEnabled: false }

		expect(await checkAutoApproval({ state, ask: "command", text: "echo safe" })).toEqual({
			decision: "approve",
		})
	})

	it("keeps ordinary denylist behavior when DCG is disabled", async () => {
		const state = { ...baseState, destructiveCommandGuardEnabled: false }

		expect(await checkAutoApproval({ state, ask: "command", text: "rm file" })).toEqual({
			decision: "deny",
		})
	})

	it("keeps ordinary prompts for unlisted commands when DCG is disabled", async () => {
		const state = { ...baseState, destructiveCommandGuardEnabled: false }

		expect(await checkAutoApproval({ state, ask: "command", text: "unlisted-command" })).toEqual({
			decision: "ask",
		})
	})
})
