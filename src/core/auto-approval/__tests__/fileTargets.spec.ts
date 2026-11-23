import * as fs from "fs/promises"

import type { ClineSayTool } from "@roo-code/types"

import type { ApprovalFileTarget } from "../../../shared/tools"
import { checkAutoApproval } from "../index"
import { baseState, CWD, type State } from "./fixtures"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, realpath: vi.fn() }
})

const inside = (relativePath: string): ApprovalFileTarget => ({
	absolutePath: `${CWD}/${relativePath}`,
	isOutsideWorkspace: false,
})

function approval(tool: ClineSayTool, state: Partial<State>, fileTargets?: readonly ApprovalFileTarget[]) {
	return checkAutoApproval({
		state: { ...baseState, ...state },
		cwd: CWD,
		ask: "tool",
		text: JSON.stringify(tool),
		fileTargets,
	})
}

beforeEach(() => {
	vi.mocked(fs.realpath).mockReset().mockResolvedValue(CWD)
})

describe("file targets decide allowlist matches", () => {
	it.each([
		{ tool: "readFile", setting: "allowedReadFiles" },
		{ tool: "readFile", setting: "allowedWriteFiles" },
		{ tool: "editedExistingFile", setting: "allowedWriteFiles" },
		{ tool: "newFileCreated", setting: "allowedWriteFiles" },
	] as const)("matches $tool targets, not display paths, through $setting", async ({ tool, setting }) => {
		const state = { [setting]: ["docs/**"] }
		const message: ClineSayTool = { tool, path: "docs/notes.md" }

		expect(await approval(message, state, [inside("docs/notes.md")])).toEqual({ decision: "approve" })
		expect(await approval(message, state, [inside("src/notes.md")])).toEqual({ decision: "ask" })
		expect(await approval({ tool, path: "src/notes.md" }, state, [inside("docs/notes.md")])).toEqual({
			decision: "approve",
		})
	})

	it.skipIf(process.platform === "win32")(
		"asks for a POSIX file whose backslash the display path turned into a separator",
		async () => {
			// getReadablePath(CWD, "my\\file") displays the single file `my\file` as `my/file`.
			const message: ClineSayTool = { tool: "editedExistingFile", path: "my/file" }
			const state = { allowedWriteFiles: ["my/**"] }

			expect(await approval(message, state)).toEqual({ decision: "approve" })
			expect(await approval(message, state, [inside("my\\file")])).toEqual({ decision: "ask" })
			expect(await approval(message, { allowedWriteFiles: ["my\\\\file"] }, [inside("my\\file")])).toEqual({
				decision: "approve",
			})
		},
	)

	it("requires every batch target to match", async () => {
		const message: ClineSayTool = {
			tool: "readFile",
			batchFiles: [
				{ path: "docs/a.md", lineSnippet: "", key: "a" },
				{ path: "docs/b.md", lineSnippet: "", key: "b" },
			],
		}
		const state = { allowedReadFiles: ["docs/**"] }

		expect(await approval(message, state, [inside("docs/a.md"), inside("docs/b.md")])).toEqual({
			decision: "approve",
		})
		expect(await approval(message, state, [inside("docs/a.md"), inside("secret/b.md")])).toEqual({
			decision: "ask",
		})
	})
})

describe("invalid or incomplete file targets ask the user", () => {
	const message: ClineSayTool = { tool: "readFile", path: "docs/notes.md" }
	// Every permission that could otherwise approve this read is on.
	const permissive = {
		alwaysAllowReadOnly: true,
		alwaysAllowReadOnlyOutsideWorkspace: true,
		allowedReadFiles: ["**"],
	}

	it("approves the same read with a valid target", async () => {
		expect(await approval(message, permissive, [inside("docs/notes.md")])).toEqual({ decision: "approve" })
	})

	it.each([
		{ name: "no targets", fileTargets: [] },
		{ name: "a relative target", fileTargets: [{ absolutePath: "docs/notes.md", isOutsideWorkspace: false }] },
		{ name: "an empty target", fileTargets: [{ absolutePath: "", isOutsideWorkspace: false }] },
		{ name: "more targets than named files", fileTargets: [inside("docs/notes.md"), inside("docs/other.md")] },
	])("asks for $name", async ({ fileTargets }) => {
		expect(await approval(message, permissive, fileTargets)).toEqual({ decision: "ask" })
	})

	it.each([
		{ name: "a workspace verdict", target: { absolutePath: `${CWD}/docs/notes.md` } },
		{ name: "a path", target: { isOutsideWorkspace: false } },
	])("asks for a target without $name", async ({ target }) => {
		// Stands in for a malformed target from a caller outside the type system.
		const malformed = [target] as unknown as ApprovalFileTarget[]

		expect(await approval(message, permissive, malformed)).toEqual({ decision: "ask" })
	})

	it.each([null, undefined])("asks for a %s target", async (target) => {
		// Stands in for a malformed target from a caller outside the type system.
		const malformed = [target] as unknown as ApprovalFileTarget[]

		expect(await approval(message, permissive, malformed)).toEqual({ decision: "ask" })
	})

	it("asks when only some batch targets are invalid", async () => {
		const batch: ClineSayTool = {
			tool: "readFile",
			batchFiles: [
				{ path: "docs/a.md", lineSnippet: "", key: "a" },
				{ path: "docs/b.md", lineSnippet: "", key: "b" },
			],
		}
		const relative = { absolutePath: "docs/b.md", isOutsideWorkspace: false }

		expect(await approval(batch, permissive, [inside("docs/a.md"), relative])).toEqual({ decision: "ask" })
	})

	it.skipIf(process.platform === "win32")("asks for a Windows drive path, which is relative on POSIX", async () => {
		const drivePath = { absolutePath: "C:\\repo\\docs\\notes.md", isOutsideWorkspace: false }

		expect(await approval(message, permissive, [drivePath])).toEqual({ decision: "ask" })
	})

	it("asks when the message names more files than the targets cover", async () => {
		const batch: ClineSayTool = {
			tool: "readFile",
			batchFiles: [
				{ path: "docs/a.md", lineSnippet: "", key: "a" },
				{ path: "docs/b.md", lineSnippet: "", key: "b" },
			],
		}

		expect(await approval(batch, permissive, [inside("docs/a.md")])).toEqual({ decision: "ask" })
		expect(await approval({ ...message, additionalFileCount: 1 }, permissive, [inside("docs/notes.md")])).toEqual({
			decision: "ask",
		})
	})
})

describe("file targets decide workspace containment", () => {
	const outside: ApprovalFileTarget = { absolutePath: "/elsewhere/notes.md", isOutsideWorkspace: true }

	it.each([
		{ tool: "readFile", allow: "alwaysAllowReadOnly", outsideAllow: "alwaysAllowReadOnlyOutsideWorkspace" },
		{ tool: "editedExistingFile", allow: "alwaysAllowWrite", outsideAllow: "alwaysAllowWriteOutsideWorkspace" },
	] as const)("uses the target verdict over the message for $tool", async ({ tool, allow, outsideAllow }) => {
		const message: ClineSayTool = { tool, path: "notes.md", isOutsideWorkspace: false }

		expect(await approval(message, { [allow]: true }, [inside("notes.md")])).toEqual({ decision: "approve" })
		expect(await approval(message, { [allow]: true }, [outside])).toEqual({ decision: "ask" })
		expect(await approval(message, { [allow]: true, [outsideAllow]: true }, [outside])).toEqual({
			decision: "approve",
		})
	})

	it("treats a batch as outside the workspace when any target is", async () => {
		// Batch messages flag containment per file only, never at the top level.
		const message: ClineSayTool = {
			tool: "readFile",
			batchFiles: [
				{ path: "docs/a.md", lineSnippet: "", key: "a", isOutsideWorkspace: false },
				{ path: "/elsewhere/notes.md", lineSnippet: "", key: "b", isOutsideWorkspace: true },
			],
		}

		expect(await approval(message, { alwaysAllowReadOnly: true }, [inside("docs/a.md"), outside])).toEqual({
			decision: "ask",
		})
	})
})

describe("read asks without file targets", () => {
	it("match display paths lexically, without resolving the canonical workspace root", async () => {
		vi.mocked(fs.realpath).mockResolvedValue("/storage/repo")
		const state = { allowedReadFiles: ["docs/**"] }

		expect(await approval({ tool: "readFile", path: "docs/notes.md" }, state)).toEqual({ decision: "approve" })
		expect(await approval({ tool: "readFile", path: "/storage/repo/docs/notes.md" }, state)).toEqual({
			decision: "ask",
		})
		expect(fs.realpath).not.toHaveBeenCalled()

		expect(
			await approval({ tool: "readFile", path: "notes.md" }, state, [
				{ absolutePath: "/storage/repo/docs/notes.md", isOutsideWorkspace: true },
			]),
		).toEqual({ decision: "approve" })
	})
})
