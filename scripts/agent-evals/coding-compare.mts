// Paired comparison driver. Checks out both commits into temporary worktrees,
// runs one coding-evals side per commit with identical repetition counts,
// then writes the JSON and Markdown comparison reports. Both commits must
// contain this framework. The driver is trusted repo code and only runs
// trusted repo commits with the credential.
import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { sideResultFileName, toSideResult, type SideResultFile } from "./coding-compare.ts"
import { buildComparisonReport, renderMarkdownReport } from "./coding-report.ts"

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const readArgs = (): {
	baseline: string
	candidate: string
	reps: number
	out: string
	credentialEnv: string
	allowUnisolatedGrading: boolean
} => {
	const args = process.argv.slice(2)
	const read = (name: string): string | undefined => {
		const index = args.indexOf(`--${name}`)
		return index >= 0 ? args[index + 1] : undefined
	}
	const baseline = read("baseline")
	const candidate = read("candidate")
	const out = read("out")
	if (!baseline || !candidate) throw new Error("Set --baseline and --candidate to commit SHAs")
	if (!out) throw new Error("Set --out to a scratch directory")
	const reps = Number(read("reps") ?? "3")
	if (!Number.isInteger(reps) || reps < 1) throw new Error("--reps must be a positive integer")
	return {
		baseline,
		candidate,
		reps,
		out: path.resolve(out),
		credentialEnv: read("credential-env") ?? "SOLHEIM_API_KEY",
		allowUnisolatedGrading: args.includes("--allow-unisolated-grading"),
	}
}

const runSide = async (
	side: "baseline" | "candidate",
	commit: string,
	inputs: ReturnType<typeof readArgs>,
	scratchDir: string,
): Promise<SideResultFile> => {
	const worktree = path.join(scratchDir, side)
	await execFileAsync("git", ["worktree", "add", "--detach", worktree, commit], { cwd: root, timeout: 120_000 })
	const sideOut = path.join(scratchDir, `${side}-out`)
	await fs.mkdir(sideOut, { recursive: true })
	const exit = await new Promise<number>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"scripts/agent-evals/coding-side.mts",
				"--reps",
				String(inputs.reps),
				"--out",
				sideOut,
				"--credential-env",
				inputs.credentialEnv,
				...(inputs.allowUnisolatedGrading ? ["--allow-unisolated-grading"] : []),
			],
			{
				cwd: worktree,
				env: { ...process.env, CODING_EVALS_SIDE: side },
				stdio: "inherit",
			},
		)
		child.once("error", reject)
		child.once("exit", (code) => resolve(code ?? 1))
	})
	if (exit !== 0) throw new Error(`${side} side failed with exit code ${exit}`)
	return JSON.parse(await fs.readFile(path.join(sideOut, sideResultFileName(side)), "utf8")) as SideResultFile
}

const inputs = readArgs()
const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-evals-compare-"))
await fs.mkdir(inputs.out, { recursive: true })
try {
	const report = buildComparisonReport({
		baseline: toSideResult(await runSide("baseline", inputs.baseline, inputs, scratchDir)),
		candidate: toSideResult(await runSide("candidate", inputs.candidate, inputs, scratchDir)),
		repetitions: inputs.reps,
	})
	await fs.writeFile(path.join(inputs.out, "comparison-report.json"), JSON.stringify(report, null, 2))
	await fs.writeFile(path.join(inputs.out, "comparison-report.md"), renderMarkdownReport(report))
	console.log(
		report.compatibility.compatible
			? `comparison complete: compatible pair, report in ${inputs.out}`
			: `comparison complete: INCOMPATIBLE pair (${report.compatibility.differences.join(", ")}), report in ${inputs.out}`,
	)
} finally {
	await execFileAsync("git", ["worktree", "remove", "--force", path.join(scratchDir, "baseline")], {
		cwd: root,
		timeout: 30_000,
	}).catch(() => {})
	await execFileAsync("git", ["worktree", "remove", "--force", path.join(scratchDir, "candidate")], {
		cwd: root,
		timeout: 30_000,
	}).catch(() => {})
	await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {})
}
