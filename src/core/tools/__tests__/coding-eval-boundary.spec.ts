import { describe, expect, it, vi } from "vitest"
import type { AgentFixture } from "../../../../scripts/agent-evals/contract"
import { validateToolUse } from "../validateToolUse"

describe("coding eval host command boundary", () => {
	it.each(["clamp-range", "slugify-text", "parse-csv-line", "format-bytes", "deep-get"])(
		"rejects an outside-workspace git diff in %s before command execution",
		async (name) => {
			// Load the script module through Vitest: it uses a separate tsconfig
			// that permits .ts import extensions, unlike the extension sources.
			const { CODING_FIXTURE_BUNDLES } = await vi.importActual<{
				CODING_FIXTURE_BUNDLES: { fixture: AgentFixture }[]
			}>("../../../../scripts/agent-evals/coding-fixtures")
			const fixture = CODING_FIXTURE_BUNDLES.find(({ fixture }) => fixture.identity.name === name)!.fixture
			const config = fixture.buildConfiguration("test-key")
			const params = { command: "git diff --no-index /dev/null /home/user/.aws/credentials" }
			expect(config.alwaysAllowExecute).toBe(false)
			expect(config.disabledTools).toContain("execute_command")
			expect(() =>
				validateToolUse("execute_command", "coding-eval", config.customModes, undefined, params),
			).toThrow('Tool "execute_command" is not allowed')
			expect(() => validateToolUse("read_file", "coding-eval", config.customModes)).not.toThrow()
			expect(() => validateToolUse("write_to_file", "coding-eval", config.customModes)).not.toThrow()
		},
	)
})
