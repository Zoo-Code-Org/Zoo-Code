import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { HOOK_MODEL_OUTPUT_MAX_BYTES, type HookDefinition, type HookInvocation } from "@roo-code/types"

import { HookRunner } from "../HookRunner"

const definition: HookDefinition = {
	id: "session-hook",
	name: "Session hook",
	enabled: true,
	phase: "sessionStart",
	executable: process.execPath,
	argv: [],
}

describe("HookRunner", () => {
	let cwd: string

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hook-runner-test-"))
	})

	afterEach(async () => {
		await fs.rm(cwd, { force: true, recursive: true })
	})

	function invocation(runId = "run-1"): HookInvocation {
		return {
			version: 1,
			hookRunId: runId,
			phase: "sessionStart",
			taskId: "task-1",
			instanceId: "instance-1",
			workspacePath: cwd,
		}
	}

	it("executes an executable directly with argv and captures successful stdout", async () => {
		const result = await new HookRunner().run(
			{ ...definition, argv: ["-e", "process.stdout.write(process.argv[1])", "literal $HOME && value"] },
			invocation(),
			new AbortController().signal,
		)

		expect(result.status).toBe("succeeded")
		expect(result.stdoutSummary).toBe("literal $HOME && value")
		expect(result.exitCode).toBe(0)
	})

	it("classifies nonzero exits as nonfatal failures", async () => {
		const result = await new HookRunner().run(
			{ ...definition, argv: ["-e", "process.stderr.write('diagnostic'); process.exit(7)"] },
			invocation(),
			new AbortController().signal,
		)

		expect(result).toMatchObject({ status: "failed", exitCode: 7, stderrSummary: "diagnostic" })
	})

	it("returns a safe failure for start errors and invalid cwd", async () => {
		const missingCwd = await new HookRunner().run(
			definition,
			{ ...invocation(), workspacePath: path.join(cwd, "missing") },
			new AbortController().signal,
		)
		const startError = await new HookRunner().run(
			{ ...definition, executable: path.join(cwd, "missing-executable") },
			invocation(),
			new AbortController().signal,
		)

		expect(missingCwd).toMatchObject({ status: "failed", stderrSummary: "The hook process could not be started." })
		expect(startError).toMatchObject({ status: "failed", stderrSummary: "The hook process could not be started." })
	})

	it("does not spawn when already cancelled", async () => {
		const controller = new AbortController()
		controller.abort()
		const result = await new HookRunner().run(definition, invocation(), controller.signal)

		expect(result.status).toBe("cancelled")
	})

	it("kills and awaits the process on timeout and cancellation", async () => {
		const timeoutResult = await new HookRunner({ timeoutMs: 30 }).run(
			{ ...definition, argv: ["-e", "setInterval(() => {}, 1000)"] },
			invocation("timeout"),
			new AbortController().signal,
		)

		const controller = new AbortController()
		const cancellation = new HookRunner().run(
			{ ...definition, argv: ["-e", "setInterval(() => {}, 1000)"] },
			invocation("cancel"),
			controller.signal,
		)
		setTimeout(() => controller.abort(), 30)

		expect(timeoutResult.status).toBe("timedOut")
		expect((await cancellation).status).toBe("cancelled")
	})

	it("uses the Windows termination path without process discovery", async () => {
		const result = await new HookRunner({ timeoutMs: 30, platform: "win32" }).run(
			{ ...definition, argv: ["-e", "setInterval(() => {}, 1000)"] },
			invocation("windows-timeout"),
			new AbortController().signal,
		)

		expect(result.status).toBe("timedOut")
	})

	it("terminates child processes before returning from timeout", async () => {
		const childScript = "setInterval(() => {}, 1000)"
		const parentScript = [
			"const { spawn } = require('child_process')",
			`const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}])`,
			"process.stdout.write(String(child.pid))",
			"setInterval(() => {}, 1000)",
		].join(";")
		const result = await new HookRunner({ timeoutMs: 200 }).run(
			{ ...definition, argv: ["-e", parentScript] },
			invocation("tree-timeout"),
			new AbortController().signal,
		)
		const childPid = Number(result.stdoutSummary)

		expect(result.status).toBe("timedOut")
		expect(Number.isInteger(childPid)).toBe(true)
		expect(() => process.kill(childPid, 0)).toThrow()
	})

	it("bounds combined capture and persisted summaries", async () => {
		const result = await new HookRunner().run(
			{
				...definition,
				argv: ["-e", "process.stdout.write('a'.repeat(70000)); process.stderr.write('b'.repeat(70000))"],
			},
			invocation(),
			new AbortController().signal,
		)

		expect(result.truncated).toBe(true)
		expect(Buffer.byteLength((result.stdoutSummary ?? "") + (result.stderrSummary ?? ""))).toBeLessThanOrEqual(
			HOOK_MODEL_OUTPUT_MAX_BYTES,
		)
	})

	it("provides mode-restricted invocation metadata and cleans it up", async () => {
		const script = [
			"const fs = require('fs')",
			"const p = process.env.ZOO_CODE_HOOK_INVOCATION_FILE",
			"process.stdout.write(JSON.stringify({ data: JSON.parse(fs.readFileSync(p, 'utf8')), mode: fs.statSync(p).mode & 0o777, path: p }))",
		].join(";")
		const result = await new HookRunner().run(
			{ ...definition, argv: ["-e", script] },
			invocation(),
			new AbortController().signal,
		)
		const metadata = JSON.parse(result.stdoutSummary ?? "{}")

		expect(metadata.data).toEqual(invocation())
		if (process.platform !== "win32") expect(metadata.mode).toBe(0o600)
		await expect(fs.stat(metadata.path)).rejects.toThrow()
	})
})
