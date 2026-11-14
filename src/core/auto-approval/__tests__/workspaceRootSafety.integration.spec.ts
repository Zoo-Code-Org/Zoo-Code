import * as fs from "fs/promises"
import os from "os"
import path from "path"
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
