import { checkAutoApproval } from ".."
import { baseState as sharedBaseState, type State } from "./fixtures"

// Matrix over the blanket auto-deny feature (`alwaysDenyUnapprovedCommands`):
// DCG on/off × blanket on/off × command shapes. The blanket setting only
// engages while command auto-approval (`autoApprovalEnabled` +
// `alwaysAllowExecute`) is on, so the engagement cases keep both gates on; the
// disengagement cases turn them off to prove the setting is inert.
describe("blanket auto-deny for unapproved commands", () => {
	const baseState = {
		...sharedBaseState,
		alwaysAllowExecute: true,
		allowedCommands: ["git"],
		deniedCommands: ["rm"],
	}

	const commandCase = (text: string, overrides: Partial<State> = {}, extra: object = {}) =>
		checkAutoApproval({ state: { ...baseState, ...overrides }, ask: "command", text, ...extra })

	describe("DCG disabled", () => {
		it("auto-approves allowlist matches regardless of the blanket setting", async () => {
			expect(await commandCase("git status")).toEqual({ decision: "approve" })
			expect(await commandCase("git status", { alwaysDenyUnapprovedCommands: true })).toEqual({
				decision: "approve",
			})
		})

		it("auto-denies denylist matches with structured detail, even with blanket off", async () => {
			expect(await commandCase("rm file")).toEqual({
				decision: "deny",
				autoDeny: { kind: "denylist", command: "rm file", pattern: "rm" },
			})
			expect(await commandCase("rm file", { alwaysDenyUnapprovedCommands: true })).toEqual({
				decision: "deny",
				autoDeny: { kind: "denylist", command: "rm file", pattern: "rm" },
			})
		})

		it("asks for unlisted commands with blanket off", async () => {
			expect(await commandCase("some-unknown-command")).toEqual({ decision: "ask" })
		})

		it("auto-denies unlisted commands with blanket on", async () => {
			expect(await commandCase("some-unknown-command", { alwaysDenyUnapprovedCommands: true })).toEqual({
				decision: "deny",
				autoDeny: { kind: "not_allowlisted", command: "some-unknown-command" },
			})
		})

		it("names the first sub-command lacking an allowlist match in a chain", async () => {
			const result = await commandCase("git status && unknown-tool", {
				alwaysDenyUnapprovedCommands: true,
			})

			expect(result).toEqual({
				decision: "deny",
				autoDeny: { kind: "not_allowlisted", command: "unknown-tool" },
			})
		})

		it("asks for dangerous substitutions with blanket off", async () => {
			expect(await commandCase('echo "${var@P}"', { allowedCommands: ["echo"] })).toEqual({ decision: "ask" })
		})

		it("auto-denies dangerous substitutions with blanket on", async () => {
			expect(
				await commandCase('echo "${var@P}"', {
					allowedCommands: ["echo"],
					alwaysDenyUnapprovedCommands: true,
				}),
			).toEqual({
				decision: "deny",
				autoDeny: { kind: "dangerous_substitution", command: 'echo "${var@P}"' },
			})
		})

		it("asks for malformed commands with blanket off (normally blocked earlier by the tool)", async () => {
			expect(await commandCase("sh -c 'echo a")).toEqual({ decision: "ask" })
		})

		it("auto-denies malformed commands with blanket on (defense in depth)", async () => {
			const result = await commandCase("sh -c 'echo a", { alwaysDenyUnapprovedCommands: true })

			expect(result).toEqual({
				decision: "deny",
				autoDeny: expect.objectContaining({
					kind: "malformed_command",
					command: "sh -c 'echo a",
					parseError: expect.stringContaining("unterminated"),
				}),
			})
		})

		it("never returns ask for a command ask with all gates on and blanket on", async () => {
			const commands = [
				"git status", // allowlisted
				"rm file", // denylisted
				"unknown-command", // unlisted
				'echo "${var@P}"', // dangerous substitution
				"sh -c 'echo a", // malformed
				"git status && rm x && npm test", // chain with a denied part
				"git status && unknown-tool", // chain with an unlisted part
			]

			for (const command of commands) {
				const result = await commandCase(command, {
					alwaysDenyUnapprovedCommands: true,
					allowedCommands: ["echo", "git", "npm", "sh"],
				})
				expect(result.decision, `command: ${command}`).not.toBe("ask")
			}
		})

		it("leaves protected asks prompting even with blanket on", async () => {
			expect(
				await checkAutoApproval({
					state: { ...baseState, alwaysDenyUnapprovedCommands: true },
					ask: "command",
					text: "some-unknown-command",
					isProtected: true,
				}),
			).toEqual({ decision: "ask" })
		})
	})

	describe("gate: blanket only engages while command auto-approval is on", () => {
		it("asks when the master auto-approval switch is off", async () => {
			expect(
				await commandCase("unknown-command", {
					alwaysDenyUnapprovedCommands: true,
					autoApprovalEnabled: false,
				}),
			).toEqual({ decision: "ask" })
		})

		it("asks when execute auto-approval is off", async () => {
			expect(
				await commandCase("unknown-command", {
					alwaysDenyUnapprovedCommands: true,
					alwaysAllowExecute: false,
				}),
			).toEqual({ decision: "ask" })
		})
	})

	describe("DCG enabled", () => {
		const dcgState = { destructiveCommandGuardEnabled: true }

		it("approves a DCG-allowed verdict in every blanket mode", async () => {
			expect(await commandCase("rm file", dcgState, { dcgDecision: { decision: "allow" } })).toEqual({
				decision: "approve",
			})
			expect(
				await commandCase(
					"rm file",
					{ ...dcgState, alwaysDenyUnapprovedCommands: true },
					{
						dcgDecision: { decision: "allow" },
					},
				),
			).toEqual({ decision: "approve" })
		})

		it("auto-denies a verdictless command ask with the retryable guard-state detail in both blanket modes", async () => {
			// Verdictless + guard-on is an inconsistent guard state, not a guard
			// decision, so the denial is the same in both blanket modes.
			expect(await commandCase("rm file", { ...dcgState })).toEqual({
				decision: "deny",
				autoDeny: { kind: "guard_unavailable", command: "rm file" },
			})
			expect(await commandCase("rm file", { ...dcgState, alwaysDenyUnapprovedCommands: true })).toEqual({
				decision: "deny",
				autoDeny: { kind: "guard_unavailable", command: "rm file" },
			})
		})

		it("auto-denies with the DCG reason when blanket is on", async () => {
			expect(
				await commandCase(
					"rm -rf /",
					{ ...dcgState, alwaysDenyUnapprovedCommands: true },
					{
						dcgDecision: {
							decision: "deny",
							reason: "matches a destructive pattern",
							ruleId: "recursive-delete",
						},
					},
				),
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

		it("prompts (protected ask) when blanket is off", async () => {
			expect(
				await commandCase(
					"rm -rf /",
					{ ...dcgState, alwaysDenyUnapprovedCommands: false },
					{ dcgDecision: { decision: "deny", reason: "matches a destructive pattern" } },
				),
			).toEqual({ decision: "ask" })
		})

		it("does not let an allowlist match rescue a DCG denial", async () => {
			const result = await commandCase(
				"rm file",
				{ ...dcgState, alwaysDenyUnapprovedCommands: true, allowedCommands: ["rm"] },
				{ dcgDecision: { decision: "deny", reason: "matches a destructive pattern" } },
			)

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

		it("never returns ask for a command ask with all gates on, blanket on, and a verdict", async () => {
			for (const dcgDecision of [{ decision: "allow" }, { decision: "deny", reason: "nope" }] as const) {
				const result = await commandCase(
					"anything",
					{ ...dcgState, alwaysDenyUnapprovedCommands: true },
					{ dcgDecision },
				)
				expect(result.decision, `verdict: ${dcgDecision.decision}`).not.toBe("ask")
			}
		})
	})

	it("does not affect non-command asks", async () => {
		const state = { ...baseState, alwaysDenyUnapprovedCommands: true, alwaysAllowWrite: true }

		expect(
			await checkAutoApproval({
				state,
				cwd: "/repo",
				ask: "tool",
				text: JSON.stringify({ tool: "editedExistingFile", path: "a.ts" }),
			}),
		).toEqual({ decision: "approve" })

		// A write that is not allowed still asks — the blanket setting is command-only.
		expect(
			await checkAutoApproval({
				state: { ...state, alwaysAllowWrite: false },
				cwd: "/repo",
				ask: "tool",
				text: JSON.stringify({ tool: "editedExistingFile", path: "a.ts" }),
			}),
		).toEqual({ decision: "ask" })
	})
})
