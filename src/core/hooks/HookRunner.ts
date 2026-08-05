import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { execa } from "execa"
import psTree from "ps-tree"

import {
	HOOK_CAPTURE_MAX_BYTES,
	HOOK_MODEL_OUTPUT_MAX_BYTES,
	HOOK_TIMEOUT_MS,
	classifyHookExit,
	sanitizeHookOutput,
	type HookDefinition,
	type HookInvocation,
	type HookRunResult,
} from "@roo-code/types"

export const HOOK_INVOCATION_FILE_ENV = "ZOO_CODE_HOOK_INVOCATION_FILE"

type TerminationReason = "timedOut" | "cancelled"

interface HookRunnerOptions {
	timeoutMs?: number
	platform?: NodeJS.Platform
}

function collectProcessTree(pid: number): Promise<number[]> {
	return new Promise((resolve) => {
		psTree(pid, (error, children) => {
			if (error) {
				resolve([])
				return
			}

			resolve(children.map(({ PID }) => Number(PID)).filter(Number.isInteger))
		})
	})
}

async function terminateProcessTree(pid: number | undefined, platform: NodeJS.Platform): Promise<void> {
	if (pid === undefined) {
		return
	}
	if (platform === "win32") {
		const taskkillPath = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")
		const result = await execa(taskkillPath, ["/PID", String(pid), "/T", "/F"], { reject: false })
		if (result.exitCode !== 0) {
			try {
				process.kill(pid, "SIGKILL")
			} catch {
				// The root process may already have exited.
			}
		}
		return
	}

	const descendants = await collectProcessTree(pid)
	for (const childPid of descendants.reverse()) {
		try {
			process.kill(childPid, "SIGKILL")
		} catch {
			// The process may have exited between discovery and termination.
		}
	}

	try {
		process.kill(pid, "SIGKILL")
	} catch {
		// The root process may already have exited.
	}

	const pids = [...descendants, pid]
	for (let attempt = 0; attempt < 200; attempt++) {
		const alive = pids.filter((processId) => {
			try {
				process.kill(processId, 0)
				return true
			} catch {
				return false
			}
		})
		if (alive.length === 0) {
			return
		}
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

function appendWithinBudget(chunks: Buffer[], chunk: Buffer, remainingBytes: { value: number }): boolean {
	if (remainingBytes.value <= 0) {
		return chunk.length > 0
	}

	const retained = chunk.subarray(0, remainingBytes.value)
	if (retained.length > 0) {
		chunks.push(retained)
		remainingBytes.value -= retained.length
	}

	return retained.length < chunk.length
}

function truncateUtf8(output: string, maxBytes: number): { output: string; truncated: boolean } {
	const bytes = Buffer.from(output)
	if (bytes.length <= maxBytes) {
		return { output, truncated: false }
	}

	const marker = Buffer.from("\n[hook output omitted to fit limit]\n")
	if (maxBytes < marker.length) {
		return { output: "", truncated: true }
	}

	let retained = bytes.subarray(0, maxBytes - marker.length).toString("utf8")
	while (Buffer.byteLength(retained) + marker.length > maxBytes) {
		retained = retained.slice(0, -1)
	}
	return { output: retained + marker.toString("utf8"), truncated: true }
}

function boundedSummaries(
	stdout: string,
	stderr: string,
): { stdoutSummary?: string; stderrSummary?: string; truncated: boolean } {
	let remainingBytes = HOOK_MODEL_OUTPUT_MAX_BYTES
	const boundedStdout = truncateUtf8(stdout, remainingBytes)
	remainingBytes -= Buffer.byteLength(boundedStdout.output)
	const boundedStderr = truncateUtf8(stderr, remainingBytes)

	return {
		stdoutSummary: boundedStdout.output || undefined,
		stderrSummary: boundedStderr.output || undefined,
		truncated: boundedStdout.truncated || boundedStderr.truncated,
	}
}

async function validateCwd(cwd: string): Promise<void> {
	if (!path.isAbsolute(cwd)) {
		throw new Error("Hook workspace path must be an absolute file-system path.")
	}

	const stat = await fs.stat(cwd)
	if (!stat.isDirectory()) {
		throw new Error("Hook workspace path is not a directory.")
	}
}

export class HookRunner {
	private readonly timeoutMs: number
	private readonly platform: NodeJS.Platform

	constructor(options: HookRunnerOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? HOOK_TIMEOUT_MS
		this.platform = options.platform ?? process.platform
	}

	async run(definition: HookDefinition, invocation: HookInvocation, signal: AbortSignal): Promise<HookRunResult> {
		const startedAt = Date.now()
		const baseResult = {
			hookRunId: invocation.hookRunId,
			hookId: definition.id,
			phase: invocation.phase,
			startedAt,
		}

		if (signal.aborted) {
			return { ...baseResult, status: "cancelled", truncated: false, completedAt: Date.now() }
		}

		let tempDirectory: string | undefined
		try {
			await validateCwd(invocation.workspacePath)
			if (path.isAbsolute(definition.executable)) {
				await fs.access(definition.executable)
			}
			tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-code-hook-"))
			await fs.chmod(tempDirectory, 0o700)
			const invocationPath = path.join(tempDirectory, "invocation.json")
			await fs.writeFile(invocationPath, JSON.stringify(invocation), { encoding: "utf8", mode: 0o600 })

			if (signal.aborted) {
				return { ...baseResult, status: "cancelled", truncated: false, completedAt: Date.now() }
			}

			const subprocess = execa(definition.executable, definition.argv, {
				buffer: false,
				cwd: invocation.workspacePath,
				env: { ...process.env, [HOOK_INVOCATION_FILE_ENV]: invocationPath },
				reject: false,
				shell: false,
				stdin: "ignore",
				stderr: "pipe",
				stdout: "pipe",
			})

			const remainingCaptureBytes = { value: HOOK_CAPTURE_MAX_BYTES }
			const stdoutChunks: Buffer[] = []
			const stderrChunks: Buffer[] = []
			let captureTruncated = false
			subprocess.stdout?.on("data", (chunk: Buffer | string) => {
				captureTruncated =
					appendWithinBudget(stdoutChunks, Buffer.from(chunk), remainingCaptureBytes) || captureTruncated
			})
			subprocess.stderr?.on("data", (chunk: Buffer | string) => {
				captureTruncated =
					appendWithinBudget(stderrChunks, Buffer.from(chunk), remainingCaptureBytes) || captureTruncated
			})

			let resolveTermination!: (reason: TerminationReason) => void
			const termination = new Promise<TerminationReason>((resolve) => {
				resolveTermination = resolve
			})
			const onAbort = () => resolveTermination("cancelled")
			signal.addEventListener("abort", onAbort, { once: true })
			const timeout = setTimeout(() => resolveTermination("timedOut"), this.timeoutMs)

			const outcome = await Promise.race([
				subprocess.then((result) => ({ type: "exit" as const, result })),
				termination.then((reason) => ({ type: "termination" as const, reason })),
			])

			clearTimeout(timeout)
			signal.removeEventListener("abort", onAbort)

			if (outcome.type === "termination") {
				await terminateProcessTree(subprocess.pid, this.platform)
				await subprocess.catch(() => undefined)
				const summaries = boundedSummaries(
					sanitizeHookOutput(Buffer.concat(stdoutChunks).toString("utf8")),
					sanitizeHookOutput(Buffer.concat(stderrChunks).toString("utf8")),
				)
				return {
					...baseResult,
					...summaries,
					status: outcome.reason,
					truncated: captureTruncated || summaries.truncated,
					completedAt: Date.now(),
				}
			}

			const summaries = boundedSummaries(
				sanitizeHookOutput(Buffer.concat(stdoutChunks).toString("utf8")),
				sanitizeHookOutput(Buffer.concat(stderrChunks).toString("utf8")),
			)
			const classification = classifyHookExit(invocation.phase, outcome.result.exitCode ?? null)
			if (outcome.result.exitCode === undefined && !summaries.stderrSummary) {
				summaries.stderrSummary = "The hook process could not be started."
			}

			return {
				...baseResult,
				...summaries,
				status: classification.status,
				exitCode: outcome.result.exitCode ?? undefined,
				truncated: captureTruncated || summaries.truncated,
				completedAt: Date.now(),
			}
		} catch {
			return {
				...baseResult,
				status: signal.aborted ? "cancelled" : "failed",
				stderrSummary: signal.aborted ? undefined : "The hook process could not be started.",
				truncated: false,
				completedAt: Date.now(),
			}
		} finally {
			if (tempDirectory) {
				await fs.rm(tempDirectory, { force: true, recursive: true }).catch(() => undefined)
			}
		}
	}
}
