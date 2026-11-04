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
		alwaysDenyUnapprovedCommands: false,
		mcpServers: [],
	}

	it("denies with the retryable guard-state detail when no verdict is supplied", async () => {
		expect(await checkAutoApproval({ state: baseState, ask: "command", text: "rm file" })).toEqual({
			decision: "deny",
			autoDeny: { kind: "guard_unavailable", command: "rm file" },
		})
	})

	it("does not auto-approve through DCG when global auto-approval is disabled", async () => {
		const state = { ...baseState, autoApprovalEnabled: false }

		expect(await checkAutoApproval({ state, ask: "command", text: "rm file" })).toEqual({ decision: "ask" })
	})

	it("requires explicit approval for a DCG-protected command when blanket auto-deny is off", async () => {
		expect(
			await checkAutoApproval({ state: baseState, ask: "command", text: "echo safe", isProtected: true }),
		).toEqual({ decision: "ask" })
	})

	it("denies with the retryable guard-state detail without consulting Zoo's allowlist when no verdict is supplied", async () => {
		expect(await checkAutoApproval({ state: baseState, ask: "command", text: "unlisted-command" })).toEqual({
			decision: "deny",
			autoDeny: { kind: "guard_unavailable", command: "unlisted-command" },
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

		// Denylist denials are automatic denials and carry their structured
		// detail even when the blanket setting is off.
		expect(await checkAutoApproval({ state, ask: "command", text: "rm file" })).toEqual({
			decision: "deny",
			autoDeny: { kind: "denylist", command: "rm file", pattern: "rm" },
		})
	})

	it("keeps ordinary prompts for unlisted commands when DCG is disabled", async () => {
		const state = { ...baseState, destructiveCommandGuardEnabled: false }

		expect(await checkAutoApproval({ state, ask: "command", text: "unlisted-command" })).toEqual({
			decision: "ask",
		})
	})

	describe("with an explicit DCG verdict", () => {
		it("auto-approves when the verdict allows the command, bypassing Zoo's deny list", async () => {
			expect(
				await checkAutoApproval({
					state: baseState,
					ask: "command",
					text: "rm file",
					dcgDecision: { decision: "allow" },
				}),
			).toEqual({ decision: "approve" })
		})

		it("falls back to the (protected) user prompt when DCG denies and blanket auto-deny is off", async () => {
			expect(
				await checkAutoApproval({
					state: baseState,
					ask: "command",
					text: "echo test",
					isProtected: true,
					dcgDecision: {
						decision: "deny",
						reason: "matches a destructive pattern",
						ruleId: "recursive-delete",
					},
				}),
			).toEqual({ decision: "ask" })
		})

		it("auto-denies with the DCG reason and rule when blanket auto-deny is on", async () => {
			const state = { ...baseState, alwaysDenyUnapprovedCommands: true }

			expect(
				await checkAutoApproval({
					state,
					ask: "command",
					text: "rm -rf /",
					dcgDecision: {
						decision: "deny",
						reason: "matches a destructive pattern",
						ruleId: "recursive-delete",
					},
				}),
			).toEqual({
				decision: "deny",
				autoDeny: {
					kind: "dcg",
					command: "rm -rf /",
					dcgReason: "matches a destructive pattern",
					dcgRuleId: "recursive-delete",
				},
			})
		})

		it("does not let an allowlist match rescue a DCG denial under blanket auto-deny", async () => {
			const state = { ...baseState, alwaysDenyUnapprovedCommands: true, allowedCommands: ["rm"] }

			const result = await checkAutoApproval({
				state,
				ask: "command",
				text: "rm file",
				dcgDecision: { decision: "deny", reason: "matches a destructive pattern" },
			})

			expect(result).toEqual({
				decision: "deny",
				autoDeny: {
					kind: "dcg",
					command: "rm file",
					dcgReason: "matches a destructive pattern",
					dcgRuleId: undefined,
				},
			})
		})

		it("ignores the verdict when DCG is disabled in settings", async () => {
			const state = { ...baseState, destructiveCommandGuardEnabled: false }

			// The verdict is only consulted while DCG is enabled; with it off,
			// the ordinary denylist still denies.
			expect(
				await checkAutoApproval({
					state,
					ask: "command",
					text: "rm file",
					dcgDecision: { decision: "allow" },
				}),
			).toEqual({ decision: "deny", autoDeny: { kind: "denylist", command: "rm file", pattern: "rm" } })
		})
	})
})
