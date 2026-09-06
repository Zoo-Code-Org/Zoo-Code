import { resolveEffectiveToolPolicy } from "../effective-tool-policy"

/**
 * `resolveEffectiveToolPolicy` must warn (once per process, per protocol
 * tool) when `disabledTools` tries to disable a protocol tool, since the
 * protocol guarantee makes such a disable a no-op.
 *
 * These tests live in their own file (not in `effective-tool-policy.spec.ts`)
 * because the warn-dedupe set is module-level state and that spec already
 * resolves a policy with `disabledTools: [...PROTOCOL_TOOLS]`, which would
 * prime the set and make the "warned exactly once" assertion silently fail.
 * Vitest gives each test file a fresh module registry, so the dedupe state
 * starts empty here.
 *
 * Note: the "warns once / dedupes" assertions are combined into a single test
 * that keeps one spy active across two resolves, because the dedupe set is
 * shared across `it` blocks within a file — a later test's fresh spy would see
 * zero calls if an earlier test had already primed the set.
 */
describe("resolveEffectiveToolPolicy - protocol override warning", () => {
	/** Build a resolver input for a mode with all standard tool groups. */
	function input(disabledTools?: string[]) {
		return { mode: "code", disabledTools }
	}

	it("warns exactly once for a disabled protocol tool, dedupes on repeat, and keeps the tool available", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const policy = resolveEffectiveToolPolicy(input(["attempt_completion"]))

			// First resolve: warns exactly once and names the tool.
			expect(warnSpy).toHaveBeenCalledTimes(1)
			expect(warnSpy.mock.calls[0]?.[0]).toContain("attempt_completion")
			// The protocol guarantee still keeps the tool available.
			expect(policy.tools.has("attempt_completion")).toBe(true)

			// Second resolve with the same protocol tool: no additional warn (dedupe).
			resolveEffectiveToolPolicy(input(["attempt_completion", "execute_command"]))
			expect(warnSpy).toHaveBeenCalledTimes(1)
		} finally {
			warnSpy.mockRestore()
		}
	})

	it("does not warn when disabledTools contains no protocol tools", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const policy = resolveEffectiveToolPolicy(input(["execute_command", "read_file"]))

			expect(warnSpy).not.toHaveBeenCalled()
			// Non-protocol disables still apply.
			expect(policy.tools.has("execute_command")).toBe(false)
			expect(policy.tools.has("read_file")).toBe(false)
		} finally {
			warnSpy.mockRestore()
		}
	})
})
