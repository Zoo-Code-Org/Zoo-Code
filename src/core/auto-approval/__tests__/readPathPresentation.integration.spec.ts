import * as fs from "fs/promises"
import os from "os"
import path from "path"
import type { ClineSayTool } from "@roo-code/types"
import { getReadablePath } from "../../../utils/path"
import { checkAutoApproval } from "../index"
import { baseState } from "./fixtures"

const SETTINGS = ["allowedReadFiles", "allowedWriteFiles"] as const
const SHAPES = ["single", "batch"] as const
let temp: string

beforeEach(async () => {
	temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "zoo-read-path-")))
})

afterEach(async () => {
	await fs.rm(temp, { recursive: true, force: true })
})

async function createWorkspace(aliasName = "alias") {
	const canonicalRoot = path.join(temp, "real", "repo")
	const cwd = path.join(temp, aliasName)
	const inside = path.join(canonicalRoot, "docs", "notes.md")
	const other = path.join(canonicalRoot, "docs", "other.md")
	await fs.mkdir(path.dirname(inside), { recursive: true })
	await fs.writeFile(inside, "workspace notes")
	await fs.writeFile(other, "other workspace notes")
	// Junctions exercise native Windows paths without requiring symlink privileges.
	await fs.symlink(canonicalRoot, cwd, "junction")
	return { cwd, canonicalRoot, inside, other }
}

function readMessage(cwd: string, targets: [string, ...string[]]): ClineSayTool {
	if (targets.length === 1) {
		return {
			tool: "readFile",
			path: getReadablePath(cwd, targets[0]),
			content: path.resolve(cwd, targets[0]),
			isOutsideWorkspace: true,
		}
	}

	return {
		tool: "readFile",
		batchFiles: targets.map((target) => ({
			path: getReadablePath(cwd, target),
			content: path.resolve(cwd, target),
			lineSnippet: "",
			key: target,
			isOutsideWorkspace: true,
		})),
	}
}

function approval(cwd: string, tool: ClineSayTool, setting: (typeof SETTINGS)[number], patterns: string[]) {
	return checkAutoApproval({
		cwd,
		state: { ...baseState, [setting]: patterns },
		ask: "tool",
		text: JSON.stringify(tool),
	})
}

describe.each(SETTINGS)("read path presentation through %s", (setting) => {
	it.skipIf(process.platform === "win32").each(SHAPES)(
		"does not extend canonical grants through a lossy POSIX %s read path",
		async (shape) => {
			const { cwd, canonicalRoot, inside } = await createWorkspace()
			const outside = path.join(temp, "real\\repo", "docs", "secret.md")
			await fs.mkdir(path.dirname(outside), { recursive: true })
			await fs.writeFile(outside, "outside workspace secret")

			const displayPath = getReadablePath(cwd, outside)
			expect(displayPath).toBe(path.join(canonicalRoot, "docs", "secret.md"))
			expect(await fs.readFile(path.resolve(cwd, outside), "utf8")).toBe("outside workspace secret")
			const tool = readMessage(cwd, shape === "single" ? [outside] : [inside, outside])

			expect(await approval(cwd, tool, setting, ["docs/**"])).toEqual({ decision: "ask" })
			// Contain the new canonical grant without changing existing lexical grants.
			expect(await approval(cwd, tool, setting, [`${canonicalRoot}/docs/**`])).toEqual({ decision: "approve" })
		},
	)

	it.each(SHAPES)("preserves ordinary canonical %s reads with native targets", async (shape) => {
		const { cwd, inside, other } = await createWorkspace()
		if (process.platform === "win32") expect(inside).toContain("\\")
		const tool = readMessage(cwd, shape === "single" ? [inside] : [inside, other])
		expect(await approval(cwd, tool, setting, ["docs/**"])).toEqual({ decision: "approve" })
	})

	it.skipIf(process.platform === "win32")(
		"allows a faithful relative display under a POSIX backslash root",
		async () => {
			const { cwd, canonicalRoot } = await createWorkspace("alias\\name")
			const target = path.join(cwd, "docs", "notes.md")
			const tool = readMessage(cwd, [target])
			expect(tool.path).toBe("docs/notes.md")
			expect(tool.content).toContain("\\")
			expect(await approval(cwd, tool, setting, [`${canonicalRoot}/docs/**`])).toEqual({ decision: "approve" })
		},
	)
})
