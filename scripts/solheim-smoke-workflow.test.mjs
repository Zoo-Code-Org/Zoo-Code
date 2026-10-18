import assert from "node:assert/strict"
import fs from "node:fs"
import { URL } from "node:url"
import { describe, it } from "node:test"
import { spawn, spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
const workflow = fs.readFileSync(new URL("../.github/workflows/solheim-provider-smoke.yml", import.meta.url), "utf8")
const codeQa = fs.readFileSync(new URL("../.github/workflows/code-qa.yml", import.meta.url), "utf8")
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const driver = fs.readFileSync(new URL("./solheim-smoke/driver.mts", import.meta.url), "utf8")
const recorder = fs.readFileSync(new URL("./solheim-smoke/record.sh", import.meta.url), "utf8")
const smokePkg = JSON.parse(fs.readFileSync(new URL("./solheim-smoke/package.json", import.meta.url), "utf8"))
const runner = fs.readFileSync(new URL("./agent-evals/runner.ts", import.meta.url), "utf8")
const launcher = fs.readFileSync(new URL("./agent-evals/launcher.ts", import.meta.url), "utf8")
const registry = fs.readFileSync(new URL("./agent-evals/registry.ts", import.meta.url), "utf8")
const fixture = fs.readFileSync(new URL("./solheim-smoke/fixture.ts", import.meta.url), "utf8")
const trace = fs.readFileSync(new URL("./agent-evals/trace.ts", import.meta.url), "utf8")
const evalsPkg = JSON.parse(fs.readFileSync(new URL("./agent-evals/package.json", import.meta.url), "utf8"))

describe("Project A provider smoke workflow", () => {
	it("runs smoke TypeScript as ESM without requiring compiled workspace packages", () => {
		assert.equal(smokePkg.type, "module")
		assert.equal(smokePkg.private, true)
	})
	it("runs only by manual dispatch against the exact trusted main revision", () => {
		assert.match(workflow, /workflow_dispatch:/)
		assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/)
		assert.match(workflow, /ref: \$\{\{ github.sha \}\}/)
		assert.ok(!workflow.includes("pull_request_review:"))
		assert.ok(!workflow.includes("pull_request_target:"))
		assert.match(workflow, /persist-credentials: false/)
		assert.match(workflow, /environment: final-vscode-review-smoke/)
	})
	it("has one credential-bearing step, no GitHub write permissions, and no posting", () => {
		assert.equal((workflow.match(/secrets\./g) ?? []).length, 1)
		const before = workflow.slice(0, workflow.indexOf("- name: Run Solheim provider smoke"))
		assert.ok(!before.includes("secrets."))
		assert.match(workflow, /permissions:\n\s+contents: read/)
		assert.ok(!/\bwrite\b/.test(workflow))
		assert.ok(!workflow.includes("github-script"))
		assert.ok(!workflow.includes("post-review"))
	})
	it("has one smoke job and no review, routing, shadow, or deterministic lanes", () => {
		const jobs = workflow.split("jobs:\n")[1] ?? ""
		assert.deepEqual(
			[...jobs.matchAll(/^ {4}([a-z-]+):$/gm)].map((match) => match[1]),
			["smoke"],
		)
		for (const name of [
			"theme-review",
			"probe-dispatch",
			"rules-review",
			"merge-report",
			"bounded-code-review",
			"model-qualification",
		])
			assert.ok(!workflow.includes(name))
		assert.ok(!driver.includes("model-qualification"))
		assert.ok(!driver.includes("AcknowledgeCompletion"))
	})
	it("bounds runtime and serializes the single provider instance", () => {
		assert.match(workflow, /cancel-in-progress: false/)
		assert.match(workflow, /timeout-minutes: 8/)
		assert.match(workflow, /^ {8}timeout-minutes: 25$/m)
	})
	it("uploads metadata and the recording as separate validated artifacts", () => {
		const metadataStep =
			workflow.split("- name: Upload provider smoke verdict and trace")[1]?.split("- name:")[0] ?? ""
		const recordingStep = workflow.split("- name: Upload provider smoke recording")[1]?.split("- name:")[0] ?? ""
		assert.ok(metadataStep.length > 0)
		assert.ok(recordingStep.length > 0)
		assert.deepEqual(
			metadataStep
				.split("path: |")[1]
				?.split("if-no-files-found:")[0]
				.trim()
				.split("\n")
				.map((line) => line.trim()),
			[
				"${{ runner.temp }}/solheim-provider-smoke/verdict.json",
				"${{ runner.temp }}/solheim-provider-smoke/trace.json",
			],
		)
		// The recording artifact carries only the exact validated final path.
		assert.equal(
			recordingStep.split("path: ")[1]?.split("\n")[0].trim(),
			"${{ runner.temp }}/solheim-provider-smoke/smoke.mp4",
		)
		for (const step of [metadataStep, recordingStep]) {
			assert.match(step, /!cancelled\(\)/)
			assert.match(step, /if-no-files-found: error/)
			assert.match(step, /retention-days: 7/)
			assert.match(step, /actions\/upload-artifact@[0-9a-f]{40}/)
			assert.ok(!step.includes("*"))
		}
		// A missing recording cannot hide behind a multi-path if-no-files-found.
		assert.match(workflow, /name: solheim-provider-smoke-recording-\$\{\{ github\.sha \}\}/)
		// Temporary recorder output is never an upload path.
		assert.ok(!workflow.includes(".tmp"))
		assert.ok(!driver.includes("console.error("))
		assert.ok(!driver.includes("stderrLog"))
	})
	it("reports a missing or failed recording explicitly before the uploads", () => {
		const checkStep = workflow.split("- name: Verify recording integrity")[1]?.split("- name:")[0] ?? ""
		// The published final is the commit marker; no separate status file exists.
		assert.match(checkStep, /test -s "\$SOLHEIM_SMOKE_OUT_DIR\/smoke\.mp4"/)
		assert.ok(!workflow.includes("recording-status"))
		assert.match(checkStep, /!cancelled\(\)/)
		const checkIndex = workflow.indexOf("- name: Verify recording integrity")
		const uploadIndex = workflow.indexOf("- name: Upload provider smoke verdict and trace")
		assert.ok(checkIndex >= 0 && checkIndex < uploadIndex)
	})
	it("records a fresh display with credential-free ffmpeg and bounded teardown", () => {
		assert.match(workflow, /install -y xvfb ffmpeg/)
		assert.match(workflow, /xvfb-run -a -s "-screen 0 1280x720x24 -nolisten tcp"/)
		assert.match(recorder, /env -i "PATH=\$PATH" "DISPLAY=\$DISPLAY"/)
		assert.match(recorder, /-t 480 -fs 125829120/)
		assert.match(recorder, /frag_keyframe\+empty_moov/)
		assert.match(recorder, /trap finish EXIT/)
		assert.match(recorder, /attempt < 50/)
		assert.ok(!recorder.includes("SOLHEIM_API_KEY"))
		assert.match(workflow, /retention-days: 7/)
		// The recorder writes a unique temporary file inside the output
		// directory, forces the mp4 muxer because the name has no mp4 suffix,
		// and publishes only validated output with an atomic rename.
		assert.match(recorder, /temp_recording="\$SOLHEIM_SMOKE_OUT_DIR\/\.smoke\.mp4\.\$\$\.tmp"/)
		assert.match(recorder, /-f mp4 "\$temp_recording"/)
		assert.match(recorder, /ffprobe -v error "\$temp_recording"/)
		assert.match(recorder, /mv -f "\$temp_recording" "\$final_recording"/)
		assert.match(recorder, /rm -f "\$final_recording"/)
		// ffmpeg must never write the final path directly.
		assert.ok(!/ffmpeg[^\n]*\$final_recording/.test(recorder))
	})
	it("signals the Node driver directly with a documented stop budget", () => {
		// A package-manager wrapper between the recorder and the driver would
		// receive the TERM and KILL meant for the driver that performs teardown
		// and the atomic verdict and trace writes.
		assert.ok(!recorder.includes("pnpm"))
		assert.match(recorder, /node --import tsx "\$script_dir\/driver\.mts" &/)
		assert.match(recorder, /SOLHEIM_SMOKE_STOP_BUDGET_S:-30/)
		assert.match(recorder, /kill -TERM "\$provider_pid"/)
		assert.match(recorder, /kill -KILL "\$provider_pid"/)
		assert.match(recorder, /wait "\$provider_pid"/)
		assert.ok(!recorder.includes("status_file"))
	})
	it("keeps Code QA and package commands focused on smoke contracts", () => {
		for (const command of [
			"test:solheim-smoke:unit",
			"test:solheim-smoke-ci",
			"solheim-smoke:check-types",
			"test:agent-evals:unit",
			"agent-evals:check-types",
		])
			assert.ok(codeQa.includes(command))
		assert.ok(!codeQa.includes("model-qualification"))
		assert.ok(!Object.keys(pkg.scripts).some((name) => name.includes("model-qualification")))
		assert.ok(!codeQa.includes("final-smoke"))
		assert.equal(pkg.scripts["solheim:smoke"], "node --import tsx scripts/solheim-smoke/driver.mts")
		assert.equal(pkg.scripts["test:agent-evals:unit"], "node --import tsx --test scripts/agent-evals/*.test.ts")
		assert.equal(pkg.scripts["agent-evals:check-types"], "tsc -p scripts/agent-evals/tsconfig.json")
		assert.ok(!fs.existsSync(new URL("../.github/workflows/final-vscode-review-smoke.yml", import.meta.url)))
	})
	it("keeps the shared controller free of smoke, provider, and solution knowledge", () => {
		assert.equal(evalsPkg.type, "module")
		assert.equal(evalsPkg.private, true)
		assert.ok(!/solheim/i.test(runner))
		assert.ok(!/smoke/i.test(runner))
		assert.ok(!runner.includes("SOLHEIM_API_KEY"))
		assert.ok(!/solheim/i.test(trace))
		assert.ok(trace.includes("traceSchemaVersion"))
	})
	it("registers fixtures only through the validated in-memory registry", () => {
		assert.ok(!registry.includes("import("))
		assert.ok(!registry.includes("fetch("))
		assert.ok(!registry.includes("readdir"))
		assert.ok(fixture.includes("registerFixture"))
	})
	it("keeps VS Code launch isolation in one shared launcher with an atomic artifact writer", () => {
		assert.ok(driver.includes("createHostRuntime"))
		assert.ok(!driver.includes("spawn("))
		assert.ok(!driver.includes("downloadAndUnzipVSCode"))
		assert.ok(launcher.includes("downloadAndUnzipVSCode"))
		assert.ok(launcher.includes("buildChildEnvironment"))
		assert.ok(launcher.includes("await fs.rename(pending"))
		assert.ok(launcher.includes("process.kill(-child.pid"))
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

const recorderScript = new URL("./solheim-smoke/record.sh", import.meta.url).pathname

function runRecorder(
	args,
	{ ffmpeg, ffmpegWrites = true, ffprobeOk = true, seedFinal, providerMarker, stopBudget } = {},
) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-sh-"))
	const bin = stubRecorderBin(dir, { ffmpeg, ffmpegWrites, ffprobeOk })
	const paths = recorderPaths(dir)
	fs.mkdirSync(paths.outDir, { recursive: true })
	if (seedFinal !== undefined) fs.writeFileSync(paths.finalRecording, seedFinal)
	const result = spawnSync("bash", [recorderScript, ...args], {
		env: recorderEnv(bin, paths.outDir, providerMarker, stopBudgetEnv(stopBudget)),
		encoding: "utf8",
		timeout: 20_000,
	})
	return { result, ...paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function runRecorderSignalled(args, { ffmpeg, ffprobeOk = true, delayMs, providerMarker, stopBudget } = {}) {
	return new Promise((resolve) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-sh-"))
		const bin = stubRecorderBin(dir, { ffmpeg, ffprobeOk })
		const paths = recorderPaths(dir)
		// The output directory is created here, before the recorder runs, so
		// every process in the test observes the same directory object.
		fs.mkdirSync(paths.outDir, { recursive: true })
		const child = spawn("bash", [recorderScript, ...args], {
			env: recorderEnv(bin, paths.outDir, providerMarker, stopBudgetEnv(stopBudget)),
		})
		let stdout = ""
		child.stdout.on("data", (chunk) => {
			stdout += chunk
		})
		const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000)
		const timer = setTimeout(() => child.kill("SIGTERM"), delayMs)
		child.on("close", (code) => {
			clearTimeout(watchdog)
			clearTimeout(timer)
			resolve({ code, stdout, ...paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) })
		})
	})
}

const tempFilesLeft = (run) => fs.readdirSync(run.outDir).filter((name) => name.includes(".tmp"))

const pidAlive = (pid) => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

describe("record.sh exit and validation behavior", () => {
	it("passes when the command succeeds and the recording is valid", () => {
		const run = runRecorder(["true"])
		try {
			assert.equal(run.result.status, 0)
			assert.equal(fs.readFileSync(run.finalRecording, "utf8"), "data\n")
			assert.deepEqual(tempFilesLeft(run), [])
		} finally {
			run.cleanup()
		}
	})
	it("keeps the exit code of a failing command and still publishes a valid recording", () => {
		const run = runRecorder(["bash", "-c", "exit 7"])
		try {
			assert.equal(run.result.status, 7)
			assert.equal(fs.readFileSync(run.finalRecording, "utf8"), "data\n")
		} finally {
			run.cleanup()
		}
	})
	it("fails when the recording is missing", () => {
		const run = runRecorder(["true"], { ffmpegWrites: false })
		try {
			assert.equal(run.result.status, 1)
			assert.match(run.result.stdout, /recording failed/)
			assert.ok(!fs.existsSync(run.finalRecording))
		} finally {
			run.cleanup()
		}
	})
	it("fails and cleans the temporary file when ffprobe rejects the recording", () => {
		const run = runRecorder(["true"], { ffprobeOk: false })
		try {
			assert.equal(run.result.status, 1)
			assert.ok(!fs.existsSync(run.finalRecording))
			assert.deepEqual(tempFilesLeft(run), [])
		} finally {
			run.cleanup()
		}
	})
	it("keeps a failing command code when the recording is also invalid", () => {
		const run = runRecorder(["bash", "-c", "exit 7"], { ffprobeOk: false })
		try {
			assert.equal(run.result.status, 7)
			assert.ok(!fs.existsSync(run.finalRecording))
		} finally {
			run.cleanup()
		}
	})
	it("removes a stale final recording when the new recording fails", () => {
		const run = runRecorder(["true"], { ffmpegWrites: false, seedFinal: "STALE" })
		try {
			assert.equal(run.result.status, 1)
			assert.ok(!fs.existsSync(run.finalRecording))
		} finally {
			run.cleanup()
		}
	})
	it("replaces a stale final recording with the validated new recording", () => {
		const run = runRecorder(["true"], { seedFinal: "STALE" })
		try {
			assert.equal(run.result.status, 0)
			assert.equal(fs.readFileSync(run.finalRecording, "utf8"), "data\n")
		} finally {
			run.cleanup()
		}
	})
	it("aborts before the command when the recorder dies at startup", () => {
		const marker = path.join(os.tmpdir(), `record-sh-marker-${process.pid}-${Math.random()}`)
		const run = runRecorder(["bash", "-c", 'echo ran > "$PROVIDER_MARKER"'], {
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
		const run = runRecorder(["bash", "-c", "sleep 2"], {
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
		const run = runRecorder(["bash", "-c", "sleep 2"], {
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

describe("record.sh signal teardown behavior", () => {
	it("stops the recorder and the command on SIGTERM and keeps the signal exit code", async () => {
		const marker = path.join(os.tmpdir(), `record-sh-marker-${process.pid}-${Math.random()}`)
		const run = await runRecorderSignalled(
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
		const run = await runRecorderSignalled(["bash", "-c", "sleep 5"], { delayMs: 800, ffprobeOk: false })
		try {
			assert.equal(run.code, 143)
			assert.ok(!fs.existsSync(run.finalRecording))
			assert.deepEqual(tempFilesLeft(run), [])
		} finally {
			run.cleanup()
		}
	})
})

describe("record.sh provider stop behavior", () => {
	it("lets a driver-style stub finish teardown and atomic artifact writes on SIGTERM", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-sh-"))
		const bin = stubRecorderBin(dir)
		const paths = recorderPaths(dir)
		// The artifact lives beside the stub, not inside the recorder output
		// directory, so the assertion only observes the driver-style write.
		const artifact = path.join(dir, "verdict.json")
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
				`setInterval(() => {}, 1000)`,
			].join("\n"),
		)
		const run = await runRecorderSignalled(["node", stub, artifact], { delayMs: 800, stopBudget: 10 })
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
		const hungStub = path.join(dir, "hung-driver.mjs")
		fs.writeFileSync(
			hungStub,
			[
				`import fs from "node:fs"`,
				`process.on("SIGTERM", () => fs.writeFileSync(process.argv[2], "seen"))`,
				`fs.writeFileSync(process.argv[3], String(process.pid))`,
				`setInterval(() => {}, 1000)`,
			].join("\n"),
		)
		const startedAt = Date.now()
		// The TERM lands well after the child booted, so the ignored TERM is a
		// handled signal, not a boot-time default kill.
		const run = await runRecorderSignalled(["node", hungStub, termSeenFile, hungPidFile], {
			delayMs: 900,
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
})
