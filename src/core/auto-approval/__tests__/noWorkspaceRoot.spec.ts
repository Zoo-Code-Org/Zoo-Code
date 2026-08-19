// npx vitest run core/auto-approval/__tests__/noWorkspaceRoot.spec.ts

import { isFileMatchedByPatterns, toMatcherPattern } from "../filePatterns"

const matchesWithoutWorkspace = (filePath: string, patterns: string[]) =>
	isFileMatchedByPatterns({ filePath, cwd: undefined, patterns })

describe("patterns without a workspace root", () => {
	// A bare gitignore pattern matches in any directory. Left unprefixed, it would
	// reach the whole filesystem, so a workspace-relative pattern must not be
	// usable at all while there is no workspace to confine it to.
	describe("does not let a workspace-relative pattern reach outside a workspace", () => {
		it.each([
			["a bare filename", "passwd"],
			["a star", "*"],
			["a double star", "**"],
			["an extension glob", "*.conf"],
			["a workspace-root-anchored path", "./passwd"],
			["a nested path", "etc/passwd"],
		])("rejects %s", (_label, pattern) => {
			expect(toMatcherPattern(pattern, undefined)).toBeUndefined()
		})

		it.each([
			["passwd", "/etc/passwd"],
			["*", "/etc/passwd"],
			["**", "/etc/passwd"],
			["*.conf", "/etc/nginx/nginx.conf"],
			["etc/passwd", "/etc/passwd"],
		])("does not match %s against %s", (pattern, filePath) => {
			expect(matchesWithoutWorkspace(filePath, [pattern])).toBe(false)
		})

		it("does not match a workspace-relative path either", () => {
			expect(matchesWithoutWorkspace("notes.md", ["notes.md"])).toBe(false)
		})
	})

	// An absolute pattern names its location outright, so it needs no workspace.
	describe("keeps absolute patterns usable", () => {
		it("matches an absolute pattern against that absolute path", () => {
			expect(matchesWithoutWorkspace("/tmp/notes.md", ["/tmp/notes.md"])).toBe(true)
		})

		it("does not match a different absolute path", () => {
			expect(matchesWithoutWorkspace("/etc/passwd", ["/tmp/notes.md"])).toBe(false)
		})

		it("matches an absolute glob", () => {
			expect(matchesWithoutWorkspace("/tmp/scratch/notes.md", ["/tmp/scratch/**"])).toBe(true)
		})

		it("honours an absolute negation", () => {
			expect(
				matchesWithoutWorkspace("/tmp/scratch/secret.md", ["/tmp/scratch/**", "!/tmp/scratch/secret.md"]),
			).toBe(false)
		})
	})

	// With a workspace root the same patterns are confined to it, which is the
	// behaviour the rejection above preserves.
	describe("for contrast, with a workspace root", () => {
		it("confines a bare filename to the workspace", () => {
			expect(
				isFileMatchedByPatterns({ filePath: "/etc/passwd", cwd: "/path/to/repo", patterns: ["passwd"] }),
			).toBe(false)

			expect(
				isFileMatchedByPatterns({
					filePath: "/path/to/repo/etc/passwd",
					cwd: "/path/to/repo",
					patterns: ["passwd"],
				}),
			).toBe(true)
		})

		it("confines a star to the workspace", () => {
			expect(isFileMatchedByPatterns({ filePath: "/etc/passwd", cwd: "/path/to/repo", patterns: ["*"] })).toBe(
				false,
			)
		})
	})
})
