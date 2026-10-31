import assert from "node:assert/strict"
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, it } from "node:test"
import { groupAlive } from "./side-process-guard.ts"

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

interface RunOutcome {
	code: number
	stdout: string
	stderr: string
}

// Spawns the real comparison driver with a minimal, credential-free
// environment. The argument gate runs before the trust policy loads, so the
// rejection happens before any worktree, child, or report exists.
const runCompareScript = async (args: string[], env: NodeJS.ProcessEnv): Promise<RunOutcome> => {
	try {
		const { stdout } = await execFileAsync(
			process.execPath,
			["--import", "tsx", path.join(repoRoot, "scripts/agent-evals/coding-compare.mts"), ...args],
			{
				cwd: repoRoot,
				timeout: 120_000,
				killSignal: "SIGKILL",
				env,
			},
		)
		return { code: 0, stdout, stderr: "" }
	} catch (error) {
		const failure = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean }
		if (failure.killed) throw new Error("compare script hung and hit the test kill timer")
		return {
			code: typeof failure.code === "number" ? failure.code : 1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		}
	}
}

const minimalEnv = (): NodeJS.ProcessEnv => ({
	PATH: process.env["PATH"] ?? "/usr/bin:/bin",
	HOME: process.env["HOME"] ?? os.homedir(),
})

describe("coding compare isolation gate", () => {
	it("rejects --allow-unisolated-grading before any worktree or report exists", { timeout: 180_000 }, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-compare-test-"))
		try {
			const trustFile = path.join(dir, "trust-policy.json")
			await fs.writeFile(trustFile, JSON.stringify({ version: 1, approvedCommits: [] }))
			const out = path.join(dir, "out")
			const outcome = await runCompareScript(
				[
					"--baseline",
					"a".repeat(40),
					"--candidate",
					"b".repeat(40),
					"--reps",
					"1",
					"--out",
					out,
					"--trust-file",
					trustFile,
					"--allow-unisolated-grading",
				],
				minimalEnv(),
			)
			assert.notEqual(outcome.code, 0)
			assert.match(outcome.stderr, /--allow-unisolated-grading is not accepted here/)
			// The rejection happens before any report generation exists, so
			// the comparison can never publish host-graded artifacts.
			for (const name of ["comparison-report.json", "comparison-report.md", "comparison-report.complete"]) {
				await assert.rejects(fs.access(path.join(out, name)))
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it(
		"runs past the isolation gate without the flag and fails at the approved-commit check",
		{ timeout: 180_000 },
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-compare-test-"))
			try {
				const trustFile = path.join(dir, "trust-policy.json")
				// The empty policy approves nothing, so the trust gate must reject
				// the run. The placeholder credential only proves the failure is
				// not the credential check; no real credential enters this test.
				await fs.writeFile(trustFile, JSON.stringify({ version: 1, approvedCommits: [] }))
				const out = path.join(dir, "out")
				const env = { ...minimalEnv(), SOLHEIM_API_KEY: "not-a-real-credential" }
				const outcome = await runCompareScript(
					[
						"--baseline",
						"a".repeat(40),
						"--candidate",
						"b".repeat(40),
						"--reps",
						"1",
						"--out",
						out,
						"--trust-file",
						trustFile,
					],
					env,
				)
				assert.notEqual(outcome.code, 0)
				// The failure is the approved-commit gate, not the argument gate.
				assert.doesNotMatch(outcome.stderr, /--allow-unisolated-grading is not accepted here/)
				assert.match(outcome.stderr, /trust policy must list at least one approved commit SHA/)
				// The rejection happens before any report generation exists, so
				// the comparison never publishes anything.
				for (const name of ["comparison-report.json", "comparison-report.md", "comparison-report.complete"]) {
					await assert.rejects(fs.access(path.join(out, name)))
				}
			} finally {
				await fs.rm(dir, { recursive: true, force: true })
			}
		},
	)
})

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitForFile = async (filePath: string, timeoutMs: number): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (
			await fs.access(filePath).then(
				() => true,
				() => false,
			)
		)
			return
		await delay(20)
	}
	throw new Error(`fixture file never appeared: ${filePath}`)
}

// Polls until the group answers ESRCH, so the test proves the group is gone
// instead of hoping the kill landed.
const assertGroupGone = async (groupPid: number): Promise<void> => {
	const deadline = Date.now() + 10_000
	while (Date.now() < deadline) {
		if (!groupAlive(groupPid)) return
		await delay(50)
	}
	throw new Error(`worktree preparation group ${groupPid} survived the driver exit`)
}

interface SignalRun {
	exitCode: number | null
	stderr: string
	scratchParent: string
	worktreeGroupPid: number
}

interface DriverRunOptions {
	// Test seam: bounds the wait for the preparation group's pid file.
	pidFileTimeoutMs?: number
	// Test seam: bounds the wait for the driver exit after the signal.
	exitTimeoutMs?: number
	// Test seam: throws after the preparation group recorded itself, so the
	// failure cleanup runs with a live driver and a live sleeper group.
	failAfterPidFile?: boolean
	// Test seam: reports what the failure cleanup observed, so a test can
	// prove the group kill and the directory removal without holding state
	// the helper already removed.
	onFailureCleanup?: (observed: { scratchParent: string; groupPid: number | undefined }) => void
}

// Reads the group id the shim recorded. Only a plausible group id counts:
// a missing, negative, zero, or tiny value would aim the kill at unrelated
// process groups, so the cleanup skips it instead.
const recordedGroupPid = async (pidFile: string): Promise<number | undefined> => {
	const raw = await fs.readFile(pidFile, "utf8").catch(() => undefined)
	if (raw === undefined) return undefined
	const pid = Number(raw.trim())
	return Number.isInteger(pid) && pid > 1 ? pid : undefined
}

// Terminates the spawned driver and waits for its exit: SIGTERM first, a
// bounded wait, then SIGKILL. The wait proves the process is gone before
// the failure path removes the temporary directory.
const terminateDriver = async (child: ChildProcess): Promise<void> => {
	if (child.exitCode !== null || child.signalCode !== null) return
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
		timer.unref()
		child.once("exit", () => {
			clearTimeout(timer)
			resolve()
		})
		if (!child.kill("SIGTERM")) resolve()
	})
}

// Spawns the real comparison driver with a PATH shim. The shim turns
// `git worktree add` into a detached sleeper that records its group id, so
// the test can aim one signal at the driver alone while a preparation child
// runs. Every other git invocation proxies to the real git, and the trust
// gates pass with the HEAD commit. The credential is a placeholder; nothing
// here contacts a provider.
const runDriverUntilSignal = async (signal: NodeJS.Signals, options: DriverRunOptions = {}): Promise<SignalRun> => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-compare-signal-test-"))
	const pidFile = path.join(dir, "worktree-add-pid")
	let child: ChildProcess | undefined
	try {
		const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
		const shimDir = path.join(dir, "bin")
		await fs.mkdir(shimDir)
		const gitShim = [
			"#!/bin/sh",
			'if [ "$1" = "worktree" ]; then',
			'  if [ "$2" = "add" ]; then',
			'    printf \'%s\\n\' "$$" > "$TMPDIR/worktree-add-pid"',
			"    exec sleep 30",
			"  fi",
			'  if [ "$2" = "remove" ]; then',
			"    exit 0",
			"  fi",
			"fi",
			`exec '${realGit}' "$@"`,
		].join("\n")
		await fs.writeFile(path.join(shimDir, "git"), gitShim, { mode: 0o755 })
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim()
		const trustFile = path.join(dir, "trust-policy.json")
		await fs.writeFile(trustFile, JSON.stringify({ version: 1, approvedCommits: [head] }))
		child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				path.join(repoRoot, "scripts/agent-evals/coding-compare.mts"),
				"--baseline",
				head,
				"--candidate",
				head,
				"--reps",
				"1",
				"--out",
				path.join(dir, "out"),
				"--trust-file",
				trustFile,
			],
			{
				cwd: repoRoot,
				env: {
					PATH: `${shimDir}:${process.env["PATH"] ?? ""}`,
					HOME: process.env["HOME"] ?? os.homedir(),
					TMPDIR: dir,
					SOLHEIM_API_KEY: "not-a-real-credential",
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		)
		let stderr = ""
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString()
		})
		await waitForFile(pidFile, options.pidFileTimeoutMs ?? 60_000)
		if (options.failAfterPidFile) throw new Error("injected failure after the preparation group recorded itself")
		// One signal aimed at the driver alone. The detached preparation group
		// receives nothing from this kill call.
		child.kill(signal)
		const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			const timer = setTimeout(() => {
				child?.kill("SIGKILL")
				reject(new Error(`driver did not exit after ${signal}: ${stderr}`))
			}, options.exitTimeoutMs ?? 60_000)
			child?.once("exit", (code, exitSignal) => {
				clearTimeout(timer)
				resolve({ code, signal: exitSignal })
			})
			child?.once("error", (error) => {
				clearTimeout(timer)
				reject(error)
			})
		})
		const groupPid = Number(await fs.readFile(pidFile, "utf8"))
		return { exitCode: exit.code, stderr, scratchParent: dir, worktreeGroupPid: groupPid }
	} catch (error) {
		// A failure here used to leak both the detached preparation group and
		// the temporary directory. The recorded group dies first, but only
		// when the shim discovered it: an unknown or implausible pid must
		// never aim a negative-pid kill at unrelated groups. The driver is
		// then terminated and waited for, and the directory is removed.
		const groupPid = await recordedGroupPid(pidFile)
		if (groupPid !== undefined) {
			try {
				process.kill(-groupPid, "SIGKILL")
			} catch {
				/* The group already exited. */
			}
		}
		if (child) await terminateDriver(child)
		options.onFailureCleanup?.({ scratchParent: dir, groupPid })
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		throw error
	}
}

describe("compare driver signal exit", () => {
	const expectSignalExit = async (signal: NodeJS.Signals, expectedCode: number): Promise<void> => {
		const run = await runDriverUntilSignal(signal)
		try {
			// The throwing interrupt path exits with the conventional signal
			// code after the cleanup, not with an unhandled-rejection 1.
			assert.equal(run.exitCode, expectedCode)
			// The detached worktree preparation group did not survive.
			await assertGroupGone(run.worktreeGroupPid)
			// The cleanup removed the scratch generation before the exit.
			const leftovers = (await fs.readdir(run.scratchParent)).filter((entry) =>
				entry.startsWith("coding-evals-compare-"),
			)
			assert.deepEqual(leftovers, [])
		} finally {
			await fs.rm(run.scratchParent, { recursive: true, force: true }).catch(() => {})
		}
	}

	it(
		"exits 130 after cleanup when SIGINT reaches the driver during worktree preparation",
		{ timeout: 180_000 },
		async () => {
			await expectSignalExit("SIGINT", 130)
		},
	)

	it(
		"exits 143 after cleanup when SIGTERM reaches the driver during worktree preparation",
		{ timeout: 180_000 },
		async () => {
			await expectSignalExit("SIGTERM", 143)
		},
	)

	it(
		"kills the preparation group and removes the scratch directory when a run fails mid-wait",
		{ timeout: 180_000 },
		async () => {
			let observed: { scratchParent: string; groupPid: number | undefined } | undefined
			await assert.rejects(
				runDriverUntilSignal("SIGINT", {
					failAfterPidFile: true,
					onFailureCleanup: (info) => {
						observed = info
					},
				}),
				/injected failure after the preparation group recorded itself/,
			)
			assert.ok(observed)
			// The shim had discovered its group, so the cleanup had a real
			// group id and the sleeper cannot have survived.
			assert.equal(typeof observed.groupPid, "number")
			await assertGroupGone(observed.groupPid as number)
			// The driver was terminated and waited for before the scratch
			// directory was removed.
			const scratchParentExists = await fs.access(observed.scratchParent).then(
				() => true,
				() => false,
			)
			assert.equal(scratchParentExists, false)
		},
	)
})
