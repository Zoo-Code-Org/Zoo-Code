import assert from "node:assert/strict"
import fs from "node:fs"
import { URL, fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { spawn, spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { parse } from "yaml"

// Parse configuration so comments, indentation, and key order are irrelevant.
// GitHub expressions remain strings: these checks protect the configured policy,
// while the recorder tests below exercise process behavior.
const workflow = parse(
	fs.readFileSync(new URL("../.github/workflows/solheim-provider-smoke.yml", import.meta.url), "utf8"),
)
const smoke = workflow.jobs.smoke
const steps = smoke.steps
const actionSteps = (action) => steps.filter((step) => step.uses?.startsWith(action + "@"))

describe("Solheim provider smoke workflow policy", () => {
	it("allows only manual runs on main behind the protected environment", () => {
		assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"])
		assert.deepEqual(Object.keys(workflow.jobs), ["smoke"])
		assert.equal(smoke.if, "github.ref == 'refs/heads/main'")
		assert.equal(smoke.environment, "final-vscode-review-smoke")
		assert.deepEqual(workflow.permissions, { contents: "read" })
		assert.equal(smoke.permissions, undefined)
	})

	it("checks out the triggering revision without persisting credentials", () => {
		const checkouts = actionSteps("actions/checkout")
		assert.equal(checkouts.length, 1)
		assert.equal(checkouts[0].with.ref, "${{ github.sha }}")
		assert.equal(checkouts[0].with["persist-credentials"], false)
	})

	it("exposes the provider credential only to the bounded provider step", () => {
		const provider = steps.find((step) => step.id === "provider")
		assert.ok(provider, "missing provider step")
		assert.equal(provider.env.SOLHEIM_API_KEY, "${{ secrets.FINAL_SMOKE_OPENAI_API_KEY }}")
		assert.equal(workflow.env, undefined)
		assert.equal(smoke.env, undefined)
		// Inspect parsed values, excluding comments and display names.
		const credentialSteps = steps.filter((step) =>
			JSON.stringify({ env: step.env, with: step.with, run: step.run }).includes("secrets."),
		)
		assert.deepEqual(credentialSteps, [provider])
		assert.ok(provider["timeout-minutes"] > 0 && provider["timeout-minutes"] <= 8)
		assert.ok(smoke["timeout-minutes"] > provider["timeout-minutes"] && smoke["timeout-minutes"] <= 25)
		assert.equal(workflow.concurrency.group, "solheim-provider-smoke")
		assert.equal(workflow.concurrency["cancel-in-progress"], false)
	})

	it("uploads metadata and the final recording separately, including after provider failure", () => {
		const uploads = actionSteps("actions/upload-artifact")
		assert.equal(uploads.length, 2)
		const output = "${{ runner.temp }}/solheim-provider-smoke"
		const paths = uploads.map((step) =>
			step.with.path
				.trim()
				.split("\n")
				.map((line) => line.trim()),
		)
		assert.deepEqual(paths, [[output + "/verdict.json", output + "/trace.json"], [output + "/smoke.mp4"]])
		for (const step of uploads) {
			assert.equal(
				step.if,
				"${{ !cancelled() && (steps.provider.outcome == 'success' || steps.provider.outcome == 'failure') }}",
			)
			assert.equal(step.with["if-no-files-found"], "error")
			assert.equal(step.with["retention-days"], 7)
			assert.ok(steps.indexOf(step) > steps.findIndex((candidate) => candidate.id === "provider"))
		}
		assert.equal(new Set(uploads.map((step) => step.with.name)).size, 2)
	})

	it("pins remote actions to immutable commit revisions", () => {
		for (const step of steps.filter((step) => step.uses && !step.uses.startsWith("./"))) {
			const revision = step.uses.split("@")[1]
			assert.match(revision ?? "", /^[0-9a-f]{40}$/, step.uses)
		}
	})
})

// Runs record.sh with stub ffmpeg and ffprobe, so no display or codec is needed.
const defaultFfmpeg = (writes) =>
	`${writes ? 'for a; do :; done; echo data > "$a"' : ":"}\ntrap 'exit 0' TERM\nwhile true; do sleep 0.05; done`

function stubRecorderBin(dir, { ffmpeg, ffmpegWrites = true, ffprobeOk = true } = {}) {
	const bin = path.join(dir, "bin")
	fs.mkdirSync(bin, { recursive: true })
	const stub = (name, body) =>
		fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
	// The stub ffmpeg writes the last argument (the recorder's output path),
	// stops on TERM, and exits.
	stub("ffmpeg", ffmpeg ?? defaultFfmpeg(ffmpegWrites))
	stub("ffprobe", ffprobeOk ? "exit 0" : "exit 1")
	return bin
}

function recorderPaths(dir) {
	const outDir = path.join(dir, "out")
	return {
		outDir,
		finalRecording: path.join(outDir, "smoke.mp4"),
	}
}

function recorderEnv(bin, outDir, providerMarker, extraEnv) {
	return {
		PATH: `${bin}:${process.env.PATH}`,
		DISPLAY: ":99",
		SOLHEIM_SMOKE_OUT_DIR: outDir,
		...(providerMarker ? { PROVIDER_MARKER: providerMarker } : {}),
		...extraEnv,
	}
}

const stopBudgetEnv = (stopBudget) => (stopBudget ? { SOLHEIM_SMOKE_STOP_BUDGET_S: String(stopBudget) } : {})

const recorderScript = fileURLToPath(new URL("./solheim-smoke/record.sh", import.meta.url))
// Test-only mirror of record.sh that runs a supplied command. Production
// record.sh always runs its fixed Node driver and rejects supplied arguments.
const recorderHelper = fileURLToPath(new URL("./solheim-smoke/record.test-helper.sh", import.meta.url))

function runRecorder(
	args,
	{
		script = recorderScript,
		ffmpeg,
		ffmpegWrites = true,
		ffprobeOk = true,
		seedFinal,
		seedMetadata,
		providerMarker,
		stopBudget,
		extraEnv,
	} = {},
) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-sh-"))
	const bin = stubRecorderBin(dir, { ffmpeg, ffmpegWrites, ffprobeOk })
	const paths = recorderPaths(dir)
	fs.mkdirSync(paths.outDir, { recursive: true })
	if (seedFinal !== undefined) fs.writeFileSync(paths.finalRecording, seedFinal)
	for (const name of seedMetadata ?? []) fs.writeFileSync(path.join(paths.outDir, name), "stale")
	const result = spawnSync("bash", [script, ...args], {
		env: recorderEnv(bin, paths.outDir, providerMarker, { ...stopBudgetEnv(stopBudget), ...extraEnv }),
		encoding: "utf8",
		timeout: 20_000,
	})
	return { result, ...paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

// TERM waits until the stub proves its signal handler is armed: a bounded wait
// for readyFile when one is given, or the fixed delayMs fallback otherwise. A
// TERM that lands during Node boot would kill the stub before its handler
// exists and turn the test into a boot-race coin flip.
function runRecorderSignalled(
	args,
	{ script = recorderScript, ffmpeg, ffprobeOk = true, delayMs, readyFile, providerMarker, stopBudget } = {},
) {
	return new Promise((resolve) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-sh-"))
		const bin = stubRecorderBin(dir, { ffmpeg, ffprobeOk })
		const paths = recorderPaths(dir)
		// The output directory is created here, before the recorder runs, so
		// every process in the test observes the same directory object.
		fs.mkdirSync(paths.outDir, { recursive: true })
		const child = spawn("bash", [script, ...args], {
			env: recorderEnv(bin, paths.outDir, providerMarker, stopBudgetEnv(stopBudget)),
		})
		let stdout = ""
		child.stdout.on("data", (chunk) => {
			stdout += chunk
		})
		const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000)
		let timer
		let poll
		const sendTerm = () => {
			timer = setTimeout(() => child.kill("SIGTERM"), delayMs)
		}
		if (readyFile === undefined) {
			sendTerm()
		} else {
			const startedAt = Date.now()
			poll = setInterval(() => {
				if (fs.existsSync(readyFile)) {
					clearInterval(poll)
					poll = undefined
					sendTerm()
					return
				}
				// A stub that never becomes ready must not hang the test.
				if (Date.now() - startedAt > 10_000) {
					clearInterval(poll)
					poll = undefined
					child.kill("SIGKILL")
				}
			}, 25)
		}
		child.on("close", (code) => {
			clearTimeout(watchdog)
			if (timer !== undefined) clearTimeout(timer)
			if (poll !== undefined) clearInterval(poll)
			resolve({ code, stdout, ...paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) })
		})
	})
}

// Command-execution recorder tests target the test-only helper: production
// record.sh never runs a supplied command.
const runCommandRecorder = (args, options = {}) => runRecorder(args, { ...options, script: recorderHelper })
const runCommandRecorderSignalled = (args, options = {}) =>
	runRecorderSignalled(args, { ...options, script: recorderHelper })

const tempFilesLeft = (run) => fs.readdirSync(run.outDir).filter((name) => name.includes(".tmp"))

const pidAlive = (pid) => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

describe("record.sh production behavior", () => {
	it("runs the real Node driver with no arguments and keeps metadata on failure", () => {
		// The credential-free driver fails fast with a SETUP_FAILED verdict, so
		// this exercises the exact CI spawn path end to end.
		const run = runRecorder([])
		try {
			assert.equal(run.result.status, 1)
			const verdict = JSON.parse(fs.readFileSync(path.join(run.outDir, "verdict.json"), "utf8"))
			assert.equal(verdict.code, "SETUP_FAILED")
			const trace = JSON.parse(fs.readFileSync(path.join(run.outDir, "trace.json"), "utf8"))
			assert.equal(trace.execution.code, "SETUP_FAILED")
			assert.equal(fs.readFileSync(run.finalRecording, "utf8"), "data\n")
			assert.deepEqual(tempFilesLeft(run), [])
		} finally {
			run.cleanup()
		}
	})
	it("refuses a supplied command while the provider credential is set", () => {
		const run = runRecorder(["true"], { extraEnv: { SOLHEIM_API_KEY: "sk-test" } })
		try {
			assert.equal(run.result.status, 2)
			assert.match(run.result.stderr, /Refusing/)
		} finally {
			run.cleanup()
		}
	})
	it("rejects and never runs a supplied command when only unrelated secrets are inherited", () => {
		const marker = path.join(os.tmpdir(), `record-sh-marker-${process.pid}-${Math.random()}`)
		// Regression for the removed "$@" path: with SOLHEIM_API_KEY unset, the
		// wrapper used to execute the supplied command with the full inherited
		// environment, including unrelated credentials such as OPENAI_API_KEY.
		const run = runRecorder(["bash", "-c", 'printf "%s" "$OPENAI_API_KEY" > "$PROVIDER_MARKER"'], {
			extraEnv: { OPENAI_API_KEY: "sk-inherited-secret" },
		})
		try {
			assert.equal(run.result.status, 2)
			assert.match(run.result.stderr, /Refusing/)
			assert.ok(!fs.existsSync(marker), "the supplied command must not run")
			assert.ok(!run.result.stdout.includes("sk-inherited-secret"))
			assert.ok(!run.result.stderr.includes("sk-inherited-secret"))
			assert.ok(!fs.existsSync(run.finalRecording), "a rejected run must publish no recording")
		} finally {
			run.cleanup()
			fs.rmSync(marker, { force: true })
		}
	})
	it("keeps the test-only command helper identical to record.sh outside the driver selection", () => {
		const structural = (source) =>
			source
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "" && !line.startsWith("#"))
		const production = structural(fs.readFileSync(recorderScript, "utf8"))
		const helper = structural(fs.readFileSync(recorderHelper, "utf8"))
		assert.deepEqual(
			production.filter((line) => !helper.includes(line)),
			[
				'if [[ "$#" -gt 0 ]]; then',
				'echo "Refusing supplied arguments: the recorder only runs its Node driver" >&2',
				"exit 2",
				'script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
				'node --import tsx "$script_dir/driver.mts" &',
			],
		)
		assert.deepEqual(
			helper.filter((line) => !production.includes(line)),
			['"$@" &'],
		)
	})
})

describe("record.test-helper.sh exit and validation behavior", () => {
	it("passes when the command succeeds and the recording is valid", () => {
		const run = runCommandRecorder(["true"])
		try {
			assert.equal(run.result.status, 0)
			assert.equal(fs.readFileSync(run.finalRecording, "utf8"), "data\n")
			assert.deepEqual(tempFilesLeft(run), [])
		} finally {
			run.cleanup()
		}
	})
	it("keeps the exit code of a failing command and still publishes a valid recording", () => {
		const run = runCommandRecorder(["bash", "-c", "exit 7"])
		try {
			assert.equal(run.result.status, 7)
			assert.equal(fs.readFileSync(run.finalRecording, "utf8"), "data\n")
		} finally {
			run.cleanup()
		}
	})
	it("removes stale verdict and trace metadata at start", () => {
		const run = runCommandRecorder(["true"], {
			seedMetadata: ["verdict.json", "trace.json", "verdict.json.1.tmp"],
		})
		try {
			for (const name of ["verdict.json", "trace.json", "verdict.json.1.tmp"])
				assert.equal(fs.existsSync(path.join(run.outDir, name)), false, name)
		} finally {
			run.cleanup()
		}
	})

	it("fails when the recording is missing", () => {
		const run = runCommandRecorder(["true"], { ffmpegWrites: false })
		try {
			assert.equal(run.result.status, 1)
			assert.match(run.result.stdout, /recording failed/)
			assert.ok(!fs.existsSync(run.finalRecording))
		} finally {
			run.cleanup()
		}
	})
	it("fails and cleans the temporary file when ffprobe rejects the recording", () => {
		const run = runCommandRecorder(["true"], { ffprobeOk: false })
		try {
			assert.equal(run.result.status, 1)
			assert.ok(!fs.existsSync(run.finalRecording))
			assert.deepEqual(tempFilesLeft(run), [])
		} finally {
			run.cleanup()
		}
	})
	it("keeps a failing command code when the recording is also invalid", () => {
		const run = runCommandRecorder(["bash", "-c", "exit 7"], { ffprobeOk: false })
		try {
			assert.equal(run.result.status, 7)
			assert.ok(!fs.existsSync(run.finalRecording))
		} finally {
			run.cleanup()
		}
	})
	it("removes a stale final recording when the new recording fails", () => {
		const run = runCommandRecorder(["true"], { ffmpegWrites: false, seedFinal: "STALE" })
		try {
			assert.equal(run.result.status, 1)
			assert.ok(!fs.existsSync(run.finalRecording))
		} finally {
			run.cleanup()
		}
	})
	it("replaces a stale final recording with the validated new recording", () => {
		const run = runCommandRecorder(["true"], { seedFinal: "STALE" })
		try {
			assert.equal(run.result.status, 0)
			assert.equal(fs.readFileSync(run.finalRecording, "utf8"), "data\n")
		} finally {
			run.cleanup()
		}
	})
	it("aborts before the command when the recorder dies at startup", () => {
		const marker = path.join(os.tmpdir(), `record-sh-marker-${process.pid}-${Math.random()}`)
		const run = runCommandRecorder(["bash", "-c", 'echo ran > "$PROVIDER_MARKER"'], {
			ffmpeg: 'for a; do :; done; echo partial > "$a"\nexit 1',
			providerMarker: marker,
		})
		try {
			assert.equal(run.result.status, 1)
			assert.ok(!fs.existsSync(marker))
			assert.ok(!fs.existsSync(run.finalRecording))
			assert.match(run.result.stdout, /stopped on its own/)
		} finally {
			run.cleanup()
			fs.rmSync(marker, { force: true })
		}
	})
	it("rejects recorder output that stopped on its own with a failure status", () => {
		const run = runCommandRecorder(["bash", "-c", "sleep 2"], {
			// The content is readable and would pass ffprobe, so the rejection
			// must come from the recorder's own non-zero exit status.
			ffmpeg: 'for a; do :; done\nsleep 0.7\necho data > "$a"\nexit 1',
		})
		try {
			assert.equal(run.result.status, 1)
			assert.ok(!fs.existsSync(run.finalRecording))
			assert.deepEqual(tempFilesLeft(run), [])
			assert.match(run.result.stdout, /stopped on its own/)
		} finally {
			run.cleanup()
		}
	})
	it("publishes when the recorder stops on its own with success (size or time limit)", () => {
		const run = runCommandRecorder(["bash", "-c", "sleep 2"], {
			ffmpeg: 'for a; do :; done\nsleep 0.7\necho data > "$a"\nexit 0',
		})
		try {
			assert.equal(run.result.status, 0)
			assert.equal(fs.readFileSync(run.finalRecording, "utf8"), "data\n")
		} finally {
			run.cleanup()
		}
	})
})

describe("record.test-helper.sh signal teardown behavior", () => {
	it("stops the recorder and the command on SIGTERM and keeps the signal exit code", async () => {
		const marker = path.join(os.tmpdir(), `record-sh-marker-${process.pid}-${Math.random()}`)
		const run = await runCommandRecorderSignalled(
			// The inner wait makes the stub command respond to TERM promptly, the
			// way a signal-safe driver does. The trap exits so the "normal" write
			// cannot run after a handled signal.
			[
				"bash",
				"-c",
				`trap 'printf killed > "$PROVIDER_MARKER"; exit 143' TERM; sleep 5 & wait; printf normal > "$PROVIDER_MARKER"`,
			],
			{ delayMs: 800, providerMarker: marker },
		)
		try {
			assert.equal(run.code, 143)
			assert.equal(fs.readFileSync(run.finalRecording, "utf8"), "data\n")
			assert.equal(fs.readFileSync(marker, "utf8"), "killed")
			assert.deepEqual(tempFilesLeft(run), [])
		} finally {
			run.cleanup()
			fs.rmSync(marker, { force: true })
		}
	})
	it("leaves no final recording when the interrupted output fails validation", async () => {
		const run = await runCommandRecorderSignalled(["bash", "-c", "sleep 5"], { delayMs: 800, ffprobeOk: false })
		try {
			assert.equal(run.code, 143)
			assert.ok(!fs.existsSync(run.finalRecording))
			assert.deepEqual(tempFilesLeft(run), [])
		} finally {
			run.cleanup()
		}
	})
})

describe("record.test-helper.sh provider stop behavior", () => {
	it("lets a driver-style stub finish teardown and atomic artifact writes on SIGTERM", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-sh-"))
		const bin = stubRecorderBin(dir)
		const paths = recorderPaths(dir)
		// The artifact lives beside the stub, not inside the recorder output
		// directory, so the assertion only observes the driver-style write.
		const artifact = path.join(dir, "verdict.json")
		const readyFile = path.join(dir, "driver-ready")
		const stub = path.join(dir, "driver-stub.mjs")
		fs.writeFileSync(
			stub,
			[
				`import fs from "node:fs"`,
				`const artifact = process.argv[2]`,
				`process.on("SIGTERM", () => {`,
				`	// Simulate driver teardown before the atomic artifact write.`,
				`	setTimeout(() => {`,
				`		fs.writeFileSync(artifact + ".tmp", "complete")`,
				`		fs.renameSync(artifact + ".tmp", artifact)`,
				`		process.exit(143)`,
				`	}, 1500)`,
				`})`,
				`fs.writeFileSync(process.argv[3], "ready")`,
				`setInterval(() => {}, 1000)`,
			].join("\n"),
		)
		const run = await runCommandRecorderSignalled(["node", stub, artifact, readyFile], {
			readyFile,
			stopBudget: 10,
		})
		try {
			assert.equal(run.code, 143)
			// The wrapper waited for the driver teardown instead of killing the
			// driver mid-write, so the atomic artifact write completed.
			assert.equal(fs.readFileSync(artifact, "utf8"), "complete")
			assert.equal(fs.readFileSync(run.finalRecording, "utf8"), "data\n")
			assert.deepEqual(tempFilesLeft(run), [])
		} finally {
			run.cleanup()
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})
	it("escalates to KILL and reaps a hung driver within the stop budget", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-sh-"))
		const bin = stubRecorderBin(dir)
		const paths = recorderPaths(dir)
		// The quote and backslash prove the paths reach the driver as argv,
		// never interpolated into the driver source.
		const hungPidFile = path.join(dir, "hung\\pid")
		const termSeenFile = path.join(dir, 'term"seen')
		const hungReadyFile = path.join(dir, "hung-ready")
		const hungStub = path.join(dir, "hung-driver.mjs")
		fs.writeFileSync(
			hungStub,
			[
				`import fs from "node:fs"`,
				`process.on("SIGTERM", () => fs.writeFileSync(process.argv[2], "seen"))`,
				`fs.writeFileSync(process.argv[4], "ready")`,
				`fs.writeFileSync(process.argv[3], String(process.pid))`,
				`setInterval(() => {}, 1000)`,
			].join("\n"),
		)
		const startedAt = Date.now()
		// TERM lands only after the ready file proves the TERM handler is
		// armed, so the ignored TERM is a handled signal, never a boot-time
		// default kill.
		const run = await runCommandRecorderSignalled(["node", hungStub, termSeenFile, hungPidFile, hungReadyFile], {
			readyFile: hungReadyFile,
			stopBudget: 2,
		})
		try {
			assert.equal(run.code, 143)
			// TERM reached the real driver child, the wrapper waited the
			// documented budget, then escalated. Teardown stays bounded.
			assert.equal(fs.readFileSync(termSeenFile, "utf8"), "seen")
			assert.ok(Date.now() - startedAt < 10_000)
			assert.equal(fs.readFileSync(run.finalRecording, "utf8"), "data\n")
			const hungPid = Number(fs.readFileSync(hungPidFile, "utf8").trim())
			assert.ok(Number.isInteger(hungPid) && hungPid > 0)
			let gone = false
			for (let attempt = 0; attempt < 50 && !gone; attempt++) {
				gone = !pidAlive(hungPid)
				if (!gone) await new Promise((resolve) => setTimeout(resolve, 100))
			}
			assert.ok(gone, "hung driver survived the KILL escalation")
		} finally {
			run.cleanup()
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})
})
