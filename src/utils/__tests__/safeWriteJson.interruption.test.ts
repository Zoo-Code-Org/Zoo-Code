import { spawn, type ChildProcess } from "child_process"
import { createRequire } from "module"
import { fileURLToPath } from "url"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { safeWriteJson } from "../safeWriteJson"
import { LOCK_STALE_MS } from "../fileLock"
import { setPersistenceTraceSink } from "../persistenceTrace"
import { readFileWithMissingRetry } from "../../core/task-persistence/readFileWithMissingRetry"

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
const fsPromises = require("fs/promises")
const actualRename = fsPromises.rename

// Fault injection: SIGKILL before the replacement lands. Any rename
// whose destination is the canonical path is the commit step, whatever
// replacement protocol the writer uses; kill the process before performing it.
let rejectedCommit = false
fsPromises.rename = function interruptionRename(oldPath, newPath) {
	if (path.resolve(String(newPath)) === targetPath) {
		if (process.env.INTERRUPTION_EPERM === "1" && !rejectedCommit) {
			rejectedCommit = true
			return Promise.reject(Object.assign(new Error("injected EPERM"), { code: "EPERM" }))
		}
		fs.writeSync(1, "EXIT_BEFORE_REPLACEMENT_RENAME\\n")
		process.kill(process.pid, "SIGKILL")
	}
	return actualRename.apply(fsPromises, arguments)
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
		process.kill(process.pid, "SIGKILL")
	})
	.catch((error) => {
		fs.writeSync(2, "WRITE_FAILED: " + ((error && error.message) || String(error)) + "\\n")
		process.exit(1)
	})
`

async function waitForChildExit(
	child: ChildProcess,
): Promise<{ signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
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
		child.once("close", (_code, signal) => {
			clearTimeout(timeout)
			resolve({
				signal,
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
		storageDir = path.join(tempDir, "storage")
		childDir = path.join(tempDir, "child")
		await fs.mkdir(storageDir)
		await fs.mkdir(childDir)
		targetPath = path.join(storageDir, "ui_messages.json")
		childScriptPath = path.join(childDir, "interrupted-writer.cjs")
		childBundlePath = path.join(childDir, "safeWriteJson.bundle.cjs")
		await fs.writeFile(childScriptPath, CHILD_SCRIPT, "utf8")
	})

	afterEach(async () => {
		setPersistenceTraceSink(undefined)
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it.each([false, true])(
		"recovers after SIGKILL before commit (EPERM fallback: %s)",
		async (eperm) => {
			// A previously committed write contains the restart marker.
			const committed = { ui_messages: [{ ts: 1, type: "say", text: "RESTART_PERSISTENCE_MARKER" }] }
			await fs.writeFile(targetPath, JSON.stringify(committed), "utf8")

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
					INTERRUPTION_EPERM: eperm ? "1" : "0",
					INTERRUPTION_PAYLOAD: JSON.stringify({
						ui_messages: [{ ts: 2, type: "say", text: "INTERRUPTED_WRITE" }],
					}),
					ESBUILD_PATH: esbuildPath,
					SAFE_WRITE_JSON_ENTRY: safeWriteJsonEntryPath,
					INTERRUPTION_BUNDLE_PATH: childBundlePath,
				},
				stdio: ["ignore", "pipe", "pipe"],
			})
			const exit = await waitForChildExit(child)

			expect(exit.stdout).toContain("EXIT_BEFORE_REPLACEMENT_RENAME")
			expect(exit.stdout).not.toContain("WRITE_COMPLETED")
			expect(exit.stderr).not.toContain("WRITE_FAILED")
			expect(exit.signal).toBe("SIGKILL")

			// SIGKILL bypasses proper-lockfile's exit cleanup. A fresh writer
			// must reject the live-looking lock rather than steal it early.
			await expect(fs.stat(`${targetPath}.lock`)).resolves.toBeDefined()
			await expect(safeWriteJson(targetPath, {})).rejects.toMatchObject({ code: "ELOCKED" })
			if (!eperm) {
				expect(JSON.parse(await readFileWithMissingRetry(targetPath))).toEqual(committed)
			} else {
				await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" })
				// A reader must fail closed while the dead writer's lock still
				// appears fresh, rather than return empty or delete its backup.
				const lines: string[] = []
				setPersistenceTraceSink((line) => lines.push(line))
				await expect(readFileWithMissingRetry(targetPath)).rejects.toMatchObject({ code: "ELOCKED" })
				expect(JSON.parse(lines[0].slice("[persistence-trace] ".length))).toMatchObject({
					stage: "json-recovery-failed",
					filePath: targetPath,
					detail: "ELOCKED",
				})
				const backups = (await fs.readdir(storageDir)).filter((entry) => entry.includes(".bak_"))
				expect(backups).toHaveLength(1)
				expect(JSON.parse(await fs.readFile(path.join(storageDir, backups[0]), "utf8"))).toEqual(committed)
			}

			// Advance the real lock's age, without waiting 31 seconds. Recovery
			// uses proper-lockfile's production stale-lock takeover protocol.
			const staleTime = new Date(Date.now() - LOCK_STALE_MS - 2_000)
			await fs.utimes(`${targetPath}.lock`, staleTime, staleTime)
			expect(JSON.parse(await readFileWithMissingRetry(targetPath))).toEqual(committed)

			const recovered = { ui_messages: [{ ts: 3, type: "say", text: "RECOVERED_AFTER_RESTART" }] }
			await safeWriteJson(targetPath, recovered)

			expect(JSON.parse(await readFileWithMissingRetry(targetPath))).toEqual(recovered)
			const leftovers = (await fs.readdir(storageDir)).filter(
				(entry) => entry.includes(".new_") || entry.includes(".bak_"),
			)
			expect(leftovers).toEqual([])
		},
		30_000,
	)
})
