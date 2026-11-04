import { buildAutoDenyReason } from "../autoDenyReason"

// Strings are asserted against buildAutoDenyReason's own templates: these are
// model-facing payloads, so exact wording (backticks, placeholders, rule
// suffix) is the contract.
describe("buildAutoDenyReason", () => {
	it("names the command and matched prefix for a complete denylist detail", () => {
		expect(buildAutoDenyReason({ kind: "denylist", command: "rm -rf /", pattern: "rm" })).toBe(
			"Command `rm -rf /` matches denied prefix `rm`.",
		)
	})

	it("falls back to (unknown) placeholders when a denylist detail omits command and pattern", () => {
		expect(buildAutoDenyReason({ kind: "denylist" })).toBe("Command `(unknown)` matches denied prefix `(unknown)`.")
	})

	it("names the command for a complete not_allowlisted detail", () => {
		expect(buildAutoDenyReason({ kind: "not_allowlisted", command: "unknown-tool" })).toBe(
			"Command `unknown-tool` is not on the command allowlist.",
		)
	})

	it("falls back to an (unknown) command when a not_allowlisted detail omits it", () => {
		expect(buildAutoDenyReason({ kind: "not_allowlisted" })).toBe(
			"Command `(unknown)` is not on the command allowlist.",
		)
	})

	it("returns the fixed shell-expansion warning for dangerous_substitution", () => {
		expect(buildAutoDenyReason({ kind: "dangerous_substitution", command: 'echo "${var@P}"' })).toBe(
			"Command contains shell expansions (${...} forms, process substitution, and similar) that are never auto-approved. Choose an approved command without shell expansions.",
		)
	})

	it("returns the honest retryable detail for guard_unavailable", () => {
		const reason = buildAutoDenyReason({ kind: "guard_unavailable", command: "npm test" })
		expect(reason).toBe(
			"Command `npm test` was not executed: the Destructive Command Guard is enabled but supplied no verdict, which is an internal guard-state inconsistency, not a policy denial. You may retry the same command.",
		)
		// The never-ask posture: the reason must name the state and invite a
		// retry without ever pointing at user approval.
		expect(reason).not.toMatch(/approv|ask the user/i)
		expect(buildAutoDenyReason({ kind: "guard_unavailable" })).toBe(
			"Command `(unknown)` was not executed: the Destructive Command Guard is enabled but supplied no verdict, which is an internal guard-state inconsistency, not a policy denial. You may retry the same command.",
		)
	})

	it("forwards the parse error for malformed_command and defaults when it is absent", () => {
		expect(buildAutoDenyReason({ kind: "malformed_command", parseError: "boom" })).toBe("boom")
		expect(buildAutoDenyReason({ kind: "malformed_command" })).toBe("Command contains a shell syntax error.")
	})

	it("appends the rule id for a dcg detail and omits the suffix without one", () => {
		expect(
			buildAutoDenyReason({
				kind: "dcg",
				command: "rm -rf /",
				dcgReason: "matches a destructive pattern",
				dcgRuleId: "recursive-delete",
			}),
		).toBe("Destructive Command Guard denied the command: matches a destructive pattern (Rule: recursive-delete)")
		expect(buildAutoDenyReason({ kind: "dcg" })).toBe(
			"Destructive Command Guard denied the command: no reason provided",
		)
	})
})
