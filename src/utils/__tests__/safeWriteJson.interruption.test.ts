import { spawn, type ChildProcess } from "child_process"
import { createRequire } from "module"
import { fileURLToPath } from "url"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { safeWriteJson } from "../safeWriteJson"
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

// Fault injection: hard-kill before the replacement lands. Any rename
// whose destination is the canonical path is the commit step, whatever
// replacement protocol the writer uses; exit before performing it.
let commitAttempts = 0
fsPromises.rename = function interruptionRename(oldPath, newPath) {
	if (path.resolve(String(newPath)) === targetPath) {
		commitAttempts++
		if (process.env.INTERRUPTION_MODE === "fallback" && commitAttempts === 1) {
			return Promise.reject(Object.assign(new Error("Injected EPERM"), { code: "EPERM" }))
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
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it.each(["atomic", "fallback"] as const)(
		"preserves committed history when the %s writer is killed before replacement",
		async (mode) => {
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
					INTERRUPTION_MODE: mode,
					INTERRUPTION_PAYLOAD: JSON.stringify({
						ui_messages: [{ ts: 2, type: "say", text: `INTERRUPTED_WRITE_${mode}` }],
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
			expect(exit.code).toBeNull()

			// Atomic replacement retains the canonical file; the two-step
			// fallback retains committed content in its backup until recovery.
			const interruptedFiles = await fs.readdir(storageDir)
			expect(interruptedFiles.filter((entry) => entry.includes(".new_"))).toHaveLength(1)
			if (mode === "fallback") {
				await expect(fs.readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" })
				const backups = interruptedFiles.filter((entry) => entry.includes(".bak_"))
				expect(backups).toHaveLength(1)
				expect(JSON.parse(await fs.readFile(path.join(storageDir, backups[0]), "utf8"))).toEqual(committed)
			} else {
				expect(JSON.parse(await readFileWithMissingRetry(targetPath))).toEqual(committed)
			}

			// SIGKILL leaves the lock behind. Age it to exercise real stale-lock
			// acquisition without making the test wait through the stale window.
			const staleTime = new Date(Date.now() - 60_000)
			await fs.utimes(`${targetPath}.lock`, staleTime, staleTime)
			const recovered = { ui_messages: [{ ts: 3, type: "say", text: "RECOVERED_AFTER_RESTART" }] }
			await safeWriteJson(targetPath, recovered, {
				merge: (existing, incoming) => {
					expect(existing).toEqual(committed)
					return incoming
				},
			})

			expect(JSON.parse(await readFileWithMissingRetry(targetPath))).toEqual(recovered)
			const leftovers = (await fs.readdir(storageDir)).filter(
				(entry) => entry.includes(".new_") || entry.includes(".bak_"),
			)
			expect(leftovers).toEqual([])
		},
		30_000,
	)
})
