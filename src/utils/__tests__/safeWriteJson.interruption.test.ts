import { spawn, spawnSync, type ChildProcess } from "child_process"
import { createRequire } from "module"
import { fileURLToPath } from "url"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { safeWriteJson } from "../safeWriteJson"
import { readFileWithMissingRetry } from "../../core/task-persistence/readFileWithMissingRetry"
import { TaskHistoryStore } from "../../core/task-persistence/TaskHistoryStore"
import { readTaskMessages } from "../../core/task-persistence/taskMessages"
import { readApiMessages } from "../../core/task-persistence/apiMessages"

vi.mock("../storage", () => ({
	getStorageBasePath: (defaultPath: string) => defaultPath,
	getTaskDirectoryPath: async (base: string, taskId: string) => path.join(base, "tasks", taskId),
}))

const requireFromTest = createRequire(import.meta.url)
const esbuildPath = requireFromTest.resolve("esbuild")
const safeWriteJsonEntryPath = fileURLToPath(new URL("../safeWriteJson.ts", import.meta.url))

// The child performs a real safeWriteJson from this repository. The source is
// bundled to CommonJS at child startup, so the bundle's require("fs/promises")
// resolves to the same exports object the script patched above, and the
// patched rename is the one the writer actually calls.
const CHILD_SCRIPT = `"use strict"
const fs = require("fs")
const path = require("path")

const targetPath = path.resolve(process.env.INTERRUPTION_TARGET_PATH)
// The commit goes through safeWriteText, which renames onto the publish target it resolved
// itself. One directory answers to two spellings on NTFS - every component longer than eight
// characters also has an 8.3 alias, so the CI runner's temp directory arrives short-named
// (RUNNER~1 under the user profile) while realpath hands back the long spelling of the same
// directory - and a junction or a link does the same thing on any box. The writer's canonical
// handed to this child can therefore name the same file as different text, and a textual
// comparison would then let the commit land unnoticed. Canonicalise this side the same way,
// and fall back to the textual form for a target that does not exist yet and cannot be
// canonicalised.
const identityOf = (entry) => {
	try {
		const stat = fs.statSync(entry, { bigint: true })
		return stat.dev + ":" + stat.ino
	} catch {
		return null
	}
}
const sameEntry = (candidate, expected) => {
	const resolved = path.resolve(String(candidate))
	const wanted = path.resolve(String(expected))
	if (resolved === wanted) {
		return true
	}
	if (process.platform === "win32" && resolved.toLowerCase() === wanted.toLowerCase()) {
		return true
	}
	const candidateIdentity = identityOf(resolved)
	const wantedIdentity = identityOf(wanted)
	if (candidateIdentity !== null && wantedIdentity !== null && candidateIdentity === wantedIdentity) {
		return true
	}
	// A destination that is not on disk yet has no identity of its own, so compare the directory it
	// would land in and the name it would land under: same directory identity and same basename is
	// the same file, whatever spelling either side used.
	const candidateName = path.basename(resolved)
	const wantedName = path.basename(wanted)
	if (
		process.platform === "win32"
			? candidateName.toLowerCase() !== wantedName.toLowerCase()
			: candidateName !== wantedName
	) {
		return false
	}
	const candidateDirIdentity = identityOf(path.dirname(resolved))
	const wantedDirIdentity = identityOf(path.dirname(wanted))
	return (
		candidateDirIdentity !== null && wantedDirIdentity !== null && candidateDirIdentity === wantedDirIdentity
	)
}
// Text and fs.realpath cannot decide this one. On the hosted Windows runner one directory answers
// under two spellings and the canonicaliser hands back the short form for the profile component
// (RUNNER~1), so the writer's canonical destination and the parent's canonical target are different
// text for one file. Measured here: realpath returns whichever spelling it is handed while fs.stat
// reports a single identity for both; measured on the runner: the staging guard reported the long
// spelling expected against a short got for the same directory. Identity is the only spelling both
// sides agree on, so the interception decision is taken on identity.
const isCommitRename = (newPath) => sameEntry(newPath, targetPath)
const fsPromises = require("fs/promises")
const actualRename = fsPromises.rename

// Fault injection: hard-kill before the replacement lands. Any rename
// whose destination is the canonical path (or an alias of it) is the commit step, whatever
// replacement protocol the writer uses; exit before performing it.
let commitAttempts = 0
fsPromises.rename = async function interruptionRename(oldPath, newPath) {
	if (isCommitRename(newPath)) {
		commitAttempts++
		if (process.env.INTERRUPTION_MODE === "fallback" && commitAttempts === 1) {
			return Promise.reject(Object.assign(new Error("Injected EPERM"), { code: "EPERM" }))
		}
		if (process.env.INTERRUPTION_BOUNDARY === "after-commit") {
			await actualRename.apply(fsPromises, arguments)
		}
		fs.writeSync(1, "EXIT_AT_REPLACEMENT_RENAME\\n")
		process.kill(process.pid, "SIGKILL")
	}
	return actualRename.apply(fsPromises, arguments)
}

// Matcher self-check mode: answer the interception decision for candidates handed in from the
// parent, without building or writing anything. This is how the alias decisions are pinned by a
// test on a real second spelling instead of being trusted to a platform that cannot show one.
if (process.env.INTERRUPTION_MODE === "matcher") {
	const cases = JSON.parse(process.env.INTERRUPTION_MATCHER_CASES || "[]")
	for (const testCase of cases) {
		fs.writeSync(1, "MATCH " + testCase.label + "=" + isCommitRename(testCase.candidate) + String.fromCharCode(10))
	}
	process.exit(0)
}

require(process.env.ESBUILD_PATH).buildSync({
	entryPoints: [process.env.SAFE_WRITE_JSON_ENTRY],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node22",
	outfile: process.env.INTERRUPTION_BUNDLE_PATH,
	logLevel: "silent",
})

const payload = JSON.parse(process.env.INTERRUPTION_PAYLOAD)
require(process.env.INTERRUPTION_BUNDLE_PATH)
	.safeWriteJson(targetPath, payload)
	.then(() => {
		fs.writeSync(1, "WRITE_COMPLETED\\n")
		process.exit(0)
	})
	.catch((error) => {
		fs.writeSync(2, "WRITE_FAILED: " + ((error && error.message) || String(error)) + "\\n")
		process.exit(1)
	})
`

async function waitForChildExit(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const stdoutChunks: Buffer[] = []
	const stderrChunks: Buffer[] = []
	child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
	child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL")
			reject(new Error("Interruption child did not exit within 20 seconds"))
		}, 20_000)
		child.once("error", reject)
		child.once("close", (code) => {
			clearTimeout(timeout)
			resolve({
				code,
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
			})
		})
	})
}

describe("safeWriteJson subprocess interruption fault injection", () => {
	let tempDir: string
	let storageDir: string
	let childDir: string
	let targetPath: string
	let childScriptPath: string
	let childBundlePath: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-interruption-"))
		storageDir = path.join(tempDir, "tasks", "restart-task")
		childDir = path.join(tempDir, "child")
		await fs.mkdir(storageDir, { recursive: true })
		await fs.mkdir(childDir)
		targetPath = path.join(storageDir, "ui_messages.json")
		childScriptPath = path.join(childDir, "interrupted-writer.cjs")
		childBundlePath = path.join(childDir, "safeWriteJson.bundle.cjs")
		await fs.writeFile(childScriptPath, CHILD_SCRIPT, "utf8")
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it.each([
		...(["ui_messages.json", "api_conversation_history.json", "history_item.json"] as const).flatMap((fileName) =>
			(["atomic", "fallback"] as const).flatMap((mode) =>
				(["before-commit", "after-commit"] as const).map((boundary) => ({
					fileName,
					mode,
					boundary,
					ageLock: true,
				})),
			),
		),
	])(
		"recovers $fileName after $mode interruption $boundary without another write (age lock: $ageLock)",
		async ({ fileName, mode, boundary, ageLock }) => {
			targetPath = path.join(storageDir, fileName)
			// A previously committed write contains the restart marker.
			const historyItem = {
				id: "restart-task",
				number: 1,
				ts: 1,
				task: "RESTART_PERSISTENCE_MARKER",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "completed",
			}
			const message = {
				ts: 1,
				type: "say",
				say: "text",
				text: "RESTART_PERSISTENCE_MARKER",
				role: "assistant",
				content: "RESTART_PERSISTENCE_MARKER",
			}
			const committed = fileName === "history_item.json" ? historyItem : [message]
			const replacement =
				fileName === "history_item.json"
					? { ...historyItem, ts: 2, task: `INTERRUPTED_WRITE_${mode}` }
					: [{ ...message, ts: 2, text: `INTERRUPTED_WRITE_${mode}`, content: `INTERRUPTED_WRITE_${mode}` }]
			await safeWriteJson(targetPath, committed)

			// The condition introduced by the previous fix: the committed
			// content is readable before the interrupted write starts.
			const before = await readFileWithMissingRetry(targetPath)
			expect(before).toContain("RESTART_PERSISTENCE_MARKER")

			// A real child process writes the same path and terminates right
			// before the replacement rename, mirroring the reported crash
			// window between the two renames of the old protocol.
			const child = spawn(process.execPath, [childScriptPath], {
				env: {
					...process.env,
					INTERRUPTION_TARGET_PATH: targetPath,
					INTERRUPTION_MODE: mode,
					INTERRUPTION_BOUNDARY: boundary,
					INTERRUPTION_PAYLOAD: JSON.stringify(replacement),
					ESBUILD_PATH: esbuildPath,
					SAFE_WRITE_JSON_ENTRY: safeWriteJsonEntryPath,
					INTERRUPTION_BUNDLE_PATH: childBundlePath,
				},
				stdio: ["ignore", "pipe", "pipe"],
			})
			const exit = await waitForChildExit(child)

			expect(exit.stdout).toContain("EXIT_AT_REPLACEMENT_RENAME")
			expect(exit.stdout).not.toContain("WRITE_COMPLETED")
			expect(exit.stderr).not.toContain("WRITE_FAILED")
			// Windows emulates SIGKILL with exit code 1; POSIX reports a signal exit with no code.
			expect(exit.code).toBe(process.platform === "win32" ? 1 : null)

			// Atomic replacement retains the canonical file; the two-step
			// fallback retains committed content in its backup until recovery.
			const interruptedFiles = await fs.readdir(storageDir)
			expect(interruptedFiles.filter((entry) => entry.includes(".new_"))).toHaveLength(
				boundary === "before-commit" ? 1 : 0,
			)
			if (mode === "fallback" && boundary === "before-commit") {
				await expect(fs.readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" })
				const backups = interruptedFiles.filter((entry) => entry.includes(".bak_"))
				expect(backups).toHaveLength(1)
				expect(JSON.parse(await fs.readFile(path.join(storageDir, backups[0]), "utf8"))).toEqual(committed)
			}

			// SIGKILL leaves the lock behind. Age it to exercise real stale-lock
			// acquisition without making the test wait through the stale window.
			const staleTime = new Date(Date.now() - 60_000)
			if (ageLock) await fs.utimes(`${targetPath}.lock`, staleTime, staleTime)
			const expected = boundary === "before-commit" ? committed : replacement
			// Fresh startup must discover a missing history record before any writer runs.
			if (fileName === "history_item.json") {
				const store = new TaskHistoryStore(tempDir)
				try {
					await store.initialize()
					expect(store.get("restart-task")).toEqual(expected)
				} finally {
					store.dispose()
				}
			} else if (fileName === "ui_messages.json") {
				expect(await readTaskMessages({ taskId: "restart-task", globalStoragePath: tempDir })).toEqual(expected)
			} else {
				expect(await readApiMessages({ taskId: "restart-task", globalStoragePath: tempDir })).toEqual(expected)
			}
			expect(JSON.parse(await readFileWithMissingRetry(targetPath))).toEqual(expected)
			const recovered = { ui_messages: [{ ts: 3, type: "say", text: "RECOVERED_AFTER_RESTART" }] }
			await safeWriteJson(targetPath, recovered, {
				merge: (existing, incoming) => {
					expect(existing).toEqual(expected)
					return incoming
				},
			})

			expect(JSON.parse(await readFileWithMissingRetry(targetPath))).toEqual(recovered)
			const leftovers = (await fs.readdir(storageDir)).filter(
				(entry) => entry.includes(".new_") || entry.includes(".bak_"),
			)
			expect(leftovers).toEqual([])
		},
		45_000,
	)

	// The child intercepts the commit rename by comparing the rename's destination with
	// INTERRUPTION_TARGET_PATH. The commit now goes through safeWriteText, which renames onto the
	// publish target it resolved itself, so the destination is not necessarily the spelling the
	// parent passed down. On NTFS one directory answers to two spellings: every component longer
	// than eight characters also has an 8.3 alias, and the Windows CI runner's temp directory
	// arrives as C:\Users\RUNNER~1\... while realpath hands back C:\Users\runneradmin\... The
	// interception has to survive that. A junction gives any Windows box the same shape without
	// needing privileges: this case spells the target through an alias of the directory the
	// writer resolves to, so the parent's spelling and the writer's canonical spelling of the same
	// directory differ as text on a box that has no 8.3 alias on its own temp path.
	it.runIf(process.platform === "win32")(
		"intercepts the commit rename when the target path is spelled through a directory alias",
		async () => {
			const fileName = "ui_messages.json"
			const message = {
				ts: 1,
				type: "say",
				say: "text",
				text: "RESTART_PERSISTENCE_MARKER",
				role: "assistant",
				content: "RESTART_PERSISTENCE_MARKER",
			}
			const committed = [message]
			const replacement = [{ ...message, ts: 2, text: "ALIASED_WRITE", content: "ALIASED_WRITE" }]
			await safeWriteJson(targetPath, committed)

			const aliasDir = path.join(tempDir, "storage-alias")
			try {
				await fs.symlink(storageDir, aliasDir, "junction")
			} catch (error: unknown) {
				const code = typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined
				// A box that cannot create a junction cannot present a second spelling of the
				// directory; there is nothing to intercept differently and no alias to reject.
				if (code === "EPERM" || code === "ENOSYS" || code === "EEXIST") {
					return
				}
				throw error
			}
			const aliasTargetPath = path.join(aliasDir, fileName)
			expect(path.resolve(aliasTargetPath)).not.toBe(path.resolve(targetPath))

			const child = spawn(process.execPath, [childScriptPath], {
				env: {
					...process.env,
					INTERRUPTION_TARGET_PATH: aliasTargetPath,
					INTERRUPTION_MODE: "atomic",
					INTERRUPTION_BOUNDARY: "before-commit",
					INTERRUPTION_PAYLOAD: JSON.stringify(replacement),
					ESBUILD_PATH: esbuildPath,
					SAFE_WRITE_JSON_ENTRY: safeWriteJsonEntryPath,
					INTERRUPTION_BUNDLE_PATH: childBundlePath,
				},
				stdio: ["ignore", "pipe", "pipe"],
			})
			const exit = await waitForChildExit(child)

			expect(exit.stderr).not.toContain("WRITE_FAILED")
			expect(exit.stdout).toContain("EXIT_AT_REPLACEMENT_RENAME")
			expect(exit.stdout).not.toContain("WRITE_COMPLETED")
			expect(exit.code).toBe(1)
			// The canonical target is untouched by an interrupted commit, spelled through either name.
			expect(JSON.parse(await readFileWithMissingRetry(targetPath))).toEqual(committed)
			expect(JSON.parse(await readFileWithMissingRetry(aliasTargetPath))).toEqual(committed)
			const interruptedFiles = await fs.readdir(storageDir)
			expect(interruptedFiles.filter((entry) => entry.includes(".new_"))).toHaveLength(1)

			const staleTime = new Date(Date.now() - 60_000)
			await fs.utimes(`${targetPath}.lock`, staleTime, staleTime)
			const recovered = { ui_messages: [{ ts: 3, type: "say", text: "RECOVERED_AFTER_RESTART" }] }
			await safeWriteJson(aliasTargetPath, recovered)
			expect(JSON.parse(await readFileWithMissingRetry(targetPath))).toEqual(recovered)
			const leftovers = (await fs.readdir(storageDir)).filter(
				(entry) => entry.includes(".new_") || entry.includes(".bak_"),
			)
			expect(leftovers).toEqual([])
		},
		45_000,
	)

	// The interception decision, taken on a directory that answers to two spellings. The
	// writer hands the child hook the spelling its own canonicalisation produced, and on the hosted
	// Windows runner that spelling is the 8.3 alias of the directory the parent created, so the hook
	// has to recognise the commit rename from the file identity rather than from the text it is
	// handed. Windows only: there is no short-name alias elsewhere, and a volume that does not
	// generate them cannot present one here either.
	const shortSpellingOf = (directory: string): string | null => {
		if (process.platform !== "win32") {
			return null
		}
		try {
			// Quoted, and verbatim: cmd splits an unquoted for-set on spaces, and a quoted argv
			// entry alone leaves cmd a value whose quotes are part of the name (see the same probe
			// in safeWriteText.alias.spec.ts, where both forms are measured). spawnSync is the API
			// whose typings carry windowsVerbatimArguments - execFileSync's do not - and both
			// measure the same answer, so the choice is about the typing only.
			const probe = spawnSync("cmd.exe", ["/c", 'for %A in ("' + directory + '") do @echo %~sA'], {
				encoding: "utf8",
				windowsVerbatimArguments: true,
			})
			// The typings say `error: Error | null`; spawnSync leaves it undefined on a successful run,
			// so a `!== null` test would reject every healthy probe and make the alias rows below
			// return early instead of asserting.
			if (probe.error || probe.status !== 0 || probe.stdout === null) {
				return null
			}
			const out = probe.stdout.trim()
			return out.includes("~1") ? out : null
		} catch {
			return null
		}
	}

	it("recognises the commit rename through a short-name alias, and refuses another directory", async () => {
		// Inside tempDir on purpose: this test returns early on a box with no short-name alias and
		// stops at an assertion failure more often than it reaches its own cleanup, and a directory
		// under os.tmpdir() survives both. The describe's afterEach removes tempDir, so creating the
		// matcher's scratch tree inside it cleans up on every exit.
		const base = await fs.mkdtemp(path.join(tempDir, "interruption-matcher-"))
		const longDir = path.join(base, "LONGMATCHERDIRECTORYNAME")
		const otherDir = path.join(base, "OTHERMATCHERDIRECTORYNAME")
		await fs.mkdir(longDir, { recursive: true })
		await fs.mkdir(otherDir, { recursive: true })
		const shortDir = shortSpellingOf(longDir)
		const shortOther = shortSpellingOf(otherDir)
		if (shortDir === null || shortOther === null) {
			return
		}
		const fileName = "target.json"
		await fs.writeFile(path.join(longDir, fileName), "committed", "utf8")

		const runMatcher = async (
			targetPath: string,
			candidates: Array<[string, string]>,
		): Promise<Record<string, string>> => {
			const child = spawn(process.execPath, [childScriptPath], {
				env: {
					...process.env,
					INTERRUPTION_TARGET_PATH: targetPath,
					INTERRUPTION_MODE: "matcher",
					INTERRUPTION_MATCHER_CASES: JSON.stringify(
						candidates.map(([label, candidate]) => ({ label, candidate })),
					),
					ESBUILD_PATH: esbuildPath,
					SAFE_WRITE_JSON_ENTRY: safeWriteJsonEntryPath,
					INTERRUPTION_BUNDLE_PATH: childBundlePath,
				},
				stdio: ["ignore", "pipe", "pipe"],
			})
			const exit = await waitForChildExit(child)
			const decisions: Record<string, string> = {}
			for (const line of exit.stdout.split(String.fromCharCode(10))) {
				const match = line.match(/^MATCH ([^=]+)=(true|false)$/)
				if (match) {
					decisions[match[1]] = match[2]
				}
			}
			return decisions
		}

		// Same file, spelled through the alias: the decision must be yes from either side's spelling.
		const fromLong = await runMatcher(path.join(longDir, fileName), [
			["self", path.join(longDir, fileName)],
			["alias", path.join(shortDir, fileName)],
			["other-directory-file", path.join(otherDir, fileName)],
			["other-directory-alias", path.join(shortOther ?? otherDir, fileName)],
		])
		expect(fromLong).toEqual({
			self: "true",
			alias: "true",
			"other-directory-file": "false",
			"other-directory-alias": "false",
		})

		const fromShort = await runMatcher(path.join(shortDir, fileName), [
			["self", path.join(shortDir, fileName)],
			["alias", path.join(longDir, fileName)],
			["other-directory-file", path.join(otherDir, fileName)],
		])
		expect(fromShort).toEqual({ self: "true", alias: "true", "other-directory-file": "false" })

		await fs.rm(base, { recursive: true, force: true })
	}, 30_000)
})
