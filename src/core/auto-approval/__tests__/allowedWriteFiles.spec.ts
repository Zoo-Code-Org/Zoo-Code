// npx vitest run core/auto-approval/__tests__/allowedWriteFiles.spec.ts

import { checkAutoApproval } from ".."
import { CWD, baseState, type State } from "./fixtures"

const askToWrite = async ({
	path,
	state,
	tool = "newFileCreated",
	isProtected,
	isOutsideWorkspace,
	cwd = CWD,
	batchDiffs,
}: {
	path?: string
	state: Partial<State>
	tool?: string
	isProtected?: boolean
	isOutsideWorkspace?: boolean
	cwd?: string
	batchDiffs?: { path: string }[]
}) =>
	checkAutoApproval({
		state: { ...baseState, ...state },
		cwd,
		ask: "tool",
		text: JSON.stringify({ tool, path, isOutsideWorkspace, isProtected, batchDiffs }),
		isProtected,
	})

describe("allowedWriteFiles auto-approval", () => {
	it("asks when the file is not listed", async () => {
		expect(await askToWrite({ path: "src/index.ts", state: { allowedWriteFiles: ["notes.md"] } })).toEqual({
			decision: "ask",
		})
	})

	it("approves a listed file even though alwaysAllowWrite is off", async () => {
		expect(await askToWrite({ path: "notes.md", state: { allowedWriteFiles: ["notes.md"] } })).toEqual({
			decision: "approve",
		})
	})

	it("approves each write tool action for a listed file", async () => {
		for (const tool of ["editedExistingFile", "appliedDiff", "newFileCreated", "generateImage"]) {
			expect(await askToWrite({ path: "notes.md", state: { allowedWriteFiles: ["notes.md"] }, tool })).toEqual({
				decision: "approve",
			})
		}
	})

	it("approves a listed file outside the workspace without the outside-workspace toggle", async () => {
		expect(
			await askToWrite({
				path: "/tmp/notes.md",
				isOutsideWorkspace: true,
				state: { allowedWriteFiles: ["/tmp/notes.md"] },
			}),
		).toEqual({ decision: "approve" })
	})

	it("still asks for a protected file, even when listed", async () => {
		expect(
			await askToWrite({
				path: "AGENTS.md",
				isProtected: true,
				state: { allowedWriteFiles: ["*.md"] },
			}),
		).toEqual({ decision: "ask" })
	})

	it("approves a listed protected file once protected writes are allowed", async () => {
		expect(
			await askToWrite({
				path: "AGENTS.md",
				isProtected: true,
				state: { allowedWriteFiles: ["*.md"], alwaysAllowWriteProtected: true },
			}),
		).toEqual({ decision: "approve" })
	})

	// Write permission implies read permission.
	it("grants read permission for a listed file", async () => {
		expect(
			await checkAutoApproval({
				state: { ...baseState, allowedWriteFiles: ["notes.md"] },
				cwd: CWD,
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", path: "notes.md" }),
			}),
		).toEqual({ decision: "approve" })
	})

	it("does not grant read permission for an unlisted file", async () => {
		expect(
			await checkAutoApproval({
				state: { ...baseState, allowedWriteFiles: ["notes.md"] },
				cwd: CWD,
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", path: "src/index.ts" }),
			}),
		).toEqual({ decision: "ask" })
	})

	it("asks when auto-approval is disabled entirely", async () => {
		expect(
			await askToWrite({
				path: "notes.md",
				state: { allowedWriteFiles: ["notes.md"], autoApprovalEnabled: false },
			}),
		).toEqual({ decision: "ask" })
	})

	it("leaves the alwaysAllowWrite behaviour unchanged when nothing is listed", async () => {
		expect(await askToWrite({ path: "src/index.ts", state: { alwaysAllowWrite: true } })).toEqual({
			decision: "approve",
		})

		expect(
			await askToWrite({
				path: "/tmp/notes.md",
				isOutsideWorkspace: true,
				state: { alwaysAllowWrite: true },
			}),
		).toEqual({ decision: "ask" })
	})

	// A workspace-relative pattern and a workspace-relative path are only about the
	// same file if both are resolved against the root the task actually runs in. A
	// resumed or child task can run in a different one than the window shows, so the
	// caller passes the task's own `cwd` rather than the provider's.
	it("resolves the patterns against the cwd it is given", async () => {
		const state = { allowedWriteFiles: ["/path/to/repo/notes.md"] }

		expect(await askToWrite({ path: "notes.md", cwd: "/path/to/repo", state })).toEqual({
			decision: "approve",
		})

		// The same relative path, in another workspace, is another file.
		expect(await askToWrite({ path: "notes.md", cwd: "/path/to/other-repo", state })).toEqual({
			decision: "ask",
		})
	})

	describe("a write naming several files", () => {
		// One approval covers the whole action, so a pattern has to cover all of it.
		it("approves only when every file in the batch is listed", async () => {
			expect(
				await askToWrite({
					state: { allowedWriteFiles: ["docs/**"] },
					tool: "appliedDiff",
					batchDiffs: [{ path: "docs/a.md" }, { path: "docs/b.md" }],
				}),
			).toEqual({ decision: "approve" })

			expect(
				await askToWrite({
					state: { allowedWriteFiles: ["docs/**"] },
					tool: "appliedDiff",
					batchDiffs: [{ path: "docs/a.md" }, { path: "src/index.ts" }],
				}),
			).toEqual({ decision: "ask" })
		})

		it("does not let a listed batch carry an unlisted path", async () => {
			expect(
				await askToWrite({
					path: "src/index.ts",
					state: { allowedWriteFiles: ["docs/**"] },
					tool: "appliedDiff",
					batchDiffs: [{ path: "docs/a.md" }],
				}),
			).toEqual({ decision: "ask" })
		})

		it("asks when the action names no file at all", async () => {
			expect(
				await askToWrite({ state: { allowedWriteFiles: ["docs/**", "*", "**"] }, tool: "appliedDiff" }),
			).toEqual({ decision: "ask" })
		})
	})
})
