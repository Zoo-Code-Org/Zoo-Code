import fs from "node:fs/promises"
import path from "node:path"
import { validateWorkspaceFilePath, type AgentFixture, type AgentFixtureWorkspaceFile } from "./contract.ts"
import { digestValue } from "./coding-digest.ts"

// Immutable initial-state digest. The digest pins the exact fixture workspace
// content, so every run of the same fixture version rebuilds byte-identical
// initial state and any fixture edit changes the pinned suite digest.
export function initialStateDigest(fixture: AgentFixture): string {
	const sorted = [...fixture.workspace.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
	return digestValue({ kind: "agent-evals-initial-workspace-v1", files: sorted })
}

// Builds the fixture workspace in a fresh directory. The directory must not
// exist yet, so no run can inherit files from an earlier run.
export async function buildFreshWorkspace(fixture: AgentFixture, targetDir: string): Promise<{ filesWritten: number }> {
	await fs.mkdir(targetDir, { recursive: false })
	let filesWritten = 0
	for (const file of fixture.workspace.files) {
		await writeContainedFile(targetDir, file)
		filesWritten++
	}
	return { filesWritten }
}

// Writes one file inside root. The containment check mirrors the launcher's
// write-time check so grader-side copies cannot be tricked into escaping.
export async function writeContainedFile(root: string, file: AgentFixtureWorkspaceFile): Promise<void> {
	validateWorkspaceFilePath(file.path)
	const rootReal = await fs.realpath(root)
	const target = path.resolve(rootReal, file.path)
	if (target !== rootReal && !target.startsWith(rootReal + path.sep))
		throw new Error("workspace file path escapes the workspace")
	await fs.mkdir(path.dirname(target), { recursive: true })
	await fs.writeFile(target, file.content)
	const written = await fs.realpath(target)
	if (!written.startsWith(rootReal + path.sep)) throw new Error("workspace file escapes the workspace")
}

// Builds a fresh grading copy of a final workspace. Hidden acceptance tests
// are added only to the copy, never to the workspace the agent used.
export async function buildGradingCopy(
	finalFiles: readonly AgentFixtureWorkspaceFile[],
	hiddenTests: readonly AgentFixtureWorkspaceFile[],
	targetDir: string,
): Promise<void> {
	await fs.mkdir(targetDir, { recursive: false })
	for (const file of [...finalFiles, ...hiddenTests]) await writeContainedFile(targetDir, file)
}
