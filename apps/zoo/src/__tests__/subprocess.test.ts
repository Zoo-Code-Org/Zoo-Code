import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)))
const cliPath = path.join(packageRoot, "dist/index.js")
const hostPath = fileURLToPath(new URL("./fixtures/fake-host.mjs", import.meta.url))

async function runCli(args: string[], scenario = "completed", signal?: NodeJS.Signals) {
	return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
		const child = spawn(process.execPath, [cliPath, ...args], {
			env: { ...process.env, ZOO_HOST_PATH: hostPath, ZOO_FAKE_SCENARIO: scenario },
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk))
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
		child.once("error", reject)
		child.once("close", (code) => resolve({ stdout, stderr, code: code ?? 70 }))
		if (signal) setTimeout(() => child.kill(signal), 100)
	})
}

describe("packaged zoo automation", () => {
	it("negotiates with the host and writes exactly one final JSON value", async () => {
		const { stdout, stderr } = await runCli(["run", "finish the task", "--format", "json", "-C", packageRoot])
		const result = JSON.parse(stdout) as { outcome: string; content: string }

		expect(result).toMatchObject({ outcome: "completed", content: "finished" })
		expect(stdout.trim().split("\n")).toHaveLength(1)
		expect(stderr).toBe("")
	})

	it("settles a host crash as one runtime-failure JSON value", async () => {
		const { stdout, code } = await runCli(["run", "crash", "--format", "json", "-C", packageRoot], "crash")
		const lines = stdout.trim().split("\n")

		expect(code).toBe(70)
		expect(lines).toHaveLength(1)
		expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: "failed", error: { code: "host_crashed" } })
	})

	it("returns immediately and resumably for a safe unattended ask", async () => {
		const { stdout, code } = await runCli(
			["run", "ask", "--format", "stream-json", "--approval", "safe", "-C", packageRoot],
			"needs-input",
		)
		const events = stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; result?: { outcome: string } })

		expect(code).toBe(3)
		expect(events.at(-1)).toMatchObject({ type: "task.result", result: { outcome: "needs_input" } })
		expect(events.filter((event) => event.type === "task.result")).toHaveLength(1)
	})

	it("enforces the whole-task timeout and exit code", async () => {
		const { stdout, code } = await runCli(
			["run", "wait", "--format", "json", "--timeout", "50ms", "-C", packageRoot],
			"hang",
		)

		expect(code).toBe(124)
		expect(JSON.parse(stdout)).toMatchObject({ outcome: "timed_out", error: { code: "task_timed_out" } })
	})

	it("cancels canonically on SIGTERM and preserves the signal exit code", async () => {
		const { stdout, code } = await runCli(["run", "wait", "--format", "json", "-C", packageRoot], "hang", "SIGTERM")

		expect(code).toBe(143)
		expect(JSON.parse(stdout)).toMatchObject({ outcome: "cancelled", cancellationReason: "signal" })
	})

	it("lists and resumes the latest workspace session", async () => {
		const listed = await runCli(["sessions", "list", "--format", "json", "-C", packageRoot])
		const resumed = await runCli(["resume", "--format", "json", "-C", packageRoot])

		expect(JSON.parse(listed.stdout)).toMatchObject([{ rootTaskId: "root-1", state: "interrupted" }])
		expect(JSON.parse(resumed.stdout)).toMatchObject({ outcome: "completed", content: "resumed" })
	})
})
