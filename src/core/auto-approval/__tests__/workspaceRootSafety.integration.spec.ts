import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { getReadablePath } from "../../../utils/path"
import { checkAutoApproval } from "../index"
import { baseState } from "./fixtures"

it("keeps permissions and wildcard exclusions scoped to a real symlinked workspace", async () => {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-workspace-approval-"))
	try {
		const canonicalRoot = path.join(temp, "storage", "project[1]")
		const lexicalParent = path.join(temp, "aliases")
		const cwd = path.join(lexicalParent, "project")
		const inside = path.join(canonicalRoot, "docs", "private.md")
		const outside = path.join(temp, "storage", "project1", "docs", "private.md")
		await fs.mkdir(path.dirname(inside), { recursive: true })
		await fs.mkdir(path.dirname(outside), { recursive: true })
		await fs.mkdir(lexicalParent)
		await fs.writeFile(inside, "allowed workspace")
		await fs.writeFile(outside, "unrelated workspace")
		// A directory junction also works on Windows without symlink privileges.
		await fs.symlink(canonicalRoot, cwd, "junction")

		const approval = async (filePath: string, patterns: string[]) =>
			checkAutoApproval({
				cwd,
				state: { ...baseState, allowedReadFiles: patterns },
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", path: filePath, isOutsideWorkspace: true }),
			})
		const canonicalInside = await fs.realpath(inside)
		const canonicalOutside = await fs.realpath(outside)
		expect(await approval(canonicalInside, ["docs/**"])).toEqual({ decision: "approve" })
		expect(await approval(canonicalOutside, ["docs/**"])).toEqual({ decision: "ask" })
		const exclusion = `!${lexicalParent}/**/private.md`
		expect(await approval(canonicalInside, ["docs/**", exclusion])).toEqual({ decision: "ask" })
		expect(await approval("docs/private.md", ["docs/**", exclusion])).toEqual({ decision: "ask" })
		expect(await approval(canonicalInside, [exclusion, "docs/**"])).toEqual({ decision: "approve" })
	} finally {
		await fs.rm(temp, { recursive: true, force: true })
	}
})

it("checks root identity after the same parent normalization used by file reads", async () => {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-workspace-parent-approval-"))
	try {
		const canonicalTemp = await fs.realpath(temp)
		const lexicalRoot = path.join(canonicalTemp, "lexical")
		const targetRoot = path.join(canonicalTemp, "target")
		const targetChild = path.join(targetRoot, "child")
		const link = path.join(lexicalRoot, "link")
		const relativePath = path.join("docs", "private.md")
		await fs.mkdir(path.join(lexicalRoot, "docs"), { recursive: true })
		await fs.mkdir(path.join(targetRoot, "docs"), { recursive: true })
		await fs.mkdir(targetChild)
		await fs.writeFile(path.join(lexicalRoot, relativePath), "lexical file")
		await fs.writeFile(path.join(targetRoot, relativePath), "different target file")
		await fs.symlink(targetChild, link, "junction")

		// Preserve the parent segment until the same path.resolve used by the reader.
		// Native realpath may follow the link first and identify a different root.
		const cwd = `${link}${path.sep}..`
		const readPath = path.resolve(cwd, relativePath)
		const toolPath = getReadablePath(cwd, relativePath)
		expect(await fs.readFile(readPath, "utf8")).toBe("lexical file")
		expect(await fs.readFile(path.join(targetRoot, relativePath), "utf8")).toBe("different target file")

		const approval = (patterns: string[]) =>
			checkAutoApproval({
				cwd,
				state: { ...baseState, allowedReadFiles: patterns },
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", path: toolPath, isOutsideWorkspace: true }),
			})
		expect(await approval([`${targetRoot}/docs/**`])).toEqual({ decision: "ask" })
		expect(await approval([`${lexicalRoot}/docs/**`])).toEqual({ decision: "approve" })
		expect(await approval(["docs/**"])).toEqual({ decision: "approve" })
	} finally {
		await fs.rm(temp, { recursive: true, force: true })
	}
})
