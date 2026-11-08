import { spawn, type ChildProcess } from "child_process"
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
const fsPromises = require("fs/promises")
const actualRename = fsPromises.rename

// Identity, not spelling. The writer renames to the publish target it resolved through
// symlinks, and node's async fs.realpath expands an NTFS 8.3 alias, so on a runner whose temp
// path is reported as an alias (the normal windows-latest condition: the profile is RUNNER~1
// there) the parent's authorized spelling and the writer's rename destination are different
// strings for one file. Text equality here never fires, every case prints WRITE_COMPLETED, and
// the injection silently stops being an injection. Decide what the destination IS: same name,
// and the same directory by dev+ino. The basenames under test are unique inside the storage
// directory, so the pair cannot land on another file.
const targetBase = path.basename(targetPath)
function sameTargetAsAuthorized(candidate) {
	if (path.basename(String(candidate)) !== targetBase) {
		return false
	}
	const resolved = path.resolve(String(candidate))
	if (resolved === targetPath) {
		return true
	}
	let candidateDir = null
	let authorizedDir = null
	try {
		candidateDir = fs.statSync(path.dirname(resolved), { bigint: true })
	} catch {
		return false
	}
	try {
		authorizedDir = fs.statSync(path.dirname(targetPath), { bigint: true })
	} catch {
		return false
	}
	return candidateDir.dev === authorizedDir.dev && candidateDir.ino === authorizedDir.ino
}

// Fault injection: hard-kill before the replacement lands. Any rename
// whose destination is the publish target is the commit step, whatever
// replacement protocol the writer uses; exit before performing it.
let commitAttempts = 0
fsPromises.rename = async function interruptionRename(oldPath, newPath) {
	if (sameTargetAsAuthorized(newPath)) {
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
})
