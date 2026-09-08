// npx vitest run core/auto-approval/__tests__/negation.spec.ts

import { isFileMatchedByPatterns } from "../filePatterns"
import { checkAutoApproval } from ".."
import { CWD, HOME, baseState, type State } from "./fixtures"

// `isWindows` and `homeDir` are fixed rather than read from the platform, so the
// expectations mean the same thing on every CI runner.
const matches = (filePath: string, patterns: string[]) =>
	isFileMatchedByPatterns({ filePath, cwd: CWD, patterns, isWindows: false, homeDir: HOME })

const readDecision = async (state: Partial<State>, path = "docs/secret.md") =>
	checkAutoApproval({
		state: { ...baseState, ...state },
		cwd: CWD,
		ask: "tool",
		text: JSON.stringify({ tool: "readFile", path }),
	})

describe("pattern negation", () => {
	it("excludes a workspace-relative file from a workspace-relative glob", () => {
		expect(matches("docs/secret.md", ["docs/**", "!docs/secret.md"])).toBe(false)
		expect(matches("docs/notes.md", ["docs/**", "!docs/secret.md"])).toBe(true)
	})

	// A negation is scoped by the path it names, not by the "!", so it lands in
	// the same scope as the pattern it is meant to cancel.
	it("excludes an absolute file from an absolute glob", () => {
		expect(matches("/tmp/x/secret.md", ["/tmp/x/**", "!/tmp/x/secret.md"])).toBe(false)
		expect(matches("/tmp/x/notes.md", ["/tmp/x/**", "!/tmp/x/secret.md"])).toBe(true)
	})

	// A deny pattern has to be effective whenever it names the file, whatever
	// spelling was used for it or for the pattern it cancels. All patterns are
	// therefore rewritten into one form and matched together.
	it("cancels across the workspace-relative and absolute spellings", () => {
		expect(matches("docs/secret.md", ["docs/**", `!${CWD}/docs/secret.md`])).toBe(false)
		expect(matches("docs/secret.md", [`${CWD}/docs/**`, "!docs/secret.md"])).toBe(false)
	})

	it("cancels when both are written in the same form", () => {
		expect(matches("docs/secret.md", [`${CWD}/docs/**`, `!${CWD}/docs/secret.md`])).toBe(false)
	})

	it("cancels a bare-filename pattern with an anchored negation", () => {
		expect(matches("docs/secret.md", ["secret.md", "!docs/secret.md"])).toBe(false)
		expect(matches("other/secret.md", ["secret.md", "!docs/secret.md"])).toBe(true)
	})

	// Asserting only the exclusion would also pass if `~/**` matched nothing at
	// all, so the sibling file has to come out granted.
	it("excludes via a home-directory negation", () => {
		expect(matches(`${HOME}/notes.md`, ["~/**", "!~/notes.md"])).toBe(false)
		expect(matches(`${HOME}/other.md`, ["~/**", "!~/notes.md"])).toBe(true)
	})

	it("grants nothing when only negations are configured", () => {
		expect(matches("docs/secret.md", ["!docs/secret.md"])).toBe(false)
	})

	describe("across the two allowlists", () => {
		// Each list is matched independently, so which box a pattern was typed
		// into cannot change the outcome by reordering a concatenation.
		it("does not let a write-list negation revoke read access", async () => {
			expect(
				await readDecision({ allowedReadFiles: ["docs/**"], allowedWriteFiles: ["!docs/secret.md"] }),
			).toEqual({ decision: "approve" })
		})

		it("does not let a read-list negation revoke read access granted by the write list", async () => {
			// Write permission implies read permission, so the write pattern
			// still grants the read; a negation only narrows its own list.
			expect(
				await readDecision({ allowedReadFiles: ["!docs/secret.md"], allowedWriteFiles: ["docs/**"] }),
			).toEqual({ decision: "approve" })
		})

		it("asks when each list's own negation excludes the file", async () => {
			expect(
				await readDecision({
					allowedReadFiles: ["docs/**", "!docs/secret.md"],
					allowedWriteFiles: ["docs/**", "!docs/secret.md"],
				}),
			).toEqual({ decision: "ask" })

			expect(
				await readDecision(
					{
						allowedReadFiles: ["docs/**", "!docs/secret.md"],
						allowedWriteFiles: ["docs/**", "!docs/secret.md"],
					},
					"docs/notes.md",
				),
			).toEqual({ decision: "approve" })
		})
	})
})
